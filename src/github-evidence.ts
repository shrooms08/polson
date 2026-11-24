import { execFile } from "node:child_process";
import { z } from "zod";

/**
 * Reads the evidence for a night's morning report from GitHub and Qodo.
 *
 * Read-only: every call is a `gh api` GET, `gh pr list` / `gh pr view` /
 * `gh issue view` / `gh repo view`, or `qodo read`. Nothing here writes to
 * GitHub, Qodo or the disk. Commands go through an injected `Exec`, so tests
 * replay recorded responses.
 *
 * Every response is projected to the fields the report needs (`--jq`), which
 * also keeps names, emails and other personal data out of the evidence, and
 * then validated. Unreadable output throws (AGENTS.md rule 6); the one
 * exception is a Qodo record that cannot be read, which is kept as
 * `{ error }` so the report can name it as missing evidence for that PR.
 */

/** Runs a command and resolves to its stdout. Rejects on a non-zero exit. */
export type Exec = (file: string, args: string[]) => Promise<string>;

/** The real `Exec`: no shell, a time limit, and the caller's environment (gh and qodo sign-in). */
export const realExec: Exec = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120_000 }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr).trim().split("\n").slice(-3).join(" ");
        reject(new Error(`${file} ${args[0] ?? ""} ${args[1] ?? ""} failed: ${detail || error.message}`));
        return;
      }
      resolve(stdout);
    });
  });

const Iso = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "must be a timestamp");

const RunJson = z.object({
  id: z.number().int().positive(),
  html_url: z.string(),
  event: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  created_at: Iso,
  run_started_at: Iso,
  updated_at: Iso,
});
export type RunJson = z.infer<typeof RunJson>;

const EventJson = z.object({
  id: z.number(),
  event: z.string(),
  created_at: Iso,
  actor: z.string().nullable(),
  label: z.string().nullable(),
  issue: z.number().int().positive().nullable(),
  is_pr: z.boolean(),
});
export type EventJson = z.infer<typeof EventJson>;

const JobJson = z.object({
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  steps: z.array(z.object({ name: z.string(), conclusion: z.string().nullable() })),
});
export type JobJson = z.infer<typeof JobJson>;

const IssueJson = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string(),
  comments: z.array(z.object({ author: z.string().nullable(), createdAt: Iso, body: z.string() })),
});
export type IssueJson = z.infer<typeof IssueJson>;

