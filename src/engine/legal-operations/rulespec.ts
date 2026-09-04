import { z } from "zod";
import { WAVE3_TOPICS } from "../wave3/contracts.ts";
import { frozen, legalOperationsSha256 } from "./canonical.ts";
import { exactRationalSchema, legalOperationsIdSchema, legalOperationsSha256Schema, type ParameterValue } from "./contracts.ts";

const valueKindSchema = z.enum(["rational", "money", "integer", "boolean"]);
const declarationObjectSchema = z.object({
  ref_id: legalOperationsIdSchema,
  value_kind: valueKindSchema,
  unit: legalOperationsIdSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.value_kind === "boolean" && value.unit !== null) context.addIssue({ code: "custom", message: "boolean_unit_must_be_null" });
  if (value.value_kind !== "boolean" && value.unit === null) context.addIssue({ code: "custom", message: "typed_value_requires_unit" });
});
const declarationSchema = declarationObjectSchema.readonly();

const parameterDeclarationSchema = declarationObjectSchema.extend({ parameter_id: legalOperationsIdSchema, parameter_version: z.string().regex(/^[1-9]\d*(?:\.\d+){0,2}$/) }).strict().readonly();
const nodeBase = { node_id: legalOperationsIdSchema } as const;

// L4-2 / D1. Two shape-only nodes. A band boundary or a tier threshold is the
// shape of a table; the value or the rate sitting at each one is a parameter,
// cited and bound like every other. Neither node decides anything — the
// boundaries come from the spec its drafter wrote, the numbers come from the
// parameter store, and both are visible in the trace.
//
// Ranges are half-open, `[from_inclusive, to_exclusive)`, and the field names
// say so. "Years 1 to 4" is ambiguous in every direction, and over half-open
// ranges the contiguity check is a single equality.
const bandSchema = z.object({
  from_inclusive: z.number().int().safe(),
  to_exclusive: z.number().int().safe().nullable(),
  value_ref: legalOperationsIdSchema,
}).strict().readonly();
const tierSchema = z.object({
  from_inclusive: z.number().int().safe(),
  to_exclusive: z.number().int().safe().nullable(),
  rate_ref: legalOperationsIdSchema,
}).strict().readonly();

export const ruleSpecNodeSchema = z.discriminatedUnion("operation", [
  z.object({ ...nodeBase, operation: z.literal("constant.rational"), value: z.enum(["0", "1"]), unit: legalOperationsIdSchema }).strict(),
  z.object({ ...nodeBase, operation: z.literal("add"), refs: z.array(legalOperationsIdSchema).min(2).max(32).readonly() }).strict(),
  z.object({ ...nodeBase, operation: z.literal("multiply"), left_ref: legalOperationsIdSchema, right_ref: legalOperationsIdSchema }).strict(),
  z.object({ ...nodeBase, operation: z.literal("money.scale"), money_ref: legalOperationsIdSchema, rational_ref: legalOperationsIdSchema, rounding: z.enum(["exact", "toward_zero", "half_up", "half_even"]) }).strict(),
  z.object({ ...nodeBase, operation: z.literal("compare.gte"), left_ref: legalOperationsIdSchema, right_ref: legalOperationsIdSchema }).strict(),
  z.object({ ...nodeBase, operation: z.literal("select"), condition_ref: legalOperationsIdSchema, when_true_ref: legalOperationsIdSchema, when_false_ref: legalOperationsIdSchema }).strict(),
  // `min` and `max` were one member carrying `z.enum(["min", "max"])`. They are
  // two members now, identical in what they parse, so that narrowing on the
  // discriminant actually removes them and `assertExhaustive` can do its job.
  z.object({ ...nodeBase, operation: z.literal("min"), refs: z.array(legalOperationsIdSchema).min(2).max(32).readonly() }).strict(),
  z.object({ ...nodeBase, operation: z.literal("max"), refs: z.array(legalOperationsIdSchema).min(2).max(32).readonly() }).strict(),
  z.object({ ...nodeBase, operation: z.literal("aggregate.bounded"), refs: z.array(legalOperationsIdSchema).min(1).max(32).readonly() }).strict(),
  z.object({ ...nodeBase, operation: z.literal("band.lookup"), input_ref: legalOperationsIdSchema, bands: z.array(bandSchema).min(1).max(32).readonly() }).strict(),
  z.object({ ...nodeBase, operation: z.literal("tiered.rate"), input_ref: legalOperationsIdSchema, base_ref: legalOperationsIdSchema, tiers: z.array(tierSchema).min(1).max(32).readonly(), rounding: z.enum(["exact", "toward_zero", "half_up", "half_even"]) }).strict(),
]).readonly();

