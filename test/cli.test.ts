import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runReport } from "../src/cli.js";
import { fixturePath, loadRawFixture } from "./fixtures.js";
import { loadRecording, replay } from "./support/replay-github.js";

describe("report CLI", () => {
  let cwd: string;
  let out: string;
  let err: string;
  const io = () => ({
    cwd,
    out: (text: string) => void (out += text),
    err: (text: string) => void (err += text),
  });

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "polson-cli-"));
    out = "";
    err = "";
  });

  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it("prints the report and writes it to reports/<date>.md", async () => {
    const code = await runReport([fixturePath("sample-escalated.json")], io());

    expect(code).toBe(0);
    expect(out).toContain("## Needs your answer");
    expect(readFileSync(join(cwd, "reports", "2026-11-19.md"), "utf8")).toBe(out);
  });

  it("lists each problem, exits 1, and writes nothing for an invalid record", async () => {
    const record = loadRawFixture("sample-escalated.json");
    delete record.reason;
    delete record.questionForHuman;
    const recordPath = join(cwd, "bad.json");
    writeFileSync(recordPath, JSON.stringify(record));

    const code = await runReport([recordPath], io());

    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toContain('- reason: is required when outcome is "escalated"');
    expect(err).toContain('- questionForHuman: is required when outcome is "escalated"');
    expect(existsSync(join(cwd, "reports"))).toBe(false);
  });

  it("exits 1 with a readable error for a file that is not JSON", async () => {
    const recordPath = join(cwd, "broken.json");
    writeFileSync(recordPath, "{ not json");

    expect(await runReport([recordPath], io())).toBe(1);
    expect(err).toContain("is not valid JSON");
    expect(existsSync(join(cwd, "reports"))).toBe(false);
  });

  it("exits 1 with usage help when no path is given", async () => {
    expect(await runReport([], io())).toBe(1);
    expect(err).toContain("Usage: npm run report -- <path-to-record.json>");
  });

  describe("existing reports (#3)", () => {
    const sample = () => fixturePath("sample-escalated.json");
    const reportFile = () => join(cwd, "reports", "2026-11-19.md");
    const existing = "# A real night's report that must survive\n";
    const seedExistingReport = () => {
      mkdirSync(join(cwd, "reports"));
      writeFileSync(reportFile(), existing);
    };

    it("refuses to overwrite an existing report: names the file, exits 1, leaves it unchanged", async () => {
      seedExistingReport();

      const code = await runReport([sample()], io());

      expect(code).toBe(1);
      expect(err).toContain("reports/2026-11-19.md already exists, so it was not overwritten.");
      expect(err).toContain("Use --force to replace it");
      expect(out).toBe("");
      expect(readFileSync(reportFile(), "utf8")).toBe(existing);
    });

    it("refuses on a second run, keeping the first run's report", async () => {
      expect(await runReport([sample()], io())).toBe(0);
      const first = readFileSync(reportFile(), "utf8");
      out = "";
      err = "";

      expect(await runReport([sample()], io())).toBe(1);
      expect(err).toContain("reports/2026-11-19.md already exists");
      expect(readFileSync(reportFile(), "utf8")).toBe(first);
    });

    it("--force overwrites the existing report", async () => {
      seedExistingReport();

      const code = await runReport([sample(), "--force"], io());

      expect(code).toBe(0);
      expect(readFileSync(reportFile(), "utf8")).toBe(out);
      expect(out).toContain("## Needs your answer");
      expect(err).toContain("Replaced reports/2026-11-19.md");
    });

    it("--force writes normally when there is no report yet", async () => {
      expect(await runReport(["--force", sample()], io())).toBe(0);
      expect(readFileSync(reportFile(), "utf8")).toBe(out);
      expect(err).toContain("Wrote reports/2026-11-19.md");
    });

    it("--dry-run prints the report and writes nothing when no report exists", async () => {
      const code = await runReport([sample(), "--dry-run"], io());

      expect(code).toBe(0);
      expect(out).toContain("# Morning report: 2026-11-19");
      expect(err).toContain("Dry run: nothing was written. A real run would write reports/2026-11-19.md.");
      expect(existsSync(join(cwd, "reports"))).toBe(false);
    });

    it("--dry-run leaves an existing report unchanged and says a real run would refuse", async () => {
      seedExistingReport();

      expect(await runReport(["--dry-run", sample()], io())).toBe(0);
      expect(out).toContain("# Morning report: 2026-11-19");
      expect(err).toContain("A real run would refuse: reports/2026-11-19.md already exists");
      expect(readFileSync(reportFile(), "utf8")).toBe(existing);
    });

    it("--dry-run wins over --force: nothing is written, and it says a real run would replace", async () => {
      seedExistingReport();

      expect(await runReport([sample(), "--force", "--dry-run"], io())).toBe(0);
      expect(out).toContain("# Morning report: 2026-11-19");
      expect(err).toContain("A real run would replace reports/2026-11-19.md (--force).");
      expect(readFileSync(reportFile(), "utf8")).toBe(existing);
    });

    describe("a dangling symlink at the report path", () => {
      const seedDanglingSymlink = () => {
        mkdirSync(join(cwd, "reports"));
        const target = join(cwd, "missing-dir", "target.md");
        symlinkSync(target, reportFile());
        return target;
      };

      it("--dry-run predicts a refusal, matching what the real run does", async () => {
        const target = seedDanglingSymlink();

        expect(await runReport([sample(), "--dry-run"], io())).toBe(0);
        expect(err).toContain("A real run would refuse: reports/2026-11-19.md already exists");

        err = "";
        out = "";
        expect(await runReport([sample()], io())).toBe(1);
        expect(err).toContain("reports/2026-11-19.md already exists, so it was not overwritten.");
        expect(readlinkSync(reportFile())).toBe(target);
        expect(lstatSync(reportFile()).isSymbolicLink()).toBe(true);
      });

      it("--dry-run with --force predicts a replace", async () => {
        seedDanglingSymlink();

        expect(await runReport([sample(), "--force", "--dry-run"], io())).toBe(0);
        expect(err).toContain("A real run would replace reports/2026-11-19.md (--force).");
      });
    });

    it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
      "--dry-run says the outcome is unknown when the report path cannot be checked",
      async () => {
        // Without search permission on reports/, lstat fails with EACCES, not ENOENT.
        mkdirSync(join(cwd, "reports"));
        chmodSync(join(cwd, "reports"), 0o000);
        try {
          expect(await runReport([sample(), "--dry-run"], io())).toBe(0);
          expect(out).toContain("# Morning report: 2026-11-19");
          expect(err).toContain(
            "Could not check reports/2026-11-19.md (EACCES), so what a real run would do is unknown.",
          );
          expect(err).not.toContain("would write");
        } finally {
          chmodSync(join(cwd, "reports"), 0o755);
        }
      },
    );

    it("--dry-run still rejects an invalid record with exit 1", async () => {
      const record = loadRawFixture("sample-escalated.json");
      delete record.questionForHuman;
      const recordPath = join(cwd, "bad.json");
      writeFileSync(recordPath, JSON.stringify(record));

      expect(await runReport([recordPath, "--dry-run"], io())).toBe(1);
      expect(out).toBe("");
      expect(err).toContain('- questionForHuman: is required when outcome is "escalated"');
    });
  });

  describe("--help", () => {
    it.each([["--help"], ["-h"]])("%s prints usage, every option, and an example, exits 0", async (flag) => {
      expect(await runReport([flag], io())).toBe(0);
      expect(out).toContain("Usage: npm run report --");
      expect(out).toMatch(/--force\s+\S/);
      expect(out).toMatch(/--dry-run\s+\S/);
      expect(out).toMatch(/--help, -h\s+\S/);
      expect(out).toContain("Example:");
      expect(err).toBe("");
    });

    it("-h prints exactly what --help prints", async () => {
      await runReport(["--help"], io());
      const long = out;
      out = "";
      await runReport(["-h"], io());
      expect(out).toBe(long);
    });

    it("works without a record path and writes nothing", async () => {
      expect(await runReport(["--help"], io())).toBe(0);
      expect(existsSync(join(cwd, "reports"))).toBe(false);
    });

    it("writes nothing even when given a record path", async () => {
      expect(await runReport([fixturePath("sample-escalated.json"), "--help"], io())).toBe(0);
      expect(out).toContain("Example:");
      expect(existsSync(join(cwd, "reports"))).toBe(false);
    });
  });

  describe("unknown or malformed options", () => {
    it.each([["--frce"], ["-f"], ["--overwrite"]])(
      "rejects the unknown option %s with exit 1 and writes nothing",
      async (flag) => {
        const code = await runReport([fixturePath("sample-escalated.json"), flag], io());

        expect(code).toBe(1);
        expect(err).toContain(`Unknown option: ${flag}. Known options: --force, --dry-run, --help, --from-github, --since, --until.`);
        expect(err).toContain("Usage: npm run report --");
        expect(out).toBe("");
        expect(existsSync(join(cwd, "reports"))).toBe(false);
      },
    );

    it("rejects a value on a boolean option", async () => {
      expect(await runReport([fixturePath("sample-escalated.json"), "--force=yes"], io())).toBe(1);
      expect(err).toContain("Option --force does not take a value.");
      expect(existsSync(join(cwd, "reports"))).toBe(false);
    });

    it("rejects more than one record path", async () => {
      const path = fixturePath("sample-escalated.json");
      expect(await runReport([path, path], io())).toBe(1);
      expect(err).toContain("Usage: npm run report --");
      expect(existsSync(join(cwd, "reports"))).toBe(false);
    });
  });
});

