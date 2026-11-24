import {
  AGENT_LOGIN,
  agentPrCandidates,
  WORKFLOW_ACTOR,
  type CheckRunJson,
  type EventJson,
  type Evidence,
  type IssueJson,
  type PrJson,
  type QodoEvidence,
  type RunJson,
} from "./github-evidence.js";
import type { UnknownItem } from "./morning-report.js";
import { parseNightRecord, type NightRecord } from "./night-record.js";

/**
 * Turns the evidence from github-evidence.ts into night records: one per issue
 * an agent run touched in the window, each validated by `parseNightRecord`.
 *
 * Pure: no clock, no I/O. State is "as of" the evidence (generation time);
 * `until` only bounds which runs, label events, comments and merges count.
 *
 * Fail closed (AGENTS.md rule 6): anything the evidence does not show becomes
 * an UnknownItem naming what is missing, never a guessed outcome. Claims in
 * agent-written text are never used as evidence: checks come only from check
 * runs, the review only from Qodo's record. Agent text is used only for an
 * escalation's reason and question, and the renderer treats it as plain text.
 */

/** The required CI checks (ci.yml), from GitHub Actions (app id 15368). */
export const REQUIRED_CHECKS = ["Node 24", "Node 20.19.0"] as const;
export const GITHUB_ACTIONS_APP_ID = 15368;
const OUTCOME_LABELS = ["agent-done", "needs-human"] as const;
type EndedLabel = (typeof OUTCOME_LABELS)[number];

// Qodo's CLI documents these as the open and closed attribution statuses.
const OPEN_STATUSES = new Set(["pending", "partial_implementation", "not_implemented", "focus_areas_edited"]);
const CLOSED_STATUSES = new Set(["implemented", "full_implementation", "dismissed", "detected_after_merge", "outdated"]);
// Closed by a commit. Qodo's record keeps only the current status, not which
// commit closed the finding, so for a head with later commits these do not show
// that the head itself was clean. "dismissed" is a person's decision and holds
// for every commit.
const CLOSED_BY_A_COMMIT = new Set(["implemented", "full_implementation", "detected_after_merge", "outdated"]);
const SEVERITY: Record<string, "High" | "Medium" | "Low"> = {
  action_required: "High",
  remediation_recommended: "Medium",
  informational: "Low",
};

