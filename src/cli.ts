import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { AtomicWriteError, realFs, writeFileAtomically, type WriteFs } from "./atomic-write.js";
import { renderMorningReport } from "./morning-report.js";
import { parseNightRecord } from "./night-record.js";

/**
 * `npm run report -- <path-to-record.json> [--force] [--dry-run] [--help]`
 *
 * Validates the record, prints the morning report, and writes it to
 * reports/<date>.md. On any problem it prints what is wrong, writes nothing,
 * and exits with code 1.
 *
 * - An existing report is never replaced unless `--force` is given: the run
 *   names the file, exits 1, and leaves the file unchanged.
 * - The write is atomic (see atomic-write.ts): a report is either fully written
 *   or not at all, and a failed write leaves any existing report unchanged.
 * - `--dry-run` prints the report and writes nothing, and says what a real run
 *   would have done. It wins over `--force`, so adding `--dry-run` to any
 *   command is always a safe preview.
 */

const USAGE = "Usage: npm run report -- <path-to-record.json> [--force] [--dry-run] [--help]\n";

const HELP =
  USAGE +
  "\n" +
  "Validates a night record, prints the morning report, and writes it to reports/<date>.md.\n" +
  "\n" +
  "Options:\n" +
  "  --force      Replace an existing report instead of refusing.\n" +
  "  --dry-run    Print the report and write nothing (wins over --force).\n" +
  "  --help, -h   Show this help and exit.\n" +
  "\n" +
  "Example:\n" +
  "  npm run report -- fixtures/sample-escalated.json --dry-run\n";

type Options = { recordPath: string; force: boolean; dryRun: boolean } | { help: true };

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
      },
    });
  } catch (error) {
    const { code, message } = error as { code?: string; message: string };
    const option = /'(-[^']*)'/.exec(message)?.[1] ?? "";
    if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
      return { error: `Unknown option: ${option}. Known options: --force, --dry-run, --help.\n${USAGE}` };
    }
    if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
      return { error: `Option ${option} does not take a value.\n${USAGE}` };
    }
    return { error: `${message}\n${USAGE}` };
  }

  if (parsed.values.help === true) return { help: true };

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
  const { recordPath, force, dryRun } = options;

  let raw: string;
  try {
    raw = await readFile(resolve(io.cwd, recordPath), "utf8");
  } catch (error) {
    io.err(`Could not read ${recordPath}: ${(error as Error).message}\n`);
    return 1;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    io.err(`${recordPath} is not valid JSON: ${(error as Error).message}\n`);
    return 1;
  }

  const parsed = parseNightRecord(json);
  if (!parsed.ok) {
    io.err(
      `${recordPath} is not a valid night record. Problems:\n` +
        parsed.problems.map((problem) => `  - ${problem}`).join("\n") +
        "\nNo report was written.\n",
    );
    return 1;
  }

  const report = renderMorningReport(parsed.record);
  const reportName = `reports/${parsed.record.date}.md`;
  const reportsDir = resolve(io.cwd, "reports");
  const reportPath = resolve(reportsDir, `${parsed.record.date}.md`);

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
