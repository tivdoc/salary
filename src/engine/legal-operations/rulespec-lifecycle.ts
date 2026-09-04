import { z } from "zod";

import { isoTimestampSchema, versionSchema } from "../domain/primitives.ts";
import { canonicalLegalOperationsJson, frozen, legalOperationsSha256 } from "./canonical.ts";
import {
  dependencyBindingsSchema,
  legalOperationsIdSchema,
  legalOperationsSha256Schema,
  type DependencyBindings,
} from "./contracts.ts";
import {
  refs as ruleSpecNodeInputRefs,
  validateGoldenCaseSet,
  validateRuleSpecPackage,
  type GoldenCaseSet,
  type RuleSpecPackage,
} from "./rulespec.ts";

export const RULESPEC_DEPENDENCY_MANIFEST_SCHEMA =
  "tivdoc-rulespec-dependency-manifest-v0.10.2" as const;
export const RULESPEC_DECISION_REFERENCE_SCHEMA =
  "tivdoc-rulespec-signed-decision-reference-v0.10.2" as const;
export const RULESPEC_LIFECYCLE_SCHEMA = "tivdoc-rulespec-lifecycle-v0.10.2" as const;

export const RULESPEC_DEPENDENCY_DIMENSIONS = Object.freeze([
  "source_versions",
  "effective_period",
  "sectors",
  "populations",
  "parameter_versions",
  "golden_case_set",
  "resource_policy",
  "operation_graph",
] as const);

export type RuleSpecDependencyDimension = typeof RULESPEC_DEPENDENCY_DIMENSIONS[number];

const parameterVersionSchema = z.object({
  ref_id: legalOperationsIdSchema,
  parameter_id: legalOperationsIdSchema,
  parameter_version: versionSchema,
  value_kind: z.enum(["rational", "money", "integer", "boolean"]),
  unit: legalOperationsIdSchema.nullable(),
}).strict().readonly();

const dependencyDigestsSchema = z.object({
  source_versions_sha256: legalOperationsSha256Schema,
  effective_period_sha256: legalOperationsSha256Schema,
  sectors_sha256: legalOperationsSha256Schema,
  populations_sha256: legalOperationsSha256Schema,
  parameter_versions_sha256: legalOperationsSha256Schema,
  golden_case_set_sha256: legalOperationsSha256Schema,
  resource_policy_sha256: legalOperationsSha256Schema,
  operation_graph_sha256: legalOperationsSha256Schema,
}).strict().readonly();

const dependencyManifestBodyFields = {
  schema_version: z.literal(RULESPEC_DEPENDENCY_MANIFEST_SCHEMA),
  rule_spec_id: legalOperationsIdSchema,
  rule_spec_version: versionSchema,
  rule_spec_sha256: legalOperationsSha256Schema,
  source_version_ids: z.array(legalOperationsIdSchema).min(1).readonly(),
  effective_period: z.object({ from: z.iso.date(), to: z.iso.date().nullable() }).strict().readonly(),
  sectors: z.array(legalOperationsIdSchema).min(1).readonly(),
  populations: z.array(legalOperationsIdSchema).min(1).readonly(),
  parameter_versions: z.array(parameterVersionSchema).readonly(),
  golden_case_set_sha256: legalOperationsSha256Schema,
  resource_policy: z.object({
    max_steps: z.number().int().positive(),
    max_depth: z.number().int().positive(),
    max_aggregate_items: z.number().int().positive(),
    max_integer_digits: z.number().int().positive(),
  }).strict().readonly(),
  operation_graph: z.array(z.object({
    node_id: legalOperationsIdSchema,
    operation: z.string().min(1).max(64),
    input_refs: z.array(legalOperationsIdSchema).readonly(),
    node_sha256: legalOperationsSha256Schema,
  }).strict().readonly()).min(1).readonly(),
  dimension_digests: dependencyDigestsSchema,
} as const;

const dependencyManifestBodySchema = z.object(dependencyManifestBodyFields).strict().readonly();

export const ruleSpecDependencyManifestSchema = z.object({
  ...dependencyManifestBodyFields,
  manifest_sha256: legalOperationsSha256Schema,
}).strict().readonly();

