// L12-1 / D1 (run 12). A derived parameter: arithmetic on cited text plus one
// declared assumption, stored as a typed record the engine recomputes.
//
// The five-day daily norm — 8.6 hours on four days and 7.6 on the shortened
// day — is written in no official text the corpus holds. It is arithmetic:
// the 2018 extension order shortens the week by one hour to 42 "by reducing
// one working hour on a defined, fixed day" (§2.1–2.2), so the week was 43,
// and 43 spread evenly over five days is 8.6, the reduced day 7.6, and
// 4 × 8.6 + 7.6 = 42 again. The spreading is not in the order. It is an
// ASSUMPTION — `five_day_even_distribution` — and the competing reading (the
// 1990 order's nine-hour day, 9 × 4 + 7) is a different branch, not derived
// here. So the record names its inputs by chunk, its assumption by slot, its
// steps one by one, and the identity that must hold; the grade it earns is
// `derived`, never `text_verified` and never `administrative`; and every
// consumer recomputes the record before it binds and refuses if the identity
// fails or the assumption is missing. A record that could be dropped or
// altered without a hash moving is not a record; the derivation's digest
// rides into the candidate's content and its binding dimensions (R-8).
//
// Exact rational arithmetic on bigint; nothing here rounds.
import { z } from "zod";
import { legalOperationsSha256 } from "./canonical.ts";

export const DERIVATION_KIND = "tivdoc-parameter-derivation-v1" as const;
export const DERIVED_GRADE = "derived" as const;
export const DERIVATION_METHOD_FIVE_DAY = "five_day_daily_norm_from_weekly_reduction" as const;
export const ASSUMPTION_FIVE_DAY_EVEN_DISTRIBUTION = "five_day_even_distribution" as const;

const digits = /^-?(?:0|[1-9]\d*)$/u;
const positive = /^[1-9]\d*$/u;
const slug = /^[a-z][a-z0-9_]{1,63}$/u;

export const exactValueSchema = z.object({
  numerator: z.string().regex(digits),
  denominator: z.string().regex(positive),
  unit: z.string().min(1).max(64),
}).strict().readonly();
export type ExactValue = z.infer<typeof exactValueSchema>;

export const derivationInputSchema = z.object({
  name: z.string().regex(slug),
  origin: z.enum(["cited_text", "derived_step"]),
  value: exactValueSchema,
  source: z.object({ source_id: z.string().min(1), source_version: z.string().min(1), chunk_id: z.string().min(1) }).strict().readonly().nullable(),
  locator: z.string().min(1).max(800),
}).strict().readonly();

export const derivationAssumptionSchema = z.object({
  slot: z.string().regex(slug),
  statement: z.string().min(20).max(800),
  parameters: z.object({ days_per_week: z.number().int().min(1).max(7), reduced_days: z.number().int().min(0).max(7) }).strict().readonly(),
  competing_reading: z.string().min(1).max(200),
  mandatory: z.literal(true),
  invalidated_by: z.string().min(1).max(300),
}).strict().readonly();

export const derivationStepSchema = z.object({
  step: z.string().regex(slug),
  expression: z.string().min(1).max(200),
  result: exactValueSchema,
}).strict().readonly();

export const derivationRecordSchema = z.object({
  kind: z.literal(DERIVATION_KIND),
  method: z.literal(DERIVATION_METHOD_FIVE_DAY),
  inputs: z.array(derivationInputSchema).min(2).max(8).readonly(),
  assumption: derivationAssumptionSchema,
  steps: z.array(derivationStepSchema).min(1).max(8).readonly(),
  identity: z.object({ expression: z.string().min(1).max(200), lhs: exactValueSchema, rhs: exactValueSchema, holds: z.literal(true) }).strict().readonly(),
  outputs: z.object({ regular_day: exactValueSchema, short_day: exactValueSchema }).strict().readonly(),
  corroboration: z.array(z.object({ source: z.string().min(1), grade: z.literal("agreement_interpretation"), note: z.string().min(1).max(400) }).strict().readonly()).readonly(),
  grade: z.literal(DERIVED_GRADE),
}).strict().readonly();
export type DerivationRecord = z.infer<typeof derivationRecordSchema>;
export type DerivationAssumption = z.infer<typeof derivationAssumptionSchema>;
export type DerivationInput = z.infer<typeof derivationInputSchema>;

// --- exact arithmetic --------------------------------------------------------