const AGENT_COMMENT_AUTHORS = new Set(["claude", "claude[bot]"]);
const WORKFLOW_COMMENT_AUTHORS = new Set(["github-actions", "github-actions[bot]"]);
const ROUND_REPORT = /^(#{1,6}\s*)?Round \d+ report\b/i;
const HAND_OVER = /^Polson's agent stopped\b/;
const TEXT_LIMIT = 300;
const SHA = /^[0-9a-f]{40}$/;

const time = (iso: string) => Date.parse(iso);
const short = (sha: string) => sha.slice(0, 7);

export interface NightReport {
  date: string;
  records: NightRecord[];
  unknowns: UnknownItem[];
  idleRuns: { id: number; url: string }[];
}

/** The calendar date in Africa/Lagos, as YYYY-MM-DD. */
export function lagosDate(when: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(when);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Runs that count: in the window, and not skipped (a skipped run is the job's `if` filtering a label event). */
function windowRuns(runs: RunJson[], since: Date, until: Date): RunJson[] {
  return runs
    .filter((run) => run.conclusion !== "skipped")
    .filter((run) => time(run.created_at) >= since.getTime() && time(run.created_at) <= until.getTime())
    .sort((a, b) => time(a.created_at) - time(b.created_at) || a.id - b.id);
}

/** The part of a run that counts: from its start to its end, or to `until` if that is earlier. */
function runSpan(run: RunJson, until: Date): { start: number; end: number } {
  return { start: time(run.run_started_at), end: Math.min(time(run.updated_at), until.getTime()) };
}

type Link = { run: RunJson; issue: number } | { run: RunJson; unlinked: true } | { run: RunJson; problem: string };

/**
 * Links each run to the issue the workflow marked agent-working during it.
 * Exactly one issue links it; none leaves it unlinked (idle or unknown); more
 * than one is unknown. Never guessed from titles or times alone.
 */
function links(runs: RunJson[], events: EventJson[], until: Date): Link[] {
  return runs.map((run) => {
    const { start, end } = runSpan(run, until);
    const issues = new Set(
      events
        .filter(
          (e) =>
            e.event === "labeled" &&
            e.label === "agent-working" &&
            e.actor === WORKFLOW_ACTOR &&
            !e.is_pr &&
            e.issue !== null &&
            time(e.created_at) >= start &&
            time(e.created_at) <= end,
        )
        .map((e) => e.issue as number),
    );
    if (issues.size === 1) return { run, issue: [...issues][0]! };
    if (issues.size === 0) return { run, unlinked: true };
    return { run, problem: `agent-working was added to more than one issue during the run (${[...issues].map((n) => `#${n}`).join(", ")})` };
  });
}

/** For github-evidence.ts: which issues to fetch, and which runs need their jobs read. */
export function linkRuns(since: Date, until: Date) {
  return (runs: RunJson[], events: EventJson[]) => {
    const all = links(windowRuns(runs, since, until), events, until);
    return {
      issues: [...new Set(all.flatMap((link) => ("issue" in link ? [link.issue] : [])))].sort((a, b) => a - b),
      unlinkedRuns: all.flatMap((link) => ("unlinked" in link ? [link.run.id] : [])),
    };
  };
}

/** The bullets under "## Acceptance criteria" in the issue body. */
export function acceptanceCriteria(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+Acceptance criteria\s*$/i.test(line.trim()));
  const criteria: string[] = [];
  if (start !== -1) {
    for (const line of lines.slice(start + 1)) {
      if (/^#{1,6}\s/.test(line.trim())) break;
      const bullet = /^\s*[-*]\s+(?:\[[ xX]\]\s+)?(.+)$/.exec(line);
      if (bullet && bullet[1]!.trim() !== "") criteria.push(bullet[1]!.trim());
    }
  }
  return criteria.length > 0 ? criteria : ["Not stated in the issue"];
}

function bounded(text: string): string {
  return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT - 1)}…` : text;
}

/**
 * The reason and question for an escalation, from the latest round report by
 * the agent or hand-over comment by the workflow during the run. Only single
 * lines, bounded, and the renderer escapes them: they are untrusted text.
 */
function escalationText(issue: IssueJson, start: number, end: number): { reason: string; question: string } | { problem: string } {
  const comment = issue.comments
    .filter((c) => time(c.createdAt) >= start && time(c.createdAt) <= end)
    .filter((c) => {
      const first = c.body.split(/\r?\n/).find((line) => line.trim() !== "")?.trim() ?? "";
      return (
        (AGENT_COMMENT_AUTHORS.has(c.author ?? "") && ROUND_REPORT.test(first)) ||
        (WORKFLOW_COMMENT_AUTHORS.has(c.author ?? "") && HAND_OVER.test(first))
      );
    })
    .sort((a, b) => time(a.createdAt) - time(b.createdAt))
    .at(-1);
  if (!comment) return { problem: "no round report or hand-over comment on the issue during the run" };

  const lines = comment.body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const neededLine = lines.find((line) => /^[*_\s]*Needed from a person[*_]*:/i.test(line));
  const reasonLine = lines.find(
    (line) =>
      !/^#{1,6}\s/.test(line) &&
      !ROUND_REPORT.test(line) &&
      !HAND_OVER.test(line) &&
      !/^(PR|Run):\s/i.test(line) &&
      line !== neededLine,
  );
  if (!reasonLine) return { problem: "the latest round report or hand-over comment states no reason" };
  const question = neededLine
    ? neededLine.replace(/^[*_\s]*Needed from a person[*_]*:[*_]*\s*/i, "").trim()
    : `Read the latest report on #${issue.number} and decide what Polson should do next.`;
  return { reason: bounded(reasonLine), question: bounded(question || `Read the latest report on #${issue.number}.`) };
}

/** When CI started on a commit: the earliest GitHub Actions check run. GitHub sets it, unlike commit dates. */
function ciStart(checkRuns: CheckRunJson[] | undefined): number | undefined {
  const starts = (checkRuns ?? [])
    .filter((run) => run.app_id === GITHUB_ACTIONS_APP_ID && run.started_at !== null)
    .map((run) => time(run.started_at as string));
  return starts.length > 0 ? Math.min(...starts) : undefined;
}

/** The PR's head commit at `when`: the last commit, in PR order, whose CI had started by then. */
function headAt(shas: string[], checkRuns: Evidence["checkRuns"], when: number, pr: number): { sha: string } | { problem: string } {
  const starts = shas.map((sha) => ciStart(checkRuns[sha]));
  let index = -1;
  starts.forEach((start, i) => {
    if (start !== undefined && start <= when) index = i;
  });
  if (index === -1) return { problem: `no commit of PR #${pr} had started CI by ${new Date(when).toISOString()}` };
  const later = shas.slice(index + 1).find((sha, i) => starts[index + 1 + i] === undefined);
  if (later) return { problem: `commit ${short(later)} on PR #${pr} has no CI check runs, so its head at ${new Date(when).toISOString()} is unknown` };
  return { sha: shas[index]! };
}

type Check = { name: string; status: "pass" | "fail"; detail?: string };

function checksFor(sha: string, checkRuns: Evidence["checkRuns"]): { checks: Check[]; problems: string[] } {
  const checks: Check[] = [];
  const problems: string[] = [];
  for (const name of REQUIRED_CHECKS) {
    const latest = (checkRuns[sha] ?? [])
      .filter((run) => run.app_id === GITHUB_ACTIONS_APP_ID && run.name === name)
      .sort((a, b) => a.id - b.id)
      .at(-1);
    if (!latest) problems.push(`no "${name}" check run on ${short(sha)}`);
    else if (latest.status !== "completed") problems.push(`"${name}" on ${short(sha)} has not finished (${latest.status})`);
    else if (latest.conclusion === "success") checks.push({ name, status: "pass" });
    else checks.push({ name, status: "fail", detail: latest.conclusion ?? "no conclusion" });
  }
  return { checks, problems };
}

type Review = { reviewer: string; verdict: "approved" | "changes_requested"; findings: number };

/**
 * Qodo's review of `sha`, from its own record: complete, skipped or incomplete,
 * or unknown. `laterCommits` says whether the PR has commits after `sha` at the
 * point that counts; if it does, a finding closed by a commit may have been
 * closed by one of them, so that finding leaves the review unknown.
 */
function reviewFor(
  sha: string,
  shas: string[],
  qodo: QodoEvidence | undefined,
  pr: number,
  laterCommits: boolean,
): { review: Review } | { skipped: string } | { problems: string[] } {
  if (!qodo) return { problems: [`no Qodo record was read for PR #${pr}`] };
  if ("error" in qodo) return { problems: [`Qodo's record for PR #${pr} could not be read`] };
  const { record } = qodo;
  if (record.qar_operation_result_truncated === true) return { problems: [`Qodo's record for PR #${pr} is truncated`] };
  const runs = record.review_runs.filter((run) => run.commit_sha === sha);
  if (runs.length === 0) return { problems: [`Qodo's record has no review run on ${short(sha)}`] };
  if (runs.length > 1 && runs.some((run) => run.run_id === null)) {
    return { problems: [`Qodo's record has several review runs on ${short(sha)} without run ids`] };
  }
  const run = [...runs].sort((a, b) => (a.run_id ?? 0) - (b.run_id ?? 0)).at(-1)!;
  if (run.status !== "completed") return { problems: [`Qodo's review of ${short(sha)} has not finished (${run.status})`] };
  if (run.review_effort === null) return { problems: [`Qodo's review of ${short(sha)} has no review effort`] };
  if (run.review_effort === "skip" || run.review_complete !== true) {
    return { skipped: `Qodo's review of ${short(sha)} was ${run.review_effort === "skip" ? "skipped" : "incomplete"}` };
  }

  // Findings raised on this commit or an earlier one in the PR apply to it.
  const upTo = new Set(shas.slice(0, shas.indexOf(sha) + 1));
  const problems: string[] = [];
  let open = 0;
  let openHighMedium = 0;
  for (const finding of record.findings) {
    if (finding.git_sha === null || !shas.includes(finding.git_sha)) {
      problems.push(`a Qodo finding is on a commit that is not in PR #${pr}`);
      continue;
    }
    if (!upTo.has(finding.git_sha)) continue;
    const severity = SEVERITY[finding.action_level ?? ""];
    const status = finding.attribution_status ?? "";
    if (!severity) problems.push(`a Qodo finding has an unknown severity (${finding.action_level ?? "none"})`);
    else if (OPEN_STATUSES.has(status)) {
      open += 1;
      if (severity !== "Low") openHighMedium += 1;
    } else if (!CLOSED_STATUSES.has(status)) problems.push(`a Qodo finding has an unknown status (${status || "none"})`);
    else if (laterCommits && CLOSED_BY_A_COMMIT.has(status)) {
      problems.push(
        `a Qodo finding on ${short(finding.git_sha)} is marked ${status}, and Qodo's record cannot show whether ${short(sha)} or a later commit closed it`,
      );
    }
  }
  if (problems.length > 0) return { problems };
  return { review: { reviewer: "Qodo", verdict: openHighMedium === 0 ? "approved" : "changes_requested", findings: open } };
}

function validUrl(url: string, expected: string): boolean {
  return url === expected;
}

type IssueRun = { id: number; url: string; headSha: string; endedLabel: EndedLabel };

function buildIssue(
  issueNumber: number,
  runs: RunJson[],
  evidence: Evidence,
  until: Date,
  date: string,
): { record: NightRecord } | { unknown: UnknownItem } {
  const issue = evidence.issues[issueNumber];
  const runRefs = runs.map((run) => ({ id: run.id, url: run.html_url }));
  const unknown = (title: string, missing: string[]) => ({
    unknown: { issue: { number: issueNumber, title }, runs: runRefs, missing },
  });
  if (!issue) return unknown(`Issue #${issueNumber}`, [`issue #${issueNumber} was not read`]);

  const problems: string[] = [];
  for (const run of runs) {
    if (!validUrl(run.html_url, `https://github.com/${evidence.repo}/actions/runs/${run.id}`)) {
      problems.push(`run ${run.id} has an unexpected URL`);
    }
  }

  // The pull request: phase.sh's rule, as of `until`.
  const candidates = agentPrCandidates(evidence.prs, issueNumber).filter((pr) => time(pr.createdAt) <= until.getTime());
  let pr: PrJson | undefined;
  if (candidates.length > 1) problems.push(`more than one pull request comes from a ticket branch (${candidates.map((p) => `#${p.number}`).join(", ")})`);
  else if (candidates.length === 1) {
    pr = candidates[0]!;
    if (pr.author.login !== AGENT_LOGIN) problems.push(`PR #${pr.number} was not opened by the agent`);
    if (!validUrl(pr.url, `https://github.com/${evidence.repo}/pull/${pr.number}`)) problems.push(`PR #${pr.number} has an unexpected URL`);
  }
  const shas = pr ? evidence.commits[pr.number] : undefined;
  if (pr && !shas) problems.push(`the commits of PR #${pr.number} were not read`);

  // Each run: the label it ended on and the PR head when it ended.
  const issueRuns: IssueRun[] = [];
  for (const run of runs) {
    const { start, end } = runSpan(run, until);
    if (run.status !== "completed" || time(run.updated_at) > until.getTime()) {
      problems.push(`run ${run.id} had not finished by ${until.toISOString()}`);
      continue;
    }
    const ended = evidence.events
      .filter(
        (e) =>
          e.event === "labeled" &&
          e.issue === issueNumber &&
          OUTCOME_LABELS.includes(e.label as EndedLabel) &&
          time(e.created_at) >= start &&
          time(e.created_at) <= end,
      )
      .sort((a, b) => time(a.created_at) - time(b.created_at) || a.id - b.id)
      .at(-1);
    if (!ended) {
      problems.push(`run ${run.id} ended without adding agent-done or needs-human`);
      continue;
    }
    if (!pr || !shas) {
      problems.push(`run ${run.id}: no pull request, so its head commit is unknown`);
      continue;
    }
    const head = headAt(shas, evidence.checkRuns, end, pr.number);
    if ("problem" in head) {
      problems.push(`run ${run.id}: ${head.problem}`);
      continue;
    }
    issueRuns.push({ id: run.id, url: run.html_url, headSha: head.sha, endedLabel: ended.label as EndedLabel });
  }
  if (problems.length > 0) return unknown(issue.title, problems);

  const task = { id: `#${issueNumber}`, title: issue.title, acceptanceCriteria: acceptanceCriteria(issue.body) };
  const latest = issueRuns.at(-1)!;
  const latestRun = runs.at(-1)!;
  const merged = pr && pr.mergedAt !== null && time(pr.mergedAt) <= until.getTime();
  const closedUnmerged = pr && pr.state === "CLOSED" && pr.closedAt !== null && time(pr.closedAt) <= until.getTime();

  let candidate: Record<string, unknown>;
  if (merged || latest.endedLabel === "agent-done") {
    // shipped or awaiting_merge: both need a complete review and passing checks of the head.
    const outcome = merged ? "shipped" : "awaiting_merge";
    if (merged && pr!.mergedBy?.is_bot !== false) return unknown(issue.title, [`PR #${pr!.number} was not merged by a person`]);
    if (!merged && closedUnmerged) return unknown(issue.title, [`PR #${pr!.number} was closed without merging`]);
    let headSha: string;
    if (merged) {
      headSha = pr!.headRefOid;
      if (!SHA.test(headSha) || shas!.at(-1) !== headSha) return unknown(issue.title, [`the merged head of PR #${pr!.number} is not its last commit`]);
    } else {
      const head = headAt(shas!, evidence.checkRuns, until.getTime(), pr!.number);
      if ("problem" in head) return unknown(issue.title, [head.problem]);
      headSha = head.sha;
    }
    const { checks, problems: checkProblems } = checksFor(headSha, evidence.checkRuns);
    // Later commits count only if their CI had started by `until`.
    const after = shas!.slice(shas!.indexOf(headSha) + 1);
    const laterByUntil = after.some((sha) => (ciStart(evidence.checkRuns[sha]) ?? Infinity) <= until.getTime());
    const review = reviewFor(headSha, shas!, evidence.qodo[pr!.number], pr!.number, laterByUntil);
    if ("problems" in review) return unknown(issue.title, [...checkProblems, ...review.problems]);
    if (checkProblems.length > 0) return unknown(issue.title, checkProblems);
    const pullRequest = { number: pr!.number, url: pr!.url, headSha };
    if ("skipped" in review) {
      // Proven by Qodo's own record: not a review, so not shipped or ready (decision 3).
      candidate = {
        date,
        task,
        outcome: "escalated",
        reason: `Qodo review skipped or incomplete: ${review.skipped}.`,
        questionForHuman: `PR #${pr!.number} has no complete Qodo review of ${short(headSha)}. Request one, or decide without it?`,
        pullRequest,
        checks,
        runs: issueRuns,
      };
    } else {
      const failed = checks.filter((check) => check.status === "fail").map((check) => `"${check.name}" failed`);
      if (review.review.verdict === "changes_requested") failed.push("Qodo has open High or Medium findings");
      if (failed.length > 0) {
        return unknown(issue.title, [
          `${merged ? `PR #${pr!.number} was merged` : `the run ended agent-done`}, but on ${short(headSha)}: ${failed.join("; ")}`,
        ]);
      }
      candidate = { date, task, outcome, pullRequest, checks, review: review.review, runs: issueRuns };
    }
  } else {
    // needs-human: the latest run's own round report or hand-over comment.
    const { start, end } = runSpan(latestRun, until);
    const text = escalationText(issue, start, end);
    if ("problem" in text) return unknown(issue.title, [text.problem]);
    candidate = { date, task, outcome: "escalated", reason: text.reason, questionForHuman: text.question, checks: [], runs: issueRuns };
    if (pr && shas) {
      candidate.pullRequest = { number: pr.number, url: pr.url, headSha: latest.headSha };
      const { checks, problems: checkProblems } = checksFor(latest.headSha, evidence.checkRuns);
      if (checkProblems.length === 0) candidate.checks = checks;
      // Optional here: included only when the record shows it for this head,
      // with no later commit (pushed at any time) that could have closed a finding.
      const laterNow = shas.indexOf(latest.headSha) < shas.length - 1;
      const review = reviewFor(latest.headSha, shas, evidence.qodo[pr.number], pr.number, laterNow);
      if ("review" in review) candidate.review = review.review;
    }
  }

  const parsed = parseNightRecord(candidate);
  if (!parsed.ok) return unknown(issue.title, parsed.problems.map((problem) => `the record is not valid: ${problem}`));
  return { record: parsed.record };
}

/** Runs no issue could be linked to: idle (the workflow found nothing to do) only if its jobs show that. */
function isIdle(jobs: Evidence["jobs"][string] | undefined): boolean {
  if (!jobs || "error" in jobs) return false;
  const agent = jobs.find((job) => job.name === "agent");
  const step = (name: string) => agent?.steps.find((s) => s.name === name)?.conclusion;
  return (
    agent?.status === "completed" &&
    agent.conclusion === "success" &&
    step("Resolve the issue number") === "success" &&
    step("Mark the issue agent-working") === "skipped"
  );
}

export function buildNightReport(evidence: Evidence, window: { since: Date; until: Date }): NightReport {
  const { since, until } = window;
  const date = lagosDate(until);
  const records: NightRecord[] = [];
  const unknowns: UnknownItem[] = [];
  const idleRuns: { id: number; url: string }[] = [];

  const byIssue = new Map<number, RunJson[]>();
  const unlinked: { run: RunJson; problem: string }[] = [];
  for (const link of links(windowRuns(evidence.runs, since, until), evidence.events, until)) {
    if ("issue" in link) byIssue.set(link.issue, [...(byIssue.get(link.issue) ?? []), link.run]);
    else if ("problem" in link) unlinked.push({ run: link.run, problem: link.problem });
    else if (isIdle(evidence.jobs[link.run.id])) idleRuns.push({ id: link.run.id, url: link.run.html_url });
    else unlinked.push({ run: link.run, problem: "no agent-working label was added during the run, and its jobs do not show it found nothing to do" });
  }

  for (const [issue, runs] of [...byIssue.entries()].sort((a, b) => a[0] - b[0])) {
    const result = buildIssue(issue, runs, evidence, until, date);
    if ("record" in result) records.push(result.record);
    else unknowns.push(result.unknown);
  }
  for (const { run, problem } of unlinked) {
    const url = `https://github.com/${evidence.repo}/actions/runs/${run.id}`;
    unknowns.push({ runs: [{ id: run.id, url }], missing: [`run ${run.id}: ${problem}`] });
  }
  for (const run of idleRuns) run.url = `https://github.com/${evidence.repo}/actions/runs/${run.id}`;
  return { date, records, unknowns, idleRuns };
}
