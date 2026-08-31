import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildSyntheticCaseFixture } from "../../../engine/case-analysis/synthetic-fixtures.ts";
import { canonicalJson } from "../../../engine/case-operations/canonical.ts";
import { SYNTHETIC_CATALOG_DATE, SYNTHETIC_POPULATION, SYNTHETIC_SECTOR } from "../../../engine/legal-operations/synthetic-fixtures.ts";
import { canonicalSha256 } from "../../../engine/rule-runtime/canonical.ts";
import { WAVE3_TOPICS, type CaseLifecycleState, type PaymentEvidenceSnapshot } from "../../../engine/wave3/contracts.ts";
import { createIntegratedFullSystemHarness } from "../../engine/case-analysis/integrated-harness.ts";
import {
  CANONICAL_POSTGRES_CAPABILITY_BINDINGS,
  startCanonicalApplicationPostgres,
} from "../../platform/composition/canonical-postgres-application.ts";
import { CANONICAL_POSTGRES_SCHEMA_VERSION } from "../../platform/composition/canonical-postgres.ts";
import { StrictRecordingPostgresDriver } from "../../platform/persistence/postgres/runtime/recording-driver.ts";
import type { StoredReportEdition } from "../customer-portal/contracts.ts";
import { installCanonicalProductApplicationComposition } from "../routes/runtime.ts";
import {
  P8_NOW,
  createP8Harness,
  opsEnvelope,
  storePdf,
  verifiedSyntheticActor,
  type P8Harness,
} from "./ready-harness.ts";

const TENANT_ID = "tenant01";
const OWNER_A = "owner-a-01";
const OWNER_B = "owner-b-01";
const LEGAL_REVIEWER = "legal-reviewer-01";
const REPORT_APPROVER = "report-approver-01";

type BrowserRuntimeGlobal = typeof globalThis & {
  __tivdocBrowserRuntimeInitialization?: Promise<void>;
  __tivdocOriginalFetch?: typeof fetch;
};

type CanonicalResult = Readonly<{
  analysis_run_id: string;
  analysis_result_sha256: string;
  report_id: string;
  report_sha256: string;
  artifact_sha256: string;
  object_version_id: string;
  pdf: Uint8Array;
}>;

export async function initializeHermeticBrowserRuntime(): Promise<void> {
  if (!enabled(process.env.TIVDOC_PRODUCT_BROWSER_RUNTIME_ENABLED)) return;
  const runtime = globalThis as BrowserRuntimeGlobal;
  runtime.__tivdocBrowserRuntimeInitialization ??= buildHermeticBrowserRuntime();
  await runtime.__tivdocBrowserRuntimeInitialization;
}

