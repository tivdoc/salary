import type { CalculationValue } from "../calculations/contracts.ts";
import {
  ruleExecutionResultSchema,
  type LegalEvidenceRef,
  type RuleExecutionRequest,
} from "../wave1/contracts.ts";
import { canonicalSha256, deepFreeze } from "./canonical.ts";
import {
  runtimeExecutionEnvelopeSchema,
  runtimeExecutionInputSchema,
  runtimeExecutionPolicySchema,
  syntheticCalculationTraceSchema,
  type RuntimeExecutionEnvelope,
  type RuntimeExecutionInput,
  type RuntimeExecutionPolicy,
  type RuntimeFactInput,
  type RuntimeOperation,
  type SyntheticCalculationTrace,
  type SyntheticRuleDefinition,
} from "./contracts.ts";
import {
  addExactDecimals,
  addMoneyMinorUnits,
  formatExactDecimal,
  multiplyExactDecimals,
  parseExactDecimal,
  roundExactDecimal,
} from "./decimal.ts";
import { SyntheticRuleRegistry, type RegisteredSyntheticRule } from "./registry.ts";

export interface RuntimeCancellation {
  isCancelled(): boolean;
}

type RejectionStatus = "rejected" | "cancelled";

const ENGINE_VERSION = "1.0.0";

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameSnapshot(
  left: RuntimeFactInput["snapshot"],
  right: RuleExecutionRequest["input_snapshot"],
): boolean {
  return (
    left.snapshot_id === right.snapshot_id &&
    left.snapshot_version === right.snapshot_version &&
    left.snapshot_sha256 === right.snapshot_sha256
  );
}

function sortEvidence(evidence: readonly LegalEvidenceRef[]): readonly LegalEvidenceRef[] {
  return [...evidence].sort((left, right) =>
    compareStrings(
      `${left.source_id}\u0000${left.source_version_id}\u0000${left.artifact_sha256}`,
      `${right.source_id}\u0000${right.source_version_id}\u0000${right.artifact_sha256}`,
    ),
  );
}

function reject(
  request: RuleExecutionRequest,
  status: RejectionStatus,
  codes: readonly string[],
): RuntimeExecutionEnvelope {
  const result = ruleExecutionResultSchema.parse({
    request_id: request.request_id,
    rule_id: request.rule_id,
    rule_version: request.rule_version,
    status,
    trace_id: null,
    output_hash: null,
    rejection_codes: [...new Set(codes)].sort(compareStrings),
    completed_at: request.requested_at,
  });
  return deepFreeze(runtimeExecutionEnvelopeSchema.parse({ result, trace: null }));
}

function decimalFrom(value: CalculationValue): { value: string; unit: string } {
  if (value.kind !== "decimal") {
    throw new TypeError("runtime_value_kind_mismatch");
  }
  return value;
}

function moneyFrom(value: CalculationValue): { currency: string; minor_units: number } {
  if (value.kind !== "money") {
    throw new TypeError("runtime_value_kind_mismatch");
  }
  return value.value;
}

function decimalDigitCount(value: string): number {
  return value.replace(/[-.]/g, "").length;
}

function checkFacts(
  definition: SyntheticRuleDefinition,
  input: RuntimeExecutionInput,
  policy: RuntimeExecutionPolicy,
): readonly string[] {
  const codes: string[] = [];
  if (input.facts.length > policy.max_inputs || definition.inputs.length > policy.max_inputs) {
    codes.push("RESOURCE_INPUT_LIMIT_EXCEEDED");
  }
  if (definition.operations.length > policy.max_steps) {
    codes.push("RESOURCE_STEP_LIMIT_EXCEEDED");
  }

  const facts = new Map<string, RuntimeFactInput>();
  for (const fact of input.facts) {
    if (facts.has(fact.input_id)) {
      codes.push("FACT_INPUT_DUPLICATE");
    } else {
      facts.set(fact.input_id, fact);
    }
  }
  const requirements = new Map(definition.inputs.map((required) => [required.input_id, required]));
  for (const fact of input.facts) {
    if (!requirements.has(fact.input_id)) {
      codes.push("FACT_INPUT_UNEXPECTED");
    }
  }

  for (const required of definition.inputs) {
    const fact = facts.get(required.input_id);
    if (fact === undefined) {
      codes.push("FACT_MISSING");
      continue;
    }
    if (fact.fact_path !== required.fact_path) {
      codes.push("FACT_PATH_MISMATCH");
    }
    if (!sameSnapshot(fact.snapshot, input.request.input_snapshot)) {
      codes.push("FACT_SNAPSHOT_MISMATCH");
    }
    if (fact.status === "missing") {
      codes.push("FACT_MISSING");
    } else if (fact.status === "conflicted") {
      codes.push("FACT_CONFLICTED");
    } else if (fact.status !== "confirmed") {
      codes.push("FACT_UNCONFIRMED");
    }
    if (fact.confidence_basis_points < policy.minimum_confidence_basis_points) {
      codes.push("FACT_LOW_CONFIDENCE");
    }
    if (fact.value === null) {
      continue;
    }
    if (fact.value.kind !== required.value_kind) {
      codes.push("FACT_VALUE_KIND_MISMATCH");
      continue;
    }
    if (fact.value.kind === "decimal") {
      if (fact.value.unit !== required.unit) {
        codes.push("FACT_VALUE_UNIT_MISMATCH");
      }
      if (decimalDigitCount(fact.value.value) > policy.max_decimal_digits) {
        codes.push("RESOURCE_DECIMAL_DIGIT_LIMIT_EXCEEDED");
      }
    } else if (fact.value.kind === "money" && fact.value.value.currency !== required.currency) {
      codes.push("FACT_VALUE_CURRENCY_MISMATCH");
    }
  }
  return codes;
}

