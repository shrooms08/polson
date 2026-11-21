#!/usr/bin/env bash
# Waits until CI and Qodo have both finished with a pull request's head commit.
# Read-only: it never comments, labels, or pushes.
#
# Usage: bash wait-for-pr.sh <pr-number>
# Needs GH_TOKEN and GH_REPO (owner/name). Optional: POLL_SECONDS (default 60),
# TIMEOUT_SECONDS (default 900), REQUIRED_CHECKS (default "Node 24,Node 20.19.0").
#
# CI is finished when every required check run from GitHub Actions on the head
# commit has completed. Qodo is finished when its "PR Summary by Qodo" comment
# says "Assessed commit <head>", its "Code Review by Qodo" comment carries the
# head commit's marker, and no "Qodo is busy working" comment remains (each told
# apart by its opening heading), on two
# polls in a row: Qodo updates its comments in stages, and on PR #10 the summary
# named a new commit about three minutes before the review listed its findings.
#
# Prints one line per poll, then writes these outputs to $GITHUB_OUTPUT (or to
# stdout when GITHUB_OUTPUT is unset):
#   pr_state   OPEN, CLOSED or MERGED
#   head_sha   the head commit that was checked
#   ci         success | failure | pending (pending: not finished in time)
#   ci_detail  each required check and its conclusion
#   qodo       finished | not-finished
#   qodo_open  open High or Medium findings on the head commit: a number, or unknown
set -euo pipefail

pr="${1:-}"
if ! [[ "$pr" =~ ^[1-9][0-9]{0,9}$ ]]; then
  echo "Usage: bash wait-for-pr.sh <pr-number>" >&2
  exit 2
fi
: "${GH_REPO:?GH_REPO must be set to owner/name}"
poll="${POLL_SECONDS:-60}"
timeout_s="${TIMEOUT_SECONDS:-900}"
IFS=',' read -r -a required <<<"${REQUIRED_CHECKS:-Node 24,Node 20.19.0}"
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# The GitHub Actions app. Only its check runs count, so a check run with the same
# name from another app cannot stand in for CI.
ACTIONS_APP_ID=15368
QODO_LOGIN="qodo-code-review[bot]"

gh_() { timeout 60 gh "$@"; }

# Qodo's comments are told apart by their opening heading, never by searching the
# whole body: a summary or review quotes the PR's text and code, which can contain
# any of these phrases (this script does).
QODO_KIND='def heading: sub("^\\s+"; "") | split("\n")[0];
  .[] | select(.user.login == "'"$QODO_LOGIN"'") | .body as $b | ($b | heading) as $h
  | if ($h | startswith("<h3>Qodo is busy working</h3>")) then "busy"
    elif ($h | startswith("<h3>PR Summary by Qodo</h3>")) then "summary " + ($b | contains($summary_mark) | tostring)
    elif ($h | startswith("<h3>Code Review by Qodo</h3>")) then "review " + ($b | contains($review_mark) | tostring)
    else "other" end'

# Prints one line per Qodo comment: busy, summary true|false, review true|false, or
# other, where true means the comment names commit $sha.
qodo_kinds() {
  local json
  json=$(gh_ api "repos/$GH_REPO/issues/$pr/comments?per_page=100" --paginate) || return 1
  jq -rs --arg summary_mark "Assessed commit <a href=\"https://github.com/$GH_REPO/commit/$sha\"" \
    --arg review_mark "<!-- https://github.com/$GH_REPO/commit/$sha -->" \
    "add | $QODO_KIND" <<<"$json"
}

# Prints the body of Qodo's review comment for commit $sha.
qodo_review_body() {
  local json
  json=$(gh_ api "repos/$GH_REPO/issues/$pr/comments?per_page=100" --paginate) || return 1
  jq -rs --arg login "$QODO_LOGIN" --arg review_mark "<!-- https://github.com/$GH_REPO/commit/$sha -->" \
    'add | .[] | select(.user.login == $login) | .body
     | select(sub("^\\s+"; "") | startswith("<h3>Code Review by Qodo</h3>"))
     | select(contains($review_mark))' <<<"$json"
}

