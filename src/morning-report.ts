import type { NightRecord, Outcome } from "./night-record.js";
import { plainText } from "./plain-text.js";

/**
 * Render one night's record as a plain-language Markdown report.
 *
 * Pure and deterministic: the output depends only on the record, so the same
 * record always produces the same text. No clocks, no randomness.
 *
 * Every free-text field from the record goes through `plainText`, so record
 * text cannot add headings, list items, links or other Markdown structure.
 */

const VERDICT_LINE: Record<Outcome, string> = {
  shipped: "**Shipped.** The change was approved in review and passed every check.",
  awaiting_merge:
    "**Ready to merge.** The change was approved in review and passed every check; a person decides whether to merge it.",
  blocked: "**Blocked.** Polson stopped and nothing shipped.",
  escalated: "**Needs you.** Polson stopped and has a question only you can answer.",
};

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function renderMorningReport(record: NightRecord): string {
  const lines: string[] = [];
  const section = (heading: string, ...body: string[]) => lines.push(heading, "", ...body, "");

  section(`# Morning report: ${record.date}`, VERDICT_LINE[record.outcome]);

  // What needs the human comes first, before the details of the work.
  if (record.outcome === "escalated") {
    section(
      "## Needs your answer",
      `**Question:** ${plainText(record.questionForHuman)}`,
      "",
      `**Why Polson stopped:** ${plainText(record.reason)}`,
    );
  } else if (record.outcome === "blocked") {
    section("## Why it was blocked", plainText(record.reason));
  }

  section(
    "## Task",
    `**${plainText(record.task.title)}** (${plainText(record.task.id)})`,
    "",
    "Acceptance criteria:",
    ...record.task.acceptanceCriteria.map((criterion) => `- ${plainText(criterion)}`),
  );

  if (record.review) {
    const verdict = record.review.verdict === "approved" ? "Approved" : "Changes requested";
    section(
      "## Review",
      `${verdict} by ${plainText(record.review.reviewer)} (${plural(record.review.findings, "finding")}).`,
    );
  } else {
    section("## Review", "No review was recorded.");
  }

  if (record.checks.length > 0) {
    section(
      "## Checks",
      ...record.checks.map((check) => {
        const detail = check.detail ? `: ${plainText(check.detail)}` : "";
        return `- ${check.status === "pass" ? "PASS" : "FAIL"} ${plainText(check.name)}${detail}`;
      }),
    );
  } else {
    section("## Checks", "No checks were recorded.");
  }

  if (record.pullRequest) {
    section(
      "## Pull request",
      // The schema only admits normalized http(s) URLs; the angle brackets keep
      // characters like ")" from ending the link early.
      `[#${record.pullRequest.number}](<${record.pullRequest.url}>)`,
    );
  }

  return lines.join("\n").trimEnd() + "\n";
}

/** Something the digest could not turn into a record, with the evidence that is missing. */
export interface UnknownItem {
  /** The issue, when the runs could be linked to one. */
  issue?: { number: number; title: string };
  /** The runs involved. Each URL must be an https link (checked by the builder). */
  runs: { id: number; url: string }[];
  /** What is missing or unreadable, in plain words. */
  missing: string[];
}

export interface DigestContext {
  /** The report's date (YYYY-MM-DD, Africa/Lagos). */
  date: string;
  generatedAt: Date;
  since: Date;
  until: Date;
  unknowns: UnknownItem[];
  /** Runs in the window that found no issue to work on. */
  idleRuns: { id: number; url: string }[];
}

const DIGEST_SECTIONS: { outcome: Outcome; heading: string }[] = [
  { outcome: "escalated", heading: "## Needs your answer" },
  { outcome: "awaiting_merge", heading: "## Ready to merge" },
  { outcome: "shipped", heading: "## Shipped" },
  { outcome: "blocked", heading: "## Blocked" },
];

function shortSha(sha: string): string {
  // Only 40-character hex SHAs reach here (the schema and builder check them).
  return sha.slice(0, 7);
}

function runLink(run: { id: number; url: string }): string {
  return `[${run.id}](<${run.url}>)`;
}