type Q = Readonly<{ n: bigint; d: bigint }>;
const gcd = (a: bigint, b: bigint): bigint => { let x = a < BigInt(0) ? -a : a; let y = b < BigInt(0) ? -b : b; while (y !== BigInt(0)) [x, y] = [y, x % y]; return x || BigInt(1); };
const q = (n: bigint, d: bigint): Q => { if (d === BigInt(0)) throw new Error("DERIVATION_DIVIDE_BY_ZERO"); const sign = d < BigInt(0) ? BigInt(-1) : BigInt(1); const g = gcd(n, d); return { n: (n * sign) / g, d: (d * sign) / g }; };
const of = (value: ExactValue): Q => q(BigInt(value.numerator), BigInt(value.denominator));
const add = (a: Q, b: Q): Q => q(a.n * b.d + b.n * a.d, a.d * b.d);
const sub = (a: Q, b: Q): Q => q(a.n * b.d - b.n * a.d, a.d * b.d);
const mul = (a: Q, b: Q): Q => q(a.n * b.n, a.d * b.d);
const div = (a: Q, b: Q): Q => q(a.n * b.d, a.d * b.n);
const eq = (a: Q, b: Q): boolean => a.n === b.n && a.d === b.d;
const exact = (value: Q, unit: string): ExactValue => ({ numerator: value.n.toString(), denominator: value.d.toString(), unit });
const same = (a: ExactValue, b: ExactValue): boolean => eq(of(a), of(b)) && a.unit === b.unit;

/** 43/5 rendered as "8.6", 38/5 as "7.6", 42 as "42": for locators and renderings, never for arithmetic. */
export function renderExact(value: ExactValue): string {
  const n = BigInt(value.numerator); const d = BigInt(value.denominator);
  if (d === BigInt(1)) return n.toString();
  const negative = n < BigInt(0); const m = negative ? -n : n;
  const whole = m / d; let rem = m % d; let fraction = "";
  for (let i = 0; i < 6 && rem !== BigInt(0); i += 1) { rem *= BigInt(10); fraction += (rem / d).toString(); rem %= d; }
  return `${negative ? "-" : ""}${whole.toString()}${fraction ? `.${fraction}` : ""}${rem !== BigInt(0) ? "…" : ""}`;
}

// --- the five-day derivation --------------------------------------------------

export type FiveDayDerivationInput = Readonly<{
  /** The week after the reduction, as the order states it (42 hours). */
  weekly_after: Readonly<{ value: ExactValue; source: DerivationInput["source"]; locator: string }>;
  /** The reduction the order states (one working hour). */
  reduction: Readonly<{ value: ExactValue; source: DerivationInput["source"]; locator: string }>;
  /** Where the pre-reduction week comes from: cited text if the corpus holds it, else the derived step weekly_after + reduction. */
  weekly_before: Readonly<{ value: ExactValue; source: DerivationInput["source"]; locator: string; origin: "cited_text" | "derived_step" }>;
  assumption: Readonly<{ days_per_week: number; reduced_days: number; statement: string; competing_reading: string; invalidated_by: string }>;
  corroboration: DerivationRecord["corroboration"];
}>;

