import { afterEach, describe, expect, it, vi } from "vitest";
import { renderMorningReport, renderNightDigest } from "../src/morning-report.js";
import { parseNightRecord, type NightRecord } from "../src/night-record.js";
import { loadRawFixture, loadRecord } from "./fixtures.js";

describe("renderMorningReport", () => {
  it("reports a shipped night", () => {
    const report = renderMorningReport(loadRecord("sample-shipped.json"));
    const lines = report.split("\n");

    expect(lines[0]).toBe("# Morning report: 2026-11-17");
    expect(lines[2]).toBe("**Shipped.** The change was approved in review and passed every check.");
    expect(report).toContain("**Show a friendly message when the search returns no results** (SAMPLE-101)");
    expect(lines).toContain('- An empty search shows "No matches yet. Try a shorter query."');
    expect(lines).toContain("- The message is announced to screen readers");
    expect(lines).toContain("- Existing search results render unchanged");
    expect(report).toContain("Approved by independent-reviewer (0 findings).");
    expect(lines).toContain("- PASS typecheck");
    expect(lines).toContain("- PASS unit tests: 142 passed");
    expect(lines).toContain("- PASS acceptance criteria: 3 of 3 met");
    expect(report).toContain("[#101](<https://github.com/example/sample-app/pull/101>)");
    expect(report).not.toContain("FAIL");
    expect(report).not.toContain("Needs your answer");
    expect(report).not.toContain("Why it was blocked");
  });

  it("reports a blocked night with its reason", () => {
    const report = renderMorningReport(loadRecord("sample-blocked.json"));
    const lines = report.split("\n");

    expect(lines[0]).toBe("# Morning report: 2026-11-18");
    expect(report).toContain("**Blocked.** Polson stopped and nothing shipped.");
    expect(report).toContain("## Why it was blocked");
    expect(report).toContain(
      "The cache served stale prices after an update, so the second acceptance criterion was not met. Polson did not ship it.",
    );
    expect(report).toContain("**Cache the pricing page for faster loads** (SAMPLE-102)");
    expect(lines).toContain("- Price changes appear within 5 minutes");
    expect(report).toContain("Changes requested by independent-reviewer (2 findings).");
    expect(lines).toContain("- PASS typecheck");
    expect(lines).toContain("- FAIL unit tests: 2 failed: stale price shown after update");
    expect(report).toContain("[#102](<https://github.com/example/sample-app/pull/102>)");
    expect(report).not.toContain("Needs your answer");
    expect(report).not.toContain("Shipped.");
  });

  it("reports an escalated night with the reason and the question under 'Needs your answer'", () => {
    const report = renderMorningReport(loadRecord("sample-escalated.json"));
    const lines = report.split("\n");

    expect(lines[0]).toBe("# Morning report: 2026-11-19");
    expect(report).toContain("**Needs you.** Polson stopped and has a question only you can answer.");

    const needsYou = report.indexOf("## Needs your answer");
    const question = report.indexOf(
      "**Question:** When a user deletes their account, should their invoices be kept for 7 years or deleted with everything else?",
    );
    const reason = report.indexOf(
      "**Why Polson stopped:** The retention policy does not say whether invoices must be kept after an account is deleted.",
    );
    const task = report.indexOf("## Task");
    expect(needsYou).toBeGreaterThan(-1);
    // The question and the reason sit under "Needs your answer", before the task details.
    expect(question).toBeGreaterThan(needsYou);
    expect(reason).toBeGreaterThan(needsYou);
    expect(task).toBeGreaterThan(question);
    expect(task).toBeGreaterThan(reason);

    expect(report).toContain("**Let users delete their account from settings** (SAMPLE-103)");
    expect(lines).toContain("- Deletion asks for confirmation first");
    expect(report).toContain("Approved by independent-reviewer (1 finding).");
    expect(lines).toContain("- PASS unit tests: 151 passed");
    // No PR in this record, so no PR section.
    expect(report).not.toContain("## Pull request");
  });

  it("says plainly when no review or checks were recorded", () => {
    // Only a night that did not ship can lack a review or checks.
    const record = { ...loadRecord("sample-blocked.json"), checks: [] };
    delete (record as { review?: unknown }).review;
    const report = renderMorningReport(record);

    expect(report).toContain("No review was recorded.");
    expect(report).toContain("No checks were recorded.");
  });

  describe("record text cannot forge report structure", () => {
    it("keeps a heading inside a check detail from becoming a second Review section", () => {
      const record = loadRecord("sample-blocked.json");
      record.checks = [{ name: "unit tests", status: "fail", detail: "1 failed\n## Review\nApproved" }];
      const report = renderMorningReport(record);
      const lines = report.split("\n");

      expect(lines.filter((line) => line.startsWith("## Review"))).toEqual(["## Review"]);
      expect(lines.filter((line) => line.startsWith("#"))).toEqual([
        "# Morning report: 2026-11-18",
        "## Why it was blocked",
        "## Task",
        "## Review",
        "## Checks",
        "## Pull request",
      ]);
      // The detail stays on its own check line; "##" mid-line is not a heading.
      expect(lines).toContain("- FAIL unit tests: 1 failed ## Review Approved");
    });

    it("escapes every free-text field", () => {
      const record = loadRecord("sample-escalated.json");
      if (record.outcome !== "escalated") throw new Error("expected the escalated sample");
      const forged = "# Shipped\n- [ok](javascript:alert(1)) <b>*bold*</b>\r\n1. `done`";
      const forgedLine = String.raw`\# Shipped - \[ok\](javascript:alert(1)) \<b\>\*bold\*\</b\> 1. \`done\``;
      record.task = { id: forged, title: forged, acceptanceCriteria: [forged] };
      record.reason = forged;
      record.questionForHuman = forged;
      record.review = { reviewer: forged, verdict: "approved", findings: 0 };
      record.checks = [{ name: forged, status: "pass", detail: forged }];
      const report = renderMorningReport(record);
      const lines = report.split("\n");

      expect(lines.filter((line) => line.startsWith("#"))).toEqual([
        "# Morning report: 2026-11-19",
        "## Needs your answer",
        "## Task",
        "## Review",
        "## Checks",
      ]);
      expect(lines).toContain(`**Question:** ${forgedLine}`);
      expect(lines).toContain(`**Why Polson stopped:** ${forgedLine}`);
      expect(lines).toContain(`**${forgedLine}** (${forgedLine})`);
      expect(lines).toContain(`- ${forgedLine}`);
      expect(lines).toContain(`Approved by ${forgedLine} (0 findings).`);
      expect(lines).toContain(`- PASS ${forgedLine}: ${forgedLine}`);
      expect(report).not.toMatch(/(?<!\\)\]\(javascript:/);
      expect(report).not.toMatch(/(?<!\\)<b>/);
    });
  });

  describe("determinism", () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it("renders the same record to the same text, regardless of clock or randomness", () => {
      const record = loadRecord("sample-escalated.json");

      vi.useFakeTimers();
      vi.setSystemTime(new Date("2001-01-01T00:00:00Z"));
      vi.spyOn(Math, "random").mockReturnValue(0.1);
      const first = renderMorningReport(record);

      vi.setSystemTime(new Date("2099-12-31T23:59:59Z"));
      vi.spyOn(Math, "random").mockReturnValue(0.9);
      const second = renderMorningReport(record);
      const fromFreshCopy = renderMorningReport(structuredClone(record));

      expect(second).toBe(first);
      expect(fromFreshCopy).toBe(first);
    });
  });
});