describe("report CLI entry point", () => {
  const CHILD_TIMEOUT_MS = 15_000;
  const TEST_TIMEOUT_MS = 30_000;

  // One process: node loads tsx's loader itself with --import, so this works on
  // Linux, macOS and Windows without a shell. tsx's own CLI forks a second Node
  // process that survives a SIGKILL of the first (Qodo on PR #46), so a stalled run
  // would leave an orphan behind. The loader is passed as an absolute file URL: the
  // child runs in a temporary directory, where the bare "tsx" does not resolve.
  const require = createRequire(import.meta.url);
  const tsxLoader = pathToFileURL(require.resolve("tsx")).href;

  it("prints usage on -h when run as a real command, and writes nothing", () => {
    const script = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const cwd = mkdtempSync(join(tmpdir(), "polson-cli-entry-"));
    try {
      const result = spawnSync(process.execPath, ["--import", tsxLoader, script, "-h"], {
        cwd,
        encoding: "utf8",
        input: "",
        timeout: CHILD_TIMEOUT_MS,
        killSignal: "SIGKILL",
      });
      const detail = `stdout: ${JSON.stringify(result.stdout)}\nstderr: ${JSON.stringify(result.stderr)}`;

      expect(
        result.error,
        `child process failed (timeout is ${CHILD_TIMEOUT_MS} ms): ${String(result.error)}\n${detail}`,
      ).toBeUndefined();
      expect(result.status, `unexpected exit status\n${detail}`).toBe(0);
      expect(result.stdout).toMatch(/^Usage: npm run report --/);
      expect(result.stderr).toBe("");
      expect(existsSync(join(cwd, "reports"))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);
});

// Gap 4, phase 1: --from-github builds the night's digest from recorded gh/qodo
// responses (fixtures/github/2026-11-24.json) instead of a record file.
describe("report CLI --from-github", () => {
  let cwd: string;
  let out: string;
  let err: string;
  const DAY = loadRecording("2026-11-24.json");
  const NOW = new Date("2026-11-25T08:00:00Z");
  const io = (exec = replay(DAY)) => ({
    cwd,
    out: (text: string) => void (out += text),
    err: (text: string) => void (err += text),
    exec,
    now: () => NOW,
  });
  const WINDOW = ["--from-github", "--since", "2026-11-24T00:00:00Z", "--until", "2026-11-24T15:20:00Z"];

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "polson-cli-github-"));
    out = "";
    err = "";
  });

  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it("prints the digest and writes it to reports/<Lagos date of --until>.md", async () => {
    expect(await runReport(WINDOW, io())).toBe(0);

    expect(out).toContain("# Morning report: 2026-11-24");
    expect(out).toContain("Generated 2026-11-25T08:00:00.000Z for agent runs from 2026-11-24T00:00:00.000Z to 2026-11-24T15:20:00.000Z.");
    expect(out).toContain("## Ready to merge");
    expect(readFileSync(join(cwd, "reports", "2026-11-24.md"), "utf8")).toBe(out);
    expect(err).toContain("Wrote reports/2026-11-24.md");
  });

  it("--dry-run prints the digest and writes nothing", async () => {
    expect(await runReport([...WINDOW, "--dry-run"], io())).toBe(0);

    expect(out).toContain("## Ready to merge");
    expect(err).toContain("Dry run: nothing was written. A real run would write reports/2026-11-24.md.");
    expect(existsSync(join(cwd, "reports"))).toBe(false);
  });

  it("never replaces an existing report without --force", async () => {
    expect(await runReport(WINDOW, io())).toBe(0);
    const first = readFileSync(join(cwd, "reports", "2026-11-24.md"), "utf8");
    out = "";
    err = "";

    expect(await runReport(WINDOW, io())).toBe(1);
    expect(err).toContain("reports/2026-11-24.md already exists, so it was not overwritten.");
    expect(readFileSync(join(cwd, "reports", "2026-11-24.md"), "utf8")).toBe(first);
    expect(await runReport([...WINDOW, "--force"], io())).toBe(0);
  });

  it("defaults the window to the 24 hours before now", async () => {
    const calls: string[] = [];
    const exec = replay({ ...DAY }, calls);
    // The recording covers 24 Nov only, so ask for a window inside it.
    const code = await runReport(["--from-github", "--until", "2026-11-24T23:59:59Z", "--dry-run"], {
      ...io(exec),
      now: () => new Date("2026-11-24T23:59:59Z"),
    });

    expect(err).toContain("outside the recording");
    expect(code).toBe(1);
    expect(calls.find((call) => call.includes("/actions/workflows/polson-agent.yml/runs?created="))).toContain(
      "created=2026-11-23T23:59:59Z..2026-11-24T23:59:59Z",
    );
  });

  it("evidence it cannot read: exit 1, nothing written", async () => {
    const failing = async () => {
      throw new Error("gh api failed: HTTP 502");
    };
    expect(await runReport(WINDOW, io(failing))).toBe(1);

    expect(err).toContain("Could not read the evidence from GitHub: gh api failed: HTTP 502");
    expect(err).toContain("No report was written.");
    expect(out).toBe("");
    expect(existsSync(join(cwd, "reports"))).toBe(false);
  });

  it.each([
    [["--from-github", "--since", "yesterday"], "--since must be an ISO timestamp with a time zone"],
    [["--from-github", "--until", "2026-11-24T10:00:00"], "--until must be an ISO timestamp with a time zone"],
    [["--from-github", "--since", "2026-11-24T10:00:00Z", "--until", "2026-11-24T09:00:00Z"], "--since must be before --until."],
    [["--from-github", "--since"], "Option --since needs a value"],
    [["--since", "2026-11-24T00:00:00Z"], "--since and --until need --from-github."],
    [["--from-github", "record.json"], "--from-github takes no record path."],
  ])("rejects %j", async (args, message) => {
    const calls: string[] = [];
    expect(await runReport(args, io(replay(DAY, calls)))).toBe(1);

    expect(err).toContain(message);
    expect(calls).toEqual([]);
    expect(existsSync(join(cwd, "reports"))).toBe(false);
  });
});
