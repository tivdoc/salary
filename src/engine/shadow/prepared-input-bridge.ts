// L7-2 / D2. From prepared rule inputs to executor inputs — the only bridge.
//
// `prepareRuleInputs` publishes calculation values (decimal, integer, money)
// with provenance; the RuleSpec executor consumes exact rationals, integers
// with a unit, and money. The bridge converts shape only: a decimal string
// becomes the exact fraction it writes (no floating point), an integer takes
// the unit the mapping declared, money passes through. A preparation that is
// not `ready` yields no inputs at all — there is no partial bridge.
import type { RuleSpecInputValue } from "../legal-operations/rulespec.ts";
import type { RegisteredRuleInputMappingRegistry } from "../rule-input/mapping-registry.ts";
import type { PreparedRuleInputs } from "../rule-input/preparation.ts";
import type { RuleInputValueRef } from "../wave2/contracts.ts";

/** "182" → 182/1; "2.50" → 250/100 reduced to 5/2; "-0.5" → -1/2. */
export function decimalToRational(text: string): { numerator: string; denominator: string } {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(text);
  if (!match) throw new Error(`SHADOW_BRIDGE_DECIMAL_MALFORMED:${text}`);
  const [, sign, whole, fraction = ""] = match;
  let numerator = BigInt(`${whole}${fraction}`);
  let denominator = BigInt(10) ** BigInt(fraction.length);
  const gcd = (a: bigint, b: bigint): bigint => (b === BigInt(0) ? a : gcd(b, a % b));
  const divisor = gcd(numerator, denominator);
  if (divisor > BigInt(1)) {
    numerator /= divisor;
    denominator /= divisor;
  }
  return { numerator: `${sign === "-" && numerator !== BigInt(0) ? "-" : ""}${numerator}`, denominator: `${denominator}` };
}

export function bridgeValueRef(ref: RuleInputValueRef, registry: RegisteredRuleInputMappingRegistry): RuleSpecInputValue {
  const mapping = registry.registry.mappings.find((candidate) => candidate.input_id === ref.input_id);
  if (!mapping) throw new Error(`SHADOW_BRIDGE_MAPPING_MISSING:${ref.input_id}`);
  const expected = mapping.expected_output;
  const value = ref.value;
  if (value.kind === "money") {
    if (expected.kind !== "money" || value.value.currency !== expected.currency) throw new Error(`SHADOW_BRIDGE_KIND_MISMATCH:${ref.input_id}`);
    return { ref_id: ref.input_id, value: { kind: "money", currency: value.value.currency, minor_units: value.value.minor_units } };
  }
  if (value.kind === "integer") {
    if (expected.kind !== "integer") throw new Error(`SHADOW_BRIDGE_KIND_MISMATCH:${ref.input_id}`);
    return { ref_id: ref.input_id, value: { kind: "integer", value: value.value, unit: expected.unit } };
  }
  if (value.kind === "decimal") {
    if (expected.kind !== "rational" || value.unit !== expected.unit) throw new Error(`SHADOW_BRIDGE_KIND_MISMATCH:${ref.input_id}`);
    return { ref_id: ref.input_id, value: { kind: "rational", ...decimalToRational(value.value), unit: expected.unit } };
  }
  throw new Error(`SHADOW_BRIDGE_KIND_UNSUPPORTED:${ref.input_id}:${value.kind}`);
}

/** All executor inputs of a ready preparation, or none. */
export function bridgePreparedInputs(prepared: PreparedRuleInputs, registry: RegisteredRuleInputMappingRegistry): readonly RuleSpecInputValue[] {
  if (prepared.result.status !== "ready") return [];
  return prepared.result.values.map((ref) => bridgeValueRef(ref, registry));
}