async function buildHermeticBrowserRuntime(): Promise<void> {
  assertHermeticEnvironment();
  installLoopbackOnlyFetchGuard();

  const fixture = buildSyntheticCaseFixture({ fixture_id: "p8-0", mode: "synthetic_test" });
  const caseId = fixture.command.case_id;
  const harness = await createP8Harness();
  const actors = Object.freeze({
    intake: verifiedSyntheticActor({ actor_id: "intake-operator-01", role: "intake_operator", tenant_id: TENANT_ID, assigned_case_ids: [caseId] }),
    extraction: verifiedSyntheticActor({ actor_id: "extraction-reviewer-01", role: "extraction_reviewer", tenant_id: TENANT_ID, assigned_case_ids: [caseId] }),
    facts: verifiedSyntheticActor({ actor_id: "fact-reviewer-01", role: "fact_reviewer", tenant_id: TENANT_ID, assigned_case_ids: [caseId] }),
    legal: verifiedSyntheticActor({ actor_id: LEGAL_REVIEWER, role: "legal_reviewer", tenant_id: TENANT_ID, assigned_case_ids: [caseId] }),
    approver: verifiedSyntheticActor({ actor_id: REPORT_APPROVER, role: "report_approver", tenant_id: TENANT_ID, assigned_case_ids: [caseId] }),
    owner: verifiedSyntheticActor({ actor_id: OWNER_A, role: "customer_owner", tenant_id: TENANT_ID, assigned_case_ids: [caseId] }),
    otherOwner: verifiedSyntheticActor({ actor_id: OWNER_B, role: "customer_owner", tenant_id: TENANT_ID, assigned_case_ids: [caseId] }),
  });

  await seedCanonicalPrerequisites(harness, caseId, actors);
  const canonical = createIntegratedFullSystemHarness([fixture.stored]);
  const canonicalRevision = await seedIntegratedReportReview(canonical, caseId);
  const canonicalCommand = Object.freeze({
    ...fixture.command,
    case_revision: canonicalRevision,
    period: Object.freeze({ start_date: SYNTHETIC_CATALOG_DATE, end_date: SYNTHETIC_CATALOG_DATE }),
    as_of: SYNTHETIC_CATALOG_DATE,
    sector: SYNTHETIC_SECTOR,
    population: SYNTHETIC_POPULATION,
  });
  let canonicalResult: CanonicalResult | null = null;
  let released = false;

  harness.adapter.installBrowserRuntimeHooks({
    async afterAnalysisRequest(command) {
      if (command.payload.action !== "analysis_request" || command.actor.actor_id !== LEGAL_REVIEWER || command.payload.mode !== "synthetic_test") {
        throw new Error("BROWSER_RUNTIME_ANALYSIS_ACTOR_OR_MODE_INVALID");
      }
      if (command.payload.requested_topics.join(":") !== WAVE3_TOPICS.join(":")) {
        throw new Error("BROWSER_RUNTIME_ANALYSIS_TOPIC_SET_INVALID");
      }
      const bundle = await canonical.application.runCaseAnalysis(canonicalCommand);
      const completed = await canonical.service.getCompletedRun(bundle.analysis_run_id);
      if (!completed?.report || !bundle.coverage_complete || bundle.topic_results.length !== 7 || !bundle.topic_results.every((item) => item.status === "calculated")) {
        throw new Error("BROWSER_RUNTIME_CANONICAL_ANALYSIS_INCOMPLETE");
      }
      const stored = await storePdf(harness, actors.legal, completed.report.pdf, "browser-report");
      await harness.adapter.attachCanonicalAnalysis(caseId, {
        analysis_run_id: bundle.analysis_run_id,
        analysis_result_sha256: bundle.result_sha256,
        report_id: completed.report.report_id,
        report_sha256: completed.report.report_sha256,
        artifact_sha256: stored.artifact_sha256,
        object_version_id: stored.object_version_id,
        coverage_complete: bundle.coverage_complete,
        bytes: completed.report.pdf,
        actor_id: actors.legal.actor_id,
        submit_for_approval: true,
      });
      canonicalResult = Object.freeze({
        analysis_run_id: bundle.analysis_run_id,
        analysis_result_sha256: bundle.result_sha256,
        report_id: completed.report.report_id,
        report_sha256: completed.report.report_sha256,
        artifact_sha256: stored.artifact_sha256,
        object_version_id: stored.object_version_id,
        pdf: Uint8Array.from(completed.report.pdf),
      });
    },
    afterReportApproval(command) {
      const result = canonicalResult;
      const state = harness.adapter.state(caseId);
      if (!result || command.payload.action !== "report_approve" || command.actor.actor_id !== REPORT_APPROVER) {
        throw new Error("BROWSER_RUNTIME_DISTINCT_APPROVER_REQUIRED");
      }
      if (command.payload.report_sha256 !== result.report_sha256 || command.payload.analysis_result_sha256 !== result.analysis_result_sha256) {
        throw new Error("BROWSER_RUNTIME_EXACT_HASH_APPROVAL_REQUIRED");
      }
      if (!state?.report?.approval_receipt_sha256 || state.report.status !== "approved") {
        throw new Error("BROWSER_RUNTIME_APPROVAL_STATE_INVALID");
      }
      if (released) return;
      harness.portalRepository.seedProductEvidence({
        evidence_id: "synthetic-payment-entitlement-01",
        evidence_sha256: canonicalSha256({ case_id: caseId, report_sha256: result.report_sha256, status: "verified" }),
        case_id: caseId,
        owner_actor_id: OWNER_A,
        edition: "full_reviewed_report",
        status: "verified",
        source: "verified_server_evidence",
      });
      const report: StoredReportEdition = Object.freeze({
        report_id: result.report_id,
        report_revision: 1,
        case_id: caseId,
        edition: "full_reviewed_report",
        report_sha256: result.report_sha256,
        artifact_sha256: result.artifact_sha256,
        object_version_id: result.object_version_id,
        release_receipt_sha256: canonicalSha256({
          report_sha256: result.report_sha256,
          approval_receipt_sha256: state.report.approval_receipt_sha256,
          approver_actor_id: command.actor.actor_id,
        }),
        release_state: "released",
        coverage_complete: true,
        blocker_codes: [],
        created_at: P8_NOW,
      });
      harness.portalRepository.seedReport(report, result.pdf);
      harness.portalRepository.recordSyntheticLifecycleTransition(
        caseId,
        command.actor.actor_id,
        "report_ready",
        [],
        state.report.approval_receipt_sha256,
      );
      released = true;
    },
    afterPaymentReconcile(command) {
      if (command.payload.action !== "payment_reconcile") throw new Error("BROWSER_RUNTIME_PAYMENT_ACTION_INVALID");
      const state = harness.adapter.state(caseId);
      if (!state?.payment.hold) return;
      harness.portalRepository.recordSyntheticLifecycleTransition(
        caseId,
        command.actor.actor_id,
        "release_hold",
        ["release_hold"],
        state.payment.evidence_sha256 ?? canonicalSha256({ case_id: caseId, payment: "hold" }),
      );
    },
    declaredCandidates(requestedCaseId) {
      return harness.portalRepository.declaredCandidates(requestedCaseId);
    },
  });

  const postgresRecording = await createCanonicalPostgresRecordingComposition();
  installCanonicalProductApplicationComposition({
    services: { portal: harness.portal, operations: harness.service },
    persistence: postgresRecording.composition,
    proof_class: "STATIC_OR_RECORDING_DRIVER_PROOF",
  });
  await writeStartupReceipt(harness, caseId, postgresRecording.receipt);
}

