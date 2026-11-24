// Tests the morning report from real GitHub runs (gap 4, phase 1) on recorded
// responses: fixtures/github/2026-11-24.json holds what gh and qodo returned for
// 24 Nov 2026 (issue #51 / PR #52, runs 45364906717, 45411976680, 45422221223;
// issue #44 / PR #46; one idle scheduled run), trimmed to the fields used.
import { describe, expect, it } from "vitest";
import { acceptanceCriteria, buildNightReport, lagosDate, linkRuns } from "../src/build-night-records.js";
import { collectEvidence } from "../src/github-evidence.js";
import { renderMorningReport, renderNightDigest } from "../src/morning-report.js";
import { loadRecording, replay, withResponse, type Recording } from "./support/replay-github.js";

const DAY = loadRecording("2026-11-24.json");
const SINCE = "2026-11-24T00:00:00Z";
const URL_52 = "https://github.com/shrooms08/polson/pull/52";
const RUN = (id: number) => `https://github.com/shrooms08/polson/actions/runs/${id}`;
const D81 = "d81b10af7d8bbd2ddf586482a645f1ee54c6052e";
const AB5 = "ab55eb829aac4b6585ce2eb66adefb444efff6c8";
const H115 = "115ddcec028652c99fc47394a00991ed8481e8a4";
const CRITERIA_51 = [
  "Find why the test takes ~5 s (measure it; report the timing breakdown in the PR).",
  "Prefer removing the slow part (e.g. avoidable real I/O or process spawn) while keeping every assertion.",
  "If the work is inherently slow, set an explicit per-test timeout with a comment giving the measured duration and the reason. Do not change the global timeout.",
  "No assertion removed, loosened, or skipped (AGENTS.md: never weaken a test).",
  "npm test passes on Node 24 and Node 20.19.0.",
];
const TITLE_51 = 'Flaky test: qodo-cli "installs the pinned CLI version into QODO_HOME" exceeds 5 s timeout';
const PASS = [
  { name: "Node 24", status: "pass" },
  { name: "Node 20.19.0", status: "pass" },
];
const RUN_1 = { id: 45364906717, url: RUN(45364906717), headSha: D81, endedLabel: "needs-human" };
const RUN_2 = { id: 45411976680, url: RUN(45411976680), headSha: D81, endedLabel: "needs-human" };
const RUN_3 = { id: 45422221223, url: RUN(45422221223), headSha: AB5, endedLabel: "agent-done" };

async function night(recording: Recording, until: string, since = SINCE) {
  const window = { since: new Date(since), until: new Date(until) };
  const evidence = await collectEvidence(replay(recording), { ...window, linkRuns: linkRuns(window.since, window.until) });
  return buildNightReport(evidence, window);
}
const record51 = (n: Awaited<ReturnType<typeof night>>) => n.records.find((r) => r.task.id === "#51");

/** Edit one gh response that prints one JSON value per line. */
const editLines = (recording: Recording, matches: (args: string[]) => boolean, edit: (values: Record<string, unknown>[]) => Record<string, unknown>[]) =>
  withResponse(
    recording,
    (file, args) => file === "gh" && matches(args),
    (stdout) =>
      edit(stdout.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Record<string, unknown>))
        .map((v) => `${JSON.stringify(v)}\n`)
        .join(""),
  );
const checkRunsOf = (sha: string) => (args: string[]) => args[1] === `repos/shrooms08/polson/commits/${sha}/check-runs?per_page=100`;
const isEvents = (args: string[]) => (args[1] ?? "").startsWith("repos/shrooms08/polson/issues/events");
const editQodo52 = (recording: Recording, edit: (record: Record<string, any>) => Record<string, any>) =>
  withResponse(
    recording,
    (file, args) => file === "qodo" && args.includes(URL_52),
    (stdout) => `${JSON.stringify(edit(JSON.parse(stdout)))}\n`,
  );

