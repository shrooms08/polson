#!/usr/bin/env bash
# Reads the body of Qodo's "Code Review by Qodo" comment on stdin and prints how
# many High or Medium findings it still lists as open, or "unknown".
#
# Qodo groups open findings under a severity badge (an img.shields.io "High-..."
# or "Medium-..." image) and lists each one as `<summary>  N.  Title ...`. Fixed
# findings carry "✓ Resolved", and findings a person dismissed carry "✗ Dismissed";
# neither counts as open. This fails closed: an open finding that appears
# before any severity badge is counted as unknown, and so is any finding at all
# when the comment does not look like a Qodo review.
set -euo pipefail

awk '
  BEGIN { seen_review = 0; sev = ""; open = 0; unknown = 0 }
  /Code Review by Qodo/ { seen_review = 1 }
  /img\.shields\.io\/badge\/High-/   { sev = "High" }
  /img\.shields\.io\/badge\/Medium-/ { sev = "Medium" }
  /img\.shields\.io\/badge\/Low-/    { sev = "Low" }
  /Resolved findings/ { sev = "resolved" }
  /<summary>[[:space:]]+[0-9]+\.[[:space:]]/ {
    if ($0 ~ /✓ Resolved/ || $0 ~ /✗ Dismissed/) next
    if (sev == "High" || sev == "Medium") open++
    else if (sev != "Low") unknown++
  }
  END {
    if (!seen_review || unknown > 0) print "unknown"
    else print open
  }
'