async function createCanonicalPostgresRecordingComposition() {
  const driver = new StrictRecordingPostgresDriver([
    { statement_name: "transaction_begin" },
    { statement_name: "runtime_context_set" },
    { statement_name: "schema_compatibility_read", result: { rows: [{ schema_version: CANONICAL_POSTGRES_SCHEMA_VERSION }], row_count: 1 } },
    { statement_name: "transaction_commit" },
    { statement_name: "transaction_begin" },
    { statement_name: "runtime_context_set" },
    { statement_name: "transaction_commit" },
  ]);
  const composition = await startCanonicalApplicationPostgres({
    mode: "isolated_postgres",
    execution_boundary: "hermetic_synthetic",
    target: {
      target_id: "v09-browser-recording-proof",
      host: "127.0.0.1",
      database: "tivdoc_v09_browser_recording_001",
      disposable: true,
      validation: "LOOPBACK_DISPOSABLE_VALIDATED",
    },
    build_identity_sha: "0".repeat(40),
  }, { connection_factory: driver });
  if (composition.mode !== "isolated_postgres") throw new Error("BROWSER_RUNTIME_POSTGRES_COMPOSITION_MODE_INVALID");
  await composition.transaction(TENANT_ID, "browser-recording-selection", async (bundle) => {
    if (bundle.intake.context !== bundle.context || !bundle.analysis.caseAnalysis || !bundle.runtime.idempotency || !bundle.runtime.jobs_outbox_audit) {
      throw new Error("BROWSER_RUNTIME_POSTGRES_BINDING_INCOMPLETE");
    }
  });
  const inventory = driver.inventory();
  if (inventory.remaining_steps !== 0 || inventory.acquisitions !== 2 || inventory.releases !== 2) {
    throw new Error("BROWSER_RUNTIME_POSTGRES_RECORDING_PROOF_INCOMPLETE");
  }
  return Object.freeze({
    composition,
    receipt: Object.freeze({
      proof_class: inventory.proof_class,
      capability_bindings: CANONICAL_POSTGRES_CAPABILITY_BINDINGS.length,
      acquisitions: inventory.acquisitions,
      releases: inventory.releases,
      remaining_steps: inventory.remaining_steps,
      statements: inventory.statements.map((entry) => ({ name: entry.name, parameter_count: entry.parameter_count, transaction_control: entry.transaction_control })),
      sensitive_parameter_values_recorded: false,
      dynamic_postgresql_execution_claimed: false,
    }),
  });
}

