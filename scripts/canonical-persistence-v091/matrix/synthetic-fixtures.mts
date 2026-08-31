import { createHash } from "node:crypto";

import type { PinnedAnalysisDependencies } from "../../../src/engine/case-analysis/contracts.ts";
import { canonicalSha256 } from "../../../src/engine/rule-runtime/canonical.ts";
import {
  WAVE3_TOPICS,
  type AnalysisResultBundle,
  type CaseAnalysisCommand,
  type DeterministicReportArtifacts,
  type LegalCatalogSelection,
  type TopicAnalysisResult,
} from "../../../src/engine/wave3/contracts.ts";

const timestamp = (seconds: number): string =>
  new Date(Date.parse("2026-08-31T10:00:00.000Z") + seconds * 1_000).toISOString();

const byteSha256 = (value: Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

export function createSyntheticCapabilityFixtures(suffix: string) {
  if (!/^[a-z0-9]{8,24}$/u.test(suffix)) throw new Error("FIXTURE_SUFFIX_INVALID");

  const tenantId = `tenant:dynamic:${suffix}`;
  const caseId = `case:dynamic:${suffix}`;
  const analysisRunId = `analysis:dynamic:${suffix}`;
  const reportId = `report:dynamic:${suffix}`;
  const conversationId = `conversation:dynamic:${suffix}`;
  const documentId = `document:dynamic:${suffix}`;

  const states = [
    "awaiting_documents",
    "awaiting_extraction_review",
    "awaiting_fact_resolution",
    "ready_for_legal_evaluation",
    "awaiting_legal_review",
    "awaiting_report_approval",
    "report_ready",
  ] as const;
  let previousEventSha256: string | null = null;
  const caseTransitions = states.map((stateAfter, index) => {
    const stateBefore = index === 0 ? null : states[index - 1];
    const eventSha256 = canonicalSha256({
      fixture: "canonical-persistence-v091",
      case_id: caseId,
      revision: index + 1,
      state_before: stateBefore,
      state_after: stateAfter,
      previous_sha256: previousEventSha256,
    });
    const transition = {
      tenant_id: tenantId,
      case_id: caseId,
      expected_revision: index,
      state_before: stateBefore,
      state_after: stateAfter,
      event_kind: `synthetic.${stateAfter}`,
      command_sha256: canonicalSha256({ caseId, expectedRevision: index, stateAfter }),
      event_sha256: eventSha256,
      previous_sha256: previousEventSha256,
      state_sha256: canonicalSha256({ caseId, revision: index + 1, stateAfter }),
      occurred_at: timestamp(index),
    };
    previousEventSha256 = eventSha256;
    return transition;
  });

  const paymentEvidence = {
    tenant_id: tenantId,
    case_id: caseId,
    evidence_id: `evidence:dynamic:${suffix}`,
    evidence_revision: "revision:001",
    evidence_sha256: canonicalSha256({ suffix, kind: "payment-evidence" }),
    status: "settled" as const,
    bound_at: timestamp(10),
  };
  const conversation = {
    tenant_id: tenantId,
    case_id: caseId,
    conversation_id: conversationId,
    analysis_run_id: null,
    status: "open" as const,
    idempotency_key: `conversation:dynamic:${suffix}`,
    created_at: timestamp(11),
    closed_at: null,
  };
  const message = {
    tenant_id: tenantId,
    case_id: caseId,
    message_id: `message:dynamic:${suffix}`,
    conversation_id: conversationId,
    analysis_run_id: null,
    role: "system" as const,
    agent: null,
    question_id: null,
    question_version: null,
    selected_option_ids: [],
    free_text_answer: null,
    content: "Synthetic dynamic verification message.",
    model_provider: null,
    model_identifier: null,
    prompt_version: null,
    idempotency_key: `message:dynamic:${suffix}`,
    created_at: timestamp(12),
  };
  const document = {
    tenant_id: tenantId,
    case_id: caseId,
    document_id: documentId,
    declared_type: "payslip",
    detected_type: "payslip",
    classification_confidence: 1,
    content_sha256: canonicalSha256({ suffix, kind: "document-content" }),
    storage_path: `cases/${caseId}/documents/${documentId}/original.pdf`,
    original_filename: "synthetic.pdf",
    mime_type: "application/pdf" as const,
    size_bytes: 100,
    period_start: "2026-08-01",
    period_end: "2026-08-31",
    supersedes_document_id: null,
    processing_status: "ready" as const,
    created_at: timestamp(13),
  };
  const artifact = {
    tenant_id: tenantId,
    case_id: caseId,
    reservation_id: `reservation:dynamic:${suffix}`,
    opaque_key: `object:dynamic:${suffix}`,
    expected_sha256: canonicalSha256({ suffix, kind: "artifact" }),
    expected_length: 100,
    detected_mime: "application/pdf",
    retention_class: "case_record",
    state: "reserved" as const,
    revision: 1,
    staged_sha256: null,
    staged_length: null,
    object_version_id: null,
    visible: false,
    created_at: timestamp(14),
    updated_at: timestamp(14),
  };
  const extraction = {
    tenant_id: tenantId,
    case_id: caseId,
    extraction_id: `extraction:dynamic:${suffix}`,
    document_id: documentId,
    analysis_run_id: null,
    extractor_id: "extractor:synthetic",
    extractor_version: "1.0.0",
    model_version: null,
    source_content_sha256: document.content_sha256,
    status: "queued" as const,
    payload: null,
    quality_metrics: { page_count: 1, mean_confidence: 1, warning_codes: [] },
    raw_artifact_path: null,
    idempotency_key: `extraction:dynamic:${suffix}`,
    created_at: timestamp(15),
    completed_at: null,
    error_code: null,
  };
  const factPayload = { schema_version: "synthetic-fact-v1", status: "conflicted" };
  const fact = {
    tenant_id: tenantId,
    case_id: caseId,
    fact_id: `fact:dynamic:${suffix}`,
    revision: 1,
    expected_prior_revision: 0,
    analysis_run_id: null,
    payload: factPayload,
    payload_sha256: canonicalSha256(factPayload),
    created_at: timestamp(16),
  };
  const hypothesis = {
    tenant_id: tenantId,
    case_id: caseId,
    hypothesis_id: `hypothesis:dynamic:${suffix}`,
    analysis_run_id: analysisRunId,
    hypothesis_key: "hypothesis.synthetic_consistency",
    category: "synthetic_consistency",
    status: "open" as const,
    priority: "high" as const,
    payload: { schema_version: "synthetic-hypothesis-v1", reason: "synthetic" },
    idempotency_key: `hypothesis:dynamic:${suffix}`,
    created_at: timestamp(20),
  };
  const ruleInputPayload = {
    snapshot_id: `snapshot:dynamic:${suffix}`,
    snapshot_version: "v1.0.0",
    snapshot_sha256: canonicalSha256({ suffix, kind: "rule-input-snapshot" }),
  };
  const ruleInput = {
    tenant_id: tenantId,
    case_id: caseId,
    rule_input_id: `rule-input:dynamic:${suffix}`,
    revision: 1,
    expected_prior_revision: 0,
    analysis_run_id: analysisRunId,
    topic: "minimum_wage" as const,
    payload: ruleInputPayload,
    payload_sha256: canonicalSha256(ruleInputPayload),
    created_at: timestamp(21),
  };

  const hashes = {
    document: canonicalSha256({ suffix, kind: "document-snapshot" }),
    extraction: canonicalSha256({ suffix, kind: "extraction-snapshot" }),
    declared: canonicalSha256({ suffix, kind: "declared-snapshot" }),
    facts: canonicalSha256({ suffix, kind: "facts-snapshot" }),
    catalog: canonicalSha256({ suffix, kind: "catalog" }),
  };
  const analysisCommand: CaseAnalysisCommand = {
    case_id: caseId,
    case_revision: 7,
    document_snapshot_id: `document-snapshot:${suffix}`,
    document_snapshot_sha256: hashes.document,
    extraction_snapshot_id: `extraction-snapshot:${suffix}`,
    extraction_snapshot_sha256: hashes.extraction,
    declared_fact_snapshot_id: `declared-snapshot:${suffix}`,
    declared_fact_snapshot_sha256: hashes.declared,
    period: { start_date: "2026-08-01", end_date: "2026-08-31" },
    as_of: "2026-08-31",
    requested_topics: WAVE3_TOPICS,
    sector: "synthetic_sector",
    population: "synthetic_population",
    mode: "synthetic_test",
    idempotency_key: `analysis:dynamic:${suffix}`,
  };
  const dependencies: PinnedAnalysisDependencies = {
    extraction_snapshot_sha256: hashes.extraction,
    facts_snapshot_sha256: hashes.facts,
    catalog_sha256: hashes.catalog,
    source_version_ids: [`synthetic-source-${suffix}`],
    parameter_version_ids: [`synthetic-parameter-${suffix}`],
    rule_spec_versions: [`synthetic-rule-${suffix}@1.0.0`],
    code_version: "case-analysis@0.6.0",
    template_version: `synthetic-template-${suffix}`,
  };
  const selections: readonly LegalCatalogSelection[] = WAVE3_TOPICS.map((topic) => ({
    catalog_id: `synthetic-catalog-${suffix}`,
    catalog_version: "1.0.0",
    catalog_sha256: hashes.catalog,
    mode: "synthetic_test",
    topic,
    source_version_ids: dependencies.source_version_ids,
    parameter_version_ids: dependencies.parameter_version_ids,
    rule_spec_id: `synthetic.${topic}`,
    rule_spec_version: "1.0.0",
    readiness: {
      schema_version: "tivdoc-legal-readiness-v0.5.0",
      decision_source: "evaluateLegalReadiness",
      status: "BLOCKED_NOT_READY",
      reason_codes: ["SYNTHETIC_DYNAMIC_VERIFICATION_ONLY"],
      operative_candidate_source_version_ids: [],
      decision_sha256: canonicalSha256({ topic, suffix, readiness: "blocked" }),
      usable_for_rules: false,
      normalized_input_sha256: null,
    },
  }));
  const topicResults: readonly TopicAnalysisResult[] = WAVE3_TOPICS.map((topic, index) =>
    index === 0
      ? {
          topic,
          status: "blocked_legal_readiness",
          blockers: ["SYNTHETIC_TRACE_PERSISTENCE_ONLY", "NO_REAL_LEGAL_SOURCE_ACTIVATION"],
          rule_input_sha256: ruleInput.payload_sha256,
          amount: null,
          trace: {
            calculation_id: "00000000-0000-4000-8000-000000000001",
            formula_id: `synthetic.${topic}`,
            formula_version: "1.0.0",
            rule: { rule_id: `synthetic.${topic}.rule`, rule_version: "1.0.0" },
            engine_version: "1.0.0",
            inputs: [{
              input_id: "synthetic.input",
              fact_id: "00000000-0000-4000-8000-000000000002",
              fact_path: "compensation.gross_salary",
              value: { kind: "money", value: { currency: "XTS", minor_units: 1_000 } },
            }],
            steps: [{
              step_id: "synthetic.output",
              operation: "identity",
              input_refs: ["synthetic.input"],
              result: { kind: "money", value: { currency: "XTS", minor_units: 1_000 } },
              explanation: "Neutral synthetic identity step.",
            }],
            output: { kind: "money", value: { currency: "XTS", minor_units: 1_000 } },
            calculated_at: timestamp(22),
          },
          legal_readiness: null,
        }
      : {
          topic,
          status: "blocked_legal_readiness",
          blockers: ["NO_REAL_LEGAL_SOURCE_ACTIVATION"],
          rule_input_sha256: ruleInput.payload_sha256,
          amount: null,
          trace: null,
          legal_readiness: null,
        },
  );
  const unsignedBundle = {
    schema_version: "tivdoc-analysis-result-bundle-v0.6.0" as const,
    analysis_run_id: analysisRunId,
    case_id: caseId,
    case_revision: 7,
    period: { start_date: "2026-08-01", end_date: "2026-08-31" },
    as_of: "2026-08-31",
    document_snapshot_sha256: hashes.document,
    extraction_snapshot_sha256: hashes.extraction,
    declared_fact_snapshot_sha256: hashes.declared,
    facts_snapshot_sha256: hashes.facts,
    facts: [],
    rule_inputs: [],
    catalog_sha256: hashes.catalog,
    topic_results: topicResults,
    known_subtotal: null,
    coverage_complete: false,
  };
  const analysisBundle: AnalysisResultBundle = {
    ...unsignedBundle,
    result_sha256: canonicalSha256(unsignedBundle),
  };

  const json = new TextEncoder().encode("synthetic-json");
  const html = new TextEncoder().encode("synthetic-html");
  const pdf = new TextEncoder().encode("%PDF-synthetic");
  const manifest = new TextEncoder().encode("synthetic-manifest");
  const reportHashes = {
    json_sha256: byteSha256(json),
    html_sha256: byteSha256(html),
    pdf_sha256: byteSha256(pdf),
    manifest_sha256: byteSha256(manifest),
  };
  const reportArtifacts: DeterministicReportArtifacts = {
    report_id: reportId,
    report_revision: 7,
    analysis_result_sha256: analysisBundle.result_sha256,
    json,
    html,
    pdf,
    manifest,
    ...reportHashes,
    report_sha256: canonicalSha256({
      report_id: reportId,
      report_revision: 7,
      analysis_result_sha256: analysisBundle.result_sha256,
      ...reportHashes,
    }),
  };
  const confirmation = {
    confirmation_id: `confirmation:dynamic:${suffix}`,
    case_id: caseId,
    source_analysis_run_id: analysisRunId,
    target_fact_path: "compensation.base_monthly_salary",
    question_id: `synthetic.question.${suffix}`,
    question_version: 1,
    proposed_value: null,
    answer: null,
    status: "pending" as const,
    source_message_id: null,
    idempotency_key: `confirmation:dynamic:${suffix}`,
    created_at: timestamp(23),
    answered_at: null,
  };
  const jobPayload = { synthetic_job: 1, fixture_suffix: suffix };
  const outboxPayload = { synthetic_effect: 1, fixture_suffix: suffix };

  return Object.freeze({
    suffix,
    tenant_id: tenantId,
    case_id: caseId,
    analysis_run_id: analysisRunId,
    report_id: reportId,
    review_task_id: `review:dynamic:${suffix}`,
    job_id: `job:dynamic:${suffix}`,
    outbox_id: `outbox:dynamic:${suffix}`,
    logical_effect_id: `effect:dynamic:${suffix}`,
    idempotency_key: `idempotency:dynamic:${suffix}`,
    case_transitions: Object.freeze(caseTransitions),
    payment_evidence: paymentEvidence,
    conversation,
    message,
    document,
    artifact,
    extraction,
    fact,
    hypothesis,
    rule_input: ruleInput,
    analysis_command: analysisCommand,
    analysis_command_sha256: canonicalSha256(analysisCommand),
    analysis_stage: {
      analysis_run_id: analysisRunId,
      stage: "input_snapshot" as const,
      payload: { fixture: "canonical-persistence-v091", synthetic: true },
      payload_sha256: canonicalSha256({ fixture: "canonical-persistence-v091", synthetic: true }),
    },
    dependencies,
    selections,
    analysis_bundle: analysisBundle,
    report_artifacts: reportArtifacts,
    confirmation,
    job: {
      job_id: `job:dynamic:${suffix}`,
      tenant_id: tenantId,
      case_id: caseId,
      job_kind: "analysis_stage",
      idempotency_key: `job:dynamic:${suffix}`,
      payload: jobPayload,
      payload_sha256: canonicalSha256(jobPayload),
      pinned_version_sha256s: [hashes.catalog],
      max_attempts: 3,
      available_at_ms: Date.parse(timestamp(30)),
    },
    outbox: {
      outbox_id: `outbox:dynamic:${suffix}`,
      tenant_id: tenantId,
      case_id: caseId,
      logical_effect_id: `effect:dynamic:${suffix}`,
      effect_kind: "synthetic.dynamic.verification",
      payload: outboxPayload,
      payload_sha256: canonicalSha256(outboxPayload),
      created_at: timestamp(31),
    },
    logical_effect_sha256: canonicalSha256({ suffix, kind: "logical-effect" }),
    job_clock_ms: Date.parse(timestamp(30)) + 1_000,
  });
}

export type SyntheticCapabilityFixtures = ReturnType<typeof createSyntheticCapabilityFixtures>;
