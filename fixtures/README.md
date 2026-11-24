These are made-up sample night records for tests and demos, not records of real nights.

`github/2026-11-24.json` is different: real, recorded responses from `gh` and `qodo` for 24 Nov 2026 (issues #44 and #51, PRs #46 and #52, and the polson-agent runs that day), as `collectEvidence` in `src/github-evidence.ts` requested them. Each command's output was projected to the fields the report reads; issue events were cut to 24 Nov and Qodo's records to the fields parsed. They hold no tokens, emails or display names. `test/support/replay-github.ts` replays them.
