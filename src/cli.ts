import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { AtomicWriteError, realFs, writeFileAtomically, type WriteFs } from "./atomic-write.js";
import { buildNightReport, linkRuns } from "./build-night-records.js";
import { collectEvidence, realExec, type Exec } from "./github-evidence.js";
import { renderMorningReport, renderNightDigest } from "./morning-report.js";
import { parseNightRecord } from "./night-record.js";

/**
 * `npm run report -- <path-to-record.json> [--force] [--dry-run] [--help]`
 * `npm run report -- --from-github [--since <ISO>] [--until <ISO>] [--force] [--dry-run]`
 *
 * Validates the record, prints the morning report, and writes it to
 * reports/<date>.md. On any problem it prints what is wrong, writes nothing,
 * and exits with code 1.
 *
 * With `--from-github` it reads the agent runs in the window from GitHub and
 * Qodo (read-only, see github-evidence.ts), builds one night record per issue
 * they touched, and writes the night's digest to reports/<date>.md, where the
 * date is the Africa/Lagos calendar date of `--until`. The window defaults to
 * the 24 hours before now. Unreadable evidence writes nothing and exits 1.
 *
 * - An existing report is never replaced unless `--force` is given: the run
 *   names the file, exits 1, and leaves the file unchanged.
 * - The write is atomic (see atomic-write.ts): a report is either fully written
 *   or not at all, and a failed write leaves any existing report unchanged.
 * - `--dry-run` prints the report and writes nothing, and says what a real run
 *   would have done. It wins over `--force`, so adding `--dry-run` to any
 *   command is always a safe preview.
 */

const USAGE =
  "Usage: npm run report -- <path-to-record.json> [--force] [--dry-run] [--help]\n" +
  "       npm run report -- --from-github [--since <ISO>] [--until <ISO>] [--force] [--dry-run]\n";

const KNOWN_OPTIONS = "--force, --dry-run, --help, --from-github, --since, --until";

const HELP =
  USAGE +
  "\n" +
  "Validates a night record, prints the morning report, and writes it to reports/<date>.md.\n" +
  "With --from-github, builds the night's report from the agent runs on GitHub instead.\n" +
  "\n" +
  "Options:\n" +
  "  --force        Replace an existing report instead of refusing.\n" +
  "  --dry-run      Print the report and write nothing (wins over --force).\n" +
  "  --from-github  Read the agent runs in the window from GitHub and Qodo (read-only).\n" +
  "  --since <ISO>  Start of the window, e.g. 2026-11-24T00:00:00Z (default: 24 hours before --until).\n" +
  "  --until <ISO>  End of the window (default: now). The report date is its Africa/Lagos date.\n" +
  "  --help, -h     Show this help and exit.\n" +
  "\n" +
  "Example:\n" +
  "  npm run report -- fixtures/sample-escalated.json --dry-run\n" +
  "  npm run report -- --from-github --since 2026-11-24T00:00:00Z --until 2026-11-24T23:59:59Z --dry-run\n";

type Options =
  | { recordPath: string; force: boolean; dryRun: boolean }
  | { fromGithub: true; since?: string | undefined; until?: string | undefined; force: boolean; dryRun: boolean }
  | { help: true };

/** Parse CLI arguments, or return a readable error message. */
function parseOptions(args: string[]): Options | { error: string } {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        force: { type: "boolean" },
        "dry-run": { type: "boolean" },
        help: { type: "boolean", short: "h" },
        "from-github": { type: "boolean" },
        since: { type: "string" },
        until: { type: "string" },
      },
    });
  } catch (error) {
    const { code, message } = error as { code?: string; message: string };
    const option = /'(-[^' ]*)/.exec(message)?.[1] ?? "";
    if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
      return { error: `Unknown option: ${option}. Known options: ${KNOWN_OPTIONS}.\n${USAGE}` };
    }
    if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
      return option === "--since" || option === "--until"
        ? { error: `Option ${option} needs a value, e.g. ${option} 2026-11-24T00:00:00Z.\n${USAGE}` }
        : { error: `Option ${option} does not take a value.\n${USAGE}` };
    }
    return { error: `${message}\n${USAGE}` };
  }

  if (parsed.values.help === true) return { help: true };

  const force = parsed.values.force === true;
  const dryRun = parsed.values["dry-run"] === true;
  if (parsed.values["from-github"] === true) {
    if (parsed.positionals.length > 0) return { error: `--from-github takes no record path.\n${USAGE}` };
    return { fromGithub: true, since: parsed.values.since, until: parsed.values.until, force, dryRun };
  }
  if (parsed.values.since !== undefined || parsed.values.until !== undefined) {
    return { error: `--since and --until need --from-github.\n${USAGE}` };
  }

  const [recordPath, ...extra] = parsed.positionals;
  if (!recordPath || extra.length > 0) return { error: USAGE };
  return {
    recordPath,
    force: parsed.values.force === true,
    dryRun: parsed.values["dry-run"] === true,
  };
}

