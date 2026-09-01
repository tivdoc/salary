import { frozen, legalOperationsSha256 } from "../legal-operations/canonical.ts";
import {
  executeRuleSpec,
  validateGoldenCaseSet,
  validateRuleSpecPackage,
  type GoldenCaseSet,
  type RuleSpecInputValue,
  type RuleSpecPackage,
} from "../legal-operations/rulespec.ts";

export const RULESPEC_MUTATION_REPORT_SCHEMA = "tivdoc-rulespec-mutation-report-v0.10.0" as const;

export type RuleSpecMutationResult = Readonly<{
  mutation_id: string;
  case_id: string;
  category: "baseline" | "order" | "missing_input" | "duplicate_input" | "undeclared_input" | "unit_type" | "resource_bound" | "content_hash";
  expected: "same_result" | "expected_output" | string;
  observed: "same_result" | "expected_output" | string;
  passed: boolean;
  result_sha256: string | null;
}>;

function errorCode(error: unknown) {
  return error instanceof Error ? error.message : "UNKNOWN_ERROR";
}

function expectedFailure(input: Readonly<{ id: string; case_id: string; category: RuleSpecMutationResult["category"]; expected: string; execute: () => unknown }>): RuleSpecMutationResult {
  try {
    input.execute();
    return frozen({ mutation_id: input.id, case_id: input.case_id, category: input.category, expected: input.expected, observed: "UNEXPECTED_SUCCESS", passed: false, result_sha256: null });
  } catch (error) {
    const observed = errorCode(error);
    return frozen({ mutation_id: input.id, case_id: input.case_id, category: input.category, expected: input.expected, observed, passed: observed === input.expected, result_sha256: null });
  }
}

function wrongTypeOrUnit(value: RuleSpecInputValue): RuleSpecInputValue {
  if (value.value.kind === "money") return frozen({ ...value, value: { ...value.value, currency: value.value.currency === "YYY" ? "ZZZ" : "YYY" } });
  if (value.value.kind === "rational") return frozen({ ...value, value: { ...value.value, unit: "mutation.invalid.unit" } });
  if (value.value.kind === "integer") return frozen({ ...value, value: { ...value.value, unit: "mutation.invalid.unit" } });
  return frozen({ ...value, value: { kind: "rational", numerator: "1", denominator: "1", unit: "ratio" } });
}

function baselineResult(rule: RuleSpecPackage, golden: GoldenCaseSet, testCase: GoldenCaseSet["cases"][number]): RuleSpecMutationResult {
  try {
    const execution = executeRuleSpec({ rule, facts: testCase.facts, parameters: testCase.parameters });
    const replay = executeRuleSpec({ rule, facts: [...testCase.facts].reverse(), parameters: [...testCase.parameters].reverse() });
    const outputMatches = legalOperationsSha256(execution.output) === legalOperationsSha256(testCase.expected_output);
    const deterministic = execution.result_sha256 === replay.result_sha256 && execution.trace_sha256 === replay.trace_sha256;
    return frozen({ mutation_id: `baseline.${testCase.case_id}`, case_id: testCase.case_id, category: "baseline", expected: "expected_output", observed: outputMatches && deterministic ? "expected_output" : outputMatches ? "NONDETERMINISTIC_REPLAY" : "OUTPUT_MISMATCH", passed: outputMatches && deterministic, result_sha256: execution.result_sha256 });
  } catch (error) {
    return frozen({ mutation_id: `baseline.${testCase.case_id}`, case_id: testCase.case_id, category: "baseline", expected: "expected_output", observed: errorCode(error), passed: false, result_sha256: null });
  }
}

