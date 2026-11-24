import { z } from "zod";

/**
 * A record of one night's work: the task Polson picked, how it was reviewed
 * and checked, and what happened in the end.
 *
 * The schema enforces the product's core promise: a record can only say
 * "shipped" (or "awaiting_merge") if it was verified, meaning an approved
 * review and at least one check, with every check passing.
 *
 * Error messages are written to follow the field path, e.g.
 * `reason: is required when outcome is "blocked"`.
 */

// No `m` flag, so `^` and `$` anchor to the whole string. The length check
// makes that explicit: no trailing "\n" or "\r" can slip into a report filename.
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_LENGTH = "YYYY-MM-DD".length;

function isRealCalendarDate(value: string): boolean {
  if (value.length !== DATE_LENGTH) return false;
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

/** A trimmed, non-empty string with a readable message when it is missing. */
function requiredText(missingMessage = "is required") {
  return z
    .string({
      error: (issue) => (issue.input === undefined ? missingMessage : "must be text"),
    })
    .trim()
    .min(1, "must not be empty");
}

const DateSchema = z
  .string({
    error: (issue) => (issue.input === undefined ? "is required (YYYY-MM-DD)" : "must be text"),
  })
  .refine(isRealCalendarDate, "must be a real calendar date in YYYY-MM-DD format");

const TaskSchema = z.strictObject(
  {
    id: requiredText(),
    title: requiredText(),
    acceptanceCriteria: z
      .array(requiredText(), { error: "is required (a list of at least one criterion)" })
      .min(1, "must list at least one criterion"),
  },
  { error: "is required" },
);

// Only http(s) links reach the report. `normalize` stores the parsed href,
// which is percent-encoded and cannot contain whitespace, "<" or ">".
const HttpUrl = z.url({
  protocol: /^https?$/,
  normalize: true,
  error: "must be a valid http or https URL",
});

const CommitSha = z
  .string({ error: "must be text" })
  .regex(/^[0-9a-f]{40}$/, "must be a full 40-character commit SHA");

const PullRequestSchema = z.strictObject({
  number: z.number({ error: "must be a number" }).int().positive("must be a positive integer"),
  url: HttpUrl,
  /** The head commit the review and checks describe. */
  headSha: CommitSha.optional(),
});

/** One agent run for the task, as the workflow recorded it on GitHub. */
const RunSchema = z.strictObject({
  id: z.number({ error: "must be a number" }).int().positive("must be a positive integer"),
  url: HttpUrl,
  /** The pull request's head commit when the run ended. */
  headSha: CommitSha,
  /** The label the run left on the issue. */
  endedLabel: z.enum(["agent-done", "needs-human"], { error: 'must be "agent-done" or "needs-human"' }),
});

const reviewShape = {
  reviewer: requiredText(),
  verdict: z.enum(["approved", "changes_requested"], {
    error: 'must be "approved" or "changes_requested"',
  }),
  findings: z.number({ error: "must be a number" }).int().nonnegative("must be zero or more"),
};

const ReviewSchema = z.strictObject(reviewShape);

const CheckSchema = z.strictObject({
  name: requiredText(),
  status: z.enum(["pass", "fail"], { error: 'must be "pass" or "fail"' }),
  detail: requiredText().optional(),
});

const commonFields = {
  date: DateSchema,
  task: TaskSchema,
  pullRequest: PullRequestSchema.optional(),
  review: ReviewSchema.optional(),
  checks: z.array(CheckSchema, { error: "is required (use [] if no checks ran)" }),
  runs: z.array(RunSchema, { error: "must be a list of runs" }).optional(),
};

/**
 * The outcomes that claim the work was verified: "shipped" (a person merged it)
 * and "awaiting_merge" (every check passed and the review approved it; a person
 * decides). Both need an approved review and at least one check, every check
 * passing. Never loosen this (AGENTS.md rule 1).
 */
const VERIFIED_OUTCOMES = ["shipped", "awaiting_merge"] as const;
type VerifiedOutcome = (typeof VERIFIED_OUTCOMES)[number];

// Requiring the review and a non-empty checks list here, in the base schema,
// means both are reported together even when both fields are absent. (A
// refinement alone would be skipped once the base parse fails, hiding the
// second problem.)
function verifiedRecord<O extends VerifiedOutcome>(outcome: O) {
  const needsReview = `is required when outcome is "${outcome}" (an approved review)`;
  const needsChecks = `must include at least one check when outcome is "${outcome}"`;
  return z.strictObject({
    ...commonFields,
    review: z.strictObject(reviewShape, {
      error: (issue) =>
        issue.code === "invalid_type" && issue.input === undefined ? needsReview : undefined,
    }),
    checks: z
      .array(CheckSchema, {
        error: (issue) => (issue.input === undefined ? needsChecks : "must be a list of checks"),
      })
      .min(1, needsChecks),
    outcome: z.literal(outcome),
  });
}

const ShippedRecord = verifiedRecord("shipped");
const AwaitingMergeRecord = verifiedRecord("awaiting_merge");

const BlockedRecord = z.strictObject({
  ...commonFields,
  outcome: z.literal("blocked"),
  reason: requiredText('is required when outcome is "blocked"'),
});

const EscalatedRecord = z.strictObject({
  ...commonFields,
  outcome: z.literal("escalated"),
  reason: requiredText('is required when outcome is "escalated"'),
  questionForHuman: requiredText('is required when outcome is "escalated"'),
});

function verifiedOutcomeOf(value: unknown): VerifiedOutcome | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const outcome = (value as { outcome?: unknown }).outcome;
  return VERIFIED_OUTCOMES.find((verified) => verified === outcome);
}

export const NightRecordSchema = z
  .discriminatedUnion("outcome", [ShippedRecord, AwaitingMergeRecord, BlockedRecord, EscalatedRecord], {
    error: 'must be "shipped", "awaiting_merge", "blocked", or "escalated"',
  })
  .superRefine(
    (parsed, ctx) => {
      // This runs for every shipped or awaiting_merge record, even one with
      // other problems, so a failing check or rejected review is never hidden
      // behind, say, a missing field. Fields may therefore be absent or only
      // partly parsed here.
      const outcome = verifiedOutcomeOf(parsed) ?? "shipped";
      const record = parsed as {
        checks?: unknown;
        review?: { verdict?: unknown } | undefined;
      };
      const checks = Array.isArray(record.checks) ? record.checks : [];

      checks.forEach((check: { name?: unknown; status?: unknown } | null, index) => {
        if (check?.status === "fail") {
          ctx.addIssue({
            code: "custom",
            path: ["checks", index, "status"],
            message: `outcome cannot be "${outcome}" while check "${String(check.name)}" failed`,
          });
        }
      });

      if (record.review?.verdict === "changes_requested") {
        ctx.addIssue({
          code: "custom",
          path: ["review", "verdict"],
          message: `outcome cannot be "${outcome}" while the reviewer requested changes`,
        });
      }
    },
    { when: (payload) => verifiedOutcomeOf(payload.value) !== undefined },
  );

export type NightRecord = z.infer<typeof NightRecordSchema>;
export type Outcome = NightRecord["outcome"];

export type ParseResult =
  | { ok: true; record: NightRecord }
  | { ok: false; problems: string[] };

/** Validate unknown input and return either the record or a readable list of problems. */
export function parseNightRecord(input: unknown): ParseResult {
  const result = NightRecordSchema.safeParse(input);
  if (result.success) return { ok: true, record: result.data };
  return {
    ok: false,
    problems: result.error.issues.map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join(".") : "record";
      return `${where}: ${issue.message}`;
    }),
  };
}