const successorSchema = z.object({
  rule_spec_id: legalOperationsIdSchema,
  rule_spec_version: versionSchema,
  rule_spec_sha256: legalOperationsSha256Schema,
  dependency_manifest_sha256: legalOperationsSha256Schema,
}).strict().readonly();

const decisionReferenceBodyFields = {
  schema_version: z.literal(RULESPEC_DECISION_REFERENCE_SCHEMA),
  reference_id: legalOperationsIdSchema,
  reference_version: versionSchema,
  decision_kind: z.enum([
    "rule_semantics_approval",
    "golden_case_outputs_approval",
    "rulespec_supersession",
    "rulespec_revocation",
  ]),
  trust_boundary: z.enum(["synthetic_test_only", "verified_reviewer_trust_boundary"]),
  verification_status: z.enum(["synthetic_fixture_not_human", "signature_verified_externally"]),
  rule_spec_id: legalOperationsIdSchema,
  rule_spec_version: versionSchema,
  rule_spec_sha256: legalOperationsSha256Schema,
  dependency_manifest_sha256: legalOperationsSha256Schema,
  golden_case_set_sha256: legalOperationsSha256Schema,
  reviewer_id: legalOperationsIdSchema,
  reviewer_role: z.enum([
    "human_rule_reviewer",
    "human_golden_case_reviewer",
    "human_activation_approver",
  ]),
  envelope_sha256: legalOperationsSha256Schema,
  signature_sha256: legalOperationsSha256Schema,
  decided_at: isoTimestampSchema,
  successor: successorSchema.nullable(),
  activation_allowed: z.literal(false),
} as const;

type DecisionReferenceBody = {
  [Key in keyof typeof decisionReferenceBodyFields]: z.infer<(typeof decisionReferenceBodyFields)[Key]>;
};

function refineDecisionReference(
  reference: DecisionReferenceBody,
  context: z.RefinementCtx,
): void {
  const synthetic = reference.trust_boundary === "synthetic_test_only";
  if (synthetic !== (reference.verification_status === "synthetic_fixture_not_human")) {
    context.addIssue({ code: "custom", message: "rulespec_reference_trust_status_mismatch" });
  }
  if (synthetic && !reference.reviewer_id.startsWith("syn.")) {
    context.addIssue({ code: "custom", message: "rulespec_synthetic_reference_identity_invalid" });
  }
  const supersession = reference.decision_kind === "rulespec_supersession";
  if (supersession !== (reference.successor !== null)) {
    context.addIssue({ code: "custom", message: "rulespec_reference_successor_binding_invalid" });
  }
  if (reference.decision_kind === "rule_semantics_approval"
      && reference.reviewer_role !== "human_rule_reviewer") {
    context.addIssue({ code: "custom", message: "rulespec_semantics_reference_role_invalid" });
  }
  if (reference.decision_kind === "golden_case_outputs_approval"
      && reference.reviewer_role !== "human_golden_case_reviewer") {
    context.addIssue({ code: "custom", message: "rulespec_golden_reference_role_invalid" });
  }
  if (["rulespec_supersession", "rulespec_revocation"].includes(reference.decision_kind)
      && reference.reviewer_role !== "human_activation_approver") {
    context.addIssue({ code: "custom", message: "rulespec_terminal_reference_role_invalid" });
  }
}

export const ruleSpecDecisionReferenceSchema = z.object({
  ...decisionReferenceBodyFields,
  reference_sha256: legalOperationsSha256Schema,
}).strict().superRefine(refineDecisionReference).readonly();

export type RuleSpecDependencyManifest = z.infer<typeof ruleSpecDependencyManifestSchema>;
export type RuleSpecDecisionReference = z.infer<typeof ruleSpecDecisionReferenceSchema>;
export type RuleSpecLifecycleState =
  | "draft"
  | "dependencies_bound"
  | "golden_ready"
  | "legal_approval"
  | "shadow_eligible"
  | "superseded"
  | "revoked";

