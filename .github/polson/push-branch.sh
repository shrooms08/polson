#!/usr/bin/env bash
# Pushes the current branch for Polson's agent. The agent may run only
# `bash <runner.temp>/polson/push-branch.sh <issue>`, the workflow's copy of this
# file from the default branch, with its own issue number, so it never chooses
# the destination: this script pushes the current branch to the
# branch of the same name, and only if that name is a ticket branch for <issue>.
set -euo pipefail

issue="${1:-}"
if ! [[ "$issue" =~ ^[1-9][0-9]{0,9}$ ]]; then
  echo "Usage: bash push-branch.sh <issue-number>" >&2
  exit 2
fi

branch=$(git symbolic-ref --quiet --short HEAD) || {
  echo "Not on a branch (detached HEAD). Check out your ticket branch first." >&2
  exit 1
}

if ! [[ "$branch" =~ ^${issue}-[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
  echo "Refusing to push '$branch': the branch must be named ${issue}-<short-slug> (lowercase words joined by hyphens)." >&2
  exit 1
fi

git push --set-upstream origin "refs/heads/${branch}:refs/heads/${branch}"