/**
 * Every operation the executor knows, in one place. `assertExhaustive` below
 * turns the compiler into the check that no dispatch forgets one — the previous
 * shape of `refs()` and of the executor's `else` chain would have swallowed a
 * new kind silently, one returning no input refs and one evaluating it as
 * `min`.
 */
export const RULE_SPEC_OPERATIONS = Object.freeze([
  "constant.rational", "add", "multiply", "money.scale", "compare.gte",
  "select", "min", "max", "aggregate.bounded", "band.lookup", "tiered.rate",
] as const);

function assertExhaustive(node: never): never {
  throw new Error(`RULESPEC_OPERATION_UNHANDLED:${(node as { operation?: string }).operation ?? "unknown"}`);
}

/** Half-open ranges must start where the previous one ended, and only the last may be open. */
function assertContiguous(ranges: readonly Readonly<{ from_inclusive: number; to_exclusive: number | null }>[], code: string): void {
  for (const [index, range] of ranges.entries()) {
    const isLast = index === ranges.length - 1;
    if (range.to_exclusive === null && !isLast) throw new Error(code);
    if (range.to_exclusive !== null && range.to_exclusive <= range.from_inclusive) throw new Error(code);
    if (index > 0 && ranges[index - 1].to_exclusive !== range.from_inclusive) throw new Error(code);
  }
}

/** The band or tier covering `quantity`, or `null` when nothing does. */
function rangeAt<T extends Readonly<{ from_inclusive: number; to_exclusive: number | null }>>(ranges: readonly T[], quantity: bigint): T | null {
  for (const range of ranges) {
    if (quantity < BigInt(range.from_inclusive)) continue;
    if (range.to_exclusive === null || quantity < BigInt(range.to_exclusive)) return range;
  }
  return null;
}

const ruleSpecDraftObjectSchema = z.object({
  schema_version: z.literal("tivdoc-rulespec-v0.6.0"),
  rule_spec_id: legalOperationsIdSchema,
  rule_spec_version: z.string().regex(/^[1-9]\d*(?:\.\d+){0,2}$/),
  topic: z.enum(WAVE3_TOPICS),
  catalog_boundary: z.enum(["synthetic_test_only", "real_inactive"]),
  source_version_ids: z.array(legalOperationsIdSchema).min(1).readonly(),
  effective_period: z.object({ from: z.iso.date(), to: z.iso.date().nullable() }).strict(),
  sectors: z.array(legalOperationsIdSchema).min(1).readonly(),
  populations: z.array(legalOperationsIdSchema).min(1).readonly(),
  facts: z.array(declarationSchema).max(64).readonly(),
  parameters: z.array(parameterDeclarationSchema).max(64).readonly(),
  nodes: z.array(ruleSpecNodeSchema).min(1).max(128).readonly(),
  output_ref: legalOperationsIdSchema,
  golden_case_set_sha256: legalOperationsSha256Schema,
  resource_policy: z.object({ max_steps: z.number().int().positive().max(128), max_depth: z.number().int().positive().max(32), max_aggregate_items: z.number().int().positive().max(32), max_integer_digits: z.number().int().positive().max(256) }).strict(),
}).strict().superRefine((value, context) => {
  if (value.effective_period.to !== null && value.effective_period.to < value.effective_period.from) context.addIssue({ code: "custom", message: "rulespec_interval_inverted" });
});
const ruleSpecDraftSchema = ruleSpecDraftObjectSchema.readonly();

export const ruleSpecPackageSchema = ruleSpecDraftObjectSchema.extend({ content_sha256: legalOperationsSha256Schema }).strict().readonly();

const ruleSpecValueSchema = z.discriminatedUnion("kind", [
  exactRationalSchema,
  z.object({ kind: z.literal("money"), currency: z.string().regex(/^[A-Z]{3}$/), minor_units: z.number().int().safe() }).strict(),
  z.object({ kind: z.literal("integer"), value: z.number().int().safe(), unit: legalOperationsIdSchema }).strict(),
  z.object({ kind: z.literal("boolean"), value: z.boolean() }).strict(),
]);
export const ruleSpecInputValueSchema = z.object({
  ref_id: legalOperationsIdSchema,
  value: ruleSpecValueSchema,
}).strict().readonly();