export type RuleSpecLifecycleEvent = Readonly<{
  schema_version: typeof RULESPEC_LIFECYCLE_SCHEMA;
  sequence: number;
  event_id: string;
  event_kind:
    | "draft_registered"
    | "dependencies_bound"
    | "golden_ready"
    | "approval_references_recorded"
    | "shadow_eligible"
    | "superseded"
    | "revoked";
  rule_spec_id: string;
  rule_spec_version: string;
  rule_spec_sha256: string;
  prior_state: "unregistered" | RuleSpecLifecycleState;
  state: RuleSpecLifecycleState;
  dependency_manifest_sha256: string | null;
  dependency_bindings_sha256: string | null;
  golden_case_set_sha256: string;
  decision_reference_sha256s: readonly string[];
  detail_sha256: string;
  occurred_at: string;
  command_id: string;
  activation_allowed: false;
  product_execution_allowed: false;
  prior_event_sha256: string | null;
  event_sha256: string;
}>;

type CommandMetadata = Readonly<{
  command_id: string;
  occurred_at: string;
}>;

function sortedUnique(values: readonly string[], code: string): readonly string[] {
  const sorted = [...values].sort();
  if (new Set(sorted).size !== sorted.length) throw new Error(code);
  return Object.freeze(sorted);
}

/**
 * The dependency manifest sorts the same refs the executor walks. This used to
 * be a second copy of `refs()` whose fall-through returned `[]`, which meant a
 * node kind added to the executor and forgotten here would ship an empty
 * `input_refs` into `operation_graph_sha256` without anything failing. There is
 * one function now, and it is exhaustive.
 */
function inputRefs(node: RuleSpecPackage["nodes"][number]): readonly string[] {
  return [...ruleSpecNodeInputRefs(node)].sort();
}

function manifestBody(rule: RuleSpecPackage) {
  const sourceVersionIds = sortedUnique(rule.source_version_ids, "RULESPEC_SOURCE_VERSION_DUPLICATED");
  const sectors = sortedUnique(rule.sectors, "RULESPEC_SECTOR_DUPLICATED");
  const populations = sortedUnique(rule.populations, "RULESPEC_POPULATION_DUPLICATED");
  const parameterVersions = [...rule.parameters].map((parameter) => ({
    ref_id: parameter.ref_id,
    parameter_id: parameter.parameter_id,
    parameter_version: parameter.parameter_version,
    value_kind: parameter.value_kind,
    unit: parameter.unit,
  })).sort((left, right) => left.ref_id.localeCompare(right.ref_id));
  const operationGraph = rule.nodes.map((node) => ({
    node_id: node.node_id,
    operation: node.operation,
    input_refs: inputRefs(node),
    node_sha256: legalOperationsSha256(node),
  }));
  const dimensions = {
    source_versions_sha256: legalOperationsSha256(sourceVersionIds),
    effective_period_sha256: legalOperationsSha256(rule.effective_period),
    sectors_sha256: legalOperationsSha256(sectors),
    populations_sha256: legalOperationsSha256(populations),
    parameter_versions_sha256: legalOperationsSha256(parameterVersions),
    golden_case_set_sha256: legalOperationsSha256(rule.golden_case_set_sha256),
    resource_policy_sha256: legalOperationsSha256(rule.resource_policy),
    operation_graph_sha256: legalOperationsSha256(operationGraph),
  };
  return dependencyManifestBodySchema.parse({
    schema_version: RULESPEC_DEPENDENCY_MANIFEST_SCHEMA,
    rule_spec_id: rule.rule_spec_id,
    rule_spec_version: rule.rule_spec_version,
    rule_spec_sha256: rule.content_sha256,
    source_version_ids: sourceVersionIds,
    effective_period: rule.effective_period,
    sectors,
    populations,
    parameter_versions: parameterVersions,
    golden_case_set_sha256: rule.golden_case_set_sha256,
    resource_policy: rule.resource_policy,
    operation_graph: operationGraph,
    dimension_digests: dimensions,
  });
}

export function createRuleSpecDependencyManifest(candidate: unknown): RuleSpecDependencyManifest {
  const rule = validateRuleSpecPackage(candidate);
  const body = manifestBody(rule);
  return frozen(ruleSpecDependencyManifestSchema.parse({
    ...body,
    manifest_sha256: legalOperationsSha256(body),
  }));
}

