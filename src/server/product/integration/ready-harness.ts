import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalSha256 } from "../../../engine/rule-runtime/canonical";
import { WAVE3_TOPICS, type CaseLifecycleState, type PaymentEvidenceSnapshot } from "../../../engine/wave3/contracts";
import type { V07Role, VerifiedActor } from "../../../engine/wave4/contracts";
import { InMemoryVerifiedPaymentEvidenceStore } from "../../engine/case-operations/verified-payment-evidence";
import { InMemoryHashChainAudit } from "../../platform/audit/hash-chain";
import { authorize, type AuthorizationAction } from "../../platform/auth/authorization";
import { deriveVerifiedActor, type TrustedIdentityEnvelope } from "../../platform/auth/claims";
import { LocalDurableJobQueue } from "../../platform/jobs/durable-job-queue";
import { PlatformPersistenceError } from "../../platform/persistence/contracts";
import { LocalDurablePlatformStore } from "../../platform/persistence/transactional-store";
import { assertCsrfProtectedMutation } from "../../platform/security/request-guards";
import { LocalPrivateObjectStorage } from "../../platform/storage/private-object-storage";
import { CustomerPortalService } from "../customer-portal/service";
import { SyntheticPortalRepository } from "../customer-portal/synthetic-repository";
import {
  INTERNAL_OPS_SCHEMA_VERSION,
  type AnalysisProjection,
  type AuditProjection,
  type DocumentProjection,
  type ExtractionProjection,
  type FactsProjection,
  type InternalOpsCaseProjection,
  type InternalOpsCommandResult,
  type MutationResultProjection,
  type OpsCapability,
  type PaymentProjection,
  type QueueProjection,
  type ReadinessProjection,
  type ReportProjection,
  type TimelineProjection,
  type TrustedInternalOpsCommand,
} from "../internal-ops/contracts";
import type { InternalOpsCommandPort, InternalOpsIdentityPort, InternalOpsProjectionPort } from "../internal-ops/ports";
import { InternalOpsService } from "../internal-ops/service";
import { createInternalOpsHttpAdapter } from "../internal-ops/http";
import type { InternalOpsFlagSnapshot } from "../internal-ops/flags";

export const P8_NOW = "2040-01-01T00:00:00.000Z" as const;
export const P8_NOW_MS = Date.parse(P8_NOW);
export const P8_ORIGIN = "https://p8.test.invalid" as const;
export const P8_CSRF = "p8_csrf_token_0123456789abcdef0123456789abcdef" as const;

const FLAGS: InternalOpsFlagSnapshot = Object.freeze({
  TIVDOC_INTERNAL_OPS_UI_ENABLED: true,
  TIVDOC_INTERNAL_OPS_API_ENABLED: true,
  TIVDOC_SYNTHETIC_OPS_ENABLED: true,
  TIVDOC_PUBLIC_FIXTURE_OPS_ENABLED: false,
  TIVDOC_MANUAL_REPORT_EXPORT_ENABLED: true,
  TIVDOC_CUSTOMER_PROCESSING_ENABLED: false,
  TIVDOC_CUSTOMER_SHADOW_ENABLED: false,
  TIVDOC_PRODUCTION_DELIVERY_ENABLED: false,
});

type StoredDocument = Readonly<{ object_version_id: string; object_sha256: string; byte_length: number; detected_mime: string }>;
type StoredReport = Readonly<{
  report_id: string;
  report_revision: number;
  report_sha256: string;
  analysis_result_sha256: string;
  artifact_sha256: string;
  object_version_id: string;
  status: ReportProjection["status"];
  coverage_complete: boolean;
  approval_receipt_sha256: string | null;
  last_content_actor_id: string;
}>; 

type IntegratedCaseState = Readonly<{
  case_id: string;
  tenant_id: string;
  revision: number;
  state: CaseLifecycleState;
  mode: "real" | "synthetic_test";
  created_at: string;
  updated_at: string;
  intake_reference_sha256: string;
  payment: PaymentProjection;
  documents: readonly StoredDocument[];
  extraction_sha256: string | null;
  facts_sha256: string | null;
  analysis_run_id: string | null;
  analysis_result_sha256: string | null;
  report: StoredReport | null;
  invalidation_codes: readonly string[];
  blocker_codes: readonly string[];
}>;

