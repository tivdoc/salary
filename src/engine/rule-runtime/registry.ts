import { canonicalSha256, deepFreeze } from "./canonical.ts";
import {
  syntheticRuleDefinitionSchema,
  type SyntheticRuleDefinition,
} from "./contracts.ts";

export interface RegisteredSyntheticRule {
  readonly definition: SyntheticRuleDefinition;
  readonly content_sha256: string;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateDefinitionGraph(definition: SyntheticRuleDefinition): void {
  const available = new Set<string>();
  for (const input of definition.inputs) {
    if (available.has(input.input_id)) {
      throw new TypeError(`duplicate_runtime_reference:${input.input_id}`);
    }
    available.add(input.input_id);
  }

  for (const operation of definition.operations) {
    if (available.has(operation.step_id)) {
      throw new TypeError(`duplicate_runtime_reference:${operation.step_id}`);
    }
    const refs =
      operation.operation === "decimal.round"
        ? [operation.input_ref]
        : [operation.left_ref, operation.right_ref];
    for (const reference of refs) {
      if (!available.has(reference)) {
        throw new TypeError(`runtime_reference_not_available:${reference}`);
      }
    }
    available.add(operation.step_id);
  }

  if (!available.has(definition.output_ref)) {
    throw new TypeError(`runtime_output_not_available:${definition.output_ref}`);
  }

  const evidenceKeys = definition.required_legal_evidence.map(
    (reference) => `${reference.source_id}\u0000${reference.source_version_id}`,
  );
  if (new Set(evidenceKeys).size !== evidenceKeys.length) {
    throw new TypeError("duplicate_legal_evidence_requirement");
  }
}

function normalizeDefinition(definition: SyntheticRuleDefinition): SyntheticRuleDefinition {
  return syntheticRuleDefinitionSchema.parse({
    ...definition,
    inputs: [...definition.inputs].sort((left, right) => compareStrings(left.input_id, right.input_id)),
    required_legal_evidence: [...definition.required_legal_evidence].sort((left, right) =>
      compareStrings(
        `${left.source_id}\u0000${left.source_version_id}`,
        `${right.source_id}\u0000${right.source_version_id}`,
      ),
    ),
  });
}

export class SyntheticRuleRegistry {
  readonly #rules = new Map<string, RegisteredSyntheticRule>();

  constructor(definitions: readonly SyntheticRuleDefinition[]) {
    for (const candidate of definitions) {
      const definition = normalizeDefinition(syntheticRuleDefinitionSchema.parse(candidate));
      validateDefinitionGraph(definition);
      const key = SyntheticRuleRegistry.key(definition.rule_id, definition.rule_version);
      if (this.#rules.has(key)) {
        throw new TypeError(`duplicate_rule_version:${key}`);
      }
      const registered = deepFreeze({
        definition,
        content_sha256: canonicalSha256(definition),
      });
      this.#rules.set(key, registered);
    }
  }

  static key(ruleId: string, ruleVersion: string): string {
    return `${ruleId}@${ruleVersion}`;
  }

  get(ruleId: string, ruleVersion: string): RegisteredSyntheticRule | null {
    return this.#rules.get(SyntheticRuleRegistry.key(ruleId, ruleVersion)) ?? null;
  }

  list(): readonly RegisteredSyntheticRule[] {
    return deepFreeze(
      [...this.#rules.values()].sort((left, right) =>
        compareStrings(
          SyntheticRuleRegistry.key(left.definition.rule_id, left.definition.rule_version),
          SyntheticRuleRegistry.key(right.definition.rule_id, right.definition.rule_version),
        ),
      ),
    );
  }
}