describe("night records from real runs (24 Nov 2026)", () => {
  it("the whole day: #51 shipped on 115ddce with its 3 runs, #44 shipped, the scheduled run idle", async () => {
    const n = await night(DAY, "2026-11-24T23:59:59Z");

    expect(n.date).toBe("2026-11-25"); // 23:59:59Z is 00:59 on the 25th in Lagos (decision 4).
    expect(n.unknowns).toEqual([]);
    expect(n.idleRuns).toEqual([{ id: 45379842277, url: RUN(45379842277) }]);
    expect(record51(n)).toEqual({
      date: "2026-11-25",
      task: { id: "#51", title: TITLE_51, acceptanceCriteria: CRITERIA_51 },
      outcome: "shipped",
      pullRequest: { number: 52, url: URL_52, headSha: H115 },
      review: { reviewer: "Qodo", verdict: "approved", findings: 0 },
      checks: PASS,
      runs: [RUN_1, RUN_2, RUN_3],
    });
    expect(n.records.find((r) => r.task.id === "#44")).toEqual({
      date: "2026-11-25",
      task: { id: "#44", title: "Harden the CLI usage test from PR #40", acceptanceCriteria: ["Not stated in the issue"] },
      outcome: "shipped",
      pullRequest: { number: 46, url: "https://github.com/shrooms08/polson/pull/46", headSha: "8a59478e0468a3d24c5bc8b7762bf1a4fa1b45ba" },
      review: { reviewer: "Qodo", verdict: "approved", findings: 0 },
      checks: PASS,
      runs: [{ id: 45344632822, url: RUN(45344632822), headSha: "8894d11a2b72877fb24608f89163e3bc448d7056", endedLabel: "needs-human" }],
    });
    expect(n.records).toHaveLength(2);
  });

  it("until 15:20, before the merge: #51 awaiting_merge on ab55eb8", async () => {
    const n = await night(DAY, "2026-11-24T15:20:00Z");

    expect(n.date).toBe("2026-11-24");
    expect(record51(n)).toEqual({
      date: "2026-11-24",
      task: { id: "#51", title: TITLE_51, acceptanceCriteria: CRITERIA_51 },
      outcome: "awaiting_merge",
      pullRequest: { number: 52, url: URL_52, headSha: AB5 },
      review: { reviewer: "Qodo", verdict: "approved", findings: 0 },
      checks: PASS,
      runs: [RUN_1, RUN_2, RUN_3],
    });
  });

  it("until 14:20, after the second escalation: #51 escalated, reason and question from that run's round report", async () => {
    const n = await night(DAY, "2026-11-24T14:20:00Z");

    expect(record51(n)).toEqual({
      date: "2026-11-24",
      task: { id: "#51", title: TITLE_51, acceptanceCriteria: CRITERIA_51 },
      outcome: "escalated",
      reason:
        "**Escalating.** I reproduced finding 2 and found it wrong, but could not push a fix for finding 1: the sandbox blocks `rm`, `git clean` and reading the push script, so I could not delete my untracked scratch file `test/zz-tmp.test.ts`. I cannot tell whether `push-branch.sh` would commit it, and it …",
      questionForHuman:
        "delete `test/zz-tmp.test.ts` on the runner, or allow `rm`, then rerun the round so the comment can be reworded. No acceptance boxes ticked.",
      pullRequest: { number: 52, url: URL_52, headSha: D81 },
      checks: PASS,
      // No review: Qodo now marks a d81b10a finding "implemented", but ab55eb8
      // (a later commit) closed it, so the record does not show d81b10a was clean.
      runs: [RUN_1, RUN_2],
    });
  });

  it("an escalation's reason and question are bounded single lines", async () => {
    const r = record51(await night(DAY, "2026-11-24T14:20:00Z"));
    if (r?.outcome !== "escalated") throw new Error("expected escalated");
    expect(r.reason.length).toBeLessThanOrEqual(300);
    expect(r.reason).not.toMatch(/\n/);
    expect(r.questionForHuman).not.toMatch(/\n/);
  });
});