export function validateRuleSpecDependencyManifest(candidate: unknown): RuleSpecDependencyManifest {
  const parsed = ruleSpecDependencyManifestSchema.parse(candidate);
  const { manifest_sha256: expected, ...body } = parsed;
  if (legalOperationsSha256(body) !== expected) throw new Error("RULESPEC_DEPENDENCY_MANIFEST_HASH_MISMATCH");
  const dimensions = {
    source_versions_sha256: legalOperationsSha256(parsed.source_version_ids),
    effective_period_sha256: legalOperationsSha256(parsed.effective_period),
    sectors_sha256: legalOperationsSha256(parsed.sectors),
    populations_sha256: legalOperationsSha256(parsed.populations),
    parameter_versions_sha256: legalOperationsSha256(parsed.parameter_versions),
    golden_case_set_sha256: legalOperationsSha256(parsed.golden_case_set_sha256),
    resource_policy_sha256: legalOperationsSha256(parsed.resource_policy),
    operation_graph_sha256: legalOperationsSha256(parsed.operation_graph),
  };
  if (legalOperationsSha256(dimensions) !== legalOperationsSha256(parsed.dimension_digests)) {
    throw new Error("RULESPEC_DEPENDENCY_DIMENSION_DIGEST_MISMATCH");
  }
  if (legalOperationsSha256([...parsed.source_version_ids].sort())
      !== legalOperationsSha256(parsed.source_version_ids)
      || legalOperationsSha256([...parsed.sectors].sort()) !== legalOperationsSha256(parsed.sectors)
      || legalOperationsSha256([...parsed.populations].sort()) !== legalOperationsSha256(parsed.populations)
      || legalOperationsSha256([...parsed.parameter_versions].sort((left, right) => left.ref_id.localeCompare(right.ref_id)))
        !== legalOperationsSha256(parsed.parameter_versions)) {
    throw new Error("RULESPEC_DEPENDENCY_MANIFEST_NOT_CANONICAL");
  }
  return frozen(parsed);
}

export function changedRuleSpecDependencyDimensions(
  expectedInput: unknown,
  observedInput: unknown,
): readonly RuleSpecDependencyDimension[] {
  const expected = validateRuleSpecDependencyManifest(expectedInput);
  const observed = validateRuleSpecDependencyManifest(observedInput);
  const mapping: Readonly<Record<RuleSpecDependencyDimension, keyof typeof expected.dimension_digests>> = {
    source_versions: "source_versions_sha256",
    effective_period: "effective_period_sha256",
    sectors: "sectors_sha256",
    populations: "populations_sha256",
    parameter_versions: "parameter_versions_sha256",
    golden_case_set: "golden_case_set_sha256",
    resource_policy: "resource_policy_sha256",
    operation_graph: "operation_graph_sha256",
  };
  return Object.freeze(RULESPEC_DEPENDENCY_DIMENSIONS.filter((dimension) =>
    expected.dimension_digests[mapping[dimension]] !== observed.dimension_digests[mapping[dimension]]));
}

export function validateRuleSpecDecisionReference(candidate: unknown): RuleSpecDecisionReference {
  const parsed = ruleSpecDecisionReferenceSchema.parse(candidate);
  const { reference_sha256: expected, ...body } = parsed;
  if (legalOperationsSha256(body) !== expected) throw new Error("RULESPEC_DECISION_REFERENCE_HASH_MISMATCH");
  return frozen(parsed);
}

export function canonicalRuleSpecLifecycleJson(candidate: unknown): string {
  if (ruleSpecDependencyManifestSchema.safeParse(candidate).success) {
    return canonicalLegalOperationsJson(validateRuleSpecDependencyManifest(candidate));
  }
  if (ruleSpecDecisionReferenceSchema.safeParse(candidate).success) {
    return canonicalLegalOperationsJson(validateRuleSpecDecisionReference(candidate));
  }
  throw new Error("RULESPEC_LIFECYCLE_SCHEMA_VERSION_UNKNOWN");
}

