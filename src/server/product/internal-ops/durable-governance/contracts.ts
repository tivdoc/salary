import type { VerifiedActor } from "../../../../engine/wave4/contracts.ts";
import type { OpsReadProjection } from "../contracts.ts";
import type {
  DurableGovernanceApplication,
  GovernanceAggregateSnapshot,
  GovernanceMutationReceipt,
  GovernanceWorkflowKind,
  GovernanceWorkClaim,
  HistoricalObservationImportPlan,
  HistoricalObservationImportReceipt,
} from "../../../platform/persistence/postgres/governance/index.ts";

export const DURABLE_GOVERNANCE_OPERATIONS_SCHEMA_VERSION =
  "tivdoc-durable-governance-operations-v0.10.2" as const;

export const DURABLE_OPERATIONS_TABS = Object.freeze([
  "Overview",
  "Payment",
  "Documents",
  "Extraction",
  "Facts",
  "Legal",
  "Parameters",
  "Rules",
  "Analysis",
  "Report",
  "Audit",
] as const);

export type DurableOperationsTab = (typeof DURABLE_OPERATIONS_TABS)[number];

export const DURABLE_GOVERNANCE_WORK_LANES = Object.freeze({
  ground_truth_visual_eligibility: Object.freeze({
    workflow_kind: "ground_truth",
    work_kind: "ground_truth_visual_eligibility",
    actor_role: "extraction_reviewer",
    reviewer_role: "human_ground_truth_eligibility_reviewer",
  }),
  ground_truth_annotation: Object.freeze({
    workflow_kind: "ground_truth",
    work_kind: "ground_truth_annotation",
    actor_role: "extraction_reviewer",
    reviewer_role: "human_ground_truth_annotator",
  }),
  ground_truth_adjudication: Object.freeze({
    workflow_kind: "ground_truth",
    work_kind: "ground_truth_adjudication",
    actor_role: "extraction_reviewer",
    reviewer_role: "human_ground_truth_adjudicator",
  }),
  ground_truth_lock: Object.freeze({
    workflow_kind: "ground_truth",
    work_kind: "ground_truth_lock",
    actor_role: "extraction_reviewer",
    reviewer_role: "human_ground_truth_lock_reviewer",
  }),
  legal_observation_reconciliation: Object.freeze({
    workflow_kind: "legal_reconciliation",
    work_kind: "legal_observation_reconciliation",
    actor_role: "legal_reviewer",
    reviewer_role: "human_source_reviewer",
  }),
  parameter_attestation: Object.freeze({
    workflow_kind: "parameter_approval",
    work_kind: "parameter_attestation",
    actor_role: "parameter_verifier",
    reviewer_role: "human_parameter_reviewer",
  }),
  rulespec_semantics: Object.freeze({
    workflow_kind: "rulespec_approval",
    work_kind: "rulespec_semantics",
    actor_role: "legal_reviewer",
    reviewer_role: "human_rule_reviewer",
  }),
  golden_case_outputs: Object.freeze({
    workflow_kind: "rulespec_approval",
    work_kind: "golden_case_outputs",
    actor_role: "legal_reviewer",
    reviewer_role: "human_golden_case_reviewer",
  }),
} as const);

export type DurableGovernanceWorkLane = keyof typeof DURABLE_GOVERNANCE_WORK_LANES;

export type DurableGovernanceOperationsScope = Readonly<{
  actor: VerifiedActor;
  case_id: string;
  correlation_id: string;
}>;

export type GovernanceAggregateReference = Readonly<{
  aggregate_id: string;
  aggregate_version: string;
}>;

export type DurableOperationsTabProjection = Readonly<{
  schema_version: typeof DURABLE_GOVERNANCE_OPERATIONS_SCHEMA_VERSION;
  tab: DurableOperationsTab;
  case_id: string;
  persistence: "postgresql_required";
  source:
    | "canonical_case_postgres"
    | "durable_governance_postgres"
    | "canonical_case_and_durable_governance_postgres";
  core_projection: OpsReadProjection | null;
  governance_workflow: GovernanceWorkflowKind | null;
  governance_snapshots: readonly GovernanceAggregateSnapshot[];
  product_reachable_memory_fallback: false;
  activation_allowed: false;
}>;

export type DurableReviewerTrustProjection = Readonly<{
  schema_version: typeof DURABLE_GOVERNANCE_OPERATIONS_SCHEMA_VERSION;
  persistence: "postgresql_required";
  governance_workflow: "reviewer_trust";
  governance_snapshots: readonly GovernanceAggregateSnapshot[];
  product_reachable_memory_fallback: false;
  activation_allowed: false;
}>;

