#!/usr/bin/env bash
# The scripted parts of .github/workflows/polson-agent.yml: finding the PR,
# deciding the next phase, building the agent prompts, finishing, and escalating.
# The workflow runs a copy taken from the default branch before any agent ran.
#
# Usage: bash phase.sh <command> <issue> [round]
#   build-prompt <issue>           write the build prompt to the step output `prompt`
#   find-pr <issue>                resume check: output next=wait with `pr` and `branch`
#                                  of the issue's open PR, or next=build if there is none.
#                                  Only a PR opened by the agent ($AGENT_LOGIN) is reused.
#   after-build <issue>            find the PR the build agent opened; output next=wait|stop
#   wait <issue> <round>           run wait-for-pr.sh on $PR, pass its outputs on, then
#                                  gate: output next=resolve (with `prompt`)|finish|stop
#   after-resolve <issue> <round>  output fixed=true|false and next=wait|finish|stop
#   finish <issue>                 agent-done if every check passed, otherwise needs-human
#
# Needs GH_TOKEN and GH_REPO. Each command reads the values it needs from the
# environment (see the workflow) and writes outputs to $GITHUB_OUTPUT.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cmd="${1:-}"
issue="${2:-}"
round="${3:-}"
: "${GH_REPO:?GH_REPO must be set to owner/name}"
out="${GITHUB_OUTPUT:-/dev/stdout}"
run_url="${RUN_URL:-}"

if ! [[ "$issue" =~ ^[1-9][0-9]{0,9}$ ]]; then
  echo "Usage: bash phase.sh <command> <issue-number> [round]" >&2
  exit 2
fi
if [ -n "$round" ] && ! [[ "$round" =~ ^[0-2]$ ]]; then
  echo "round must be 0, 1 or 2, got: $round" >&2
  exit 2
fi

gh_() { timeout 60 gh "$@"; }
set_out() { echo "$1=$2" >>"$out"; }
branch_re="^${issue}-[a-z0-9]+(-[a-z0-9]+)*$"
# The account the build agent opens PRs as (the Claude GitHub App), as gh reports it.
agent_login="${AGENT_LOGIN:-app/claude}"
# The agents push through this trusted copy of the helper, never the checked-out one.
push_helper="bash $here/push-branch.sh"

# Every check below is explicit: bash ignores `set -e` inside functions called
# from `||` or `$(...)`, which is how these are called. A failed request exits.
still_working() {
  local labels
  labels=$(gh_ issue view "$issue" --json labels --jq '.labels[].name') \
    || { echo "::error::Could not read the labels of #$issue." >&2; exit 1; }
  grep -qx 'agent-working' <<<"$labels"
}

# Comment first, then swap the label. If the comment fails, the label stays
# agent-working and the always-run hand-over step (or the next run) retries.
escalate() {
  local why="$1"
  echo "::warning::Escalating #$issue: $why"
  gh_ issue comment "$issue" --body "$(printf '%s\n\n%s\n\nRun: %s' \
    "Polson's agent stopped, so this needs a person." "$why" "$run_url")" \
    || { echo "::error::Could not comment on #$issue; leaving it agent-working." >&2; exit 1; }
  gh_ issue edit "$issue" --remove-label agent-working --add-label needs-human \
    || { echo "::error::Could not relabel #$issue." >&2; exit 1; }
  set_out next stop
}

# Values substituted into a prompt come from GitHub enums, numbers, and the
# check names in the workflow, never from issue or PR text.
safe_value() {
  [[ "$1" =~ ^[A-Za-z0-9\ .,=_/-]*$ ]] || { echo "::error::Unsafe prompt value: $1"; exit 1; }
}

