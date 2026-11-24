// Replays recorded gh/qodo responses (fixtures/github/) as an Exec, for tests.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Exec } from "../../src/github-evidence.js";

export interface Recording {
  since: string;
  until: string;
  responses: { file: string; args: string[]; stdout: string }[];
}

export function loadRecording(name: string): Recording {
  return JSON.parse(readFileSync(resolve(import.meta.dirname, "../../fixtures/github", name), "utf8")) as Recording;
}

const RUNS_QUERY = /^(repos\/[^/]+\/[^/]+\/actions\/workflows\/polson-agent\.yml\/runs)\?created=([^.]+)\.\.([^&]+)&per_page=100$/;

/**
 * An Exec that answers from a recording. Every command must match one recorded
 * exactly, except the workflow-runs query, which is answered like the API: the
 * recorded runs whose created_at falls inside the requested range (the
 * recording's range must cover it). Unknown commands reject, as gh would fail.
 */
export function replay(recording: Recording, calls: string[] = []): Exec {
  return async (file, args) => {
    calls.push([file, ...args].join(" "));
    const runs = file === "gh" && args[0] === "api" ? RUNS_QUERY.exec(args[1] ?? "") : null;
    if (runs) {
      const recorded = recording.responses.find((r) => r.file === "gh" && RUNS_QUERY.test(r.args[1] ?? ""));
      if (!recorded) throw new Error("replay: no recorded workflow runs");
      const [, , from, to] = runs;
      const [, , recFrom, recTo] = RUNS_QUERY.exec(recorded.args[1]!)!;
      if (Date.parse(from!) < Date.parse(recFrom!) || Date.parse(to!) > Date.parse(recTo!)) {
        throw new Error(`replay: requested runs ${from}..${to} are outside the recording ${recFrom}..${recTo}`);
      }
      return recorded.stdout
        .split("\n")
        .filter((line) => line.trim() !== "")
        .filter((line) => {
          const created = Date.parse((JSON.parse(line) as { created_at: string }).created_at);
          return created >= Date.parse(from!) && created <= Date.parse(to!);
        })
        .map((line) => `${line}\n`)
        .join("");
    }
    const match = recording.responses.find((r) => r.file === file && r.args.join("\u0000") === args.join("\u0000"));
    if (!match) throw new Error(`replay: no recorded response for ${file} ${args.join(" ")}`);
    return match.stdout;
  };
}

/** A copy of the recording with one response's stdout changed. */
export function withResponse(recording: Recording, matches: (file: string, args: string[]) => boolean, edit: (stdout: string) => string): Recording {
  let found = 0;
  const responses = recording.responses.map((r) => {
    if (!matches(r.file, r.args)) return r;
    found += 1;
    return { ...r, stdout: edit(r.stdout) };
  });
  if (found === 0) throw new Error("withResponse: no response matched");
  return { ...recording, responses };
}