export const goldenCaseSetSchema = z.object({
  schema_version: z.literal("tivdoc-rulespec-golden-case-set-v0.6.0"),
  golden_case_set_id: legalOperationsIdSchema,
  rule_spec_id: legalOperationsIdSchema,
  rule_spec_version: z.string().regex(/^[1-9]\d*(?:\.\d+){0,2}$/),
  cases: z.array(z.object({
    case_id: legalOperationsIdSchema,
    facts: z.array(ruleSpecInputValueSchema).readonly(),
    parameters: z.array(ruleSpecInputValueSchema).readonly(),
    expected_output: ruleSpecValueSchema,
  }).strict()).min(1).max(100).readonly(),
  content_sha256: legalOperationsSha256Schema,
}).strict().readonly();

export type RuleSpecPackage = z.infer<typeof ruleSpecPackageSchema>;
export type RuleSpecDraft = z.input<typeof ruleSpecDraftSchema>;
export type RuleSpecInputValue = z.infer<typeof ruleSpecInputValueSchema>;
export type GoldenCaseSet = z.infer<typeof goldenCaseSetSchema>;

type RuntimeValue =
  | Readonly<{ kind: "rational"; numerator: bigint; denominator: bigint; unit: string }>
  | Readonly<{ kind: "integer"; value: bigint; unit: string }>
  | Readonly<{ kind: "money"; currency: string; minor_units: bigint }>
  | Readonly<{ kind: "boolean"; value: boolean }>;

function gcd(left: bigint, right: bigint): bigint {
  let a = left < BigInt(0) ? -left : left;
  let b = right < BigInt(0) ? -right : right;
  while (b !== BigInt(0)) [a, b] = [b, a % b];
  return a;
}

function rational(numerator: bigint, denominator: bigint, unit: string): RuntimeValue {
  if (denominator <= BigInt(0)) throw new Error("RULESPEC_RATIONAL_DENOMINATOR_INVALID");
  const divisor = gcd(numerator, denominator);
  return frozen({ kind: "rational", numerator: numerator / divisor, denominator: denominator / divisor, unit });
}

function inputValue(value: RuleSpecInputValue["value"]): RuntimeValue {
  if (value.kind === "rational") return rational(BigInt(value.numerator), BigInt(value.denominator), value.unit);
  if (value.kind === "integer") return frozen({ kind: "integer", value: BigInt(value.value), unit: value.unit });
  if (value.kind === "money") return frozen({ kind: "money", currency: value.currency, minor_units: BigInt(value.minor_units) });
  return frozen(value);
}

function serialized(value: RuntimeValue): RuleSpecInputValue["value"] {
  if (value.kind === "rational") return { kind: "rational", numerator: value.numerator.toString(), denominator: value.denominator.toString(), unit: value.unit };
  if (value.kind === "integer") {
    const integer = Number(value.value);
    if (!Number.isSafeInteger(integer)) throw new Error("RULESPEC_INTEGER_OVERFLOW");
    return { kind: "integer", value: integer, unit: value.unit };
  }
  if (value.kind === "money") {
    const amount = Number(value.minor_units);
    if (!Number.isSafeInteger(amount)) throw new Error("RULESPEC_MONEY_OVERFLOW");
    return { kind: "money", currency: value.currency, minor_units: amount };
  }
  return value;
}

function sameType(left: RuntimeValue, right: RuntimeValue) {
  return left.kind === right.kind && (left.kind !== "rational" || right.kind !== "rational" || left.unit === right.unit) && (left.kind !== "integer" || right.kind !== "integer" || left.unit === right.unit) && (left.kind !== "money" || right.kind !== "money" || left.currency === right.currency);
}

function compare(left: RuntimeValue, right: RuntimeValue) {
  if (!sameType(left, right)) throw new Error("RULESPEC_UNIT_OR_TYPE_MISMATCH");
  if (left.kind === "boolean" || right.kind === "boolean") throw new Error("RULESPEC_BOOLEAN_NOT_ORDERED");
  if (left.kind === "money" && right.kind === "money") return left.minor_units < right.minor_units ? -1 : left.minor_units > right.minor_units ? 1 : 0;
  if (left.kind === "integer" && right.kind === "integer") return left.value < right.value ? -1 : left.value > right.value ? 1 : 0;
  if (left.kind === "rational" && right.kind === "rational") {
    const difference = left.numerator * right.denominator - right.numerator * left.denominator;
    return difference < BigInt(0) ? -1 : difference > BigInt(0) ? 1 : 0;
  }
  throw new Error("RULESPEC_COMPARISON_INVALID");
}