write_prompt() {
  local template="$here/$1" text key value
  shift
  text=$(cat "$template")
  while [ $# -gt 0 ]; do
    key="$1" value="$2"
    shift 2
    safe_value "$value"
    text="${text//"{{$key}}"/$value}"
  done
  if grep -q '{{' <<<"$text"; then
    echo "::error::$template still contains a {{...}} placeholder."
    exit 1
  fi
  local delimiter="POLSON_PROMPT_$(openssl rand -hex 16)"
  { echo "prompt<<$delimiter"; printf '%s\n' "$text"; echo "$delimiter"; } >>"$out"
}

# Prints "<number> <branch>" for the issue's open PR into main from a ticket
# branch in this repository, or nothing. Returns 3 if there is more than one,
# and 4 if the one PR was not opened by the agent: its branch could carry code
# nobody reviewed, and resuming it would run that code with the agent's token.
find_pr() {
  local list found count
  list=$(gh_ pr list --state open --base main --limit 200 \
    --json number,headRefName,isCrossRepository,author) || return 1
  found=$(jq -r --arg re "$branch_re" \
    '.[] | select(.isCrossRepository | not) | select(.headRefName | test($re)) | "\(.number) \(.headRefName) \(.author.login)"' \
    <<<"$list") || return 1
  count=$(grep -c . <<<"$found" || true)
  if [ "$count" -gt 1 ]; then
    echo "More than one open PR comes from a ticket branch for #$issue: $(tr '\n' ' ' <<<"$found")" >&2
    return 3
  fi
  if [ -n "$found" ] && [ "${found##* }" != "$agent_login" ]; then
    echo "PR #${found%% *} comes from a ticket branch for #$issue but was opened by ${found##* }, not the agent." >&2
    return 4
  fi
  printf '%s' "${found% *}"
}

agent_step_ok() {
  if [ "${AGENT_SKIPPED:-}" = "true" ]; then
    escalate "The $1 agent did not run: claude-code-action skipped it because this workflow does not match the copy on the default branch."
    return 1
  fi
  if [ "${AGENT_CONCLUSION:-}" != "success" ]; then
    escalate "The $1 agent ended with conclusion \`${AGENT_CONCLUSION:-none}\`."
    return 1
  fi
  return 0
}

# Sets state and head for a PR. A failed request fails the step.
pr_head() {
  local info
  info=$(gh_ pr view "$1" --json state,headRefOid --jq '"\(.state) \(.headRefOid)"') \
    || { echo "::error::Could not read PR #$1." >&2; exit 1; }
  state="${info%% *}"
  head="${info#* }"
}

case "$cmd" in
  build-prompt)
    write_prompt build-prompt.md ISSUE_NUMBER "$issue" PUSH_HELPER "$push_helper"
    ;;

  find-pr)
    rc=0
    found=$(find_pr) || rc=$?
    if [ "$rc" = 3 ]; then
      escalate "More than one open pull request comes from a ticket branch for this issue, so the agent cannot tell which one to continue. Close the extra ones and relabel."
      exit 0
    fi
    if [ "$rc" = 4 ]; then
      escalate "An open pull request comes from a ticket branch for this issue but was not opened by the agent, so the agent will not run its code. A person decides: continue it by hand, or close it and relabel."
      exit 0
    fi
    [ "$rc" = 0 ] || exit "$rc"
    if [ -n "$found" ]; then
      echo "Resuming PR #${found%% *} (${found#* }); skipping the build phase."
      set_out pr "${found%% *}"
      set_out branch "${found#* }"
      set_out next wait
    else
      echo "No open PR for #$issue; building."
      set_out next build
    fi
    ;;

  after-build)
    still_working || { echo "The build agent handed the issue over itself."; set_out next stop; exit 0; }
    agent_step_ok build || exit 0
    rc=0
    found=$(find_pr) || rc=$?
    if [ "$rc" = 3 ]; then
      escalate "The build phase left more than one open pull request for this issue."
      exit 0
    fi
    if [ "$rc" = 4 ]; then
      escalate "The open pull request for this issue's ticket branch was not opened by the agent."
      exit 0
    fi
    [ "$rc" = 0 ] || exit "$rc"
    if [ -z "$found" ]; then
      escalate "The build agent finished without opening a pull request from a branch named $issue-<slug>."
      exit 0
    fi
    set_out pr "${found%% *}"
    set_out branch "${found#* }"
    set_out next wait
    ;;

  wait)
    : "${PR:?}" "${BRANCH:?}"
    still_working || { echo "The issue is no longer agent-working."; set_out next stop; exit 0; }
    # Run the read-only wait, then pass its outputs on and read them back.
    wait_out=$(mktemp)
    GITHUB_OUTPUT="$wait_out" bash "$here/wait-for-pr.sh" "$PR"
    PR_STATE="" HEAD_SHA="" CI="" CI_DETAIL="" QODO="" QODO_OPEN=""
    while IFS='=' read -r key value; do
      case "$key" in
        pr_state) PR_STATE="$value" ;;
        head_sha) HEAD_SHA="$value" ;;
        ci) CI="$value" ;;
        ci_detail) CI_DETAIL="$value" ;;
        qodo) QODO="$value" ;;
        qodo_open) QODO_OPEN="$value" ;;
        *) continue ;;
      esac
      set_out "$key" "$value"
    done <"$wait_out"
    set_out pr "$PR"
    set_out branch "$BRANCH"

    # Gate. The agent may have handed the issue over while we waited.
    limit="$(( ${TIMEOUT_SECONDS:-900} / 60 )) minutes"
    still_working || { echo "The issue is no longer agent-working."; set_out next stop; exit 0; }
    if [ "${PR_STATE:-}" != "OPEN" ]; then
      escalate "Pull request #$PR is ${PR_STATE:-unknown}, not open."
      exit 0
    fi
    if [ "${CI:-}" = "pending" ]; then
      escalate "CI did not finish on ${HEAD_SHA:0:7} within $limit (${CI_DETAIL:-no checks}). Pull request: #$PR."
      exit 0
    fi
    if [ "${QODO:-}" != "finished" ]; then
      escalate "Qodo did not finish reviewing ${HEAD_SHA:0:7} within $limit. Pull request: #$PR."
      exit 0
    fi
    if [ "$round" = "2" ]; then
      echo "Both fix rounds are used; finishing."
      set_out next finish
      exit 0
    fi
    [[ "$BRANCH" =~ $branch_re ]] || { echo "::error::Unexpected branch name: $BRANCH"; exit 1; }
    # Check out the exact commit that was checked, from GitHub, with the workflow
    # token (the agent's token from the previous phase is already revoked).
    git_auth=()
    if [ -n "${GH_TOKEN:-}" ]; then
      auth=$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 | tr -d '\n')
      echo "::add-mask::$auth"
      git_auth=(-c "http.https://github.com/.extraheader=AUTHORIZATION: basic $auth")
    fi
    git ${git_auth[@]+"${git_auth[@]}"} \
      fetch --no-tags "https://github.com/$GH_REPO.git" "+refs/heads/$BRANCH:refs/remotes/polson/$BRANCH"
    git checkout --force -B "$BRANCH" "refs/remotes/polson/$BRANCH"
    git clean -fd
    if [ "$(git rev-parse HEAD)" != "$HEAD_SHA" ]; then
      escalate "The branch $BRANCH moved after CI and Qodo checked ${HEAD_SHA:0:7}."
      exit 0
    fi
    write_prompt resolve-prompt.md ISSUE_NUMBER "$issue" PR_NUMBER "$PR" ROUND "$((round + 1))" \
      CI_RESULT "$CI" CI_DETAIL "$CI_DETAIL" QODO_OPEN "$QODO_OPEN" HEAD_SHA "$HEAD_SHA" \
      PUSH_HELPER "$push_helper"
    set_out next resolve
    ;;

  after-resolve)
    : "${PR:?}" "${HEAD_BEFORE:?}"
    still_working || { echo "The resolve agent handed the issue over itself."; set_out next stop; exit 0; }
    agent_step_ok resolve || exit 0
    pr_head "$PR"
    if [ "$state" != "OPEN" ]; then
      escalate "Pull request #$PR is $state, not open."
      exit 0
    fi
    if [ "$head" != "$HEAD_BEFORE" ]; then
      echo "Fix round $round pushed ${head:0:7}; waiting for CI and Qodo again."
      set_out fixed true
      set_out next wait
    else
      echo "The resolve agent pushed nothing; finishing."
      set_out fixed false
      set_out next finish
    fi
    ;;

  finish)
    : "${PR:?}" "${HEAD_SHA:?}"
    still_working || { echo "The issue is no longer agent-working."; exit 0; }
    # FIXED1 and FIXED2: whether resolve rounds 1 and 2 pushed a fix.
    rounds=0
    if [ "${FIXED1:-}" = "true" ]; then rounds=1; fi
    if [ "${FIXED2:-}" = "true" ]; then rounds=2; fi
    pr_head "$PR"
    if [ "$state" != "OPEN" ] || [ "$head" != "$HEAD_SHA" ]; then
      escalate "Pull request #$PR changed after the last check (state $state, head ${head:0:7}, checked ${HEAD_SHA:0:7})."
      exit 0
    fi
    if [ "${CI:-}" != "success" ]; then
      escalate "CI is not green on ${HEAD_SHA:0:7} after $rounds fix round(s): ${CI_DETAIL:-no checks}. Pull request: #$PR."
      exit 0
    fi
    if [ "${QODO:-}" != "finished" ]; then
      escalate "Qodo did not finish reviewing ${HEAD_SHA:0:7}. Pull request: #$PR."
      exit 0
    fi
    if ! [[ "${QODO_OPEN:-}" =~ ^[0-9]+$ ]]; then
      escalate "The workflow could not read Qodo's findings on ${HEAD_SHA:0:7}, so it cannot confirm that no High or Medium finding is open. Pull request: #$PR."
      exit 0
    fi
    if [ "$QODO_OPEN" != "0" ]; then
      escalate "Qodo still lists $QODO_OPEN open High or Medium finding(s) on ${HEAD_SHA:0:7} after $rounds fix round(s). Pull request: #$PR."
      exit 0
    fi
    gh_ issue comment "$issue" --body "$(cat <<EOF
Polson's checks passed. This is ready for a person to review and decide whether to merge.

- Pull request: https://github.com/$GH_REPO/pull/$PR
- Head commit: $HEAD_SHA
- CI: $CI_DETAIL
- Qodo: finished reviewing ${HEAD_SHA:0:7}, with 0 open High or Medium findings
- Fix rounds used: $rounds of 2

The agent's latest report above lists each acceptance criterion with its evidence, and each Qodo finding with what it did.

Run: $run_url
EOF
)"
    gh_ issue edit "$issue" --remove-label agent-working --add-label agent-done
    ;;

  *)
    echo "Unknown command: $cmd" >&2
    exit 2
    ;;
esac