function isGreaterVersion(candidate: string, prior: string): boolean {
  const left = candidate.split(".").map(Number);
  const right = prior.split(".").map(Number);
  const width = Math.max(left.length, right.length);
  for (let index = 0; index < width; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta > 0;
  }
  return false;
}

export class NonOperativeRuleSpecLifecycle {
  readonly #rule: RuleSpecPackage;
  #state: RuleSpecLifecycleState = "draft";
  #manifest: RuleSpecDependencyManifest | null = null;
  #bindings: DependencyBindings | null = null;
  #golden: GoldenCaseSet | null = null;
  #approvalReferences: RuleSpecDecisionReference[] = [];
  readonly #events: RuleSpecLifecycleEvent[] = [];

  constructor(input: Readonly<{ rule_spec: unknown; metadata: CommandMetadata }>) {
    this.#rule = validateRuleSpecPackage(input.rule_spec);
    this.#append("draft_registered", "unregistered", "draft", null, input.metadata, {
      catalog_boundary: this.#rule.catalog_boundary,
    });
  }

  bindDependencies(input: Readonly<{
    manifest: unknown;
    bindings: unknown;
    metadata: CommandMetadata;
  }>) {
    this.#requireState("draft");
    const manifest = validateRuleSpecDependencyManifest(input.manifest);
    const expected = createRuleSpecDependencyManifest(this.#rule);
    if (manifest.manifest_sha256 !== expected.manifest_sha256) {
      throw new Error("RULESPEC_DEPENDENCY_MANIFEST_RULE_BINDING_MISMATCH");
    }
    const bindings = dependencyBindingsSchema.parse(input.bindings);
    if (bindings.rule_spec_sha256 !== this.#rule.content_sha256
        || bindings.golden_cases_sha256 !== this.#rule.golden_case_set_sha256) {
      throw new Error("RULESPEC_DEPENDENCY_BINDINGS_RULE_MISMATCH");
    }
    const prior = this.#state;
    this.#manifest = manifest;
    this.#bindings = bindings;
    this.#state = "dependencies_bound";
    return this.#append("dependencies_bound", prior, this.#state, null, input.metadata, {
      manifest_sha256: manifest.manifest_sha256,
      bindings_sha256: legalOperationsSha256(bindings),
    });
  }

  markGoldenReady(input: Readonly<{ golden_case_set: unknown; metadata: CommandMetadata }>) {
    this.#requireState("dependencies_bound");
    const golden = validateGoldenCaseSet(input.golden_case_set);
    if (golden.rule_spec_id !== this.#rule.rule_spec_id
        || golden.rule_spec_version !== this.#rule.rule_spec_version
        || golden.content_sha256 !== this.#rule.golden_case_set_sha256) {
      throw new Error("RULESPEC_GOLDEN_CASE_SET_BINDING_MISMATCH");
    }
    const prior = this.#state;
    this.#golden = golden;
    this.#state = "golden_ready";
    return this.#append("golden_ready", prior, this.#state, null, input.metadata, {
      golden_case_set_id: golden.golden_case_set_id,
      golden_case_set_sha256: golden.content_sha256,
    });
  }

  recordApprovalReferences(input: Readonly<{
    references: readonly unknown[];
    metadata: CommandMetadata;
  }>) {
    this.#requireState("golden_ready");
    if (input.references.length !== 2) throw new Error("RULESPEC_TWO_APPROVAL_REFERENCES_REQUIRED");
    const references = input.references.map(validateRuleSpecDecisionReference);
    const kinds = new Set(references.map((reference) => reference.decision_kind));
    if (!kinds.has("rule_semantics_approval") || !kinds.has("golden_case_outputs_approval")) {
      throw new Error("RULESPEC_TWO_APPROVAL_REFERENCES_REQUIRED");
    }
    if (new Set(references.map((reference) => reference.reviewer_id)).size !== 2) {
      throw new Error("RULESPEC_APPROVAL_REFERENCE_SEPARATION_REQUIRED");
    }
    for (const reference of references) this.#assertReferenceBinding(reference);
    const prior = this.#state;
    this.#approvalReferences = [...references].sort((left, right) =>
      left.decision_kind.localeCompare(right.decision_kind));
    this.#state = "legal_approval";
    return this.#append("approval_references_recorded", prior, this.#state, references, input.metadata, {
      genuine_human_approval_count: references.filter((reference) =>
        reference.trust_boundary === "verified_reviewer_trust_boundary").length,
      synthetic_reference_count: references.filter((reference) =>
        reference.trust_boundary === "synthetic_test_only").length,
    });
  }

  markShadowEligible(input: Readonly<{ metadata: CommandMetadata }>) {
    this.#requireState("legal_approval");
    const prior = this.#state;
    this.#state = "shadow_eligible";
    return this.#append("shadow_eligible", prior, this.#state, this.#approvalReferences, input.metadata, {
      customer_shadow_allowed: false,
      catalog_boundary: this.#rule.catalog_boundary,
    });
  }

  supersede(input: Readonly<{
    successor_rule_spec: unknown;
    successor_manifest: unknown;
    reference: unknown;
    metadata: CommandMetadata;
  }>) {
    this.#requireState("shadow_eligible");
    const successor = validateRuleSpecPackage(input.successor_rule_spec);
    const successorManifest = validateRuleSpecDependencyManifest(input.successor_manifest);
    const calculatedSuccessorManifest = createRuleSpecDependencyManifest(successor);
    const reference = validateRuleSpecDecisionReference(input.reference);
    if (reference.decision_kind !== "rulespec_supersession"
        || successor.rule_spec_id !== this.#rule.rule_spec_id
        || successor.topic !== this.#rule.topic
        || !isGreaterVersion(successor.rule_spec_version, this.#rule.rule_spec_version)
        || successor.content_sha256 === this.#rule.content_sha256
        || successorManifest.manifest_sha256 !== calculatedSuccessorManifest.manifest_sha256
        || reference.successor?.rule_spec_id !== successor.rule_spec_id
        || reference.successor.rule_spec_version !== successor.rule_spec_version
        || reference.successor.rule_spec_sha256 !== successor.content_sha256
        || reference.successor.dependency_manifest_sha256 !== successorManifest.manifest_sha256) {
      throw new Error("RULESPEC_SUPERSESSION_BINDING_INVALID");
    }
    this.#assertReferenceBinding(reference);
    const prior = this.#state;
    this.#state = "superseded";
    return this.#append("superseded", prior, this.#state, [reference], input.metadata, {
      successor_rule_spec_version: successor.rule_spec_version,
      successor_rule_spec_sha256: successor.content_sha256,
      successor_manifest_sha256: successorManifest.manifest_sha256,
    });
  }

  revoke(input: Readonly<{ reference: unknown; metadata: CommandMetadata }>) {
    if (this.#state === "superseded" || this.#state === "revoked") {
      throw new Error("RULESPEC_LIFECYCLE_TERMINAL");
    }
    const reference = validateRuleSpecDecisionReference(input.reference);
    if (reference.decision_kind !== "rulespec_revocation") {
      throw new Error("RULESPEC_REVOCATION_REFERENCE_REQUIRED");
    }
    this.#assertReferenceBinding(reference);
    const prior = this.#state;
    this.#state = "revoked";
    return this.#append("revoked", prior, this.#state, [reference], input.metadata, {
      prior_revision: this.#events.length,
    });
  }

  status() {
    const humanApprovalCount = this.#approvalReferences.filter((reference) =>
      reference.trust_boundary === "verified_reviewer_trust_boundary").length;
    return frozen({
      schema_version: RULESPEC_LIFECYCLE_SCHEMA,
      rule_spec_id: this.#rule.rule_spec_id,
      rule_spec_version: this.#rule.rule_spec_version,
      rule_spec_sha256: this.#rule.content_sha256,
      state: this.#state,
      revision: this.#events.length,
      dependency_manifest_sha256: this.#manifest?.manifest_sha256 ?? null,
      dependency_bindings_sha256: this.#bindings === null ? null : legalOperationsSha256(this.#bindings),
      golden_case_set_sha256: this.#golden?.content_sha256 ?? this.#rule.golden_case_set_sha256,
      approval_reference_count: this.#approvalReferences.length,
      genuine_human_approval_count: humanApprovalCount,
      synthetic_reference_count: this.#approvalReferences.length - humanApprovalCount,
      activation_allowed: false as const,
      product_execution_allowed: false as const,
      customer_shadow_allowed: false as const,
      audit_head_sha256: this.#events.at(-1)?.event_sha256 ?? null,
    });
  }

  events(): readonly RuleSpecLifecycleEvent[] {
    return frozen(this.#events.map((event) => ({ ...event })));
  }

  verifyAuditChain() {
    let prior: string | null = null;
    for (const event of this.#events) {
      const { event_sha256: expected, ...body } = event;
      if (body.prior_event_sha256 !== prior || legalOperationsSha256(body) !== expected) {
        return frozen({ valid: false, event_count: this.#events.length, tail_sha256: prior });
      }
      prior = event.event_sha256;
    }
    return frozen({ valid: true, event_count: this.#events.length, tail_sha256: prior });
  }

  #requireState(expected: RuleSpecLifecycleState): void {
    if (this.#state !== expected) throw new Error("RULESPEC_LIFECYCLE_EXPECTED_STATE_MISMATCH");
  }

  #assertReferenceBinding(reference: RuleSpecDecisionReference): void {
    if (this.#manifest === null || reference.rule_spec_id !== this.#rule.rule_spec_id
        || reference.rule_spec_version !== this.#rule.rule_spec_version
        || reference.rule_spec_sha256 !== this.#rule.content_sha256
        || reference.dependency_manifest_sha256 !== this.#manifest.manifest_sha256
        || reference.golden_case_set_sha256 !== this.#rule.golden_case_set_sha256) {
      throw new Error("RULESPEC_DECISION_REFERENCE_BINDING_MISMATCH");
    }
    if (this.#rule.catalog_boundary === "real_inactive"
        && reference.trust_boundary !== "verified_reviewer_trust_boundary") {
      throw new Error("RULESPEC_VERIFIED_HUMAN_REFERENCE_REQUIRED_FOR_REAL_CANDIDATE");
    }
  }

  #append(
    eventKind: RuleSpecLifecycleEvent["event_kind"],
    priorState: RuleSpecLifecycleEvent["prior_state"],
    state: RuleSpecLifecycleState,
    references: readonly RuleSpecDecisionReference[] | null,
    metadataInput: CommandMetadata,
    detail: Readonly<Record<string, unknown>>,
  ): RuleSpecLifecycleEvent {
    const metadata = {
      command_id: legalOperationsIdSchema.parse(metadataInput.command_id),
      occurred_at: isoTimestampSchema.parse(metadataInput.occurred_at),
    };
    const prior = this.#events.at(-1)?.event_sha256 ?? null;
    const body = {
      schema_version: RULESPEC_LIFECYCLE_SCHEMA,
      sequence: this.#events.length + 1,
      event_id: `rulespec.lifecycle.event.${String(this.#events.length + 1).padStart(8, "0")}`,
      event_kind: eventKind,
      rule_spec_id: this.#rule.rule_spec_id,
      rule_spec_version: this.#rule.rule_spec_version,
      rule_spec_sha256: this.#rule.content_sha256,
      prior_state: priorState,
      state,
      dependency_manifest_sha256: this.#manifest?.manifest_sha256 ?? null,
      dependency_bindings_sha256: this.#bindings === null ? null : legalOperationsSha256(this.#bindings),
      golden_case_set_sha256: this.#golden?.content_sha256 ?? this.#rule.golden_case_set_sha256,
      decision_reference_sha256s: (references ?? []).map((reference) => reference.reference_sha256).sort(),
      detail_sha256: legalOperationsSha256(detail),
      occurred_at: metadata.occurred_at,
      command_id: metadata.command_id,
      activation_allowed: false as const,
      product_execution_allowed: false as const,
      prior_event_sha256: prior,
    };
    const event = frozen({ ...body, event_sha256: legalOperationsSha256(body) });
    this.#events.push(event);
    return event;
  }
}