export function runRuleSpecMutationSuite(input: Readonly<{ rule: unknown; golden_case_set: unknown }>) {
  const rule = validateRuleSpecPackage(input.rule);
  const golden = validateGoldenCaseSet(input.golden_case_set);
  if (golden.rule_spec_id !== rule.rule_spec_id || golden.rule_spec_version !== rule.rule_spec_version || golden.content_sha256 !== rule.golden_case_set_sha256) throw new Error("RULESPEC_MUTATION_GOLDEN_BINDING_MISMATCH");
  const results: RuleSpecMutationResult[] = [];
  for (const testCase of [...golden.cases].sort((left, right) => left.case_id.localeCompare(right.case_id))) {
    const baseline = executeRuleSpec({ rule, facts: testCase.facts, parameters: testCase.parameters });
    results.push(baselineResult(rule, golden, testCase));
    const reordered = executeRuleSpec({ rule, facts: [...testCase.facts].reverse(), parameters: [...testCase.parameters].reverse() });
    results.push(frozen({ mutation_id: `order.${testCase.case_id}`, case_id: testCase.case_id, category: "order", expected: "same_result", observed: reordered.result_sha256 === baseline.result_sha256 && reordered.trace_sha256 === baseline.trace_sha256 ? "same_result" : "ORDER_DEPENDENT_RESULT", passed: reordered.result_sha256 === baseline.result_sha256 && reordered.trace_sha256 === baseline.trace_sha256, result_sha256: reordered.result_sha256 }));
    const combined = [...testCase.facts, ...testCase.parameters];
    const first = combined[0];
    if (first) {
      const remove = (entries: readonly RuleSpecInputValue[]) => entries.filter((entry) => entry.ref_id !== first.ref_id);
      results.push(expectedFailure({ id: `missing.${testCase.case_id}`, case_id: testCase.case_id, category: "missing_input", expected: "RULESPEC_INPUT_MISSING", execute: () => executeRuleSpec({ rule, facts: remove(testCase.facts), parameters: remove(testCase.parameters) }) }));
      results.push(expectedFailure({ id: `duplicate.${testCase.case_id}`, case_id: testCase.case_id, category: "duplicate_input", expected: "RULESPEC_INPUT_DUPLICATE", execute: () => executeRuleSpec({ rule, facts: [...testCase.facts, first], parameters: testCase.parameters }) }));
      const wrong = wrongTypeOrUnit(first);
      const replace = (entries: readonly RuleSpecInputValue[]) => entries.map((entry) => entry.ref_id === first.ref_id ? wrong : entry);
      results.push(expectedFailure({ id: `unit-type.${testCase.case_id}`, case_id: testCase.case_id, category: "unit_type", expected: "RULESPEC_INPUT_TYPE_OR_UNIT_MISMATCH", execute: () => executeRuleSpec({ rule, facts: replace(testCase.facts), parameters: replace(testCase.parameters) }) }));
    }
    results.push(expectedFailure({ id: `undeclared.${testCase.case_id}`, case_id: testCase.case_id, category: "undeclared_input", expected: "RULESPEC_INPUT_UNDECLARED", execute: () => executeRuleSpec({ rule, facts: [...testCase.facts, { ref_id: "mutation.undeclared.input", value: { kind: "boolean", value: true } }], parameters: testCase.parameters }) }));
    const rational = combined.find((entry) => entry.value.kind === "rational");
    if (rational?.value.kind === "rational") {
      const excessive = frozen({ ...rational, value: { ...rational.value, numerator: "9".repeat(rule.resource_policy.max_integer_digits + 1) } });
      const replace = (entries: readonly RuleSpecInputValue[]) => entries.map((entry) => entry.ref_id === rational.ref_id ? excessive : entry);
      results.push(expectedFailure({ id: `resource-bound.${testCase.case_id}`, case_id: testCase.case_id, category: "resource_bound", expected: "RULESPEC_INTEGER_DIGIT_LIMIT_EXCEEDED", execute: () => executeRuleSpec({ rule, facts: replace(testCase.facts), parameters: replace(testCase.parameters) }) }));
    }
  }
  const tamperedRule = { ...rule, source_version_ids: [...rule.source_version_ids, "mutation.source.version"] };
  results.push(expectedFailure({ id: "content-hash.rule", case_id: "all", category: "content_hash", expected: "RULESPEC_CONTENT_HASH_MISMATCH", execute: () => validateRuleSpecPackage(tamperedRule) }));
  const sorted = [...results].sort((left, right) => left.mutation_id.localeCompare(right.mutation_id));
  const body = {
    schema_version: RULESPEC_MUTATION_REPORT_SCHEMA,
    rule_spec_id: rule.rule_spec_id,
    rule_spec_version: rule.rule_spec_version,
    rule_spec_sha256: rule.content_sha256,
    golden_case_set_id: golden.golden_case_set_id,
    golden_case_set_sha256: golden.content_sha256,
    case_count: golden.cases.length,
    mutation_count: sorted.length,
    results: sorted,
    all_mechanical_checks_passed: sorted.every((result) => result.passed),
    eligible_for_human_review: sorted.every((result) => result.passed),
    activation_allowed: false as const,
    activation_blockers: ["GENUINE_HUMAN_RULE_APPROVAL_REQUIRED", "GENUINE_HUMAN_GOLDEN_APPROVAL_REQUIRED", "EXPLICIT_SIGNED_ACTIVATION_REQUIRED"] as const,
  };
  return frozen({ ...body, report_sha256: legalOperationsSha256(body) });
}
