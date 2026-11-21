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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runReport } from "../src/cli.js";
import { fixturePath, loadRawFixture } from "./fixtures.js";

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
        expect(err).toContain(`Unknown option: ${flag}. Known options: --force, --dry-run, --help.`);
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