async function seedIntegratedReportReview(canonical: ReturnType<typeof createIntegratedFullSystemHarness>, caseId: string): Promise<number> {
  const payment: PaymentEvidenceSnapshot = Object.freeze({
    evidence_id: "payment:evidence:browser-canonical:001",
    evidence_revision: "1",
    evidence_sha256: "c".repeat(64),
    case_reference: caseId,
    customer_reference: "customer:opaque:browser-canonical:001",
    amount: Object.freeze({ currency: "ZZZ", minor_units: 9_999 }),
    status: "settled",
    duplicate_of_evidence_id: null,
  });
  canonical.payments.appendVerifiedEvidence(payment);
  canonical.caseOperations.createCase(caseId);
  let state = await canonical.caseOperations.reconcilePayment(caseId, payment.amount, payment.customer_reference);
  const targets: readonly CaseLifecycleState[] = [
    "awaiting_extraction_review",
    "awaiting_fact_resolution",
    "ready_for_legal_evaluation",
    "awaiting_legal_review",
    "awaiting_report_approval",
  ];
  for (const [index, target] of targets.entries()) {
    state = await canonical.caseOperations.transition({
      case_id: caseId,
      expected_revision: state.revision,
      target_state: target,
      actor_id: "actor:synthetic:browser-canonical",
      actor_role: "synthetic_reviewer",
      reason: `browser_canonical_stage_${index}`,
      idempotency_key: `browser:canonical:transition:${index}`,
    });
  }
  return state.revision;
}