const Account = z.object({ login: z.string(), is_bot: z.boolean() });
const PrJson = z.object({
  number: z.number().int().positive(),
  url: z.string(),
  headRefName: z.string(),
  headRefOid: z.string(),
  baseRefName: z.string(),
  isCrossRepository: z.boolean(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  createdAt: Iso,
  mergedAt: Iso.nullable(),
  closedAt: Iso.nullable(),
  mergedBy: Account.nullable(),
  author: Account,
});
export type PrJson = z.infer<typeof PrJson>;

const CheckRunJson = z.object({
  id: z.number(),
  name: z.string(),
  app_id: z.number().nullable(),
  status: z.string(),
  conclusion: z.string().nullable(),
  started_at: Iso.nullable(),
});
export type CheckRunJson = z.infer<typeof CheckRunJson>;

/** The parts of Qodo's review record (`qodo read pr-review-session findings`) the report reads. */
const QodoRecordJson = z.object({
  review_session: z
    .object({ run_id: z.number().nullable(), commit_sha: z.string().nullable(), status: z.string().nullable() })
    .nullable(),
  review_runs: z.array(
    z.object({
      run_id: z.number().nullable(),
      commit_sha: z.string(),
      status: z.string(),
      review_effort: z.string().nullable(),
      review_complete: z.boolean().nullable(),
    }),
  ),
  findings: z.array(
    z.object({
      title: z.string(),
      action_level: z.string().nullable(),
      attribution_status: z.string().nullable(),
      git_sha: z.string().nullable(),
    }),
  ),
  qar_operation_result_truncated: z.boolean().optional(),
});
export type QodoRecordJson = z.infer<typeof QodoRecordJson>;
export type QodoEvidence = { record: QodoRecordJson } | { error: string };

export interface Evidence {
  repo: string;
  runs: RunJson[];
  events: EventJson[];
  /** Jobs of runs no issue could be linked to, by run id. */
  jobs: Record<string, JobJson[] | { error: string }>;
  issues: Record<string, IssueJson>;
  prs: PrJson[];
  /** Commit SHAs of each candidate PR, in PR order, by PR number. */
  commits: Record<string, string[]>;
  /** Check runs by commit SHA. */
  checkRuns: Record<string, CheckRunJson[]>;
  qodo: Record<string, QodoEvidence>;
}

/** The agent's login on pull requests (as phase.sh's AGENT_LOGIN). */
export const AGENT_LOGIN = "app/claude";
/** The bot that applies the workflow's labels. */
export const WORKFLOW_ACTOR = "github-actions[bot]";
const PR_LIST_LIMIT = 500;

function parseJson<T>(schema: z.ZodType<T>, text: string, what: string): T {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${what} is not readable JSON: ${(error as Error).message}`);
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`${what} has an unexpected shape: ${result.error.issues[0]?.message ?? "unknown"}`);
  }
  return result.data;
}

/** `gh api --paginate --jq '.[] | ...'` prints one JSON value per line. */
function parseLines<T>(schema: z.ZodType<T>, text: string, what: string): T[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, index) => parseJson(schema, line, `${what} (line ${index + 1})`));
}

/** The pull requests from a ticket branch of issue `issue`: phase.sh find-pr's rule, in any state. */
export function agentPrCandidates(prs: PrJson[], issue: number): PrJson[] {
  const branch = new RegExp(`^${issue}-[a-z0-9-]+$`);
  return prs.filter((pr) => pr.baseRefName === "main" && !pr.isCrossRepository && branch.test(pr.headRefName));
}

export interface CollectOptions {
  since: Date;
  until: Date;
  /** Decides which runs belong to which issue (build-night-records.ts). */
  linkRuns: (runs: RunJson[], events: EventJson[]) => { issues: number[]; unlinkedRuns: number[] };
}

export async function collectEvidence(exec: Exec, options: CollectOptions): Promise<Evidence> {
  const repo = (await exec("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])).trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error(`Unexpected repository name: ${repo}`);

  const range = `${options.since.toISOString().replace(/\.\d{3}Z$/, "Z")}..${options.until.toISOString().replace(/\.\d{3}Z$/, "Z")}`;
  const runs = parseLines(
    RunJson,
    await exec("gh", [
      "api",
      `repos/${repo}/actions/workflows/polson-agent.yml/runs?created=${range}&per_page=100`,
      "--paginate",
      "--jq",
      ".workflow_runs[] | {id, html_url, event, status, conclusion, created_at, run_started_at, updated_at}",
    ]),
    "workflow runs",
  );

  const events = parseLines(
    EventJson,
    await exec("gh", [
      "api",
      `repos/${repo}/issues/events?per_page=100`,
      "--paginate",
      "--jq",
      ".[] | {id, event, created_at, actor: .actor.login, label: .label.name, issue: .issue.number, is_pr: (.issue.pull_request != null)}",
    ]),
    "issue events",
  );

  const linked = options.linkRuns(runs, events);

  const jobs: Evidence["jobs"] = {};
  for (const runId of linked.unlinkedRuns) {
    try {
      jobs[runId] = parseLines(
        JobJson,
        await exec("gh", [
          "api",
          `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`,
          "--jq",
          ".jobs[] | {name, status, conclusion, steps: [.steps[] | {name, conclusion}]}",
        ]),
        `jobs of run ${runId}`,
      );
    } catch (error) {
      // Only used to tell an idle run from an unknown one: a run whose jobs
      // cannot be read is reported as unknown, never as idle.
      jobs[runId] = { error: (error as Error).message };
    }
  }

  const issues: Evidence["issues"] = {};
  for (const issue of linked.issues) {
    issues[issue] = parseJson(
      IssueJson,
      await exec("gh", [
        "issue",
        "view",
        String(issue),
        "--repo",
        repo,
        "--json",
        "number,title,body,comments",
        "--jq",
        "{number, title, body, comments: [.comments[] | {author: .author.login, createdAt, body}]}",
      ]),
      `issue #${issue}`,
    );
  }

  let prs: PrJson[] = [];
  const commits: Evidence["commits"] = {};
  const checkRuns: Evidence["checkRuns"] = {};
  const qodo: Evidence["qodo"] = {};
  if (linked.issues.length > 0) {
    prs = parseJson(
      z.array(PrJson),
      await exec("gh", [
        "pr",
        "list",
        "--repo",
        repo,
        "--state",
        "all",
        "--limit",
        String(PR_LIST_LIMIT),
        "--json",
        "number,url,headRefName,headRefOid,baseRefName,isCrossRepository,state,createdAt,mergedAt,closedAt,mergedBy,author",
        "--jq",
        "[.[] | {number, url, headRefName, headRefOid, baseRefName, isCrossRepository, state, createdAt, mergedAt, closedAt, mergedBy: (if .mergedBy then {login: .mergedBy.login, is_bot: .mergedBy.is_bot} else null end), author: {login: .author.login, is_bot: .author.is_bot}}]",
      ]),
      "pull requests",
    );
    if (prs.length >= PR_LIST_LIMIT) {
      throw new Error(`gh pr list returned ${prs.length} pull requests, the limit: the list may be incomplete.`);
    }

    for (const issue of linked.issues) {
      const candidates = agentPrCandidates(prs, issue);
      if (candidates.length !== 1) continue; // The builder reports none or several as unknown.
      const pr = candidates[0]!;
      const shas = parseJson(
        z.array(z.string().regex(/^[0-9a-f]{40}$/)),
        await exec("gh", ["pr", "view", String(pr.number), "--repo", repo, "--json", "commits", "--jq", "[.commits[].oid]"]),
        `commits of PR #${pr.number}`,
      );
      commits[pr.number] = shas;
      for (const sha of shas) {
        checkRuns[sha] = parseLines(
          CheckRunJson,
          await exec("gh", [
            "api",
            `repos/${repo}/commits/${sha}/check-runs?per_page=100`,
            "--paginate",
            "--jq",
            ".check_runs[] | {id, name, app_id: .app.id, status, conclusion, started_at}",
          ]),
          `check runs of ${sha.slice(0, 7)}`,
        );
      }
      try {
        qodo[pr.number] = {
          record: parseJson(
            QodoRecordJson,
            await exec("qodo", ["read", "pr-review-session", "findings", "--pr-url", pr.url, "--extended", "--json"]),
            `Qodo's record for PR #${pr.number}`,
          ),
        };
      } catch (error) {
        // The one failure kept rather than thrown: the report names this PR's
        // review as missing evidence, so it can never count as reviewed.
        qodo[pr.number] = { error: (error as Error).message };
      }
    }
  }

  return { repo, runs, events, jobs, issues, prs, commits, checkRuns, qodo };
}