describe("fails closed: Unknown, never shipped (rule 6)", () => {
  const notShipped = (n: Awaited<ReturnType<typeof night>>) =>
    expect(n.records.filter((r) => r.task.id === "#51" && (r.outcome === "shipped" || r.outcome === "awaiting_merge"))).toEqual([]);
  const unknown51 = (n: Awaited<ReturnType<typeof night>>) => n.unknowns.find((u) => u.issue?.number === 51);

  it("a missing check run on the merged head", async () => {
    const recording = editLines(DAY, checkRunsOf(H115), (runs) => runs.filter((r) => r.name !== "Node 24"));
    const n = await night(recording, "2026-11-24T23:59:59Z");

    notShipped(n);
    expect(unknown51(n)?.missing).toEqual(['no "Node 24" check run on 115ddce']);
  });

  it("a check run that has not finished", async () => {
    const recording = editLines(DAY, checkRunsOf(H115), (runs) =>
      runs.map((r) => (r.name === "Node 20.19.0" ? { ...r, status: "in_progress", conclusion: null } : r)),
    );
    const n = await night(recording, "2026-11-24T23:59:59Z");

    notShipped(n);
    expect(unknown51(n)?.missing).toEqual(['"Node 20.19.0" on 115ddce has not finished (in_progress)']);
  });

  it("a failed check on the merged head", async () => {
    const recording = editLines(DAY, checkRunsOf(H115), (runs) =>
      runs.map((r) => (r.name === "Node 24" ? { ...r, conclusion: "failure" } : r)),
    );
    const n = await night(recording, "2026-11-24T23:59:59Z");

    notShipped(n);
    expect(unknown51(n)?.missing).toEqual(['PR #52 was merged, but on 115ddce: "Node 24" failed']);
  });

  it("Qodo's record cannot be read", async () => {
    const recording = { ...DAY, responses: DAY.responses.filter((r) => !(r.file === "qodo" && r.args.includes(URL_52))) };
    const n = await night(recording, "2026-11-24T23:59:59Z");

    notShipped(n);
    expect(unknown51(n)?.missing).toEqual(["Qodo's record for PR #52 could not be read"]);
  });

  it("Qodo's record is truncated", async () => {
    const n = await night(editQodo52(DAY, (r) => ({ ...r, qar_operation_result_truncated: true })), "2026-11-24T23:59:59Z");

    notShipped(n);
    expect(unknown51(n)?.missing).toEqual(["Qodo's record for PR #52 is truncated"]);
  });

  it("Qodo has no review run on the merged head", async () => {
    const recording = editQodo52(DAY, (r) => ({ ...r, review_runs: r.review_runs.filter((x: any) => x.commit_sha !== H115) }));
    const n = await night(recording, "2026-11-24T23:59:59Z");

    notShipped(n);
    expect(unknown51(n)?.missing).toEqual(["Qodo's record has no review run on 115ddce"]);
  });

  it("a skipped Qodo review, proven by the record: escalated, never shipped (decision 3)", async () => {
    const recording = editQodo52(DAY, (r) => ({
      ...r,
      review_runs: r.review_runs.map((x: any) => (x.commit_sha === H115 ? { ...x, review_effort: "skip", review_complete: false } : x)),
    }));
    const r = record51(await night(recording, "2026-11-24T23:59:59Z"));

    expect(r?.outcome).toBe("escalated");
    expect(r).toMatchObject({
      reason: "Qodo review skipped or incomplete: Qodo's review of 115ddce was skipped.",
      pullRequest: { headSha: H115 },
    });
    expect(r && "review" in r ? r.review : undefined).toBeUndefined();
  });

  it("an open Medium finding on the merged head", async () => {
    const recording = editQodo52(DAY, (r) => ({
      ...r,
      findings: r.findings.map((f: any) => (f.attribution_status === "dismissed" ? { ...f, attribution_status: "pending" } : f)),
    }));
    const n = await night(recording, "2026-11-24T23:59:59Z");

    notShipped(n);
    expect(unknown51(n)?.missing).toEqual(["PR #52 was merged, but on 115ddce: Qodo has open High or Medium findings"]);
  });

  it("a Qodo finding with an unknown status or severity", async () => {
    for (const edit of [{ attribution_status: "reopened" }, { action_level: "critical" }]) {
      const recording = editQodo52(DAY, (r) => ({ ...r, findings: r.findings.map((f: any, i: number) => (i === 0 ? { ...f, ...edit } : f)) }));
      const n = await night(recording, "2026-11-24T23:59:59Z");

      notShipped(n);
      expect(unknown51(n)?.missing[0]).toMatch(/a Qodo finding has an unknown (status|severity)/);
    }
  });

  it("merged by a bot", async () => {
    const recording = withResponse(
      DAY,
      (file, args) => file === "gh" && args[0] === "pr" && args[1] === "list",
      (stdout) =>
        `${JSON.stringify((JSON.parse(stdout) as any[]).map((pr) => (pr.number === 52 ? { ...pr, mergedBy: { login: "some-bot", is_bot: true } } : pr)))}\n`,
    );
    const n = await night(recording, "2026-11-24T23:59:59Z");

    notShipped(n);
    expect(unknown51(n)?.missing).toEqual(["PR #52 was not merged by a person"]);
  });

  it("a run that has not finished by --until", async () => {
    const n = await night(DAY, "2026-11-24T15:12:00Z");

    notShipped(n);
    expect(unknown51(n)?.missing).toEqual(["run 45422221223 had not finished by 2026-11-24T15:12:00.000Z"]);
  });

  it("an unlinkable run: no agent-working label during it, and no jobs evidence", async () => {
    const recording = editLines(DAY, isEvents, (events) =>
      events.filter((e) => !(e.label === "agent-working" && e.event === "labeled" && e.created_at === "2026-11-24T15:09:48Z")),
    );
    const n = await night(recording, "2026-11-24T23:59:59Z");

    expect(n.unknowns).toContainEqual({
      runs: [{ id: 45422221223, url: RUN(45422221223) }],
      missing: ["run 45422221223: no agent-working label was added during the run, and its jobs do not show it found nothing to do"],
    });
    expect(n.idleRuns.map((r) => r.id)).not.toContain(45422221223);
    // #51 still shipped by the merge; the unlinked run is not listed as its run.
    expect(record51(n)?.runs?.map((r) => r.id)).toEqual([45364906717, 45411976680]);
  });

  it("an ambiguous run: agent-working on two issues during it", async () => {
    const recording = editLines(DAY, isEvents, (events) => [
      ...events,
      { id: 1, event: "labeled", created_at: "2026-11-24T15:10:00Z", actor: "github-actions[bot]", label: "agent-working", issue: 999, is_pr: false },
    ]);
    const n = await night(recording, "2026-11-24T23:59:59Z");

    expect(n.unknowns).toContainEqual({
      runs: [{ id: 45422221223, url: RUN(45422221223) }],
      missing: ["run 45422221223: agent-working was added to more than one issue during the run (#51, #999)"],
    });
  });

  it("a scheduled run is idle only if its jobs show it found nothing to do", async () => {
    const recording = withResponse(
      DAY,
      (file, args) => file === "gh" && (args[1] ?? "").includes("/actions/runs/45379842277/jobs"),
      (stdout) => stdout.replace('{"conclusion":"skipped","name":"Mark the issue agent-working"}', '{"conclusion":"success","name":"Mark the issue agent-working"}'),
    );
    const n = await night(recording, "2026-11-24T23:59:59Z");

    expect(n.idleRuns).toEqual([]);
    expect(n.unknowns.map((u) => u.runs[0]?.id)).toContain(45379842277);
  });
});

