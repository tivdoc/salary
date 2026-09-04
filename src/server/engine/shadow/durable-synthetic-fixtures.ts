import { canonicalSha256 } from "../../../engine/rule-runtime/canonical.ts";
import { WAVE3_TOPICS } from "../../../engine/wave3/contracts.ts";
import {
  createShadowEvaluationSnapshot,
  createShadowThresholdPolicy,
  type ShadowEvaluationSnapshot,
  type ShadowThresholdPolicy,
} from "../../../engine/shadow/contracts.ts";
import { createDurableShadowRunEnvelope, type DurableShadowRunEnvelope } from "./durable-contracts.ts";

function sha(label: string) {
  return canonicalSha256({ classification: "deterministic_synthetic", label });
}

function pin(pinId: string, version = "1.0.0") {
  return { pin_id: pinId, version, sha256: sha(`${pinId}:${version}`) };
}

export function buildDurableSyntheticShadowEnvelope(overrides: Readonly<{
  run_id?: string;
  requested_at?: string;
  scheduled_for?: string;
  dataset_byte_count?: number;
}> = {}): DurableShadowRunEnvelope {
  const requestedAt = overrides.requested_at ?? "2042-01-01T00:00:00.000Z";
  return createDurableShadowRunEnvelope({
    schema_version: "tivdoc-durable-offline-shadow-envelope-v0.10.0",
    run_id: overrides.run_id ?? "shadow.run.synthetic.001",
    execution_mode: "offline_synthetic_only",
    dataset_pin: { ...pin("dataset.synthetic.001"), classification: "deterministic_synthetic", byte_count: overrides.dataset_byte_count ?? 4_096, customer_material: false },
    ground_truth_pin: { ...pin("ground-truth.synthetic.001"), classification: "synthetic_mechanics_ground_truth", customer_material: false, human_ground_truth_count: 0 },
    source_state_pin: { ...pin("source-state.synthetic.001"), mode: "synthetic_placeholder_only", active_real_source_count: 0, selected_real_source_count: 0 },
    parameter_state_pin: { ...pin("parameter-state.synthetic.001"), active_real_parameter_count: 0 },
    rule_state_pin: { ...pin("rule-state.synthetic.001"), active_real_rule_count: 0 },
    approved_baseline_pin: { ...pin("baseline.approved.synthetic.001"), approval_receipt_sha256: sha("baseline-approval-receipt") },
    candidate_pin: pin("candidate.synthetic.001", "1.1.0"),
    code_pin: pin("code.synthetic.001"),
    config_pin: pin("config.synthetic.001"),
    threshold_policy_pin: pin("threshold-policy.synthetic.001"),
    requested_at: requestedAt,
    scheduled_for: overrides.scheduled_for ?? requestedAt,
    network_allowed: false,
    external_provider_allowed: false,
    customer_input_allowed: false,
    delivery_allowed: false,
    automatic_customer_promotion: false,
    automatic_production_promotion: false,
  });
}

export function buildSyntheticEvaluationSnapshot(input: Readonly<{
  snapshot_id: string;
  changed_topic?: (typeof WAVE3_TOPICS)[number];
  state?: "complete" | "blocked" | "uncertain" | "error";
  uncertainty?: "none" | "low" | "high" | "unknown";
  fingerprint_label?: string;
}>): ShadowEvaluationSnapshot {
  return createShadowEvaluationSnapshot({
    schema_version: "tivdoc-shadow-evaluation-snapshot-v0.10.0",
    snapshot_id: input.snapshot_id,
    engine_version_pin: "engine.synthetic.1.0.0",
    topics: WAVE3_TOPICS.map((topic) => ({
      topic,
      fields: [{
        field_id: `${topic}.synthetic.fixture`,
        value_fingerprint: sha(topic === input.changed_topic ? (input.fingerprint_label ?? "candidate-change") : `stable:${topic}`),
        state: topic === input.changed_topic ? (input.state ?? "complete") : "complete",
        uncertainty: topic === input.changed_topic ? (input.uncertainty ?? "none") : "none",
        blocker_codes: topic === input.changed_topic && input.state === "blocked" ? ["SYNTHETIC_MECHANICS_BLOCKED"] : [],
      }],
    })),
    monetary_output_count: 0,
    finding_count: 0,
    customer_report_count: 0,
    raw_document_count: 0,
  });
}

