import { WAVE3_TOPICS, type Wave3Topic } from "../wave3/contracts.ts";
import { frozen, legalOperationsSha256 } from "./canonical.ts";
import {
  dependencyBindingsSchema,
  parameterAttestationSchema,
  parameterCandidateSchema,
  semanticApprovalSchema,
  sourceReviewAttestationSchema,
  type DependencyBindings,
  type ParameterAttestation,
  type ParameterCandidate,
  type SemanticApproval,
  type SourceReviewAttestation,
} from "./contracts.ts";
import {
  createGoldenCaseSet,
  createRuleSpecPackage,
  type GoldenCaseSet,
  type RuleSpecInputValue,
  type RuleSpecPackage,
} from "./rulespec.ts";

export const SYNTHETIC_CATALOG_DATE = "2040-01-01" as const;
export const SYNTHETIC_CATALOG_TIMESTAMP = "2040-01-01T00:00:00.000Z" as const;
export const SYNTHETIC_SECTOR = "synthetic.sector" as const;
export const SYNTHETIC_POPULATION = "synthetic.population" as const;
export const SYNTHETIC_CURRENCY = "ZZZ" as const;

function digest(label: string) { return legalOperationsSha256({ synthetic_test_only: true, label }); }

export function syntheticBindings(topic: Wave3Topic, ruleSha256 = digest(`${topic}:rule.unassigned`), goldenSha256 = digest(`${topic}:golden.unassigned`)): DependencyBindings {
  return dependencyBindingsSchema.parse({
    source_bytes_sha256: digest(`${topic}:source.bytes`),
    citations_sha256: digest(`${topic}:citations`),
    interval_sha256: digest(`${topic}:interval`),
    scope_sha256: digest(`${topic}:scope`),
    parameter_set_sha256: digest(`${topic}:parameter.set`),
    rule_spec_sha256: ruleSha256,
    golden_cases_sha256: goldenSha256,
    reviewer_decisions_sha256: digest(`${topic}:reviewer.decisions`),
  });
}

export type SyntheticLegalFixture = Readonly<{
  topic: Wave3Topic;
  source_version_id: string;
  source_attestations: readonly SourceReviewAttestation[];
  parameter: ParameterCandidate;
  parameter_attestations: readonly [ParameterAttestation, ParameterAttestation];
  rule: RuleSpecPackage;
  golden_cases: GoldenCaseSet;
  semantic_approvals: readonly [SemanticApproval, SemanticApproval];
  facts: readonly RuleSpecInputValue[];
  parameters: readonly RuleSpecInputValue[];
  expected_output: RuleSpecInputValue["value"];
}>;