# One poll. Sets pr_state, sha, ci, ci_detail and the Qodo flags. Returns non-zero
# if a GitHub call failed, so the caller can retry on the next poll.
poll_once() {
  local info runs state name kinds
  info=$(gh_ pr view "$pr" --json state,headRefOid --jq '"\(.state) \(.headRefOid)"') || return 1
  pr_state="${info%% *}"
  sha="${info#* }"
  [ "$pr_state" = "OPEN" ] || return 0

  runs=$(gh_ api "repos/$GH_REPO/commits/$sha/check-runs?per_page=100" --paginate \
    --jq ".check_runs[] | select(.app.id == $ACTIONS_APP_ID) | {id, name, status, conclusion}") || return 1
  runs=$(jq -s '.' <<<"$runs")
  ci="success"
  ci_detail=""
  for name in "${required[@]}"; do
    # The latest run of that name, in case a check was re-run.
    state=$(jq -r --arg n "$name" \
      '[.[] | select(.name == $n)] | sort_by(.id) | last
       | if . == null then "missing" elif .status != "completed" then .status else .conclusion end' <<<"$runs")
    ci_detail="${ci_detail:+$ci_detail, }$name=$state"
    case "$state" in
      success) ;;
      missing | queued | in_progress | waiting | requested | pending) ci="pending" ;;
      *) [ "$ci" = "pending" ] || ci="failure" ;;
    esac
  done

  kinds=$(qodo_kinds) || return 1
  summary=no review=no busy=no
  if grep -qx 'summary true' <<<"$kinds"; then summary=yes; fi
  if grep -qx 'review true' <<<"$kinds"; then review=yes; fi
  if grep -qx 'busy' <<<"$kinds"; then busy=yes; fi
  return 0
}

emit() {
  local out="${GITHUB_OUTPUT:-/dev/stdout}"
  {
    echo "pr_state=$pr_state"
    echo "head_sha=$sha"
    echo "ci=$ci"
    echo "ci_detail=$ci_detail"
    echo "qodo=$qodo"
    echo "qodo_open=$qodo_open"
  } >>"$out"
}

start=$(date +%s)
deadline=$((start + timeout_s))
stable=0
last_sha=""
n=0
pr_state="" sha="" ci="pending" ci_detail="" qodo="not-finished" qodo_open="unknown"
summary=no review=no busy=no

while :; do
  n=$((n + 1))
  now=$(date -u +%H:%M:%S)
  if ! poll_once; then
    echo "poll $n $now: a GitHub request failed; trying again next poll."
    stable=0
  elif [ "$pr_state" != "OPEN" ]; then
    echo "poll $n $now: PR #$pr is $pr_state. Stopping."
    ci="pending"
    break
  else
    if [ -n "$last_sha" ] && [ "$sha" != "$last_sha" ]; then
      echo "The head commit changed from ${last_sha:0:7} to ${sha:0:7}; checking Qodo again from the start."
      stable=0
    fi
    last_sha="$sha"
    if [ "$summary" = yes ] && [ "$review" = yes ] && [ "$busy" = no ]; then
      stable=$((stable + 1))
    else
      stable=0
    fi
    echo "poll $n $now: head=${sha:0:7} ci=$ci [$ci_detail] qodo: summary@head=$summary review@head=$review busy=$busy ready_polls=$stable"
    if [ "$ci" != "pending" ] && [ "$stable" -ge 2 ]; then
      break
    fi
  fi
  if [ $(($(date +%s) + poll)) -gt "$deadline" ]; then
    echo "Gave up after $((($(date +%s) - start) / 60)) minutes."
    break
  fi
  sleep "$poll"
done

if [ "$pr_state" = "OPEN" ] && [ "$stable" -ge 2 ]; then
  qodo="finished"
  # Qodo's review comment for this head commit; it edits one comment in place.
  review_body=$(qodo_review_body) || review_body=""
  qodo_open=$(printf '%s\n' "$review_body" | bash "$here/qodo-open-findings.sh")
fi

echo "Result: head=${sha:-none} ci=$ci ($ci_detail) qodo=$qodo open_high_medium=$qodo_open"
emit
