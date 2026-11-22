// Tests find_pr in .github/polson/phase.sh with a stand-in `gh` (and `timeout`)
// first on PATH. The real bash and jq run the script, as they do in the workflow.
// Issue: https://github.com/shrooms08/polson/issues/18
//
// The tests run `phase.sh find-pr <issue>`, the resume-check command that calls
// find_pr, instead of calling find_pr directly: phase.sh dispatches on its first
// argument as soon as it runs and has no source-only mode, so its functions
// cannot be loaded on their own. find_pr's return codes show up as: 0 ->
// next=build or next=wait, 3 and 4 -> an escalation (comment, then needs-human),
// 1 -> the command exits 1.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const PHASE = resolve(import.meta.dirname, "../.github/polson/phase.sh");

// Answers `gh pr list` from $STUB_PR_LIST (a file) with exit code $STUB_PR_LIST_EXIT,
// logs every call to $STUB_LOG, and accepts the escalation's comment and label edit.
// Anything else fails, so the real gh is never needed.
const STUB_GH = `#!/usr/bin/env bash
echo "gh $*" >> "$STUB_LOG"
case "$1 $2" in
  "pr list") cat "$STUB_PR_LIST"; exit "\${STUB_PR_LIST_EXIT:-0}" ;;
  "issue comment"|"issue edit") exit 0 ;;
esac
echo "stand-in gh: unexpected call: $*" >&2
exit 99
`;

// phase.sh wraps gh in `timeout 60`; this drops the limit so the test needs no coreutils.
const STUB_TIMEOUT = `#!/usr/bin/env bash
shift
exec "$@"
`;

type Pr = { number: number; headRefName: string; isCrossRepository: boolean; author: { login: string } };
const pr = (number: number, headRefName: string, login: string, isCrossRepository = false): Pr => ({
  number,
  headRefName,
  isCrossRepository,
  author: { login },
});

/**
 * True only if bash runs and finds jq on PATH. Without jq, find_pr returns 1 for
 * every input, so the failure-case tests would pass for the wrong reason.
 */
function bashAndJqAvailable(): boolean {
  const check = spawnSync("bash", ["-c", "command -v jq"], { encoding: "utf8" });
  return check.error === undefined && check.status === 0;
}