export type DurableGovernanceOperationsProof = Readonly<{
  schema_version: typeof DURABLE_GOVERNANCE_OPERATIONS_SCHEMA_VERSION;
  persistence: "postgresql_required";
  stable_operations_async: true;
  canonical_transaction_contexts: 1;
  product_reachable_memory_fallbacks: 0;
  durable_governance_replacements_wired: 4;
  operations_tabs: typeof DURABLE_OPERATIONS_TABS;
  activation_allowed: false;
}>;

type ReviewerTrust = DurableGovernanceApplication["reviewer_trust"];
type WorkQueue = DurableGovernanceApplication["work_queue"];
type GroundTruth = DurableGovernanceApplication["ground_truth"];
type LegalReconciliation = DurableGovernanceApplication["legal_reconciliation"];
type ParameterRepository = DurableGovernanceApplication["parameters"];
type RuleSpec = DurableGovernanceApplication["rulespec"];

export type DurableGovernanceCommand =
  | Readonly<{
      action: "reviewer_trust.organization.append";
      candidate: Parameters<ReviewerTrust["appendOrganization"]>[0];
      metadata: Parameters<ReviewerTrust["appendOrganization"]>[2];
    }>
  | Readonly<{
      action: "reviewer_trust.policy.append";
      candidate: Parameters<ReviewerTrust["appendPolicy"]>[0];
      metadata: Parameters<ReviewerTrust["appendPolicy"]>[2];
    }>
  | Readonly<{
      action: "reviewer_trust.reviewer.append";
      candidate: Parameters<ReviewerTrust["appendReviewer"]>[0];
      metadata: Parameters<ReviewerTrust["appendReviewer"]>[2];
    }>
  | Readonly<{
      action: "reviewer_trust.key_challenge.append";
      candidate: Parameters<ReviewerTrust["appendKeyChallenge"]>[0];
      metadata: Parameters<ReviewerTrust["appendKeyChallenge"]>[2];
    }>
  | Readonly<{
      action: "reviewer_trust.key.register";
      input: Parameters<ReviewerTrust["registerProvenKey"]>[0];
    }>
  | Readonly<{
      action: "reviewer_trust.key.revoke";
      input: Parameters<ReviewerTrust["revokeKey"]>[0];
    }>
  | Readonly<{
      action: "work.enqueue";
      input: Parameters<WorkQueue["enqueue"]>[0];
    }>
  | Readonly<{
      action: "work.release";
      lane: DurableGovernanceWorkLane;
      input: Parameters<WorkQueue["release"]>[0];
    }>
  | Readonly<{
      action: "ground_truth.visual_eligibility.append";
      input: Parameters<GroundTruth["appendVisualEligibility"]>[0];
    }>
  | Readonly<{
      action: "ground_truth.manifest.append";
      input: Parameters<GroundTruth["appendManifest"]>[0];
    }>
  | Readonly<{
      action: "legal_observation.import";
      candidate: Parameters<LegalReconciliation["importObservation"]>[0];
      metadata: Parameters<LegalReconciliation["importObservation"]>[1];
    }>
  | Readonly<{
      action: "legal_observation.decide";
      input: Parameters<LegalReconciliation["decideObservation"]>[0];
    }>
  | Readonly<{
      action: "historical_observations.import_exact_plan";
      plan: HistoricalObservationImportPlan;
      imported_at: string;
    }>
  | Readonly<{
      action: "parameter.candidate.import";
      candidate: Parameters<ParameterRepository["importCandidate"]>[0];
      metadata: Parameters<ParameterRepository["importCandidate"]>[1];
    }>
  | Readonly<{
      action: "parameter.attestation.append";
      input: Parameters<ParameterRepository["appendAttestation"]>[0];
    }>
  | Readonly<{
      action: "rulespec.golden_case_set.import";
      candidate: Parameters<RuleSpec["importGoldenCaseSet"]>[0];
      metadata: Parameters<RuleSpec["importGoldenCaseSet"]>[1];
    }>
  | Readonly<{
      action: "rulespec.package.import";
      candidate: Parameters<RuleSpec["importRuleSpec"]>[0];
      metadata: Parameters<RuleSpec["importRuleSpec"]>[1];
    }>
  | Readonly<{
      action: "rulespec.approval.append";
      input: Parameters<RuleSpec["appendApproval"]>[0];
    }>;

export type DurableGovernanceCommandResult = Readonly<{
  schema_version: typeof DURABLE_GOVERNANCE_OPERATIONS_SCHEMA_VERSION;
  action: DurableGovernanceCommand["action"];
  result:
    | GovernanceMutationReceipt
    | HistoricalObservationImportReceipt;
  product_reachable_memory_fallback: false;
  activation_allowed: false;
}>;

export type DurableGovernanceClaimResult = Readonly<{
  schema_version: typeof DURABLE_GOVERNANCE_OPERATIONS_SCHEMA_VERSION;
  lane: DurableGovernanceWorkLane;
  claim: GovernanceWorkClaim | null;
  product_reachable_memory_fallback: false;
  activation_allowed: false;
}>;