export function buildSyntheticShadowThresholdPolicy(overrides: Partial<Pick<ShadowThresholdPolicy, "max_regressions" | "max_uncertainty_increases" | "max_changed_fields">> = {}): ShadowThresholdPolicy {
  return createShadowThresholdPolicy({
    schema_version: "tivdoc-shadow-threshold-policy-v0.10.0",
    threshold_version: "1.0.0",
    max_regressions: overrides.max_regressions ?? 0,
    max_uncertainty_increases: overrides.max_uncertainty_increases ?? 0,
    max_changed_fields: overrides.max_changed_fields ?? 7,
    blocked_removal_requires_review: true,
    automatic_promotion_allowed: false,
  });
}

/**
 * L7-6 / D1. A v0.11 envelope in the draft mode: draft parameter values over
 * synthetic inputs. The pin carries the counts the run will prove and the
 * corpus hash; nothing real is active, extraction is not used.
 */
export function buildDraftShadowEnvelope(input: Readonly<{
  run_id: string;
  corpus_sha256: string;
  draft_parameter_versions: number;
  synthetic_inputs: number;
  requested_at?: string;
  dataset_byte_count?: number;
  code_sha256?: string;
}>): DurableShadowRunEnvelope {
  const requestedAt = input.requested_at ?? "2026-09-05T00:00:00.000Z";
  return createDurableShadowRunEnvelope({
    schema_version: "tivdoc-durable-offline-shadow-envelope-v0.11.0",
    run_id: input.run_id,
    execution_mode: "draft_parameters_synthetic_inputs",
    draft_input_pin: {
      ...pin("draft-input.synthetic-corpus", "2.0.0"),
      sha256: input.corpus_sha256,
      mode: "draft_parameters_synthetic_inputs",
      active_real_parameter_count: 0,
      draft_parameter_versions: input.draft_parameter_versions,
      synthetic_inputs: input.synthetic_inputs,
      extraction_used: false,
      corpus_sha256: input.corpus_sha256,
      tenant_id: "legal.synthetic.proof",
    },
    dataset_pin: { ...pin("dataset.synthetic-corpus", "2.0.0"), sha256: input.corpus_sha256, classification: "deterministic_synthetic", byte_count: input.dataset_byte_count ?? 4_096, customer_material: false },
    ground_truth_pin: { ...pin("ground-truth.blank", "0.7.0"), classification: "synthetic_mechanics_ground_truth", customer_material: false, human_ground_truth_count: 0 },
    source_state_pin: { ...pin("source-state.synthetic"), mode: "synthetic_placeholder_only", active_real_source_count: 0, selected_real_source_count: 0 },
    parameter_state_pin: { ...pin("parameter-state.draft-only"), active_real_parameter_count: 0 },
    rule_state_pin: { ...pin("rule-state.real-inactive"), active_real_rule_count: 0 },
    approved_baseline_pin: { ...pin("baseline.none"), approval_receipt_sha256: sha("baseline-approval-receipt.none") },
    candidate_pin: pin("candidate.draft-shadow", "1.0.0"),
    code_pin: { ...pin("code.draft-shadow"), ...(input.code_sha256 ? { sha256: input.code_sha256 } : {}) },
    config_pin: pin("config.draft-shadow"),
    threshold_policy_pin: pin("threshold-policy.none"),
    requested_at: requestedAt,
    scheduled_for: requestedAt,
    network_allowed: false,
    external_provider_allowed: false,
    customer_input_allowed: false,
    delivery_allowed: false,
    automatic_customer_promotion: false,
    automatic_production_promotion: false,
  });
}