export function refs(node: RuleSpecPackage["nodes"][number]): readonly string[] {
  switch (node.operation) {
    case "constant.rational": return [];
    case "add": case "min": case "max": case "aggregate.bounded": return node.refs;
    case "multiply": case "compare.gte": return [node.left_ref, node.right_ref];
    case "money.scale": return [node.money_ref, node.rational_ref];
    case "select": return [node.condition_ref, node.when_true_ref, node.when_false_ref];
    case "band.lookup": return [node.input_ref, ...node.bands.map((band) => band.value_ref)];
    case "tiered.rate": return [node.input_ref, node.base_ref, ...node.tiers.map((tier) => tier.rate_ref)];
    default: return assertExhaustive(node);
  }
}

export function createRuleSpecPackage(candidate: RuleSpecDraft): RuleSpecPackage {
  const draft = ruleSpecDraftSchema.parse(candidate);
  return validateRuleSpecPackage({ ...draft, content_sha256: legalOperationsSha256(draft) });
}

export function createGoldenCaseSet(candidate: Omit<GoldenCaseSet, "content_sha256">): GoldenCaseSet {
  const contentSha256 = legalOperationsSha256(candidate);
  return validateGoldenCaseSet({ ...candidate, content_sha256: contentSha256 });
}

export function validateGoldenCaseSet(candidate: unknown): GoldenCaseSet {
  const parsed = goldenCaseSetSchema.parse(candidate);
  const { content_sha256: contentSha256, ...content } = parsed;
  if (legalOperationsSha256(content) !== contentSha256) throw new Error("GOLDEN_CASE_SET_CONTENT_HASH_MISMATCH");
  return frozen(parsed);
}