function digestItem(record: NightRecord): string[] {
  const lines = [`### ${plainText(record.task.id)}: ${plainText(record.task.title)}`, "", VERDICT_LINE[record.outcome], ""];
  if (record.outcome === "escalated") {
    lines.push(`- **Question:** ${plainText(record.questionForHuman)}`);
    lines.push(`- **Why Polson stopped:** ${plainText(record.reason)}`);
  } else if (record.outcome === "blocked") {
    lines.push(`- **Why it was blocked:** ${plainText(record.reason)}`);
  }
  if (record.pullRequest) {
    const head = record.pullRequest.headSha ? ` at ${shortSha(record.pullRequest.headSha)}` : "";
    lines.push(`- **Pull request:** [#${record.pullRequest.number}](<${record.pullRequest.url}>)${head}`);
  } else {
    lines.push("- **Pull request:** none recorded");
  }
  lines.push(
    record.checks.length > 0
      ? `- **Checks:** ${record.checks
          .map((check) => {
            const detail = check.detail ? ` (${plainText(check.detail)})` : "";
            return `${check.status === "pass" ? "PASS" : "FAIL"} ${plainText(check.name)}${detail}`;
          })
          .join(", ")}`
      : "- **Checks:** none recorded",
  );
  if (record.review) {
    const verdict = record.review.verdict === "approved" ? "Approved" : "Changes requested";
    lines.push(
      `- **Review:** ${verdict} by ${plainText(record.review.reviewer)} (${plural(record.review.findings, "open finding")})`,
    );
  } else {
    lines.push("- **Review:** none recorded");
  }
  if (record.runs && record.runs.length > 0) {
    lines.push(
      `- **Runs:** ${record.runs
        .map((run) => `${runLink(run)} ended ${run.endedLabel} on ${shortSha(run.headSha)}`)
        .join("; ")}`,
    );
  }
  lines.push("");
  return lines;
}

function unknownItem(item: UnknownItem): string[] {
  const heading = item.issue
    ? `### #${item.issue.number}: ${plainText(item.issue.title)}`
    : `### Runs not linked to an issue`;
  const lines = [heading, ""];
  if (item.runs.length > 0) lines.push(`- **Runs:** ${item.runs.map(runLink).join(", ")}`);
  lines.push(...item.missing.map((missing) => `- **Missing evidence:** ${plainText(missing)}`), "");
  return lines;
}

/**
 * Render one night's records as a digest: what needs the human first, then
 * what is ready to merge, what shipped, what was blocked, and what Polson
 * could not tell from the evidence.
 *
 * Pure: the output depends only on its arguments. Every free-text field goes
 * through `plainText`; the structure (headings, lists, links) is the
 * renderer's own.
 */
export function renderNightDigest(records: NightRecord[], context: DigestContext): string {
  const lines: string[] = [
    `# Morning report: ${context.date}`,
    "",
    `Generated ${context.generatedAt.toISOString()} for agent runs from ${context.since.toISOString()} to ${context.until.toISOString()}. Everything below is as of the generation time.`,
    "",
  ];
  if (context.idleRuns.length > 0) {
    lines.push(`Runs that found no issue to work on: ${context.idleRuns.map(runLink).join(", ")}.`, "");
  }

  const ordered = [...records].sort((a, b) => a.task.id.localeCompare(b.task.id, "en", { numeric: true }));
  for (const { outcome, heading } of DIGEST_SECTIONS) {
    const items = ordered.filter((record) => record.outcome === outcome);
    if (items.length === 0) continue;
    lines.push(heading, "");
    for (const record of items) lines.push(...digestItem(record));
  }
  if (context.unknowns.length > 0) {
    lines.push("## Unknown", "", "Polson could not tell what happened from the evidence. Nothing here counts as shipped.", "");
    for (const item of context.unknowns) lines.push(...unknownItem(item));
  }
  if (records.length === 0 && context.unknowns.length === 0) {
    lines.push("No agent worked on an issue in this window.", "");
  }
  return lines.join("\n").trimEnd() + "\n";
}