function checkEvidence(
  definition: SyntheticRuleDefinition,
  evidence: readonly LegalEvidenceRef[],
): readonly string[] {
  const codes: string[] = [];
  for (const reference of evidence) {
    if (reference.review_state !== "reviewed" || reference.activation_state !== "active") {
      codes.push("LEGAL_EVIDENCE_NOT_REVIEWED_ACTIVE");
    }
  }
  const supplied = new Set(
    evidence.map((reference) => `${reference.source_id}\u0000${reference.source_version_id}`),
  );
  if (supplied.size !== evidence.length) {
    codes.push("LEGAL_EVIDENCE_DUPLICATE");
  }
  for (const requirement of definition.required_legal_evidence) {
    if (!supplied.has(`${requirement.source_id}\u0000${requirement.source_version_id}`)) {
      codes.push("LEGAL_EVIDENCE_REQUIRED");
    }
  }
  return codes;
}

function operationExpression(operation: RuntimeOperation): string {
  switch (operation.operation) {
    case "decimal.add":
      return `${operation.step_id}=add(${operation.left_ref},${operation.right_ref})`;
    case "decimal.multiply":
      return `${operation.step_id}=multiply(${operation.left_ref},${operation.right_ref})`;
    case "money.add":
      return `${operation.step_id}=money_add(${operation.left_ref},${operation.right_ref})`;
    case "decimal.round":
      return `${operation.step_id}=round(${operation.input_ref},scale=${operation.scale},mode=${operation.mode})`;
  }
}

function evaluateOperation(
  operation: RuntimeOperation,
  values: ReadonlyMap<string, CalculationValue>,
): {
  readonly value: CalculationValue;
  readonly inputRefs: readonly string[];
  readonly rounding: ReturnType<typeof roundExactDecimal>["trace"] | null;
} {
  if (operation.operation === "decimal.round") {
    const source = values.get(operation.input_ref);
    if (source === undefined) throw new TypeError("runtime_reference_missing");
    const decimal = decimalFrom(source);
    const rounded = roundExactDecimal(parseExactDecimal(decimal.value), operation.scale, operation.mode);
    return {
      value: {
        kind: "decimal",
        value: formatExactDecimal(rounded.value),
        unit: operation.result_unit,
      },
      inputRefs: [operation.input_ref],
      rounding: rounded.trace,
    };
  }

  const left = values.get(operation.left_ref);
  const right = values.get(operation.right_ref);
  if (left === undefined || right === undefined) throw new TypeError("runtime_reference_missing");
  if (operation.operation === "money.add") {
    return {
      value: { kind: "money", value: addMoneyMinorUnits(moneyFrom(left), moneyFrom(right)) },
      inputRefs: [operation.left_ref, operation.right_ref],
      rounding: null,
    };
  }

  const leftDecimal = decimalFrom(left);
  const rightDecimal = decimalFrom(right);
  const computed =
    operation.operation === "decimal.add"
      ? addExactDecimals(parseExactDecimal(leftDecimal.value), parseExactDecimal(rightDecimal.value))
      : multiplyExactDecimals(parseExactDecimal(leftDecimal.value), parseExactDecimal(rightDecimal.value));
  return {
    value: { kind: "decimal", value: formatExactDecimal(computed), unit: operation.result_unit },
    inputRefs: [operation.left_ref, operation.right_ref],
    rounding: null,
  };
}