/** The error's code and message, without repeating a code Node already put in the message. */
function describeFailure(failure: AtomicWriteError): string {
  const { code, message } = failure;
  return code && !message.startsWith(`${code}:`) ? `${code}: ${message}` : message;
}

/**
 * Whether something already occupies the report path. `lstat` checks the path
 * itself, so a dangling symlink counts as present, matching what the "wx"
 * write will do. Only ENOENT means absent; any other error is returned so the
 * caller does not guess.
 */
async function probe(path: string): Promise<"present" | "absent" | { error: string }> {
  try {
    await lstat(path);
    return "present";
  } catch (error) {
    const code = (error as { code?: string }).code;
    return code === "ENOENT" ? "absent" : { error: code ?? (error as Error).message };
  }
}

export interface CliIo {
  cwd: string;
  out: (text: string) => void;
  err: (text: string) => void;
  /** Filesystem calls used to write the report; tests inject failures here. */
  fs?: WriteFs;
  /** Runs gh and qodo for --from-github; tests replay recorded responses here. */
  exec?: Exec;
  /** The generation time for --from-github; tests fix it here. */
  now?: () => Date;
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/** A timestamp with a date, a time and a zone, or a readable error. */
function parseTimestamp(name: string, value: string): Date | { error: string } {
  const when = new Date(value);
  if (!ISO_TIMESTAMP.test(value) || Number.isNaN(when.getTime())) {
    return { error: `--${name} must be an ISO timestamp with a time zone, e.g. 2026-11-24T00:00:00Z; got: ${value}\n${USAGE}` };
  }
  return when;
}

/** Builds the night's digest from GitHub, or returns a readable error. Writes nothing. */
async function digestFromGithub(
  options: { since?: string | undefined; until?: string | undefined },
  io: CliIo,
): Promise<{ date: string; report: string } | { error: string }> {
  const generatedAt = (io.now ?? (() => new Date()))();
  const until = options.until === undefined ? generatedAt : parseTimestamp("until", options.until);
  if ("error" in until) return until;
  const since = options.since === undefined ? new Date(until.getTime() - 24 * 60 * 60 * 1000) : parseTimestamp("since", options.since);
  if ("error" in since) return since;
  if (since.getTime() >= until.getTime()) return { error: `--since must be before --until.\n${USAGE}` };

  let evidence;
  try {
    evidence = await collectEvidence(io.exec ?? realExec, { since, until, linkRuns: linkRuns(since, until) });
  } catch (error) {
    return { error: `Could not read the evidence from GitHub: ${(error as Error).message}\nNo report was written.\n` };
  }
  const night = buildNightReport(evidence, { since, until });
  const report = renderNightDigest(night.records, {
    date: night.date,
    generatedAt,
    since,
    until,
    unknowns: night.unknowns,
    idleRuns: night.idleRuns,
  });
  return { date: night.date, report };
}

/** Reads, validates and renders one night record from a file, or returns a readable error. */
async function reportFromFile(recordPath: string, io: CliIo): Promise<{ date: string; report: string } | { error: string }> {
  let raw: string;
  try {
    raw = await readFile(resolve(io.cwd, recordPath), "utf8");
  } catch (error) {
    return { error: `Could not read ${recordPath}: ${(error as Error).message}\n` };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    return { error: `${recordPath} is not valid JSON: ${(error as Error).message}\n` };
  }

  const parsed = parseNightRecord(json);
  if (!parsed.ok) {
    return {
      error:
        `${recordPath} is not a valid night record. Problems:\n` +
        parsed.problems.map((problem) => `  - ${problem}`).join("\n") +
        "\nNo report was written.\n",
    };
  }
  return { date: parsed.record.date, report: renderMorningReport(parsed.record) };
}

export async function runReport(args: string[], io: CliIo): Promise<number> {
  const options = parseOptions(args);
  if ("error" in options) {
    io.err(options.error);
    return 1;
  }
  if ("help" in options) {
    io.out(HELP);
    return 0;
  }
  const { force, dryRun } = options;

  const built = "fromGithub" in options ? await digestFromGithub(options, io) : await reportFromFile(options.recordPath, io);
  if ("error" in built) {
    io.err(built.error);
    return 1;
  }

  const { report, date } = built;
  const reportName = `reports/${date}.md`;
  const reportsDir = resolve(io.cwd, "reports");
  const reportPath = resolve(reportsDir, `${date}.md`);

  if (dryRun) {
    const state = await probe(reportPath);
    const realRun =
      state === "absent"
        ? `A real run would write ${reportName}.`
        : state === "present"
          ? force
            ? `A real run would replace ${reportName} (--force).`
            : `A real run would refuse: ${reportName} already exists (use --force to replace it).`
          : `Could not check ${reportName} (${state.error}), so what a real run would do is unknown.`;
    io.out(report);
    io.err(`\nDry run: nothing was written. ${realRun}\n`);
    return 0;
  }

  // Only for the wording of the success message; the write itself decides
  // atomically whether a report already exists (see atomic-write.ts).
  // Accepted case: probe() returns an error (not "present"), so replacing is
  // false and the message below says "Wrote". That is harmless: "Wrote" is
  // printed only after the write succeeds, and the errors that stop lstat (for
  // example EACCES or ELOOP) stop the write too, which then reports "Could not
  // write" and exits 1. A transient lstat-only failure could still make a
  // replace say "Wrote"; that is wording only, the report is written either way.
  const replacing = force && (await probe(reportPath)) === "present";

  let outcome;
  try {
    outcome = await writeFileAtomically(reportPath, report, { overwrite: force }, io.fs ?? realFs);
  } catch (error) {
    const failure = error instanceof AtomicWriteError ? error : new AtomicWriteError(error);
    const linkAdvice =
      failure.reason === "no-hard-links"
        ? `The filesystem holding reports/ does not support hard links (${failure.code}), for example exFAT or FAT32.\n` +
          "Polson needs them to refuse overwriting an existing report safely. Use a folder on a filesystem\n" +
          "with hard links (APFS, ext4, NTFS), or pass --force, which replaces by rename and skips the overwrite check.\n"
        : failure.reason === "link-denied"
          ? `The system refused to create a hard link in reports/ (${failure.code}). Either the filesystem does not\n` +
            "support hard links (for example exFAT or FAT32), or a permission or security restriction blocked it.\n" +
            "Polson needs hard links to refuse overwriting an existing report safely. Check the folder's filesystem\n" +
            "and permissions before trying again.\n"
          : "";
    io.err(
      `Could not write ${reportName}: ${describeFailure(failure)}\n` +
        linkAdvice +
        "No report was written, and any existing report is unchanged.\n" +
        (failure.leftoverTemp ? `Could not remove the temporary file ${failure.leftoverTemp}.\n` : ""),
    );
    return 1;
  }

  if (outcome.status === "exists") {
    io.err(
      `${reportName} already exists, so it was not overwritten.\n` +
        "Use --force to replace it, or --dry-run to print the report without writing.\n" +
        (outcome.leftoverTemp ? `Could not remove the temporary file ${outcome.leftoverTemp}.\n` : ""),
    );
    return 1;
  }

  io.out(report);
  io.err(
    `\n${replacing ? "Replaced" : "Wrote"} ${reportName}\n` +
      (outcome.leftoverTemp ? `Warning: could not remove the temporary file ${outcome.leftoverTemp}.\n` : ""),
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = await runReport(process.argv.slice(2), {
    cwd: process.cwd(),
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  });
}