/** Builds the record and proves its identity; a failed identity is a refusal, not a record. */
export function deriveFiveDayDailyNorm(input: FiveDayDerivationInput): DerivationRecord {
  const weeklyAfter = of(input.weekly_after.value);
  const reduction = of(input.reduction.value);
  const weeklyBefore = of(input.weekly_before.value);
  if (!eq(add(weeklyAfter, reduction), weeklyBefore)) throw new Error("DERIVATION_WEEKLY_BEFORE_INCONSISTENT");
  const days = q(BigInt(input.assumption.days_per_week), BigInt(1));
  const reducedDays = q(BigInt(input.assumption.reduced_days), BigInt(1));
  const regular = div(weeklyBefore, days);
  const short = sub(regular, reduction);
  const lhs = add(mul(sub(days, reducedDays), regular), mul(reducedDays, short));
  if (!eq(lhs, weeklyAfter)) throw new Error("DERIVATION_IDENTITY_FAILED");
  const hoursUnit = "hours";
  const weekly = input.weekly_after.value.unit;
  const record = {
    kind: DERIVATION_KIND,
    method: DERIVATION_METHOD_FIVE_DAY,
    inputs: [
      { name: "weekly_after", origin: "cited_text" as const, value: input.weekly_after.value, source: input.weekly_after.source, locator: input.weekly_after.locator },
      { name: "reduction", origin: "cited_text" as const, value: input.reduction.value, source: input.reduction.source, locator: input.reduction.locator },
      { name: "weekly_before", origin: input.weekly_before.origin, value: input.weekly_before.value, source: input.weekly_before.source, locator: input.weekly_before.locator },
    ],
    assumption: {
      slot: ASSUMPTION_FIVE_DAY_EVEN_DISTRIBUTION,
      statement: input.assumption.statement,
      parameters: { days_per_week: input.assumption.days_per_week, reduced_days: input.assumption.reduced_days },
      competing_reading: input.assumption.competing_reading,
      mandatory: true as const,
      invalidated_by: input.assumption.invalidated_by,
    },
    steps: [
      { step: "regular_day", expression: `weekly_before ÷ days_per_week = ${renderExact(input.weekly_before.value)} ÷ ${input.assumption.days_per_week} = ${renderExact(exact(regular, hoursUnit))}`, result: exact(regular, hoursUnit) },
      { step: "short_day", expression: `regular_day − reduction = ${renderExact(exact(regular, hoursUnit))} − ${renderExact(input.reduction.value)} = ${renderExact(exact(short, hoursUnit))}`, result: exact(short, hoursUnit) },
      { step: "weekly_identity", expression: `(days_per_week − reduced_days) × regular_day + reduced_days × short_day = ${input.assumption.days_per_week - input.assumption.reduced_days} × ${renderExact(exact(regular, hoursUnit))} + ${input.assumption.reduced_days} × ${renderExact(exact(short, hoursUnit))} = ${renderExact(exact(lhs, weekly))}`, result: exact(lhs, weekly) },
    ],
    identity: { expression: "(days_per_week − reduced_days) × regular_day + reduced_days × short_day = weekly_after", lhs: exact(lhs, weekly), rhs: input.weekly_after.value, holds: true as const },
    outputs: { regular_day: exact(regular, hoursUnit), short_day: exact(short, hoursUnit) },
    corroboration: input.corroboration,
    grade: DERIVED_GRADE,
  };
  return derivationRecordSchema.parse(record);
}

/**
 * Recomputes a stored record from its own inputs and assumption and refuses
 * unless every step, both outputs and the identity come out the same. This is
 * what a binder runs before it binds; a record it cannot reproduce is not
 * bound.
 */
export function verifyDerivation(candidate: unknown): DerivationRecord {
  const record = derivationRecordSchema.parse(candidate);
  if (record.assumption.slot !== ASSUMPTION_FIVE_DAY_EVEN_DISTRIBUTION || record.assumption.mandatory !== true) throw new Error("DERIVATION_ASSUMPTION_MISSING");
  const named = (name: string) => { const found = record.inputs.find((entry) => entry.name === name); if (!found) throw new Error(`DERIVATION_INPUT_MISSING:${name}`); return found; };
  const weeklyAfter = of(named("weekly_after").value);
  const reduction = of(named("reduction").value);
  const weeklyBefore = of(named("weekly_before").value);
  if (!eq(add(weeklyAfter, reduction), weeklyBefore)) throw new Error("DERIVATION_WEEKLY_BEFORE_INCONSISTENT");
  const days = q(BigInt(record.assumption.parameters.days_per_week), BigInt(1));
  const reducedDays = q(BigInt(record.assumption.parameters.reduced_days), BigInt(1));
  const regular = div(weeklyBefore, days);
  const short = sub(regular, reduction);
  const lhs = add(mul(sub(days, reducedDays), regular), mul(reducedDays, short));
  if (!eq(lhs, weeklyAfter) || !eq(of(record.identity.lhs), lhs) || !eq(of(record.identity.rhs), weeklyAfter)) throw new Error("DERIVATION_IDENTITY_FAILED");
  const expected = { regular_day: exact(regular, record.outputs.regular_day.unit), short_day: exact(short, record.outputs.short_day.unit) };
  if (!same(record.outputs.regular_day, expected.regular_day) || !same(record.outputs.short_day, expected.short_day)) throw new Error("DERIVATION_RECOMPUTATION_MISMATCH");
  const stepResult = (step: string) => record.steps.find((entry) => entry.step === step)?.result;
  const regularStep = stepResult("regular_day"); const shortStep = stepResult("short_day");
  if (!regularStep || !shortStep || !same(regularStep, expected.regular_day) || !same(shortStep, expected.short_day)) throw new Error("DERIVATION_RECOMPUTATION_MISMATCH");
  return record;
}

export function derivationSha256(record: DerivationRecord): string {
  return legalOperationsSha256(derivationRecordSchema.parse(record));
}
