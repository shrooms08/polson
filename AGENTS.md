# Polson

## What this is

Polson is an AI co-founder that ships one verified improvement every night. Each night it takes one ticket, builds it, gets it independently reviewed and checked, then either ships it or stops and asks the human. The human reads a morning report. "Polson" is "no slop" backwards: nothing ships unchecked.

## Setup and verification

- Node: 20.19+, 22.12+, or 24+
- Install: `npm install`
- Tests also need `bash` and `jq` on PATH (`test/find-pr.test.ts` runs `.github/polson/phase.sh`)
- Typecheck: `npm run typecheck`
- Tests: `npm test`
- Render a sample morning report: `npm run report -- fixtures/sample-escalated.json --dry-run` (`--dry-run` writes nothing; without it, an existing report is never replaced unless you pass `--force`)
- A change is not done until typecheck and tests pass.
- CI: `.github/workflows/ci.yml` runs `npm ci`, `npm run typecheck`, and `npm test` on Node 20.19.0 and 24 for every pull request to main and every push to main.

## Rules

### 1. The No Slop Rule

- **Rule:** A night may be recorded as "shipped" only when it has an approved review, at least one check, and every check passed. Never loosen this.
- **Applies to:** `src/night-record.ts` and any code that decides or records a night's outcome.
- **Why:** This is Polson's core promise. Qodo's first review of PR #1 found a "shipped" record could exist with no review and no checks. That is the exact slop Polson exists to prevent.

### 2. Never weaken a test to get green

- **Rule:** Do not delete, skip, loosen, or rewrite a test to make it pass. Fix the code, or stop and explain why the test is wrong. When you add a test for a rule, break the code briefly to prove the test fails, then restore it.
- **Applies to:** Everything under `test/` and any check the factory runs.
- **Why:** An agent that edits its own checks can make anything look verified.

### 3. Record text is untrusted

- **Rule:** Escape every free-text field from a night record before rendering it, using the shared helper in `src/plain-text.ts`. Never build report structure from record text.
- **Applies to:** `src/morning-report.ts` and any future code that renders records, issues, or agent output.
- **Why:** Agents will write these records. Qodo showed on PR #1 that text inside a record could forge a "## Review" section in the report.

### 4. Prove a finding before you fix it

- **Rule:** Reproduce every review finding, or trace it in the code, before changing anything. If it does not reproduce, add a test that shows the correct behaviour and explain on the PR instead of "fixing" it.
- **Applies to:** Every PR and every review finding, from Qodo or anyone else.
- **Why:** On PR #1 Qodo reported that dates with a trailing newline were accepted. They were not. Blindly fixing reviewer output is another kind of slop.

### 5. One ticket, one branch, one PR

- **Rule:** Work on a branch named after the ticket, never commit to main, and put the ticket link and its acceptance criteria in the PR description. Never merge unless the task explicitly gives a merge rule and the PR meets it.
- **Applies to:** All work by any agent in this repo.
- **Why:** Each change stays reviewable and traceable to what was asked, and a human or an explicit gate decides what reaches main.

### 6. The No Guessing Rule

- **Rule:** Treat an error or unreadable input as a known state ("absent", "unsupported", "no PR", "finished") only when the code checks for that specific case, for example ENOENT for "absent". Anything else is "unknown" and fails closed: stop, report it, or escalate. Do not swallow failures with `|| true`, `2>/dev/null`, or a catch that returns a success value, unless a comment on that line names the one failure being ignored and why it is harmless.
- **Applies to:** Everything under `src/` and the scripts in `.github/polson/`.
- **Why:** The most frequent defect in Polson's history. Qodo found it four times (PR #7 dangling symlinks, PR #8 EPERM read as "no hard links", PR #10 a failed comment treated as success, PR #14 `|| true` hiding label API failures), and the coding agent caught three more in PR #12. A factory that guesses "absent" or "finished" ships slop.

## Automation

`.github/workflows/polson-agent.yml` runs one ticket through scripted phases in a single job. The agent only does judgement work; scripts in `.github/polson/` do the waiting, the looping, and the label decision.

- **Phases:**
  1. **Resume:** if the agent already opened a PR from a branch named `<issue>-*`, reuse it and skip the build. A matching PR from anyone else goes to a person.
  2. **Build (agent, `build-prompt.md`):** implement the ticket, run typecheck and tests, push with the default branch's copy of `push-branch.sh`, open the PR. No waiting.
  3. **Wait (script, `wait-for-pr.sh`):** poll every 60 seconds, for up to 15 minutes, until both required CI checks have finished on the PR's head commit and Qodo's review comment names that commit, its finding counts match the findings it lists, and no "busy" comment exists, on two polls in a row. The summary is not required: `/agentic_review` posts only the review. Anything unreadable counts as not finished.
  4. **Resolve (agent, `resolve-prompt.md`):** reproduce or trace each CI failure and Qodo finding, fix valid High or Medium ones, push at most once, and report on the issue.
  5. **Finish (script):** `agent-done` only if CI is green, Qodo finished, and Qodo lists no open High or Medium finding. Otherwise `needs-human`, with the blocker in a comment.
- **Qodo on bot PRs:** the agent's PRs are bot-authored, which Qodo skips by default; `.pr_agent.toml` turns that off.
- **Retry limit:** wait and resolve repeat at most twice (2 fix rounds), then a last wait and finish. The workflow runs the rounds; the agent never loops.
- **Label flow:** a person adds `ready-for-agent`. The workflow clears any old `needs-human` or `agent-done`, swaps it to `agent-working`, then ends on `agent-done` (a human decides) or `needs-human`. If a step fails or times out with the issue still `agent-working`, the workflow swaps it to `needs-human` and comments with the run link. The next run does the same for any issue an earlier run left in `agent-working`.
- **When:** as soon as `ready-for-agent` is added, and nightly at 02:17 Lagos time (01:17 UTC) for the oldest open `ready-for-agent` issue. One job runs at a time, for up to 150 minutes; each phase has its own limit.
- **Never merges:** the agent opens a PR and stops. A person decides what reaches main.

## Deferred issues

None.