async function seedCanonicalPrerequisites(
  harness: P8Harness,
  caseId: string,
  actors: Readonly<{
    intake: ReturnType<typeof verifiedSyntheticActor>;
    extraction: ReturnType<typeof verifiedSyntheticActor>;
    facts: ReturnType<typeof verifiedSyntheticActor>;
    legal: ReturnType<typeof verifiedSyntheticActor>;
    approver: ReturnType<typeof verifiedSyntheticActor>;
    owner: ReturnType<typeof verifiedSyntheticActor>;
    otherOwner: ReturnType<typeof verifiedSyntheticActor>;
  }>,
): Promise<void> {
  await harness.service.mutate(actors.intake, opsEnvelope("case_create", caseId, 0, {
    intake_reference_sha256: canonicalSha256({ fixture: "v0.8-browser", source: "synthetic_only" }),
  }, "browser-create"), "browser-seed-create");

  const paymentCore = Object.freeze({
    evidence_id: "browser-payment-01",
    evidence_revision: "browser-payment-revision-01",
    case_reference: caseId,
    customer_reference: OWNER_A,
    amount: { currency: "XTS", minor_units: 1 },
    status: "settled" as const,
    duplicate_of_evidence_id: null,
  });
  const payment = Object.freeze({ ...paymentCore, evidence_sha256: canonicalSha256(paymentCore) });
  harness.payments.appendVerifiedEvidence(payment);
  await harness.service.mutate(actors.intake, opsEnvelope("payment_reconcile", caseId, 1, {
    payment_reference_sha256: payment.evidence_sha256,
  }, "browser-payment"), "browser-seed-payment");
  const chargebackCore = Object.freeze({ ...paymentCore, evidence_revision: "browser-payment-revision-02", status: "chargeback" as const });
  harness.payments.appendVerifiedEvidence(Object.freeze({ ...chargebackCore, evidence_sha256: canonicalSha256(chargebackCore) }));

  const documentBytes = new TextEncoder().encode("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n");
  const document = await storePdf(harness, actors.intake, documentBytes, "browser-document");
  await harness.service.mutate(actors.intake, opsEnvelope("document_reference_add", caseId, 2, {
    object_version_id: document.object_version_id,
    object_sha256: document.object_sha256,
    byte_length: documentBytes.byteLength,
    detected_mime: "application/pdf",
  }, "browser-document"), "browser-seed-document");

  const extractionSha = canonicalSha256({ case_id: caseId, provider: "stored_synthetic_snapshot", version: 1 });
  await harness.service.mutate(actors.extraction, opsEnvelope("extraction_review", caseId, 3, {
    extraction_snapshot_sha256: extractionSha,
    field_ids: ["field001"],
    decision: "approved",
  }, "browser-extract"), "browser-seed-extraction");

  const factsSha = canonicalSha256({ case_id: caseId, source_snapshot_sha256: extractionSha, version: 1 });
  await harness.service.mutate(actors.facts, opsEnvelope("fact_resolution", caseId, 4, {
    facts_snapshot_sha256: factsSha,
    fact_ids: ["fact0001"],
    decision: "confirmed",
  }, "browser-facts"), "browser-seed-facts");

  harness.portalRepository.seedCase({
    case_id: caseId,
    tenant_id: TENANT_ID,
    owner_actor_id: OWNER_A,
    revision: 1,
    lifecycle_state: "ready_for_legal_evaluation",
    lifecycle_history: [{ revision: 1, lifecycle_state: "ready_for_legal_evaluation", occurred_at: P8_NOW }],
    blocker_codes: [],
    document_references: [{ document_id: "synthetic-document-01", declared_type: "payslip", status: "accepted", revision: 1 }],
    retention: { retention_class: "case_record", legal_hold: true, deletion_status: "not_requested" },
  });
  harness.portal.recordConsent(actors.owner, {
    case_id: caseId,
    consent_version: "synthetic-consent-1",
    terms_version: "synthetic-terms-1",
    granted: true,
    idempotency_key: "browser-consent-0001",
  });
  harness.portal.requestHumanClarification(actors.facts, caseId, [{
    fact_path: "documents.period",
    status: "conflicted",
    fact_ids: ["documented-fact-01"],
    state_sha256: canonicalSha256({ case_id: caseId, fact_path: "documents.period", conflict: true }),
  }]);
}