export function validateRuleSpecPackage(candidate: unknown): RuleSpecPackage {
  const parsed = ruleSpecPackageSchema.parse(candidate);
  const { content_sha256: contentSha256, ...draft } = parsed;
  if (legalOperationsSha256(draft) !== contentSha256) throw new Error("RULESPEC_CONTENT_HASH_MISMATCH");
  const available = new Map<string, { kind: string; unit: string | null; depth: number }>();
  for (const declaration of [...parsed.facts, ...parsed.parameters]) {
    if (available.has(declaration.ref_id)) throw new Error("RULESPEC_DUPLICATE_REF");
    available.set(declaration.ref_id, { kind: declaration.value_kind, unit: declaration.unit, depth: 0 });
  }
  for (const node of parsed.nodes) {
    if (available.has(node.node_id)) throw new Error("RULESPEC_DUPLICATE_REF");
    const dependencies = refs(node);
    if (dependencies.some((reference) => !available.has(reference))) throw new Error("RULESPEC_FORWARD_OR_MISSING_REF");
    if (node.operation === "aggregate.bounded" && node.refs.length > parsed.resource_policy.max_aggregate_items) throw new Error("RULESPEC_AGGREGATE_BOUND_EXCEEDED");
    if (node.operation === "band.lookup" && node.bands.length > parsed.resource_policy.max_aggregate_items) throw new Error("RULESPEC_AGGREGATE_BOUND_EXCEEDED");
    if (node.operation === "tiered.rate" && node.tiers.length > parsed.resource_policy.max_aggregate_items) throw new Error("RULESPEC_AGGREGATE_BOUND_EXCEEDED");
    const inputs = dependencies.map((reference) => available.get(reference)!);
    let kind: string;
    let unit: string | null;
    if (node.operation === "constant.rational") [kind, unit] = ["rational", node.unit];
    else if (node.operation === "compare.gte") [kind, unit] = ["boolean", null];
    else if (node.operation === "select") {
      if (inputs[0].kind !== "boolean" || inputs[1].kind !== inputs[2].kind || inputs[1].unit !== inputs[2].unit) throw new Error("RULESPEC_SELECT_TYPE_MISMATCH");
      [kind, unit] = [inputs[1].kind, inputs[1].unit];
    } else if (node.operation === "money.scale") {
      if (inputs[0].kind !== "money" || inputs[1].kind !== "rational" || inputs[1].unit !== "ratio") throw new Error("RULESPEC_MONEY_SCALE_UNIT_MISMATCH");
      [kind, unit] = ["money", inputs[0].unit];
    } else if (node.operation === "multiply") {
      if (inputs[0].kind !== "rational" || inputs[1].kind !== "rational" || (inputs[0].unit !== "ratio" && inputs[1].unit !== "ratio")) throw new Error("RULESPEC_MULTIPLY_REQUIRES_RATIO");
      [kind, unit] = ["rational", inputs[0].unit === "ratio" ? inputs[1].unit : inputs[0].unit];
    } else if (node.operation === "band.lookup") {
      // The selector is a whole count — a seniority year, a headcount. The
      // values are whatever the table holds, but all of one type, because a
      // band lookup that could return money or days depending on the input
      // would be a branch pretending to be a table.
      if (inputs[0].kind !== "integer") throw new Error("RULESPEC_BAND_LOOKUP_INPUT_NOT_INTEGER");
      const values = inputs.slice(1);
      if (values.some((value) => value.kind === "boolean" || value.kind !== values[0].kind || value.unit !== values[0].unit)) throw new Error("RULESPEC_BAND_LOOKUP_VALUE_TYPE_MISMATCH");
      assertContiguous(node.bands, "RULESPEC_BAND_LOOKUP_BANDS_NOT_CONTIGUOUS");
      [kind, unit] = [values[0].kind, values[0].unit];
    } else if (node.operation === "tiered.rate") {
      if (inputs[0].kind !== "integer") throw new Error("RULESPEC_TIERED_RATE_INPUT_NOT_INTEGER");
      if (inputs[1].kind !== "money") throw new Error("RULESPEC_TIERED_RATE_BASE_NOT_MONEY");
      if (inputs.slice(2).some((rate) => rate.kind !== "rational" || rate.unit !== "ratio")) throw new Error("RULESPEC_TIERED_RATE_RATE_NOT_RATIO");
      if (node.tiers[0].from_inclusive < 0) throw new Error("RULESPEC_TIERED_RATE_TIERS_NOT_CONTIGUOUS");
      assertContiguous(node.tiers, "RULESPEC_TIERED_RATE_TIERS_NOT_CONTIGUOUS");
      [kind, unit] = ["money", inputs[1].unit];
    } else {
      if (inputs.length === 0 || inputs.some((input) => input.kind !== inputs[0].kind || input.unit !== inputs[0].unit || input.kind === "boolean")) throw new Error("RULESPEC_UNIT_OR_TYPE_MISMATCH");
      [kind, unit] = [inputs[0].kind, inputs[0].unit];
    }
    const depth = inputs.length === 0 ? 1 : Math.max(...inputs.map((input) => input.depth)) + 1;
    if (depth > parsed.resource_policy.max_depth) throw new Error("RULESPEC_DEPTH_LIMIT_EXCEEDED");
    available.set(node.node_id, { kind, unit, depth });
  }
  if (parsed.nodes.length > parsed.resource_policy.max_steps) throw new Error("RULESPEC_STEP_LIMIT_EXCEEDED");
  if (!available.has(parsed.output_ref)) throw new Error("RULESPEC_OUTPUT_REF_MISSING");
  return frozen(parsed);
}

function roundDivision(numerator: bigint, denominator: bigint, policy: "exact" | "toward_zero" | "half_up" | "half_even") {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === BigInt(0)) return quotient;
  if (policy === "exact") throw new Error("RULESPEC_EXACT_ROUNDING_REQUIRED");
  if (policy === "toward_zero") return quotient;
  const magnitude = remainder < BigInt(0) ? -remainder : remainder;
  const direction = numerator < BigInt(0) ? BigInt(-1) : BigInt(1);
  const doubled = magnitude * BigInt(2);
  if (doubled > denominator || (doubled === denominator && (policy === "half_up" || quotient % BigInt(2) !== BigInt(0)))) return quotient + direction;
  return quotient;
}

export type RuleSpecExecution = Readonly<{ status: "succeeded"; output: RuleSpecInputValue["value"]; trace: readonly Readonly<{ step_id: string; operation: string; input_refs: readonly string[]; result: RuleSpecInputValue["value"] }>[]; trace_sha256: string; result_sha256: string }>;