describe("untrusted text stays plain text (rule 3)", () => {
  const INJECT = '# Owned <img src=x onerror=alert(1)> [click](javascript:alert(1)) <script>alert(2)</script> | *x* `y`';
  // A round report's heading lines are skipped, so the reason line starts with another block marker.
  const INJECT_LINE = '> quoted <img src=x onerror=alert(1)> [click](javascript:alert(1)) <script>alert(2)</script>';

  it("in the issue title, the acceptance criteria and the round report", async () => {
    let recording = withResponse(
      DAY,
      (file, args) => file === "gh" && args[0] === "issue" && args[2] === "51",
      (stdout) => {
        const issue = JSON.parse(stdout);
        issue.title = INJECT;
        issue.body = `## Acceptance criteria\n- ${INJECT}\n- ## second\n`;
        issue.comments = issue.comments.map((c: any) =>
          c.body.startsWith("## Round 1 report (second attempt)")
            ? { ...c, body: `## Round 1 report (second attempt)\n\n${INJECT_LINE}\nNeeded from a person: ${INJECT}\n` }
            : c,
        );
        return `${JSON.stringify(issue)}\n`;
      },
    );
    const n = await night(recording, "2026-11-24T14:20:00Z");
    const digest = renderNightDigest(n.records, {
      date: n.date,
      generatedAt: new Date("2026-11-25T08:00:00Z"),
      since: new Date(SINCE),
      until: new Date("2026-11-24T14:20:00Z"),
      unknowns: n.unknowns,
      idleRuns: n.idleRuns,
    });
    const single = renderMorningReport(record51(n)!);

    for (const report of [digest, single]) {
      // Unescaped only: plainText leaves "\<img" and "\](", which render as text.
      expect(report).not.toMatch(/(^|[^\\])<(img|script)/m);
      expect(report).not.toMatch(/(^|[^\\])\]\(javascript:/m);
      expect(report).not.toMatch(/^# Owned/m);
      expect(report).not.toMatch(/^#+ second/m);
    }
    expect(digest).toContain("### \\#51: \\# Owned \\<img src=x onerror=alert(1)\\> \\[click\\](javascript:alert(1))");
    expect(digest).toContain("- **Question:** \\# Owned \\<img");
    expect(digest).toContain("- **Why Polson stopped:** \\> quoted \\<img src=x onerror=alert(1)\\>");
    expect(single).toContain("- \\# Owned \\<img src=x onerror=alert(1)\\>");
    expect(single).toContain("- \\## second");
  });

  it("a round report whose only text is headings gives no reason: Unknown, not a guessed one", async () => {
    const recording = withResponse(
      DAY,
      (file, args) => file === "gh" && args[0] === "issue" && args[2] === "51",
      (stdout) => {
        const issue = JSON.parse(stdout);
        issue.comments = issue.comments.map((c: any) =>
          c.body.startsWith("## Round 1 report (second attempt)") ? { ...c, body: "## Round 1 report (second attempt)\n\n# Escalating\n" } : c,
        );
        return `${JSON.stringify(issue)}\n`;
      },
    );
    const n = await night(recording, "2026-11-24T14:20:00Z");

    expect(record51(n)).toBeUndefined();
    expect(n.unknowns.find((u) => u.issue?.number === 51)?.missing).toEqual([
      "the latest round report or hand-over comment states no reason",
    ]);
  });
});

describe("helpers", () => {
  it("acceptance criteria: bullets under the heading only, checkboxes stripped, else not stated", () => {
    expect(acceptanceCriteria("Intro\n## Acceptance criteria\n- [ ] one\n* two\n\n- [x] three\n## Notes\n- not this")).toEqual([
      "one",
      "two",
      "three",
    ]);
    expect(acceptanceCriteria("Acceptance criteria:\n- not under a heading")).toEqual(["Not stated in the issue"]);
    expect(acceptanceCriteria("## Acceptance criteria\n\nNo bullets here.")).toEqual(["Not stated in the issue"]);
  });

  it("the report date is the Africa/Lagos date of --until", () => {
    expect(lagosDate(new Date("2026-11-24T22:59:59Z"))).toBe("2026-11-24");
    expect(lagosDate(new Date("2026-11-24T23:00:00Z"))).toBe("2026-11-25");
  });

  it("reads only: every command is a gh read or qodo read", async () => {
    const calls: string[] = [];
    const window = { since: new Date(SINCE), until: new Date("2026-11-24T23:59:59Z") };
    await collectEvidence(replay(DAY, calls), { ...window, linkRuns: linkRuns(window.since, window.until) });

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toMatch(/^(gh (api repos\/\S+ |repo view |issue view |pr list |pr view )|qodo read pr-review-session findings )/);
      expect(call).not.toMatch(/ -X | --method | -f | -F | --field | --raw-field | --input /);
    }
  });
});