async function writeStartupReceipt(
  harness: P8Harness,
  caseId: string,
  postgresRecording: Readonly<{
    proof_class: "STATIC_OR_RECORDING_DRIVER_PROOF";
    capability_bindings: number;
    acquisitions: number;
    releases: number;
    remaining_steps: number;
    statements: readonly Readonly<{ name: string; parameter_count: number; transaction_control: boolean }>[];
    sensitive_parameter_values_recorded: false;
    dynamic_postgresql_execution_claimed: false;
  }>,
): Promise<void> {
  const realFixture = buildSyntheticCaseFixture({ fixture_id: "v08-real-inactive", mode: "real" });
  const real = createIntegratedFullSystemHarness([realFixture.stored]);
  const realBundle = await real.application.runCaseAnalysis(realFixture.command);
  const blocked = realBundle.topic_results.filter((item) => item.status === "blocked_legal_readiness");
  const provenanceCandidates = [1, 2, 3, 4, 5].map((index) => Object.freeze({
    candidate_id: `REAL_PUBLIC_00${index}`,
    repository_declarations: [
      "src/server/engine/extraction/benchmarks/openai/real-public/artifacts.ts",
      "src/server/engine/extraction/benchmarks/openai/real-public/ground-truth.ts",
    ],
    eligibility_gate: "src/engine/extraction-ground-truth/overnight-v07/workspace.ts",
    acquisition_boundary: "repository_only_no_fixture_bytes_read",
    source_reference: null,
    acquisition_date: null,
    license_or_reuse_evidence: null,
    pii_status: "VISIBLE_PII_DECLARED_NOT_REVALIDATED",
    visible_pii_categories: ["employee_name", "national_id", "address", "bank_account", "employer_identity"],
    immutable_fixture_sha256: null,
    fixture_bytes_read: 0,
    eligibility: "PUBLIC_FIXTURE_PROVENANCE_NOT_ELIGIBLE",
    missing_evidence: ["source_reference", "acquisition_date", "explicit_reuse_license", "immutable_fixture_sha256"],
  }));
  const lane = process.env.TIVDOC_PRODUCT_E2E_LANE === "negative" ? "negative" : "synthetic";
  const outputRoot = path.resolve(process.cwd(), "output", "product-integration-v0.8.0", "e2e", lane);
  await mkdir(outputRoot, { recursive: true });
  const receipt = Object.freeze({
    schema_version: "tivdoc-product-browser-startup-v0.8.0",
    status: "PRE_START_SEED_READY",
    lane,
    case_id: caseId,
    canonical_composition: [
      "InternalOpsService",
      "CustomerPortalService",
      "createIntegratedFullSystemHarness",
      "DeterministicCaseReportBuilder",
      "LocalPrivateObjectStorage",
      "SyntheticPortalRepository",
      "startCanonicalApplicationPostgres",
    ],
    canonical_postgres_recording: postgresRecording,
    prerequisites: {
      payment_evidence: "verified_settled_synthetic",
      document: "stored_hash_bound_synthetic",
      extraction: "reviewed_synthetic",
      facts: "confirmed_synthetic",
      clarification: "human_handoff_open",
      deterministic_topic_count: 7,
    },
    real_corpus: {
      active_sources: 0,
      ready_topics: 0,
      blocked_topics: blocked.length,
      calculations: real.executor.counters.execute_calls,
      findings: 0,
      approvals: real.review.counters.approvals,
      exports: 0,
      topic_statuses: realBundle.topic_results.map((item) => ({ topic: item.topic, status: item.status })),
    },
    provenance_candidates: provenanceCandidates,
    human_handoff: {
      generated_decisions: 0,
      generated_signatures: 0,
      owner_actions: [
        {
          artifact: "seven_topic_legal_review_workspace",
          path: "output/overnight-v0.7/p3/run-c/review-workspace",
          index_files: [
            "output/overnight-v0.7/p3/run-c/review-workspace/owner-action-index.json",
            "output/overnight-v0.7/p3/run-c/review-workspace/workspace-index.json",
          ],
          build_command: "npm run legal:review-workspace:build -- --output output/overnight-v0.7/p3/run-c",
          import_command: "npm run legal:ops:import",
          roles: ["identified_legal_reviewer", "distinct_importer", "configured_cryptographic_trust_operator"],
          gates_unlocked_only_after: ["exact_workspace_hash_review", "reviewer_identity_verification", "signature_verification", "separation_of_duties"],
        },
        {
          artifact: "seven_rulespec_skeletons",
          path: "output/overnight-v0.7/p4/legal-quality/rulespec-skeletons",
          index_files: ["output/overnight-v0.7/p4/legal-quality/manifest.json"],
          build_command: "npm run legal:rulespec-skeletons:verify",
          import_command: "npm run legal:ops:propose-activation",
          roles: ["rulespec_author", "legal_reviewer", "numeric_parameter_attestor", "independent_rulespec_approver"],
          gates_unlocked_only_after: ["source_active", "parameter_dual_attestation", "golden_case_set_bound", "rulespec_legal_approval"],
        },
        {
          artifact: "forty_two_blank_golden_cases",
          path: "output/overnight-v0.7/p4/legal-quality/golden-templates",
          index_files: ["output/overnight-v0.7/p4/legal-quality/manifest.json"],
          build_command: "npm run legal:golden-workflow:verify",
          import_command: "npm run legal:ops:import",
          roles: ["golden_case_author", "legal_reviewer", "independent_reviewer"],
          gates_unlocked_only_after: ["human_cases_completed", "expected_results_reviewed", "signatures_verified", "rulespec_hash_bound"],
        },
        {
          artifact: "ground_truth_workspace",
          path: "output/overnight-v0.7/p4/ground-truth",
          index_files: [
            "output/overnight-v0.7/p4/ground-truth/manifest.json",
            "output/overnight-v0.7/p4/ground-truth/workspace.json",
          ],
          build_command: "npm run extraction:gt:workspace:verify",
          import_command: "npm run extraction:gt:workspace:verify",
          roles: ["annotator_1", "independent_annotator_2", "human_adjudicator", "identity_signature_verifier"],
          gates_unlocked_only_after: ["annotation_1_sealed", "annotation_2_sealed", "disagreements_adjudicated", "locked_ground_truth_signed"],
        },
      ],
      blockers_preserved: [
        "OWNER_OFFICIAL_SOURCE_HANDOFF_REQUIRED",
        "HUMAN_LEGAL_SOURCE_REVIEW_REQUIRED",
        "NUMERIC_DUAL_ATTESTATION_REQUIRED",
        "RULE_LEGAL_APPROVAL_REQUIRED",
        "HUMAN_GROUND_TRUTH_REQUIRED",
        "REVIEWER_IDENTITY_AND_SIGNATURE_VERIFICATION_MISSING",
      ],
    },
    safety_counters: {
      external_calls: 0,
      customer_records_read: 0,
      production_mutations: 0,
      real_calculations: 0,
      real_findings: 0,
      real_approvals: 0,
      real_exports: 0,
    },
    operations_revision: harness.adapter.state(caseId)?.revision ?? null,
  });
  const serialized = canonicalJson(receipt);
  await writeFile(path.join(outputRoot, "runtime-seed-receipt.json"), serialized, "utf8");
  await writeFile(path.join(outputRoot, "runtime-seed-receipt.sha256"), `${sha(serialized)}\n`, "utf8");
}