export function buildSyntheticLegalFixture(topic: Wave3Topic, ordinal = WAVE3_TOPICS.indexOf(topic) + 1): SyntheticLegalFixture {
  if (ordinal < 1) throw new Error("SYNTHETIC_TOPIC_ORDINAL_INVALID");
  const sourceVersionId = `syn.source.${topic}@1.0.0`;
  const parameterId = `syn.parameter.${topic}`;
  const ruleId = `syn.rule.${topic}`;
  const amount = ordinal * 100;
  const facts: readonly RuleSpecInputValue[] = Object.freeze([{ ref_id: "fact.signal", value: { kind: "rational", numerator: "1", denominator: "1", unit: "ratio" } }]);
  const parameters: readonly RuleSpecInputValue[] = Object.freeze([{ ref_id: "parameter.amount", value: { kind: "money", currency: SYNTHETIC_CURRENCY, minor_units: amount } }]);
  const expectedOutput = parameters[0].value;
  const goldenCases = createGoldenCaseSet({
    schema_version: "tivdoc-rulespec-golden-case-set-v0.6.0",
    golden_case_set_id: `syn.golden.${topic}`,
    rule_spec_id: ruleId,
    rule_spec_version: "1.0.0",
    cases: [{ case_id: `syn.case.${topic}.001`, facts, parameters, expected_output: expectedOutput }],
  });
  const rule = createRuleSpecPackage({
    schema_version: "tivdoc-rulespec-v0.6.0",
    rule_spec_id: ruleId,
    rule_spec_version: "1.0.0",
    topic,
    catalog_boundary: "synthetic_test_only",
    source_version_ids: [sourceVersionId],
    effective_period: { from: SYNTHETIC_CATALOG_DATE, to: null },
    sectors: [SYNTHETIC_SECTOR],
    populations: [SYNTHETIC_POPULATION],
    facts: [{ ref_id: "fact.signal", value_kind: "rational", unit: "ratio" }],
    parameters: [{ ref_id: "parameter.amount", parameter_id: parameterId, parameter_version: "1.0.0", value_kind: "money", unit: "currency.zzz" }],
    nodes: [{ node_id: "result.amount", operation: "money.scale", money_ref: "parameter.amount", rational_ref: "fact.signal", rounding: "exact" }],
    output_ref: "result.amount",
    golden_case_set_sha256: goldenCases.content_sha256,
    resource_policy: { max_steps: 8, max_depth: 4, max_aggregate_items: 8, max_integer_digits: 32 },
  });
  const bindings = syntheticBindings(topic, rule.content_sha256, goldenCases.content_sha256);
  const parameterSeed = frozen({
    schema_version: "tivdoc-parameter-candidate-v0.6.0" as const,
    parameter_id: parameterId,
    parameter_version: "1.0.0",
    topic,
    value: { kind: "money" as const, value: { currency: SYNTHETIC_CURRENCY, minor_units: amount } },
    unit: "currency.zzz",
    rounding_policy: "exact" as const,
    effective_from: SYNTHETIC_CATALOG_DATE,
    effective_to: null,
    sectors: [SYNTHETIC_SECTOR],
    populations: [SYNTHETIC_POPULATION],
    operative_source_version_ids: [sourceVersionId],
    support_roles: ["primary_binding" as const],
    bindings,
  });
  const parameter = parameterCandidateSchema.parse({ ...parameterSeed, candidate_sha256: legalOperationsSha256(parameterSeed) });
  const sourceReviewDefinitions = Object.freeze([
    ["artifact_authenticity", "human_artifact_reviewer"],
    ["content_transcription_accuracy", "human_content_reviewer"],
    ["effective_interval", "human_effective_period_reviewer"],
    ["sector_population_applicability", "human_applicability_reviewer"],
    ["authority_precedence", "human_authority_reviewer"],
  ] as const);
  const sourceDecisionPayload = (decisionKind: typeof sourceReviewDefinitions[number][0]) => {
    if (decisionKind === "artifact_authenticity") return { kind: decisionKind, status: "verified" as const, artifact_sha256s: [bindings.source_bytes_sha256] };
    if (decisionKind === "content_transcription_accuracy") return { kind: decisionKind, status: "verified" as const, artifact_sha256s: [bindings.source_bytes_sha256], chunk_sha256s: [bindings.citations_sha256] };
    if (decisionKind === "effective_interval") return { kind: decisionKind, status: "verified" as const, intervals: [{ from: SYNTHETIC_CATALOG_DATE, to: null }] };
    if (decisionKind === "sector_population_applicability") return { kind: decisionKind, status: "verified" as const, sectors: [SYNTHETIC_SECTOR], populations: [SYNTHETIC_POPULATION] };
    return { kind: decisionKind, status: "verified" as const, source_roles: [{ source_version_id: sourceVersionId, authority_role: "primary_binding" as const }] };
  };
  const sourceAttestations = sourceReviewDefinitions.map(([decisionKind, reviewerRole], index) => sourceReviewAttestationSchema.parse({
    schema_version: "tivdoc-source-review-attestation-v0.6.0",
    attestation_id: `syn.source.attestation.${topic}.${index + 1}`,
    packet_id: `syn.packet.${topic}`,
    packet_sha256: digest(`${topic}:source.review.packet`),
    source_version_ids: [sourceVersionId],
    decision_kind: decisionKind,
    decision: "approved",
    reviewer_id: `syn.human.${decisionKind}.reviewer.${topic}`,
    reviewer_role: reviewerRole,
    decided_at: SYNTHETIC_CATALOG_TIMESTAMP,
    reason: "Synthetic-test-only attestation over neutral fixture bytes; no real legal determination.",
    decision_payload: sourceDecisionPayload(decisionKind),
    bound_artifact_sha256s: [bindings.source_bytes_sha256],
    bound_citation_sha256: bindings.citations_sha256,
    bound_interval_sha256: bindings.interval_sha256,
    bound_scope_sha256: bindings.scope_sha256,
    signature_sha256: digest(`${topic}:source.attestation.${index + 1}.signature`),
  }));
  const attestation = (index: 1 | 2) => parameterAttestationSchema.parse({
    schema_version: "tivdoc-parameter-attestation-v0.6.0",
    attestation_id: `syn.parameter.attestation.${topic}.${index}`,
    candidate_id: parameter.parameter_id,
    candidate_version: parameter.parameter_version,
    candidate_sha256: parameter.candidate_sha256,
    reviewer_id: `syn.human.parameter.reviewer.${topic}.${index}`,
    reviewer_role: "human_parameter_reviewer",
    value: parameter.value,
    unit: parameter.unit,
    rounding_policy: parameter.rounding_policy,
    operative_source_version_ids: parameter.operative_source_version_ids,
    bindings_sha256: legalOperationsSha256(parameter.bindings),
    decision: "approved",
    attested_at: SYNTHETIC_CATALOG_TIMESTAMP,
    signature_sha256: digest(`${topic}:parameter.attestation.${index}.signature`),
  });
  const approval = (kind: "rule_semantics" | "golden_case_outputs") => semanticApprovalSchema.parse({
    schema_version: "tivdoc-legal-semantic-approval-v0.6.0",
    approval_id: `syn.${kind}.approval.${topic}`,
    artifact_id: rule.rule_spec_id,
    artifact_version: rule.rule_spec_version,
    artifact_sha256: kind === "rule_semantics" ? rule.content_sha256 : rule.golden_case_set_sha256,
    approval_kind: kind,
    reviewer_id: `syn.human.${kind}.reviewer.${topic}`,
    reviewer_role: kind === "rule_semantics" ? "human_rule_reviewer" : "human_golden_case_reviewer",
    decision: "approved",
    decided_at: SYNTHETIC_CATALOG_TIMESTAMP,
    signature_sha256: digest(`${topic}:${kind}.signature`),
  });
  return frozen({
    topic,
    source_version_id: sourceVersionId,
    source_attestations: sourceAttestations,
    parameter,
    parameter_attestations: [attestation(1), attestation(2)],
    rule,
    golden_cases: goldenCases,
    semantic_approvals: [approval("rule_semantics"), approval("golden_case_outputs")],
    facts,
    parameters,
    expected_output: expectedOutput,
  });
}

export const SYNTHETIC_SEVEN_TOPIC_FIXTURES: readonly SyntheticLegalFixture[] = frozen(WAVE3_TOPICS.map((topic, index) => buildSyntheticLegalFixture(topic, index + 1)));
