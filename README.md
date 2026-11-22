# polson
No slop. An AI co-founder that ships one verified improvement every night.

## What Polson is

Polson works on your product while you sleep. Each night it picks one task, builds it,
has it independently reviewed and checked, then either ships it or stops and asks you.
In the morning you read a short report. "Polson" is "no slop" backwards: nothing ships unchecked.

## Run the morning report

Requires Node 20.19+, 22.12+, or 24+ (the range the locked Vite and Vitest support).

```sh
npm install
npm run report -- fixtures/sample-escalated.json --dry-run
```

This validates the night record and prints the report. Without `--dry-run` it also saves it
to `reports/<date>.md`, but never replaces an existing report: it names the file and exits 1.
Add `--force` to replace it. `--dry-run` always wins and writes nothing, so the command above
is safe to repeat. Reports are written to a temporary file and moved into place, so a failed
write never leaves a partial report. Writing without `--force` needs a filesystem with hard links
(APFS, ext4, NTFS); on exFAT or FAT32 it stops with a clear error and writes nothing. An invalid record or unknown option prints the problem and exits 1.
The records in `fixtures/` are samples, not real nights.

Other commands: `npm test`, `npm run typecheck`. `npm test` also needs `bash` and `jq` on PATH,
because it runs one of the automation scripts in `.github/polson/`.