export type RuleSpecExecutionControl = Readonly<{
  signal?: AbortSignal;
  max_steps?: number;
  locale?: string;
  time_zone?: string;
}>;

export type RuleSpecAtomicOutcome =
  | Readonly<{
    status: "succeeded";
    execution: RuleSpecExecution;
    error_code: null;
    output_visible: true;
    partial_output_visible: false;
  }>
  | Readonly<{
    status: "failed";
    execution: null;
    error_code: string;
    output_visible: false;
    partial_output_visible: false;
  }>;

function assertRuntimeBounds(value: RuntimeValue, maxDigits: number) {
  const integers = value.kind === "rational" ? [value.numerator, value.denominator] : value.kind === "integer" ? [value.value] : value.kind === "money" ? [value.minor_units] : [];
  if (integers.some((integer) => (integer < BigInt(0) ? -integer : integer).toString().length > maxDigits)) throw new Error("RULESPEC_INTEGER_DIGIT_LIMIT_EXCEEDED");
  if (value.kind === "money" && (value.minor_units < BigInt(Number.MIN_SAFE_INTEGER) || value.minor_units > BigInt(Number.MAX_SAFE_INTEGER))) throw new Error("RULESPEC_MONEY_OVERFLOW");
  if (value.kind === "integer" && (value.value < BigInt(Number.MIN_SAFE_INTEGER) || value.value > BigInt(Number.MAX_SAFE_INTEGER))) throw new Error("RULESPEC_INTEGER_OVERFLOW");
}

function executionLimit(rule: RuleSpecPackage, control: RuleSpecExecutionControl | undefined): number {
  const requested = control?.max_steps ?? rule.resource_policy.max_steps;
  if (!Number.isSafeInteger(requested) || requested < 0) throw new Error("RULESPEC_EXECUTION_STEP_LIMIT_INVALID");
  if (control?.locale !== undefined && !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(control.locale)) {
    throw new Error("RULESPEC_EXECUTION_LOCALE_INVALID");
  }
  if (control?.time_zone !== undefined
      && !/^(?:UTC|[A-Za-z_+-]+(?:\/[A-Za-z0-9_+.-]+)+)$/u.test(control.time_zone)) {
    throw new Error("RULESPEC_EXECUTION_TIME_ZONE_INVALID");
  }
  return Math.min(requested, rule.resource_policy.max_steps);
}

function assertNotCancelled(control: RuleSpecExecutionControl | undefined): void {
  if (control?.signal?.aborted === true) throw new Error("RULESPEC_EXECUTION_CANCELLED");
}