describe("find_pr (phase.sh find-pr)", () => {
  let dir: string;

  // Fail every test, not skip it: a missing tool must not look like a passing run.
  // (A throwing beforeAll makes vitest report the tests as skipped.)
  const toolsAvailable = bashAndJqAvailable();

  beforeEach(() => {
    if (!toolsAvailable) throw new Error("find_pr tests need bash and jq on PATH");
    dir = mkdtempSync(join(tmpdir(), "polson-find-pr-"));
    for (const [name, body] of [
      ["gh", STUB_GH],
      ["timeout", STUB_TIMEOUT],
    ] as const) {
      writeFileSync(join(dir, name), body);
      chmodSync(join(dir, name), 0o755);
    }
  });

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Runs `phase.sh find-pr 9` with `gh pr list` printing `listOutput`. `extraBin`
   * adds more stand-in commands (name -> script) ahead of everything else on PATH.
   */
  function findPr(listOutput: string, listExit = 0, extraBin: Record<string, string> = {}) {
    const extra = join(dir, "extra-bin");
    mkdirSync(extra, { recursive: true });
    for (const [name, body] of Object.entries(extraBin)) {
      writeFileSync(join(extra, name), body);
      chmodSync(join(extra, name), 0o755);
    }
    const list = join(dir, "pr-list.json");
    const log = join(dir, "gh.log");
    const outputs = join(dir, "github-output");
    writeFileSync(list, listOutput);
    writeFileSync(log, "");
    writeFileSync(outputs, "");
    const result = spawnSync("bash", [PHASE, "find-pr", "9"], {
      encoding: "utf8",
      env: {
        PATH: `${extra}:${dir}:${process.env.PATH ?? ""}`,
        GH_REPO: "owner/repo",
        GITHUB_OUTPUT: outputs,
        RUN_URL: "https://example.invalid/run",
        STUB_LOG: log,
        STUB_PR_LIST: list,
        STUB_PR_LIST_EXIT: String(listExit),
      },
    });
    const ghCalls = readFileSync(log, "utf8").split("\n").filter(Boolean);
    return {
      status: result.status,
      stderr: result.stderr,
      outputs: readFileSync(outputs, "utf8"),
      escalated: ghCalls.some((call) => call.startsWith("gh issue comment 9")),
      relabelled: ghCalls.some((call) =>
        call.startsWith("gh issue edit 9 --remove-label agent-working --add-label needs-human"),
      ),
    };
  }

  it("0 PRs: builds, ignoring other issues' branches and forks", () => {
    const run = findPr(JSON.stringify([pr(20, "19-other-ticket", "app/claude"), pr(21, "9-from-a-fork", "someone", true)]));

    expect(run.status).toBe(0);
    expect(run.outputs).toBe("next=build\n");
    expect(run.escalated).toBe(false);
  });

  it("1 agent PR: resumes it", () => {
    const run = findPr(JSON.stringify([pr(11, "9-add-help-report-cli", "app/claude")]));

    expect(run.status).toBe(0);
    expect(run.outputs).toBe("pr=11\nbranch=9-add-help-report-cli\nnext=wait\n");
    expect(run.escalated).toBe(false);
  });

  it("1 non-agent PR: returns 4, so it escalates instead of running that branch", () => {
    const run = findPr(JSON.stringify([pr(15, "9-human-try", "someone")]));

    expect(run.status).toBe(0);
    expect(run.stderr).toContain("PR #15 comes from a ticket branch for #9 but was opened by someone, not the agent.");
    expect(run.outputs).toBe("next=stop\n");
    expect(run.escalated).toBe(true);
    expect(run.relabelled).toBe(true);
  });

  it("2+ PRs: returns 3, so it escalates", () => {
    const run = findPr(
      JSON.stringify([pr(11, "9-add-help-report-cli", "app/claude"), pr(12, "9-second-try", "app/claude"), pr(13, "9-third", "someone")]),
    );

    expect(run.status).toBe(0);
    expect(run.stderr).toContain("More than one open PR comes from a ticket branch for #9");
    expect(run.outputs).toBe("next=stop\n");
    expect(run.escalated).toBe(true);
    expect(run.relabelled).toBe(true);
  });

  // Qodo on PR #20: if reading the PR lines out of jq's output fails while the
  // count still reads fine, the step must not decide there is no PR and build a
  // duplicate.
  describe("a lost PR line never becomes \"no PR\"", () => {
    const AGENT_PR = JSON.stringify([pr(11, "9-add-help-report-cli", "app/claude")]);
    const realPath = (command: string) =>
      spawnSync("bash", ["-c", `command -v ${command}`], { encoding: "utf8" }).stdout.trim();

    it("returns 1 when the PR lines are lost after the count", () => {
      // jq still counts 1 PR, but only the count line reaches find_pr.
      const jq = `#!/usr/bin/env bash
out=$("${realPath("jq")}" "$@") || exit $?
printf '%s\\n' "\${out%%$'\\n'*}"
`;
      const run = findPr(AGENT_PR, 0, { jq });

      expect(run.status).toBe(1);
      expect(run.stderr).not.toContain("building");
      expect(run.outputs).toBe("");
      expect(run.escalated).toBe(false);
    });

    it("does not build when cat fails to read stdin", () => {
      // The failure Qodo described: \`cat\` with no arguments fails. (With file
      // arguments, as the stand-in gh uses it, it still works.)
      const cat = `#!/usr/bin/env bash
if [ $# -eq 0 ]; then echo "cat: read error" >&2; exit 1; fi
exec "${realPath("cat")}" "$@"
`;
      const run = findPr(AGENT_PR, 0, { cat });

      expect(run.stderr).not.toContain("building");
      expect(run.outputs).not.toContain("next=build");
    });
  });

  describe("a failed count returns 1: the step fails, nothing is guessed or escalated", () => {
    it.each([
      ["gh prints nothing", ""],
      ["gh prints something that is not JSON", "Bad gateway"],
      ["gh prints JSON that is not a list of PRs", "null"],
    ])("%s", (_case, listOutput) => {
      const run = findPr(listOutput);

      expect(run.status).toBe(1);
      expect(run.outputs).toBe("");
      expect(run.escalated).toBe(false);
    });

    it("gh pr list fails", () => {
      const run = findPr("[]", 1);

      expect(run.status).toBe(1);
      expect(run.outputs).toBe("");
      expect(run.escalated).toBe(false);
    });
  });
});