export type P8BrowserRuntimeHooks = Readonly<{
  afterAnalysisRequest(command: TrustedInternalOpsCommand): Promise<void>;
  afterReportApproval(command: TrustedInternalOpsCommand): Promise<void> | void;
  afterPaymentReconcile(command: TrustedInternalOpsCommand): Promise<void> | void;
  declaredCandidates(caseId: string): readonly Readonly<{ candidate_id: string; fact_path: string; candidate_sha256: string; conflicting_documented_fact_ids: readonly string[] }>[];
}>;

function sha(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function verifiedSyntheticActor(input: Readonly<{
  actor_id: string;
  role: V07Role;
  tenant_id: string | null;
  assigned_case_ids: readonly string[];
  runtime?: "test" | "production";
}>): VerifiedActor {
  const envelope: TrustedIdentityEnvelope = Object.freeze({
    source: "verified_server_adapter",
    signature_valid: true,
    issuer: "p8-local-issuer",
    audience: "p8-local-audience",
    issued_at: "2039-12-31T23:59:00.000Z",
    expires_at: "2040-01-01T01:00:00.000Z",
    actor_id: input.actor_id,
    role: input.role,
    tenant_id: input.tenant_id,
    assigned_case_ids: Object.freeze([...input.assigned_case_ids]),
    break_glass_reason: null,
    break_glass_expires_at: null,
    test_only: true,
  });
  return deriveVerifiedActor(envelope, {
    issuer: "p8-local-issuer",
    audience: "p8-local-audience",
    runtime: input.runtime ?? "test",
    clock_skew_ms: 0,
  }, P8_NOW_MS);
}

class VerifiedSessionIdentity implements InternalOpsIdentityPort {
  readonly #sessions = new Map<string, VerifiedActor>();
  readonly #resource: (caseId: string | null) => IntegratedCaseState | null;

  constructor(resource: (caseId: string | null) => IntegratedCaseState | null) {
    this.#resource = resource;
  }

  add(token: string, actor: VerifiedActor): void { this.#sessions.set(token, actor); }

  async authenticate(request: Request): Promise<VerifiedActor | null> {
    const token = request.headers.get("authorization")?.match(/^Bearer ([a-z][a-z0-9_-]{7,63})$/)?.[1];
    if (!token) return null;
    if (request.method !== "GET") {
      const cookie = request.headers.get("cookie")?.match(/(?:^|;\s*)tivdoc_csrf=([^;]+)/)?.[1] ?? null;
      assertCsrfProtectedMutation({
        method: request.method,
        origin: request.headers.get("origin"),
        allowed_origin: P8_ORIGIN,
        content_type: request.headers.get("content-type"),
        cookie_token: cookie,
        header_token: request.headers.get("x-csrf-token"),
      });
    }
    return this.#sessions.get(token) ?? null;
  }

  async authorize(actor: VerifiedActor, capability: OpsCapability, caseId: string | null): Promise<boolean> {
    const state = this.#resource(caseId);
    const action = p2Action(actor.role, capability);
    return authorize(actor, action, {
      tenant_id: state?.tenant_id ?? actor.tenant_id,
      case_id: caseId,
      owner_actor_id: null,
      report_released: state?.report?.status === "approved",
      last_content_actor_id: state?.report?.last_content_actor_id ?? null,
      first_parameter_attestor_id: null,
      worker_scope_actor_id: actor.role === "scoped_background_worker" ? actor.actor_id : null,
      break_glass_audit_bound: false,
    }, P8_NOW_MS).allowed;
  }
}

function p2Action(role: V07Role, capability: OpsCapability): AuthorizationAction {
  if (capability === "audit.read") return "read_audit_metadata";
  if (capability.startsWith("command.report_approve") || capability.startsWith("command.report_reject") || capability.startsWith("command.report_manual_export")) return "approve_report";
  if (capability.startsWith("command.extraction")) return "review_extraction";
  if (capability.startsWith("command.fact")) return "review_facts";
  if (capability.startsWith("command.analysis") || capability.startsWith("command.report_submit")) return "review_legal";
  if (capability.startsWith("command.")) return "mutate_case";
  if (role === "auditor") return "read_audit_metadata";
  if (role === "legal_reviewer" || role === "parameter_verifier") return "read_legal_artifact";
  if (role === "extraction_reviewer" || role === "fact_reviewer") return "read_document_body";
  if (role === "scoped_background_worker") return "run_scoped_job";
  return "read_case_metadata";
}

class P1BackedOpsAdapter implements InternalOpsProjectionPort, InternalOpsCommandPort {
  readonly store: LocalDurablePlatformStore;
  readonly payments: InMemoryVerifiedPaymentEvidenceStore;
  readonly #artifacts = new Map<string, Uint8Array>();
  #browserRuntimeHooks: P8BrowserRuntimeHooks | null = null;

  constructor(store: LocalDurablePlatformStore, payments: InMemoryVerifiedPaymentEvidenceStore) {
    this.store = store;
    this.payments = payments;
  }

  state(caseId: string): IntegratedCaseState | null {
    return (this.store.current("cases", caseId)?.payload as IntegratedCaseState | undefined) ?? null;
  }

  installBrowserRuntimeHooks(hooks: P8BrowserRuntimeHooks): void {
    if (process.env.NODE_ENV === "production") throw new Error("P8_BROWSER_RUNTIME_HOOKS_PRODUCTION_FORBIDDEN");
    if (this.#browserRuntimeHooks) throw new Error("P8_BROWSER_RUNTIME_HOOKS_ALREADY_INSTALLED");
    this.#browserRuntimeHooks = Object.freeze(hooks);
  }

  attachCanonicalAnalysis(caseId: string, input: Readonly<{
    analysis_run_id: string;
    analysis_result_sha256: string;
    report_id: string;
    report_sha256: string;
    artifact_sha256: string;
    object_version_id: string;
    coverage_complete: boolean;
    bytes: Uint8Array;
    actor_id: string;
    submit_for_approval?: boolean;
  }>): Promise<MutationResultProjection> {
    const current = this.required(caseId);
    const next: IntegratedCaseState = Object.freeze({
      ...current,
      revision: current.revision + 1,
      state: input.submit_for_approval ? "awaiting_report_approval" : "awaiting_legal_review",
      updated_at: P8_NOW,
      analysis_run_id: input.analysis_run_id,
      analysis_result_sha256: input.analysis_result_sha256,
      report: Object.freeze({
        report_id: input.report_id,
        report_revision: 1,
        report_sha256: input.report_sha256,
        analysis_result_sha256: input.analysis_result_sha256,
        artifact_sha256: input.artifact_sha256,
        object_version_id: input.object_version_id,
        status: input.submit_for_approval ? "awaiting_approval" : "internal_draft",
        coverage_complete: input.coverage_complete,
        approval_receipt_sha256: null,
        last_content_actor_id: input.actor_id,
      }),
    });
    this.#artifacts.set(input.artifact_sha256, Uint8Array.from(input.bytes));
    return this.persistDirect(current, next, input.actor_id, "canonical_analysis_attached", `p8-analysis-${input.analysis_result_sha256.slice(0, 24)}`);
  }

  async execute(command: TrustedInternalOpsCommand): Promise<InternalOpsCommandResult> {
    const caseId = command.payload.case_id;
    const current = this.state(caseId);
    if (command.payload.action !== "case_create" && !current) throw Object.freeze({ code: "record_not_found" });
    const next = await this.reduce(current, command);
    const commandHash = canonicalSha256(command);
    try {
      const receipt = await this.store.execute({
        tenant_id: command.actor.tenant_id!,
        case_id: caseId,
        actor_id: command.actor.actor_id,
        scope: `ops:${command.payload.action}`,
        idempotency_key: command.idempotency_key,
        expected_case_revision: command.expected_revision,
        command_sha256: commandHash,
        command,
        occurred_at: P8_NOW,
        writes: [{ entity: "cases", record_id: caseId, expected_revision: current?.revision ?? 0, payload_sha256: canonicalSha256(next), payload: next }],
        invalidates: [],
        outbox: [{
          logical_effect_id: `${caseId}:${command.payload.action}:${command.idempotency_key}`,
          effect_kind: `ops.${command.payload.action}`,
          payload_sha256: canonicalSha256({ case_id: caseId, revision: next.revision }),
          payload: { case_id: caseId, revision: next.revision },
        }],
      });
      const persisted = this.required(caseId);
      const mutation = this.mutation(persisted, receipt.command_sha256, receipt.audit_event_sha256, receipt.idempotent_replay);
      if (command.payload.action === "report_manual_export") {
        const report = persisted.report!;
        const bytes = this.#artifacts.get(report.artifact_sha256);
        if (!bytes) throw Object.freeze({ code: "exact_report_approval_required" });
        return Object.freeze({ mutation, format: command.payload.format, media_type: "application/pdf" as const, artifact_sha256: report.artifact_sha256, bytes: Uint8Array.from(bytes) });
      }
      if (!receipt.idempotent_replay && command.payload.action === "analysis_request" && this.#browserRuntimeHooks) {
        await this.#browserRuntimeHooks.afterAnalysisRequest(command);
      }
      if (!receipt.idempotent_replay && command.payload.action === "report_approve" && this.#browserRuntimeHooks) {
        await this.#browserRuntimeHooks.afterReportApproval(command);
      }
      if (!receipt.idempotent_replay && command.payload.action === "payment_reconcile" && this.#browserRuntimeHooks) {
        await this.#browserRuntimeHooks.afterPaymentReconcile(command);
      }
      const postHook = this.required(caseId);
      return this.mutation(postHook, receipt.command_sha256, receipt.audit_event_sha256, receipt.idempotent_replay);
    } catch (error) {
      if (error instanceof PlatformPersistenceError) {
        if (error.code === "CASE_REVISION_CONFLICT" || error.code === "ENTITY_REVISION_CONFLICT") throw Object.freeze({ code: "case_revision_conflict" });
        if (error.code === "IDEMPOTENCY_KEY_COMMAND_MISMATCH") throw Object.freeze({ code: "idempotency_key_reused_with_different_command" });
      }
      throw error;
    }
  }

  async queue(actor: VerifiedActor): Promise<QueueProjection> {
    const records = this.store.snapshot().records.flatMap(([, values]) => values).filter((record) => record.entity === "cases" && record.visible);
    const latest = new Map(records.map((record) => [record.record_id, record.payload as IntegratedCaseState]));
    return Object.freeze({ schema_version: INTERNAL_OPS_SCHEMA_VERSION, items: [...latest.values()].filter((state) => actor.assigned_case_ids.includes(state.case_id)).map((state) => ({ case_id: state.case_id, revision: state.revision, state: state.state, blocker_count: state.blocker_codes.length, next_action_code: `next:${state.state}`, updated_at: state.updated_at })), next_cursor: null });
  }

  async case(_actor: VerifiedActor, caseId: string): Promise<InternalOpsCaseProjection | null> {
    const state = this.state(caseId); return state ? this.caseProjection(state) : null;
  }

  async timeline(_actor: VerifiedActor, caseId: string): Promise<TimelineProjection | null> {
    if (!this.state(caseId)) return null;
    const events = this.store.auditEvents().filter((item) => item.case_id === caseId).map((item) => ({ sequence: item.sequence, event_code: item.action, revision: item.case_revision, occurred_at: item.occurred_at, actor_role: "scoped_background_worker" as const, event_sha256: item.event_sha256 }));
    return Object.freeze({ schema_version: INTERNAL_OPS_SCHEMA_VERSION, case_id: caseId, events });
  }

  async payment(_actor: VerifiedActor, caseId: string): Promise<PaymentProjection | null> { return this.state(caseId)?.payment ?? null; }
  async documents(_actor: VerifiedActor, caseId: string): Promise<DocumentProjection | null> {
    const state = this.state(caseId); if (!state) return null;
    return Object.freeze({ schema_version: INTERNAL_OPS_SCHEMA_VERSION, case_id: caseId, documents: state.documents.map((document) => ({ ...document, status: "accepted" as const })) });
  }
  async extraction(_actor: VerifiedActor, caseId: string): Promise<ExtractionProjection | null> {
    const state = this.state(caseId); if (!state) return null;
    return Object.freeze({ schema_version: INTERNAL_OPS_SCHEMA_VERSION, case_id: caseId, snapshot_sha256: state.extraction_sha256, fields: state.extraction_sha256 ? [{ field_id: "field001", canonical_path: "documents.period", status: "confirmed" as const, confidence_micros: 1_000_000, source_document_id: state.documents[0]?.object_version_id ?? null }] : [] });
  }
  async facts(_actor: VerifiedActor, caseId: string): Promise<FactsProjection | null> {
    const state = this.state(caseId); if (!state) return null;
    const declared = this.#browserRuntimeHooks?.declaredCandidates(caseId) ?? [];
    const facts = [
      ...(state.facts_sha256 ? [{ fact_id: "fact0001", canonical_path: "documents.period", status: "confirmed" as const, provenance_count: 1, conflict_count: 0 }] : []),
      ...declared.map((candidate) => ({ fact_id: candidate.candidate_id, canonical_path: candidate.fact_path, status: "needs_confirmation" as const, provenance_count: 1, conflict_count: candidate.conflicting_documented_fact_ids.length })),
    ];
    const snapshotSha = state.facts_sha256 === null ? null : declared.length === 0 ? state.facts_sha256 : canonicalSha256({ confirmed_snapshot_sha256: state.facts_sha256, declared_candidates: declared.map((item) => item.candidate_sha256) });
    return Object.freeze({ schema_version: INTERNAL_OPS_SCHEMA_VERSION, case_id: caseId, snapshot_sha256: snapshotSha, facts });
  }
  async readiness(_actor: VerifiedActor, caseId: string): Promise<ReadinessProjection | null> {
    const state = this.state(caseId); if (!state) return null;
    const ready = state.facts_sha256 !== null && state.mode === "synthetic_test";
    return Object.freeze({ schema_version: INTERNAL_OPS_SCHEMA_VERSION, case_id: caseId, topics: WAVE3_TOPICS.map((topic) => ({ topic, status: ready ? "READY" as const : "BLOCKED_NOT_READY" as const, blocker_codes: ready ? [] : ["legal_readiness_not_proven"], decision_sha256: ready ? canonicalSha256({ topic, case_id: caseId }) : null, decision_source: "evaluateLegalReadiness" as const })), all_topics_ready: ready });
  }
  async analysis(_actor: VerifiedActor, caseId: string): Promise<AnalysisProjection | null> {
    const state = this.state(caseId); if (!state) return null;
    return Object.freeze({ schema_version: INTERNAL_OPS_SCHEMA_VERSION, case_id: caseId, runs: state.analysis_run_id ? [{ analysis_run_id: state.analysis_run_id, status: state.analysis_result_sha256 ? "complete" as const : "requested" as const, input_snapshot_sha256: state.facts_sha256!, result_sha256: state.analysis_result_sha256, known_subtotal_minor_units: null, coverage_complete: state.report?.coverage_complete ?? false, blocker_codes: state.blocker_codes }] : [] });
  }
  async report(_actor: VerifiedActor, caseId: string): Promise<ReportProjection | null> {
    const state = this.state(caseId); if (!state) return null;
    const report = state.report;
    return Object.freeze({ schema_version: INTERNAL_OPS_SCHEMA_VERSION, case_id: caseId, report_id: report?.report_id ?? null, report_revision: report?.report_revision ?? null, report_sha256: report?.report_sha256 ?? null, analysis_result_sha256: report?.analysis_result_sha256 ?? null, status: report?.status ?? "not_created", coverage_complete: report?.coverage_complete ?? false, watermark: "INTERNAL_DRAFT_NOT_FOR_CUSTOMER", exact_hash_approval_receipt_sha256: report?.approval_receipt_sha256 ?? null, manual_export_eligible: report?.status === "approved" && report.coverage_complete, blocker_codes: state.blocker_codes });
  }
  async audit(_actor: VerifiedActor, caseId: string): Promise<AuditProjection | null> {
    if (!this.state(caseId)) return null;
    const events = this.store.auditEvents().filter((item) => item.case_id === caseId);
    return Object.freeze({ schema_version: INTERNAL_OPS_SCHEMA_VERSION, case_id: caseId, chain_valid: events.every((event) => event.previous_sha256 === (this.store.auditEvents()[event.sequence - 2]?.event_sha256 ?? null)), event_count: events.length, tail_sha256: events.at(-1)?.event_sha256 ?? null, events: events.map((item) => ({ sequence: item.sequence, action: item.action, resource_revision: item.case_revision, resource_sha256: item.command_sha256, event_sha256: item.event_sha256, occurred_at: item.occurred_at })) });
  }

  private required(caseId: string): IntegratedCaseState { const state = this.state(caseId); if (!state) throw new Error("P8_CASE_NOT_FOUND"); return state; }
  private caseProjection(state: IntegratedCaseState): InternalOpsCaseProjection {
    return Object.freeze({ schema_version: INTERNAL_OPS_SCHEMA_VERSION, case_id: state.case_id, revision: state.revision, state: state.state, mode: state.mode, created_at: state.created_at, updated_at: state.updated_at, snapshot_hashes: { documents: state.documents.length ? canonicalSha256(state.documents) : null, extraction: state.extraction_sha256, facts: state.facts_sha256, analysis: state.analysis_result_sha256, report: state.report?.report_sha256 ?? null }, invalidation_codes: state.invalidation_codes, blocker_codes: state.blocker_codes });
  }
  private mutation(state: IntegratedCaseState, commandSha: string, auditSha: string, replay: boolean): MutationResultProjection {
    return Object.freeze({ schema_version: INTERNAL_OPS_SCHEMA_VERSION, case_id: state.case_id, revision: state.revision, state: state.state, command_sha256: commandSha, audit_event_sha256: auditSha, idempotent_replay: replay, snapshot_hashes: this.caseProjection(state).snapshot_hashes, invalidation_codes: state.invalidation_codes, blocker_codes: state.blocker_codes, correlation_id: "p8correlation0001" });
  }
  private async persistDirect(current: IntegratedCaseState, next: IntegratedCaseState, actorId: string, scope: string, idempotency: string): Promise<MutationResultProjection> {
    const command = { scope, case_id: current.case_id, revision: next.revision };
    const receipt = await this.store.execute({ tenant_id: current.tenant_id, case_id: current.case_id, actor_id: actorId, scope, idempotency_key: idempotency, expected_case_revision: current.revision, command_sha256: canonicalSha256(command), command, occurred_at: P8_NOW, writes: [{ entity: "cases", record_id: current.case_id, expected_revision: current.revision, payload_sha256: canonicalSha256(next), payload: next }], invalidates: [], outbox: [] });
    return this.mutation(this.required(current.case_id), receipt.command_sha256, receipt.audit_event_sha256, receipt.idempotent_replay);
  }

  private async reduce(current: IntegratedCaseState | null, command: TrustedInternalOpsCommand): Promise<IntegratedCaseState> {
    const payload = command.payload;
    if (payload.action === "case_create") {
      if (current) throw Object.freeze({ code: "case_revision_conflict" });
      const payment: PaymentProjection = Object.freeze({ schema_version: INTERNAL_OPS_SCHEMA_VERSION, case_id: payload.case_id, status: "unmatched", evidence_revision: null, evidence_sha256: null, reference_sha256: null, hold: false });
      return Object.freeze({ case_id: payload.case_id, tenant_id: command.actor.tenant_id!, revision: 1, state: "awaiting_payment", mode: "synthetic_test", created_at: P8_NOW, updated_at: P8_NOW, intake_reference_sha256: payload.intake_reference_sha256, payment, documents: [], extraction_sha256: null, facts_sha256: null, analysis_run_id: null, analysis_result_sha256: null, report: null, invalidation_codes: [], blocker_codes: [] });
    }
    const base = current!;
    if (payload.action === "payment_reconcile") {
      const evidence = (await this.payments.loadVerifiedEvidence(payload.case_id)).find((item) => item.evidence_sha256 === payload.payment_reference_sha256);
      if (!evidence) throw Object.freeze({ code: "payment_evidence_mismatch" });
      const adverse = evidence.status === "refunded" || evidence.status === "chargeback" || evidence.status === "failed" || evidence.status === "cancelled";
      return Object.freeze({ ...base, revision: base.revision + 1, updated_at: P8_NOW, state: adverse ? "release_hold" : evidence.status === "settled" ? "awaiting_documents" : base.state, payment: paymentProjection(base.case_id, evidence, adverse), report: adverse && base.report ? Object.freeze({ ...base.report, status: "invalidated", approval_receipt_sha256: null }) : base.report, invalidation_codes: adverse ? Object.freeze([`payment_${evidence.status}`]) : base.invalidation_codes });
    }
    if (payload.action === "document_reference_add") return Object.freeze({ ...base, revision: base.revision + 1, updated_at: P8_NOW, state: "awaiting_extraction_review", documents: Object.freeze([...base.documents, { object_version_id: payload.object_version_id, object_sha256: payload.object_sha256, byte_length: payload.byte_length, detected_mime: payload.detected_mime }]) });
    if (payload.action === "extraction_review") return Object.freeze({ ...base, revision: base.revision + 1, updated_at: P8_NOW, state: payload.decision === "approved" ? "awaiting_fact_resolution" : "awaiting_extraction_review", extraction_sha256: payload.extraction_snapshot_sha256 });
    if (payload.action === "fact_resolution") return Object.freeze({ ...base, revision: base.revision + 1, updated_at: P8_NOW, state: payload.decision === "confirmed" ? "ready_for_legal_evaluation" : "awaiting_fact_resolution", facts_sha256: payload.facts_snapshot_sha256 });
    if (payload.action === "analysis_request" || payload.action === "analysis_resume" || payload.action === "analysis_replay") return Object.freeze({ ...base, revision: base.revision + 1, updated_at: P8_NOW, state: "awaiting_legal_review", mode: payload.mode, analysis_run_id: payload.analysis_run_id ?? `analysis_${payload.input_snapshot_sha256.slice(0, 24)}` });
    if (payload.action === "report_submit") return Object.freeze({ ...base, revision: base.revision + 1, updated_at: P8_NOW, state: "awaiting_report_approval", report: Object.freeze({ ...base.report!, status: "awaiting_approval" }) });
    if (payload.action === "report_approve") {
      const approval = canonicalSha256({ report_sha256: payload.report_sha256, actor_id: command.actor.actor_id, decision: payload.decision });
      return Object.freeze({ ...base, revision: base.revision + 1, updated_at: P8_NOW, state: "report_ready", report: Object.freeze({ ...base.report!, status: "approved", approval_receipt_sha256: approval }) });
    }
    if (payload.action === "report_reject") return Object.freeze({ ...base, revision: base.revision + 1, updated_at: P8_NOW, state: "awaiting_legal_review", report: Object.freeze({ ...base.report!, status: "rejected", approval_receipt_sha256: null }) });
    return Object.freeze({ ...base, revision: base.revision + 1, updated_at: P8_NOW });
  }
}

function paymentProjection(caseId: string, evidence: PaymentEvidenceSnapshot, adverse: boolean): PaymentProjection {
  return Object.freeze({ schema_version: INTERNAL_OPS_SCHEMA_VERSION, case_id: caseId, status: evidence.status === "cancelled" ? "failed" : evidence.status, evidence_revision: evidence.evidence_revision, evidence_sha256: evidence.evidence_sha256, reference_sha256: evidence.evidence_sha256, hold: adverse });
}

export type P8Harness = Awaited<ReturnType<typeof createP8Harness>>;

export async function createP8Harness() {
  const store = new LocalDurablePlatformStore();
  const jobs = new LocalDurableJobQueue();
  const payments = new InMemoryVerifiedPaymentEvidenceStore();
  const adapter = new P1BackedOpsAdapter(store, payments);
  const identity = new VerifiedSessionIdentity((caseId) => caseId ? adapter.state(caseId) : null);
  const service = new InternalOpsService({ ports: { identity, projections: adapter, commands: adapter }, flags: FLAGS, now: () => P8_NOW });
  const http = createInternalOpsHttpAdapter({ service, flags: FLAGS });
  const audit = new InMemoryHashChainAudit();
  const root = await mkdtemp(join(tmpdir(), "tivdoc-"));
  const allowedReads = new Set<string>();
  const storage = new LocalPrivateObjectStorage({ root, environment: "generated_local_test_root", audit, nowMs: () => P8_NOW_MS, authorizeRead: (actor, versionId, scopeRef) => allowedReads.has(`${actor.actor_id}:${versionId}:${scopeRef}`) });
  const portalRepository = new SyntheticPortalRepository({ now: () => P8_NOW }, "test");
  const portal = new CustomerPortalService(portalRepository, { isEnabled: () => true }, () => P8_NOW);
  return Object.freeze({ store, jobs, payments, adapter, identity, service, http, audit, storage, allowedReads, portalRepository, portal });
}

export function addSession(harness: P8Harness, token: string, actor: VerifiedActor): void { harness.identity.add(token, actor); }

export function opsRequest(token: string, body?: unknown, input: Readonly<{ method?: "GET" | "POST"; correlation?: string; csrf?: string; origin?: string }> = {}): Request {
  const method = input.method ?? (body === undefined ? "GET" : "POST");
  const headers = new Headers({ authorization: `Bearer ${token}`, "x-correlation-id": input.correlation ?? "p8correlation0001" });
  if (method === "POST") {
    const csrf = input.csrf ?? P8_CSRF;
    headers.set("content-type", "application/json");
    headers.set("origin", input.origin ?? P8_ORIGIN);
    headers.set("cookie", `tivdoc_csrf=${csrf}`);
    headers.set("x-csrf-token", csrf);
  }
  return new Request("https://p8.test.invalid/api/internal", { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

export function opsEnvelope(action: string, caseId: string, expectedRevision: number, payload: Readonly<Record<string, unknown>>, suffix: string) {
  return Object.freeze({ schema_version: INTERNAL_OPS_SCHEMA_VERSION, command_id: `command_${suffix.padEnd(12, "0")}`, idempotency_key: `idempotency_${suffix.padEnd(16, "0")}`, expected_revision: expectedRevision, reason: "P8_SYNTHETIC_INTEGRATION", payload: Object.freeze({ action, case_id: caseId, ...payload }) });
}

export async function storePdf(harness: P8Harness, actor: VerifiedActor, bytes: Uint8Array, suffix: string) {
  const artifactSha = sha(bytes);
  const reservation = await harness.storage.reserve({ command_id: `storage_${suffix.padEnd(12, "0")}`, idempotency_key: `storageidem_${suffix.padEnd(12, "0")}`, expected_revision: 0, actor, reason: "STORAGE_WRITE", payload: { expected_sha256: artifactSha, expected_length: bytes.byteLength, detected_mime: "application/pdf", retention_class: "report_record" } });
  await harness.storage.stage(reservation, (async function* () { yield bytes; })());
  return Object.freeze({ ...(await harness.storage.finalize(reservation)), artifact_sha256: artifactSha });
}