function buildTrace(
  input: RuntimeExecutionInput,
  registered: RegisteredSyntheticRule,
  policy: RuntimeExecutionPolicy,
  cancellation?: RuntimeCancellation,
): SyntheticCalculationTrace | null {
  const definition = registered.definition;
  const orderedFacts = [...input.facts].sort((left, right) => compareStrings(left.input_id, right.input_id));
  const values = new Map<string, CalculationValue>();
  for (const fact of orderedFacts) {
    if (fact.value === null) throw new TypeError("runtime_fact_value_missing");
    values.set(fact.input_id, fact.value);
  }

  const steps: Array<Record<string, unknown>> = [];
  for (const operation of definition.operations) {
    if (cancellation?.isCancelled()) return null;
    const evaluated = evaluateOperation(operation, values);
    if (evaluated.value.kind === "decimal" && decimalDigitCount(evaluated.value.value) > policy.max_decimal_digits) {
      throw new RangeError("runtime_decimal_digit_limit_exceeded");
    }
    values.set(operation.step_id, evaluated.value);
    steps.push({
      step_id: operation.step_id,
      operation: operation.operation,
      input_refs: evaluated.inputRefs,
      result: evaluated.value,
      explanation: "Deterministic synthetic operation; no legal interpretation.",
      formula_expression: operationExpression(operation),
      rounding: evaluated.rounding,
    });
  }

  const output = values.get(definition.output_ref);
  if (output === undefined) throw new TypeError("runtime_output_missing");
  const normalizedInputs = orderedFacts.map((fact) => ({
    input_id: fact.input_id,
    fact_id: fact.fact_id,
    fact_path: fact.fact_path,
    value: fact.value,
    provenance: [...fact.provenance].sort((left, right) =>
      compareStrings(left.provenance_id, right.provenance_id),
    ),
    snapshot: fact.snapshot,
  }));
  const normalizedEvidence = sortEvidence(input.request.legal_evidence);
  const traceSeed = canonicalSha256({
    request: { ...input.request, legal_evidence: normalizedEvidence },
    rule_content_sha256: registered.content_sha256,
    inputs: normalizedInputs,
  });
  const trace = syntheticCalculationTraceSchema.parse({
    runtime_kind: "synthetic_only",
    calculation_id: `calc:${traceSeed.slice(0, 64)}`,
    formula_id: definition.formula_id,
    formula_version: definition.formula_version,
    rule: { rule_id: definition.rule_id, rule_version: definition.rule_version },
    engine_version: ENGINE_VERSION,
    inputs: normalizedInputs,
    steps,
    output,
    calculated_at: input.request.requested_at,
    legal_evidence: normalizedEvidence,
    rule_content_sha256: registered.content_sha256,
    execution_policy_version: policy.policy_version,
  });
  return deepFreeze(trace);
}

export class DeterministicSyntheticRuleRuntime {
  readonly #registry: SyntheticRuleRegistry;
  readonly #policy: RuntimeExecutionPolicy;

  constructor(registry: SyntheticRuleRegistry, policy: RuntimeExecutionPolicy) {
    this.#registry = registry;
    this.#policy = deepFreeze(runtimeExecutionPolicySchema.parse(policy));
  }

  execute(candidate: RuntimeExecutionInput, cancellation?: RuntimeCancellation): RuntimeExecutionEnvelope {
    const input = runtimeExecutionInputSchema.parse(candidate);
    const request = input.request;
    if (cancellation?.isCancelled()) {
      return reject(request, "cancelled", ["EXECUTION_CANCELLED"]);
    }
    if (request.execution_policy_version !== this.#policy.policy_version) {
      return reject(request, "rejected", ["EXECUTION_POLICY_VERSION_MISMATCH"]);
    }
    const registered = this.#registry.get(request.rule_id, request.rule_version);
    if (registered === null) {
      return reject(request, "rejected", ["RULE_VERSION_NOT_FOUND"]);
    }

    const rejectionCodes = [
      ...checkFacts(registered.definition, input, this.#policy),
      ...checkEvidence(registered.definition, request.legal_evidence),
    ];
    if (rejectionCodes.length > 0) {
      return reject(request, "rejected", rejectionCodes);
    }

    try {
      const trace = buildTrace(input, registered, this.#policy, cancellation);
      if (trace === null) {
        return reject(request, "cancelled", ["EXECUTION_CANCELLED"]);
      }
      const outputHash = canonicalSha256(trace);
      const result = ruleExecutionResultSchema.parse({
        request_id: request.request_id,
        rule_id: request.rule_id,
        rule_version: request.rule_version,
        status: "succeeded",
        trace_id: `trace:${outputHash}`,
        output_hash: outputHash,
        rejection_codes: [],
        completed_at: request.requested_at,
      });
      return deepFreeze(runtimeExecutionEnvelopeSchema.parse({ result, trace }));
    } catch (error) {
      const code =
        error instanceof RangeError && error.message === "runtime_decimal_digit_limit_exceeded"
          ? "RESOURCE_DECIMAL_DIGIT_LIMIT_EXCEEDED"
          : "DETERMINISTIC_EXECUTION_FAILED";
      return reject(request, "rejected", [code]);
    }
  }
}
