import { calculationTraceSchema, type CalculationValue } from "../../../engine/calculations/contracts.ts";
import { ruleInputSnapshotSchema } from "../../../engine/wave1/contracts.ts";
import type { RuleInputSnapshot } from "../../../engine/wave2/contracts.ts";
import type { LegalCatalogSelection, RuleSpecExecutionResult, RuleSpecExecutorPort, Wave3Topic } from "../../../engine/wave3/contracts.ts";
import { canonicalLegalOperationsJson, frozen, legalOperationsSha256 } from "../../../engine/legal-operations/canonical.ts";
import { SYNTHETIC_CATALOG_BOUNDARY } from "../../../engine/legal-operations/catalog.ts";
import { executeRuleSpec, type RuleSpecInputValue } from "../../../engine/legal-operations/rulespec.ts";
import { SYNTHETIC_SEVEN_TOPIC_FIXTURES, type SyntheticLegalFixture } from "../../../engine/legal-operations/synthetic-fixtures.ts";

type ExecutionContext = Readonly<{
  topic: Wave3Topic;
  facts: readonly RuleSpecInputValue[];
  parameters: readonly RuleSpecInputValue[];
}>;

function deterministicUuid(seed: unknown) {
  const hash = legalOperationsSha256(seed);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function asCalculationValue(value: RuleSpecInputValue["value"]): CalculationValue {
  if (value.kind === "money") return { kind: "money", value: { currency: value.currency, minor_units: value.minor_units } };
  if (value.kind === "integer") return { kind: "integer", value: value.value };
  if (value.kind === "boolean") return { kind: "boolean", value: value.value };
  return { kind: "text", value: `${value.numerator}/${value.denominator} ${value.unit}` };
}

function fixtureForSelection(selection: LegalCatalogSelection): SyntheticLegalFixture {
  const fixture = SYNTHETIC_SEVEN_TOPIC_FIXTURES.find((entry) => entry.topic === selection.topic);
  if (!fixture) throw new Error("RULESPEC_SYNTHETIC_FIXTURE_MISSING");
  if (selection.rule_spec_id !== fixture.rule.rule_spec_id || selection.rule_spec_version !== fixture.rule.rule_spec_version || !selection.parameter_version_ids.includes(`${fixture.parameter.parameter_id}@${fixture.parameter.parameter_version}`)) throw new Error("RULESPEC_CATALOG_SELECTION_NOT_EXACTLY_PINNED");
  return fixture;
}

/**
 * Process-local exact-snapshot input registry. It deliberately has no database,
 * filesystem, network or implicit-latest path. An absent exact snapshot rejects.
 */
export class LegalOperationsRuleSpecExecutor implements RuleSpecExecutorPort {
  readonly #contexts = new Map<string, ExecutionContext>();

  registerSyntheticContext(snapshotCandidate: RuleInputSnapshot, context: ExecutionContext) {
    const snapshot = ruleInputSnapshotSchema.parse(snapshotCandidate);
    const key = `${context.topic}:${snapshot.snapshot_id}@${snapshot.snapshot_version}:${snapshot.snapshot_sha256}`;
    const byRef = (left: RuleSpecInputValue, right: RuleSpecInputValue) => left.ref_id < right.ref_id ? -1 : left.ref_id > right.ref_id ? 1 : 0;
    const parsed = frozen({
      topic: context.topic,
      facts: context.facts.map((entry) => entry).sort(byRef),
      parameters: context.parameters.map((entry) => entry).sort(byRef),
    });
    const existing = this.#contexts.get(key);
    if (existing && legalOperationsSha256(existing) !== legalOperationsSha256(parsed)) throw new Error("RULE_INPUT_SNAPSHOT_CONTEXT_MUTATION_REJECTED");
    this.#contexts.set(key, parsed);
    return frozen({ snapshot, context_sha256: legalOperationsSha256(parsed), idempotent_replay: existing !== undefined });
  }

  registerFixtureSnapshot(topic: Wave3Topic, snapshot: RuleInputSnapshot) {
    const fixture = SYNTHETIC_SEVEN_TOPIC_FIXTURES.find((entry) => entry.topic === topic);
    if (!fixture) throw new Error("RULESPEC_SYNTHETIC_FIXTURE_MISSING");
    return this.registerSyntheticContext(snapshot, { topic, facts: fixture.facts, parameters: fixture.parameters });
  }

  async execute(input: Readonly<{ selection: LegalCatalogSelection; rule_input: RuleInputSnapshot; execution_id: string; calculated_at: string }>): Promise<RuleSpecExecutionResult> {
    const snapshot = ruleInputSnapshotSchema.parse(input.rule_input);
    if (input.selection.mode !== "synthetic_test" || input.selection.catalog_id !== SYNTHETIC_CATALOG_BOUNDARY.catalog_id || input.selection.readiness.status !== "READY" || !input.selection.readiness.usable_for_rules) throw new Error("RULESPEC_EXECUTION_CATALOG_NOT_READY_OR_FORBIDDEN");
    const fixture = fixtureForSelection(input.selection);
    const key = `${input.selection.topic}:${snapshot.snapshot_id}@${snapshot.snapshot_version}:${snapshot.snapshot_sha256}`;
    const context = this.#contexts.get(key);
    if (!context) throw new Error("RULE_INPUT_EXACT_SNAPSHOT_CONTEXT_MISSING");
    if (context.topic !== input.selection.topic) throw new Error("RULE_INPUT_TOPIC_MISMATCH");
    const execution = executeRuleSpec({ rule: fixture.rule, facts: context.facts, parameters: context.parameters });
    const inputs = [...context.facts, ...context.parameters].map((entry, index) => ({
      input_id: entry.ref_id,
      fact_id: deterministicUuid({ snapshot: snapshot.snapshot_sha256, ref: entry.ref_id, index }),
      fact_path: index === 0 ? "work.regular_hours" as const : "compensation.base_monthly_salary" as const,
      value: asCalculationValue(entry.value),
    }));
    const steps = execution.trace.map((step) => ({
      step_id: step.step_id,
      operation: step.operation,
      input_refs: [...step.input_refs],
      result: asCalculationValue(step.result),
      explanation: "Deterministic synthetic-test RuleSpec operation; no legal meaning is assigned.",
    }));
    const trace = calculationTraceSchema.parse({
      calculation_id: deterministicUuid({ execution_id: input.execution_id, snapshot: snapshot.snapshot_sha256, rule: fixture.rule.content_sha256 }),
      formula_id: `synthetic.formula.${fixture.topic}`,
      formula_version: fixture.rule.rule_spec_version,
      rule: { rule_id: fixture.rule.rule_spec_id, rule_version: fixture.rule.rule_spec_version },
      engine_version: "6.0.0",
      inputs,
      steps,
      output: asCalculationValue(execution.output),
      calculated_at: input.calculated_at,
    });
    const amount = execution.output.kind === "money" ? { currency: execution.output.currency, minor_units: execution.output.minor_units } : null;
    return frozen({
      topic: fixture.topic,
      rule_spec_id: fixture.rule.rule_spec_id,
      rule_spec_version: fixture.rule.rule_spec_version,
      amount,
      trace,
      result_sha256: legalOperationsSha256({ selection_sha256: input.selection.catalog_sha256, rule_input: snapshot, execution: JSON.parse(canonicalLegalOperationsJson(execution)), trace }),
    });
  }
}