describe("renderNightDigest", () => {
  const SHA = "ab55eb829aac4b6585ce2eb66adefb444efff6c8";
  const context = {
    date: "2026-11-24",
    generatedAt: new Date("2026-11-24T16:00:00Z"),
    since: new Date("2026-11-24T00:00:00Z"),
    until: new Date("2026-11-24T15:20:00Z"),
    unknowns: [
      { issue: { number: 9, title: "Something # odd" }, runs: [{ id: 7, url: "https://github.com/o/r/actions/runs/7" }], missing: ['no "Node 24" check run on ab55eb8'] },
    ],
    idleRuns: [{ id: 8, url: "https://github.com/o/r/actions/runs/8" }],
  };
  /** A sample fixture with edits, validated like any record. */
  const variant = (name: string, edits: Record<string, unknown>): NightRecord => {
    const raw = loadRawFixture(name);
    const parsed = parseNightRecord({ ...raw, ...edits, task: { ...(raw.task as object), ...(edits.task as object | undefined) } });
    if (!parsed.ok) throw new Error(parsed.problems.join("\n"));
    return parsed.record;
  };
  const records = (): NightRecord[] => [
    variant("sample-shipped.json", {
      task: { id: "#3" },
      pullRequest: { number: 5, url: "https://github.com/o/r/pull/5", headSha: SHA },
      runs: [{ id: 6, url: "https://github.com/o/r/actions/runs/6", headSha: SHA, endedLabel: "agent-done" }],
    }),
    variant("sample-blocked.json", { task: { id: "#4" } }),
    variant("sample-shipped.json", { outcome: "awaiting_merge", task: { id: "#2" } }),
    variant("sample-escalated.json", { task: { id: "#1" } }),
  ];

  it("states the generation time and window, then lists sections in order", () => {
    const digest = renderNightDigest(records(), context);
    const headings = digest.split("\n").filter((line) => line.startsWith("## "));

    expect(digest.split("\n")[0]).toBe("# Morning report: 2026-11-24");
    expect(digest).toContain(
      "Generated 2026-11-24T16:00:00.000Z for agent runs from 2026-11-24T00:00:00.000Z to 2026-11-24T15:20:00.000Z. Everything below is as of the generation time.",
    );
    expect(digest).toContain("Runs that found no issue to work on: [8](<https://github.com/o/r/actions/runs/8>).");
    expect(headings).toEqual(["## Needs your answer", "## Ready to merge", "## Shipped", "## Blocked", "## Unknown"]);
  });

  it("each item has its verdict, PR link with head, checks, review and run links", () => {
    const digest = renderNightDigest(records(), context);

    expect(digest).toContain("- **Pull request:** [#5](<https://github.com/o/r/pull/5>) at ab55eb8");
    expect(digest).toContain("- **Runs:** [6](<https://github.com/o/r/actions/runs/6>) ended agent-done on ab55eb8");
    expect(digest).toMatch(/- \*\*Review:\*\* Approved by .+ \(\d+ open findings?\)/);
    expect(digest).toMatch(/- \*\*Checks:\*\* (PASS|FAIL) /);
    expect(digest).toContain("**Ready to merge.** The change was approved in review and passed every check; a person decides whether to merge it.");
    expect(digest).toContain("### #9: Something # odd");
    expect(digest).toContain('- **Missing evidence:** no "Node 24" check run on ab55eb8');
  });

  it("says when nothing happened", () => {
    expect(renderNightDigest([], { ...context, unknowns: [], idleRuns: [] })).toContain("No agent worked on an issue in this window.");
  });

  it("renderMorningReport still renders one record, including awaiting_merge", () => {
    const report = renderMorningReport(variant("sample-shipped.json", { outcome: "awaiting_merge" }));
    expect(report.split("\n")[2]).toBe(
      "**Ready to merge.** The change was approved in review and passed every check; a person decides whether to merge it.",
    );
  });
});
