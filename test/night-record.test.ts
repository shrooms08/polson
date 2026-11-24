import { describe, expect, it } from "vitest";
import { parseNightRecord } from "../src/night-record.js";
import { loadRawFixture } from "./fixtures.js";

function problemsFor(input: unknown): string[] {
  const result = parseNightRecord(input);
  if (result.ok) throw new Error("expected the record to be rejected, but it was accepted");
  return result.problems;
}

describe("NightRecord schema", () => {
  it.each(["sample-shipped.json", "sample-blocked.json", "sample-escalated.json"])(
    "accepts the sample %s",
    (name) => {
      expect(parseNightRecord(loadRawFixture(name)).ok).toBe(true);
    },
  );

  it("rejects a blocked record with no reason", () => {
    const { reason: _omit, ...record } = loadRawFixture("sample-blocked.json");
    expect(problemsFor(record)).toContain('reason: is required when outcome is "blocked"');
  });

  it("rejects an escalated record with no reason", () => {
    const { reason: _omit, ...record } = loadRawFixture("sample-escalated.json");
    expect(problemsFor(record)).toContain('reason: is required when outcome is "escalated"');
  });

  it("rejects an escalated record with no questionForHuman", () => {
    const { questionForHuman: _omit, ...record } = loadRawFixture("sample-escalated.json");
    expect(problemsFor(record)).toContain(
      'questionForHuman: is required when outcome is "escalated"',
    );
  });

  it("rejects a blank reason", () => {
    const record = { ...loadRawFixture("sample-blocked.json"), reason: "   " };
    expect(problemsFor(record)).toContain("reason: must not be empty");
  });

  it("rejects a shipped record with a failing check", () => {
    const record = loadRawFixture("sample-shipped.json");
    record.checks = [
      { name: "typecheck", status: "pass" },
      { name: "unit tests", status: "fail", detail: "1 failed" },
    ];
    expect(problemsFor(record)).toEqual([
      'checks.1.status: outcome cannot be "shipped" while check "unit tests" failed',
    ]);
  });

  it("rejects a shipped record whose review requested changes", () => {
    const record = loadRawFixture("sample-shipped.json");
    record.review = { reviewer: "independent-reviewer", verdict: "changes_requested", findings: 3 };
    expect(problemsFor(record)).toEqual([
      'review.verdict: outcome cannot be "shipped" while the reviewer requested changes',
    ]);
  });

  it("rejects a shipped record with no review", () => {
    const { review: _omit, ...record } = loadRawFixture("sample-shipped.json");
    expect(problemsFor(record)).toEqual([
      'review: is required when outcome is "shipped" (an approved review)',
    ]);
  });

  it("rejects a shipped record with empty checks, listing each missing piece", () => {
    const { review: _omit, ...record } = loadRawFixture("sample-shipped.json");
    record.checks = [];
    expect(problemsFor(record)).toEqual([
      'review: is required when outcome is "shipped" (an approved review)',
      'checks: must include at least one check when outcome is "shipped"',
    ]);
  });

  it("rejects a shipped record that omits both review and checks, reporting both", () => {
    const { review: _review, checks: _checks, ...record } = loadRawFixture("sample-shipped.json");
    expect(record).not.toHaveProperty("review");
    expect(record).not.toHaveProperty("checks");
    expect(problemsFor(record)).toEqual([
      'review: is required when outcome is "shipped" (an approved review)',
      'checks: must include at least one check when outcome is "shipped"',
    ]);
  });

  it("still reports a failing check on a shipped record that has no review", () => {
    const { review: _omit, ...record } = loadRawFixture("sample-shipped.json");
    record.checks = [{ name: "unit tests", status: "fail" }];
    expect(problemsFor(record)).toEqual([
      'review: is required when outcome is "shipped" (an approved review)',
      'checks.0.status: outcome cannot be "shipped" while check "unit tests" failed',
    ]);
  });

  it("still reports changes_requested on a shipped record that has no checks", () => {
    const { checks: _omit, ...record } = loadRawFixture("sample-shipped.json");
    record.review = { reviewer: "independent-reviewer", verdict: "changes_requested", findings: 1 };
    expect(problemsFor(record)).toEqual([
      'checks: must include at least one check when outcome is "shipped"',
      'review.verdict: outcome cannot be "shipped" while the reviewer requested changes',
    ]);
  });

  it("rejects a shipped record with an approved review but zero checks", () => {
    const record = loadRawFixture("sample-shipped.json");
    record.checks = [];
    expect(problemsFor(record)).toEqual([
      'checks: must include at least one check when outcome is "shipped"',
    ]);
  });

  it("rejects a shipped record that has every problem at once", () => {
    const record = loadRawFixture("sample-shipped.json");
    record.review = { reviewer: "independent-reviewer", verdict: "changes_requested", findings: 1 };
    record.checks = [
      { name: "typecheck", status: "fail" },
      { name: "unit tests", status: "fail" },
    ];
    expect(problemsFor(record)).toEqual([
      'checks.0.status: outcome cannot be "shipped" while check "typecheck" failed',
      'checks.1.status: outcome cannot be "shipped" while check "unit tests" failed',
      'review.verdict: outcome cannot be "shipped" while the reviewer requested changes',
    ]);
  });

  it.each([
    ["javascript:", "javascript:alert(document.cookie)"],
    ["data:", "data:text/html,<script>alert(1)</script>"],
    ["ftp:", "ftp://example.com/pull/1"],
    ["file:", "file:///etc/passwd"],
  ])("rejects a pull request URL with a %s scheme", (_label, url) => {
    const record = { ...loadRawFixture("sample-shipped.json"), pullRequest: { number: 1, url } };
    expect(problemsFor(record)).toEqual(["pullRequest.url: must be a valid http or https URL"]);
  });

  it("accepts http and https pull request URLs, stored in normalized form", () => {
    for (const url of ["http://example.com/pull/1", "HTTPS://Example.com/pull/1"]) {
      const result = parseNightRecord({
        ...loadRawFixture("sample-shipped.json"),
        pullRequest: { number: 1, url },
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.record.pullRequest?.url).toBe(url.replace("HTTPS://Example", "https://example"));
    }
  });

  it("stores a pull request URL with no raw line breaks or angle brackets", () => {
    const result = parseNightRecord({
      ...loadRawFixture("sample-shipped.json"),
      pullRequest: { number: 1, url: "https://example.com/pull/1\n## Review <b>" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.record.pullRequest?.url).not.toMatch(/[\s<>]/);
  });

  it("allows a failing check and changes_requested when the outcome is not shipped", () => {
    // The blocked sample has both; stopping is exactly what should happen.
    expect(parseNightRecord(loadRawFixture("sample-blocked.json")).ok).toBe(true);
  });

  it("rejects empty acceptance criteria", () => {
    const record = loadRawFixture("sample-shipped.json");
    record.task = { id: "SAMPLE-1", title: "A task", acceptanceCriteria: [] };
    expect(problemsFor(record)).toContain(
      "task.acceptanceCriteria: must list at least one criterion",
    );
  });

  it.each([
    ["wrong format", "11/19/2026"],
    ["missing zero padding", "2026-1-9"],
    ["impossible day", "2026-02-30"],
    ["impossible month", "2026-13-01"],
    ["trailing text", "2026-11-19T00:00:00Z"],
    ["trailing line feed", "2026-11-19\n"],
    ["trailing carriage return", "2026-11-19\r"],
    ["trailing CRLF", "2026-11-19\r\n"],
    ["leading line feed", "\n2026-11-19"],
    ["surrounding spaces", " 2026-11-19 "],
    ["impossible leap day", "2026-02-29"],
    ["day zero", "2026-11-00"],
  ])("rejects a bad date (%s: %j)", (_label, date) => {
    const record = { ...loadRawFixture("sample-shipped.json"), date };
    expect(problemsFor(record)).toContain(
      "date: must be a real calendar date in YYYY-MM-DD format",
    );
  });

  it("rejects a missing date", () => {
    const { date: _omit, ...record } = loadRawFixture("sample-shipped.json");
    expect(problemsFor(record)).toContain("date: is required (YYYY-MM-DD)");
  });

  it("rejects an unknown outcome", () => {
    const record = { ...loadRawFixture("sample-shipped.json"), outcome: "done" };
    expect(problemsFor(record)).toContain(
      'outcome: must be "shipped", "awaiting_merge", "blocked", or "escalated"',
    );
  });

  it("lists every problem, not just the first", () => {
    const record = loadRawFixture("sample-escalated.json");
    delete record.reason;
    delete record.questionForHuman;
    record.date = "yesterday";
    const problems = problemsFor(record);
    expect(problems).toEqual(
      expect.arrayContaining([
        'reason: is required when outcome is "escalated"',
        'questionForHuman: is required when outcome is "escalated"',
        "date: must be a real calendar date in YYYY-MM-DD format",
      ]),
    );
  });
});

// Gap 4: awaiting_merge claims verification like shipped, so it gets the same
// rules (AGENTS.md rule 1), and runs[] is checked like the rest of the record.
describe("NightRecord schema: awaiting_merge and runs", () => {
  const SHA = "ab55eb829aac4b6585ce2eb66adefb444efff6c8";
  const awaiting = (): Record<string, unknown> => ({
    ...loadRawFixture("sample-shipped.json"),
    outcome: "awaiting_merge",
    pullRequest: { number: 52, url: "https://github.com/shrooms08/polson/pull/52", headSha: SHA },
    runs: [{ id: 45422221223, url: "https://github.com/shrooms08/polson/actions/runs/45422221223", headSha: SHA, endedLabel: "agent-done" }],
  });

  it("accepts a verified awaiting_merge record with runs", () => {
    expect(parseNightRecord(awaiting()).ok).toBe(true);
  });

  it("rejects awaiting_merge with no review and no checks", () => {
    const record: Record<string, unknown> = { ...awaiting(), checks: [] };
    delete record.review;
    expect(problemsFor(record)).toEqual([
      'review: is required when outcome is "awaiting_merge" (an approved review)',
      'checks: must include at least one check when outcome is "awaiting_merge"',
    ]);
  });

  it("rejects awaiting_merge with a failed check or a review that requested changes", () => {
    const record = awaiting();
    const checks = (record.checks as { name: string; status: string }[]).map((check, i) => (i === 0 ? { ...check, status: "fail" } : check));
    const review = { ...(record.review as object), verdict: "changes_requested" };
    const problems = problemsFor({ ...record, checks, review });

    expect(problems).toContain(`checks.0.status: outcome cannot be "awaiting_merge" while check "${checks[0]!.name}" failed`);
    expect(problems).toContain('review.verdict: outcome cannot be "awaiting_merge" while the reviewer requested changes');
  });

  it("rejects a run with a bad URL, SHA or label, and a short pull request SHA", () => {
    const record = awaiting();
    const problems = problemsFor({
      ...record,
      pullRequest: { ...(record.pullRequest as object), headSha: "ab55eb8" },
      runs: [{ id: 1, url: "javascript:alert(1)", headSha: "nope", endedLabel: "agent-working" }],
    });

    expect(problems).toEqual([
      "pullRequest.headSha: must be a full 40-character commit SHA",
      "runs.0.url: must be a valid http or https URL",
      "runs.0.headSha: must be a full 40-character commit SHA",
      'runs.0.endedLabel: must be "agent-done" or "needs-human"',
    ]);
  });
});