export function executeRuleSpec(candidate: Readonly<{
  rule: RuleSpecPackage;
  facts: readonly RuleSpecInputValue[];
  parameters: readonly RuleSpecInputValue[];
  control?: RuleSpecExecutionControl;
}>): RuleSpecExecution {
  const rule = validateRuleSpecPackage(candidate.rule);
  const maximumExecutionSteps = executionLimit(rule, candidate.control);
  assertNotCancelled(candidate.control);
  const values = new Map<string, RuntimeValue>();
  const declared = new Map([...rule.facts, ...rule.parameters].map((entry) => [entry.ref_id, entry]));
  const supplied = [...candidate.facts, ...candidate.parameters].map((entry) => ruleSpecInputValueSchema.parse(entry));
  for (const entry of supplied) {
    assertNotCancelled(candidate.control);
    if (values.has(entry.ref_id)) throw new Error("RULESPEC_INPUT_DUPLICATE");
    const declaration = declared.get(entry.ref_id);
    if (!declaration) throw new Error("RULESPEC_INPUT_UNDECLARED");
    const value = inputValue(entry.value);
    assertRuntimeBounds(value, rule.resource_policy.max_integer_digits);
    const unit = value.kind === "rational" || value.kind === "integer" ? value.unit : value.kind === "money" ? `currency.${value.currency.toLowerCase()}` : null;
    if ((entry.value.kind === "integer" ? "integer" : entry.value.kind) !== declaration.value_kind || unit !== declaration.unit) throw new Error("RULESPEC_INPUT_TYPE_OR_UNIT_MISMATCH");
    values.set(entry.ref_id, value);
  }
  if (values.size !== declared.size) throw new Error("RULESPEC_INPUT_MISSING");
  const trace: Array<{ step_id: string; operation: string; input_refs: readonly string[]; result: RuleSpecInputValue["value"] }> = [];
  for (const [nodeIndex, node] of rule.nodes.entries()) {
    assertNotCancelled(candidate.control);
    if (nodeIndex >= maximumExecutionSteps) throw new Error("RULESPEC_EXECUTION_RESOURCE_LIMIT_EXCEEDED");
    const get = (reference: string) => { const value = values.get(reference); if (!value) throw new Error("RULESPEC_REFERENCE_MISSING"); return value; };
    let result: RuntimeValue;
    if (node.operation === "constant.rational") result = rational(BigInt(node.value), BigInt(1), node.unit);
    else if (node.operation === "add" || node.operation === "aggregate.bounded") {
      const items = node.refs.map(get);
      const first = items[0];
      if (first.kind === "money" && items.every((item) => item.kind === "money" && item.currency === first.currency)) result = { kind: "money", currency: first.currency, minor_units: items.reduce((sum, item) => sum + (item.kind === "money" ? item.minor_units : BigInt(0)), BigInt(0)) };
      else if (first.kind === "integer" && items.every((item) => item.kind === "integer" && item.unit === first.unit)) result = { kind: "integer", value: items.reduce((sum, item) => sum + (item.kind === "integer" ? item.value : BigInt(0)), BigInt(0)), unit: first.unit };
      else if (first.kind === "rational" && items.every((item) => item.kind === "rational" && item.unit === first.unit)) result = items.slice(1).reduce<RuntimeValue>((sum, item) => item.kind === "rational" && sum.kind === "rational" ? rational(sum.numerator * item.denominator + item.numerator * sum.denominator, sum.denominator * item.denominator, sum.unit) : sum, first);
      else throw new Error("RULESPEC_UNIT_OR_TYPE_MISMATCH");
    } else if (node.operation === "multiply") {
      const left = get(node.left_ref); const right = get(node.right_ref);
      if (left.kind !== "rational" || right.kind !== "rational") throw new Error("RULESPEC_MULTIPLY_TYPE_MISMATCH");
      result = rational(left.numerator * right.numerator, left.denominator * right.denominator, left.unit === "ratio" ? right.unit : left.unit);
    } else if (node.operation === "money.scale") {
      const money = get(node.money_ref); const ratio = get(node.rational_ref);
      if (money.kind !== "money" || ratio.kind !== "rational" || ratio.unit !== "ratio") throw new Error("RULESPEC_MONEY_SCALE_TYPE_MISMATCH");
      result = { kind: "money", currency: money.currency, minor_units: roundDivision(money.minor_units * ratio.numerator, ratio.denominator, node.rounding) };
    } else if (node.operation === "compare.gte") result = { kind: "boolean", value: compare(get(node.left_ref), get(node.right_ref)) >= 0 };
    else if (node.operation === "select") {
      const condition = get(node.condition_ref); if (condition.kind !== "boolean") throw new Error("RULESPEC_SELECT_CONDITION_NOT_BOOLEAN");
      result = get(condition.value ? node.when_true_ref : node.when_false_ref);
    } else if (node.operation === "band.lookup") {
      const selector = get(node.input_ref);
      if (selector.kind !== "integer") throw new Error("RULESPEC_BAND_LOOKUP_INPUT_NOT_INTEGER");
      const band = rangeAt(node.bands, selector.value);
      // Fail-closed: a value the table does not cover is not a zero and not the
      // nearest band. The caller gets a refusal and no output at all.
      if (band === null) throw new Error("RULESPEC_BAND_LOOKUP_INPUT_OUT_OF_RANGE");
      const value = values.get(band.value_ref);
      if (!value) throw new Error("RULESPEC_BAND_LOOKUP_VALUE_UNBOUND");
      result = value;
    } else if (node.operation === "tiered.rate") {
      const quantity = get(node.input_ref);
      const base = get(node.base_ref);
      if (quantity.kind !== "integer") throw new Error("RULESPEC_TIERED_RATE_INPUT_NOT_INTEGER");
      if (base.kind !== "money") throw new Error("RULESPEC_TIERED_RATE_BASE_NOT_MONEY");
      const last = node.tiers[node.tiers.length - 1];
      // A tier lookup is not a band lookup, and the difference at the top
      // boundary is deliberate rather than an inconsistency. `band.lookup`
      // selects by a POINT: year 8 against a table ending at 8 is outside it,
      // and refuses. `tiered.rate` accumulates over the INTERVAL [0, quantity):
      // a quantity equal to the last tier's `to_exclusive` has consumed the
      // table exactly, with nothing left over, so it is paid rather than
      // refused. A quantity beyond it has units no tier covers, and refuses.
      if (quantity.value < BigInt(node.tiers[0].from_inclusive)) throw new Error("RULESPEC_TIERED_RATE_INPUT_OUT_OF_RANGE");
      if (last.to_exclusive !== null && quantity.value > BigInt(last.to_exclusive)) throw new Error("RULESPEC_TIERED_RATE_INPUT_OUT_OF_RANGE");
      // Cumulative: every tier is paid for the units that fall inside it, and
      // the sum stays an exact rational until one rounding at the end. Rounding
      // per tier and then adding would make the total depend on how the table
      // happens to be cut up.
      let numerator = BigInt(0);
      let denominator = BigInt(1);
      for (const tier of node.tiers) {
        const rate = values.get(tier.rate_ref);
        if (!rate) throw new Error("RULESPEC_TIERED_RATE_RATE_UNBOUND");
        if (rate.kind !== "rational" || rate.unit !== "ratio") throw new Error("RULESPEC_TIERED_RATE_RATE_NOT_RATIO");
        const ceiling = tier.to_exclusive === null ? quantity.value : BigInt(tier.to_exclusive);
        const units = (ceiling < quantity.value ? ceiling : quantity.value) - BigInt(tier.from_inclusive);
        if (units <= BigInt(0)) continue;
        const addition = units * base.minor_units * rate.numerator;
        numerator = numerator * rate.denominator + addition * denominator;
        denominator = denominator * rate.denominator;
        const divisor = gcd(numerator, denominator);
        if (divisor > BigInt(1)) [numerator, denominator] = [numerator / divisor, denominator / divisor];
        // The running sum is bounded too, not only the rounded result. Thirty-two
        // tiers with coprime denominators multiply, and a policy that is checked
        // only after the division is a policy the intermediate never had to obey.
        assertRuntimeBounds(rational(numerator, denominator, "ratio"), rule.resource_policy.max_integer_digits);
      }
      result = { kind: "money", currency: base.currency, minor_units: roundDivision(numerator, denominator, node.rounding) };
    } else if (node.operation === "min" || node.operation === "max") {
      const items = node.refs.map(get); result = items.slice(1).reduce((selected, item) => node.operation === "min" ? (compare(item, selected) < 0 ? item : selected) : (compare(item, selected) > 0 ? item : selected), items[0]);
    } else assertExhaustive(node);
    assertRuntimeBounds(result, rule.resource_policy.max_integer_digits);
    const rendered = serialized(result);
    values.set(node.node_id, result);
    trace.push({ step_id: node.node_id, operation: node.operation, input_refs: refs(node), result: rendered });
  }
  const outputValue = values.get(rule.output_ref)!;
  assertRuntimeBounds(outputValue, rule.resource_policy.max_integer_digits);
  const output = serialized(outputValue);
  const traceSha256 = legalOperationsSha256(trace);
  return frozen({ status: "succeeded", output, trace, trace_sha256: traceSha256, result_sha256: legalOperationsSha256({ rule: rule.content_sha256, output, trace_sha256: traceSha256 }) });
}

/**
 * Converts every execution failure into a zero-output receipt.  The internal
 * trace is never exposed on cancellation, validation or resource failure.
 */
export function executeRuleSpecAtomic(candidate: Parameters<typeof executeRuleSpec>[0]): RuleSpecAtomicOutcome {
  try {
    return frozen({
      status: "succeeded",
      execution: executeRuleSpec(candidate),
      error_code: null,
      output_visible: true,
      partial_output_visible: false,
    });
  } catch (error) {
    return frozen({
      status: "failed",
      execution: null,
      error_code: error instanceof Error ? error.message : "RULESPEC_EXECUTION_UNKNOWN_FAILURE",
      output_visible: false,
      partial_output_visible: false,
    });
  }
}

export function parameterAsInput(refId: string, candidate: Readonly<{ value: ParameterValue }>): RuleSpecInputValue {
  const value = candidate.value.kind === "money" ? { kind: "money" as const, ...candidate.value.value } : candidate.value;
  return ruleSpecInputValueSchema.parse({ ref_id: refId, value });
}