function installLoopbackOnlyFetchGuard(): void {
  const runtime = globalThis as BrowserRuntimeGlobal;
  if (runtime.__tivdocOriginalFetch) return;
  const original = globalThis.fetch.bind(globalThis);
  runtime.__tivdocOriginalFetch = original;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const raw = input instanceof Request ? input.url : input.toString();
    const url = new URL(raw);
    if ((url.protocol === "http:" || url.protocol === "https:") && !isLoopback(url.hostname)) {
      throw new Error("TIVDOC_HERMETIC_OUTBOUND_NETWORK_DENIED");
    }
    return original(input, init);
  };
}

function assertHermeticEnvironment(): void {
  if (!enabled(process.env.TIVDOC_HERMETIC_MODE)) throw new Error("BROWSER_RUNTIME_HERMETIC_MODE_REQUIRED");
  if (process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production" || process.env.VERCEL_ENV === "preview") {
    throw new Error("BROWSER_RUNTIME_PRODUCTION_PREVIEW_FORBIDDEN");
  }
  if (!enabled(process.env.TIVDOC_PORTAL_UI_ENABLED) || !enabled(process.env.TIVDOC_PORTAL_API_ENABLED)
      || !enabled(process.env.TIVDOC_OPERATIONS_UI_ENABLED) || !enabled(process.env.TIVDOC_OPERATIONS_API_ENABLED)) {
    throw new Error("BROWSER_RUNTIME_STABLE_ROUTES_REQUIRED");
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function enabled(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

function sha(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
