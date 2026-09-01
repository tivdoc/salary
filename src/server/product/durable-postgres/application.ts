import { createHash } from "node:crypto";

import { canonicalSha256 } from "../../../engine/rule-runtime/canonical.ts";
import {
  WAVE3_TOPICS,
  type CaseAnalysisCommand,
  type DeterministicReportArtifacts,
} from "../../../engine/wave3/contracts.ts";
import type { VerifiedActor } from "../../../engine/wave4/contracts.ts";
import {
  CANONICAL_POSTGRES_SCHEMA_VERSION,
  requireIsolatedCanonicalPostgres,
} from "../../platform/composition/canonical-postgres.ts";
import type { CanonicalApplicationPostgresComposition } from "../../platform/composition/canonical-postgres-application.ts";
import { PlatformPersistenceError } from "../../platform/persistence/contracts.ts";
import { statement } from "../../platform/persistence/postgres/contracts.ts";
import { decodeReport } from "../../platform/persistence/postgres/analysis/validation.ts";
import {
  DURABLE_PRODUCT_CAPABILITIES,
  DURABLE_PRODUCT_SCHEMA_VERSION,
  type DurableApprovalInput,
  type DurableApprovalReceipt,
  type DurableCaseScope,
  type DurableDownloadReceipt,
  type DurablePipelineReference,
  type DurableProductSnapshot,
  type DurableReportReference,
  type DurableWorkerReceipt,
} from "./contracts.ts";

const SHA256 = /^[a-f0-9]{64}$/u;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9:._-]{2,159}$/u;

export class DurableProductPostgresApplication {
  readonly #application: Extract<CanonicalApplicationPostgresComposition, { mode: "isolated_postgres" }>;

  constructor(composition: CanonicalApplicationPostgresComposition) {
    const isolated = requireIsolatedCanonicalPostgres(composition);
    if (!isolated.durable || isolated.schema_version !== CANONICAL_POSTGRES_SCHEMA_VERSION) {
      throw new Error("DURABLE_PRODUCT_POSTGRES_REQUIRED");
    }
    this.#application = isolated;
  }

  proof(): Readonly<{
    schema_version: typeof DURABLE_PRODUCT_SCHEMA_VERSION;
    persistence_mode: "isolated_postgres";
    persistence_schema: typeof CANONICAL_POSTGRES_SCHEMA_VERSION;
    durable: true;
    product_reachable_memory_fallbacks: 0;
    capabilities: typeof DURABLE_PRODUCT_CAPABILITIES;
  }> {
    return Object.freeze({
      schema_version: DURABLE_PRODUCT_SCHEMA_VERSION,
      persistence_mode: "isolated_postgres",
      persistence_schema: CANONICAL_POSTGRES_SCHEMA_VERSION,
      durable: true,
      product_reachable_memory_fallbacks: 0,
      capabilities: DURABLE_PRODUCT_CAPABILITIES,
    });
  }

  async createCase(input: DurableCaseScope & Readonly<{
    actor: VerifiedActor;
    occurred_at: string;
    initial_state?: "awaiting_documents";
  }>): Promise<Readonly<{ case_id: string; revision: 1; state_sha256: string; audit_event_sha256: string }>> {
    assertScope(input);
    assertOperationsActor(input.actor, input, ["intake_operator", "scoped_background_worker"]);
    assertInstant(input.occurred_at);
    const state = input.initial_state ?? "awaiting_documents";
    const command = Object.freeze({ action: "durable_case_create", tenant_id: input.tenant_id, case_id: input.case_id, state });
    const commandSha256 = canonicalSha256(command);
    const eventSha256 = canonicalSha256({ command_sha256: commandSha256, event_kind: "product.case.created" });
    const stateSha256 = canonicalSha256({ tenant_id: input.tenant_id, case_id: input.case_id, revision: 1, state });
    return this.#application.transaction(input.tenant_id, input.case_id, async (bundle) => {
      const created = await bundle.intake.case_lifecycle.append(bundle.context, {
        tenant_id: input.tenant_id,
        case_id: input.case_id,
        expected_revision: 0,
        state_before: null,
        state_after: state,
        event_kind: "product.case.created",
        command_sha256: commandSha256,
        event_sha256: eventSha256,
        previous_sha256: null,
        state_sha256: stateSha256,
        occurred_at: input.occurred_at,
      });
      const audit = await bundle.runtime.jobs_outbox_audit.append({
        actor_id: input.actor.actor_id,
        action: "DURABLE_PRODUCT_CASE_CREATED",
        resource_id: input.case_id,
        resource_revision: created.revision,
        resource_sha256: created.state_sha256,
        reason: "SYNTHETIC_PRODUCT_INTEGRATION",
        occurred_at: input.occurred_at,
      });
      if (created.revision !== 1) throw new Error("DURABLE_PRODUCT_CASE_REVISION_INVALID");
      return Object.freeze({ case_id: input.case_id, revision: 1 as const, state_sha256: created.state_sha256, audit_event_sha256: audit.event_sha256 });
    });
  }

  async prepareReportPipeline(input: DurableCaseScope & Readonly<{
    actor: VerifiedActor;
    report: DeterministicReportArtifacts;
    pipeline: DurablePipelineReference;
    idempotency_key: string;
    available_at_ms: number;
    occurred_at: string;
  }>): Promise<Readonly<{ report: DurableReportReference; pipeline: DurablePipelineReference }>> {
    assertScope(input);
    assertOperationsActor(input.actor, input, ["scoped_background_worker"]);
    assertPipeline(input.pipeline);
    assertOpaque(input.idempotency_key, "DURABLE_PRODUCT_IDEMPOTENCY_INVALID");
    assertInstant(input.occurred_at);
    if (!Number.isSafeInteger(input.available_at_ms) || input.available_at_ms < 1) throw new Error("DURABLE_PRODUCT_CLOCK_INVALID");
    const payload = Object.freeze({
      schema_version: DURABLE_PRODUCT_SCHEMA_VERSION,
      tenant_id: input.tenant_id,
      case_id: input.case_id,
      analysis_run_id: input.pipeline.analysis_run_id,
      report_id: input.report.report_id,
      report_sha256: input.report.report_sha256,
    });
    const payloadSha256 = canonicalSha256(payload);
    await this.#application.transaction(input.tenant_id, input.case_id, async (bundle) => {
      const state = await bundle.intake.case_lifecycle.get(bundle.context, { tenant_id: input.tenant_id, case_id: input.case_id });
      if (!state || state.revision !== input.report.report_revision) throw new PlatformPersistenceError("CASE_REVISION_CONFLICT");
      const command = analysisCommand(input.case_id, input.pipeline.analysis_run_id, input.idempotency_key, state.revision);
      await bundle.analysis.caseAnalysis.begin({
        analysis_run_id: input.pipeline.analysis_run_id,
        idempotency_key: input.idempotency_key,
        command_sha256: canonicalSha256(command),
        command,
      });
      await bundle.analysis.reports.persistReport({
        case_id: input.case_id,
        analysis_run_id: input.pipeline.analysis_run_id,
        report: input.report,
        review_eligible: true,
      });
      await bundle.runtime.jobs_outbox_audit.enqueue({
        job_id: input.pipeline.job_id,
        tenant_id: input.tenant_id,
        case_id: input.case_id,
        job_kind: "durable_product_report_pipeline",
        idempotency_key: `job:${input.idempotency_key}`,
        payload_sha256: payloadSha256,
        payload,
        pinned_version_sha256s: Object.freeze([]),
        max_attempts: 3,
        available_at_ms: input.available_at_ms,
      });
      await bundle.runtime.jobs_outbox_audit.enqueueOutbox({
        outbox_id: input.pipeline.outbox_id,
        tenant_id: input.tenant_id,
        case_id: input.case_id,
        logical_effect_id: input.pipeline.logical_effect_id,
        effect_kind: "durable_product_report_available",
        payload_sha256: payloadSha256,
        payload,
        created_at: input.occurred_at,
      });
      await bundle.runtime.jobs_outbox_audit.append({
        actor_id: input.actor.actor_id,
        action: "DURABLE_REPORT_PIPELINE_ENQUEUED",
        resource_id: input.report.report_id,
        resource_revision: input.report.report_revision,
        resource_sha256: input.report.report_sha256,
        reason: "SYNTHETIC_PRODUCT_INTEGRATION",
        occurred_at: input.occurred_at,
      });
    });
    return Object.freeze({
      report: reportReference(input.report),
      pipeline: input.pipeline,
    });
  }

  async approveExactReport(input: DurableApprovalInput): Promise<DurableApprovalReceipt> {
    assertScope(input);
    assertReportReference(input.report);
    assertInstant(input.decided_at);
    assertOpaque(input.task_id, "DURABLE_PRODUCT_TASK_ID_INVALID");
    assertOpaque(input.idempotency_key, "DURABLE_PRODUCT_IDEMPOTENCY_INVALID");
    if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 1) throw new Error("DURABLE_PRODUCT_REPORT_REVISION_CONFLICT");
    if (input.reason.trim().length < 8 || input.reason.length > 500) throw new Error("DURABLE_PRODUCT_REASON_INVALID");
    const identity = input.identity;
    assertOperationsActor(identity.actor, input, ["report_approver"]);
    if (identity.product_audience !== "operations" || !identity.reviewer_organization_id) {
      throw new Error("DURABLE_PRODUCT_REVIEWER_ORGANIZATION_REQUIRED");
    }
    const reviewerOrganizationSha256 = canonicalSha256({ reviewer_organization_id: identity.reviewer_organization_id });
    const approvalCommand = Object.freeze({
      action: "durable_product_exact_report_approval",
      tenant_id: input.tenant_id,
      case_id: input.case_id,
      report_id: input.report.report_id,
      report_revision: input.report.report_revision,
      report_sha256: input.report.report_sha256,
      reviewer_actor_id: identity.actor.actor_id,
      reviewer_organization_sha256: reviewerOrganizationSha256,
      task_id: input.task_id,
      reason: input.reason,
    });
    const commandSha256 = canonicalSha256(approvalCommand);
    const receipt = await this.#application.transaction(input.tenant_id, input.case_id, async (bundle) => {
      const state = await bundle.intake.case_lifecycle.get(bundle.context, { tenant_id: input.tenant_id, case_id: input.case_id });
      if (!state || state.revision !== input.expected_revision || state.revision !== input.report.report_revision) {
        throw new PlatformPersistenceError("CASE_REVISION_CONFLICT");
      }
      return bundle.runtime.idempotency.execute(bundle.context, {
        tenant_id: input.tenant_id,
        case_id: input.case_id,
        actor_id: identity.actor.actor_id,
        scope: "durable_product_report_approval",
        idempotency_key: input.idempotency_key,
        expected_case_revision: input.expected_revision,
        command_sha256: commandSha256,
        command: approvalCommand,
        occurred_at: input.decided_at,
        writes: Object.freeze([]),
        invalidates: Object.freeze([]),
        outbox: Object.freeze([]),
      }, async () => {
        await bundle.analysis.reports.decide({
          task_id: input.task_id,
          task_kind: "report_approval",
          reviewer_id: identity.actor.actor_id,
          reviewer_role: "report_approver",
          decision: "approved",
          input_sha256: input.report.report_sha256,
          output_sha256: input.report.report_sha256,
          decided_at: input.decided_at,
          reason: input.reason,
          schema_version: DURABLE_PRODUCT_SCHEMA_VERSION,
        });
        const audit = await bundle.runtime.jobs_outbox_audit.append({
          actor_id: identity.actor.actor_id,
          action: "DURABLE_EXACT_REPORT_APPROVED",
          resource_id: input.report.report_id,
          resource_revision: input.report.report_revision,
          resource_sha256: input.report.report_sha256,
          reason: "EXACT_REPORT_HASH_APPROVAL",
          occurred_at: input.decided_at,
        });
        return Object.freeze({
          tenant_id: input.tenant_id,
          case_id: input.case_id,
          case_revision: state.revision,
          command_sha256: commandSha256,
          audit_event_sha256: audit.event_sha256,
          outbox_ids: Object.freeze([]),
          idempotent_replay: false,
        });
      });
    });
    const eligible = await this.#application.transaction(input.tenant_id, input.case_id, (bundle) =>
      bundle.analysis.reports.isReportExportEligible(input.case_id, input.report.report_sha256));
    if (!eligible) throw new Error("DURABLE_PRODUCT_REPORT_NOT_EXPORT_ELIGIBLE");
    return Object.freeze({
      schema_version: DURABLE_PRODUCT_SCHEMA_VERSION,
      case_id: input.case_id,
      case_revision: receipt.case_revision,
      report_sha256: input.report.report_sha256,
      command_sha256: receipt.command_sha256,
      audit_event_sha256: receipt.audit_event_sha256,
      idempotent_replay: receipt.idempotent_replay,
      export_eligible: true,
    });
  }

  async claimAndStart(input: DurableCaseScope & Readonly<{
    actor: VerifiedActor;
    worker_id: string;
    job_id: string;
    now_ms: number;
    lease_ms: number;
  }>): Promise<DurableWorkerReceipt> {
    assertScope(input);
    assertOperationsActor(input.actor, input, ["scoped_background_worker"]);
    assertWorkerInput(input);
    return this.#application.transaction(input.tenant_id, input.case_id, async (bundle) => {
      const jobs = await bundle.runtime.jobs_outbox_audit.claim(input.worker_id, input.now_ms, input.lease_ms, 8);
      const claimed = jobs.find((job) => job.job_id === input.job_id && job.case_id === input.case_id);
      if (!claimed) throw new Error("DURABLE_PRODUCT_JOB_NOT_CLAIMED");
      const running = await bundle.runtime.jobs_outbox_audit.start(
        input.job_id,
        input.worker_id,
        claimed.fencing_token,
        input.now_ms + 1,
      );
      return Object.freeze({
        schema_version: DURABLE_PRODUCT_SCHEMA_VERSION,
        case_id: input.case_id,
        job_id: input.job_id,
        job_revision: running.revision,
        job_state: "running" as const,
        fencing_token: running.fencing_token,
        logical_effect_sha256: null,
        outbox_published: false,
        audit_event_sha256: null,
      });
    });
  }

  async recoverAndComplete(input: DurableCaseScope & Readonly<{
    actor: VerifiedActor;
    worker_id: string;
    job_id: string;
    now_ms: number;
    lease_ms: number;
    logical_effect_sha256: string;
    outbox_id: string;
  }>): Promise<DurableWorkerReceipt> {
    assertScope(input);
    assertOperationsActor(input.actor, input, ["scoped_background_worker"]);
    assertWorkerInput(input);
    assertHash(input.logical_effect_sha256, "DURABLE_PRODUCT_EFFECT_HASH_INVALID");
    assertOpaque(input.outbox_id, "DURABLE_PRODUCT_OUTBOX_ID_INVALID");
    return this.#application.transaction(input.tenant_id, input.case_id, async (bundle) => {
      const jobs = await bundle.runtime.jobs_outbox_audit.claim(input.worker_id, input.now_ms, input.lease_ms, 8);
      const claimed = jobs.find((job) => job.job_id === input.job_id && job.case_id === input.case_id);
      if (!claimed) throw new Error("DURABLE_PRODUCT_JOB_NOT_RECOVERED");
      const running = await bundle.runtime.jobs_outbox_audit.start(
        input.job_id,
        input.worker_id,
        claimed.fencing_token,
        input.now_ms + 1,
      );
      const outbox = await bundle.runtime.jobs_outbox_audit.claimOutbox(input.worker_id, input.now_ms + 2, input.lease_ms);
      if (!outbox || outbox.outbox_id !== input.outbox_id) throw new Error("DURABLE_PRODUCT_OUTBOX_NOT_CLAIMED");
      const published = await bundle.runtime.jobs_outbox_audit.publishOutbox({
        outbox_id: input.outbox_id,
        worker_id: input.worker_id,
        fencing_token: outbox.fencing_token,
        now_ms: input.now_ms + 3,
        logical_effect_sha256: input.logical_effect_sha256,
      });
      if (published.deduplicated) throw new Error("DURABLE_PRODUCT_UNEXPECTED_EFFECT_REPLAY");
      const succeeded = await bundle.runtime.jobs_outbox_audit.succeed(
        input.job_id,
        input.worker_id,
        running.fencing_token,
        input.now_ms + 4,
        input.logical_effect_sha256,
      );
      const audit = await bundle.runtime.jobs_outbox_audit.append({
        actor_id: input.actor.actor_id,
        action: "DURABLE_REPORT_PIPELINE_RECOVERED",
        resource_id: input.job_id,
        resource_revision: succeeded.revision,
        resource_sha256: input.logical_effect_sha256,
        reason: "WORKER_RESTART_RECOVERY",
        occurred_at: new Date(input.now_ms + 5).toISOString(),
      });
      return Object.freeze({
        schema_version: DURABLE_PRODUCT_SCHEMA_VERSION,
        case_id: input.case_id,
        job_id: input.job_id,
        job_revision: succeeded.revision,
        job_state: "succeeded" as const,
        fencing_token: succeeded.fencing_token,
        logical_effect_sha256: succeeded.terminal_effect_sha256,
        outbox_published: true,
        audit_event_sha256: audit.event_sha256,
      });
    });
  }

  async assertNoPendingReplay(input: DurableCaseScope & Readonly<{
    actor: VerifiedActor;
    worker_id: string;
    now_ms: number;
    lease_ms: number;
  }>): Promise<Readonly<{ claimed_jobs: 0; claimed_outbox: false }>> {
    assertScope(input);
    assertOperationsActor(input.actor, input, ["scoped_background_worker"]);
    assertWorkerInput({ ...input, job_id: "replay-probe" });
    return this.#application.transaction(input.tenant_id, input.case_id, async (bundle) => {
      const jobs = await bundle.runtime.jobs_outbox_audit.claim(input.worker_id, input.now_ms, input.lease_ms, 8);
      const outbox = await bundle.runtime.jobs_outbox_audit.claimOutbox(input.worker_id, input.now_ms + 1, input.lease_ms);
      if (jobs.length !== 0 || outbox !== null) throw new Error("DURABLE_PRODUCT_DUPLICATE_REPLAY_REACHABLE");
      return Object.freeze({ claimed_jobs: 0 as const, claimed_outbox: false as const });
    });
  }

  async downloadApprovedPdf(input: DurableCaseScope & Readonly<{
    actor: VerifiedActor;
    report: DurableReportReference;
  }>): Promise<DurableDownloadReceipt> {
    assertScope(input);
    assertReportReference(input.report);
    assertPortalActor(input.actor, input);
    const report = await this.#application.transaction(input.tenant_id, input.case_id, async (bundle) => {
      const result = await bundle.context.client.query(statement(
        "product_approved_report_exact",
        `select r.artifacts_payload
           from public.engine_report_versions r
           join public.engine_case_state c on c.case_id = r.case_id and c.tenant_id = r.tenant_id
          where r.tenant_id = $1 and c.canonical_case_id = $2
            and r.report_id = $3 and r.revision = $4
            and r.report_sha256 = $5 and r.pdf_sha256 = $6
            and (select rv.release_state
                   from public.engine_review_task_versions rv
                  where rv.tenant_id = r.tenant_id and rv.case_id = r.case_id
                    and rv.report_sha256 = r.report_sha256
                  order by rv.revision desc limit 1) = 'approved'
          limit 1`,
        [
          input.tenant_id,
          input.case_id,
          input.report.report_id,
          input.report.report_revision,
          input.report.report_sha256,
          input.report.pdf_sha256,
        ],
      ));
      if (result.row_count !== 1 || !result.rows[0]) throw new Error("DURABLE_PRODUCT_REPORT_NOT_FOUND");
      return decodeReport(result.rows[0].artifacts_payload);
    });
    if (report.report_sha256 !== input.report.report_sha256 || byteSha256(report.pdf) !== input.report.pdf_sha256) {
      throw new Error("DURABLE_PRODUCT_EXACT_BYTES_MISMATCH");
    }
    return Object.freeze({
      schema_version: DURABLE_PRODUCT_SCHEMA_VERSION,
      report: input.report,
      bytes: Uint8Array.from(report.pdf),
      content_type: "application/pdf",
    });
  }

  async revision(input: DurableCaseScope & Readonly<{ actor: VerifiedActor; audience: "portal" | "operations" }>): Promise<number> {
    assertScope(input);
    if (input.audience === "portal") assertPortalActor(input.actor, input);
    else assertOperationsActor(input.actor, input, ["intake_operator", "report_approver", "scoped_background_worker", "auditor"]);
    return this.#application.transaction(input.tenant_id, input.case_id, async (bundle) => {
      const state = await bundle.intake.case_lifecycle.get(bundle.context, { tenant_id: input.tenant_id, case_id: input.case_id });
      if (!state) throw new Error("DURABLE_PRODUCT_CASE_NOT_FOUND");
      return state.revision;
    });
  }

  async snapshot(scope: DurableCaseScope): Promise<DurableProductSnapshot> {
    assertScope(scope);
    return this.#application.transaction(scope.tenant_id, scope.case_id, async (bundle) => {
      const result = await bundle.context.client.query(statement(
        "product_durable_snapshot",
        `select c.revision::text as case_revision, c.lifecycle_state,
                (select count(*)::text from public.engine_report_versions r where r.tenant_id = $1 and r.case_id = c.case_id) as report_versions,
                (select count(*)::text from public.engine_review_task_versions v where v.tenant_id = $1 and v.case_id = c.case_id) as approval_versions,
                (select count(*)::text from public.engine_durable_jobs j where j.tenant_id = $1 and j.canonical_case_id = $2) as durable_jobs,
                (select count(*)::text from public.engine_outbox_events o where o.tenant_id = $1 and o.canonical_case_id = $2) as outbox_events,
                (select count(*)::text from public.engine_logical_effect_receipts e join public.engine_outbox_events o on o.tenant_id = e.tenant_id and o.outbox_id = e.outbox_id where e.tenant_id = $1 and o.canonical_case_id = $2) as logical_effects,
                (select count(*)::text from public.engine_platform_audit_events a where a.tenant_id = $1 and a.canonical_case_id = $2) as audit_events
           from public.engine_case_state c
          where c.tenant_id = $1 and c.canonical_case_id = $2`,
        [scope.tenant_id, scope.case_id],
      ));
      const row = result.rows[0];
      if (result.row_count !== 1 || !row) throw new Error("DURABLE_PRODUCT_CASE_NOT_FOUND");
      const audit = await bundle.runtime.jobs_outbox_audit.verify();
      return Object.freeze({
        schema_version: DURABLE_PRODUCT_SCHEMA_VERSION,
        case_revision: safeCount(row.case_revision),
        lifecycle_state: safeString(row.lifecycle_state),
        report_versions: safeCount(row.report_versions),
        approval_versions: safeCount(row.approval_versions),
        durable_jobs: safeCount(row.durable_jobs),
        outbox_events: safeCount(row.outbox_events),
        logical_effects: safeCount(row.logical_effects),
        audit_events: safeCount(row.audit_events),
        audit_chain_valid: audit.valid,
        audit_tail_sha256: audit.tail_sha256,
      });
    });
  }
}

export function createSyntheticDurableReport(input: Readonly<{
  report_id: string;
  report_revision: number;
  marker: string;
}>): DeterministicReportArtifacts {
  assertOpaque(input.report_id, "DURABLE_PRODUCT_REPORT_ID_INVALID");
  if (!Number.isSafeInteger(input.report_revision) || input.report_revision < 1) throw new Error("DURABLE_PRODUCT_REPORT_REVISION_INVALID");
  assertOpaque(input.marker, "DURABLE_PRODUCT_MARKER_INVALID");
  const analysisResultSha256 = canonicalSha256({ marker: input.marker, result: "synthetic_blocked_no_legal_rules" });
  const json = bytes(JSON.stringify({ schema_version: DURABLE_PRODUCT_SCHEMA_VERSION, marker: input.marker, legal_result: "BLOCKED_NOT_READY" }));
  const html = bytes(`<html dir="rtl" lang="he"><body><h1>דוח סינתטי</h1><p>הערכת הדין חסומה ולא הופעלו כללים.</p></body></html>`);
  const pdf = bytes(`%PDF-1.4\n% synthetic:${input.marker}\n1 0 obj<</Type/Catalog>>endobj\n%%EOF`);
  const manifest = bytes(JSON.stringify({ marker: input.marker, topics: WAVE3_TOPICS, legal_rules_activated: 0 }));
  const hashes = Object.freeze({
    json_sha256: byteSha256(json),
    html_sha256: byteSha256(html),
    pdf_sha256: byteSha256(pdf),
    manifest_sha256: byteSha256(manifest),
  });
  return Object.freeze({
    report_id: input.report_id,
    report_revision: input.report_revision,
    analysis_result_sha256: analysisResultSha256,
    json,
    html,
    pdf,
    manifest,
    ...hashes,
    report_sha256: canonicalSha256({
      report_id: input.report_id,
      report_revision: input.report_revision,
      analysis_result_sha256: analysisResultSha256,
      ...hashes,
    }),
  });
}

function analysisCommand(caseId: string, runId: string, idempotencyKey: string, revision: number): CaseAnalysisCommand {
  return Object.freeze({
    case_id: caseId,
    case_revision: revision,
    document_snapshot_id: `document-snapshot:${runId}`,
    document_snapshot_sha256: canonicalSha256({ runId, snapshot: "document" }),
    extraction_snapshot_id: `extraction-snapshot:${runId}`,
    extraction_snapshot_sha256: canonicalSha256({ runId, snapshot: "extraction" }),
    declared_fact_snapshot_id: `declared-snapshot:${runId}`,
    declared_fact_snapshot_sha256: canonicalSha256({ runId, snapshot: "declared" }),
    period: Object.freeze({ start_date: "2026-01-01", end_date: "2026-01-31" }),
    as_of: "2026-02-01",
    requested_topics: WAVE3_TOPICS,
    sector: "synthetic_sector",
    population: "synthetic_population",
    mode: "synthetic_test",
    idempotency_key: idempotencyKey,
  });
}

function reportReference(report: DeterministicReportArtifacts): DurableReportReference {
  return Object.freeze({
    report_id: report.report_id,
    report_revision: report.report_revision,
    report_sha256: report.report_sha256,
    pdf_sha256: report.pdf_sha256,
  });
}

function assertScope(scope: DurableCaseScope): void {
  assertOpaque(scope.tenant_id, "DURABLE_PRODUCT_TENANT_INVALID");
  assertOpaque(scope.case_id, "DURABLE_PRODUCT_CASE_INVALID");
}

function assertOperationsActor(actor: VerifiedActor, scope: DurableCaseScope, roles: readonly VerifiedActor["role"][]): void {
  if (actor.verified_server_side !== true || !roles.includes(actor.role) || actor.tenant_id !== scope.tenant_id || !actor.assigned_case_ids.includes(scope.case_id)) {
    throw new Error("DURABLE_PRODUCT_FORBIDDEN");
  }
}

function assertPortalActor(actor: VerifiedActor, scope: DurableCaseScope): void {
  if (actor.verified_server_side !== true || actor.role !== "customer_owner" || actor.tenant_id !== scope.tenant_id || !actor.assigned_case_ids.includes(scope.case_id)) {
    throw new Error("DURABLE_PRODUCT_NOT_FOUND");
  }
}

function assertPipeline(pipeline: DurablePipelineReference): void {
  for (const value of [pipeline.analysis_run_id, pipeline.job_id, pipeline.outbox_id, pipeline.logical_effect_id]) {
    assertOpaque(value, "DURABLE_PRODUCT_PIPELINE_REFERENCE_INVALID");
  }
  assertHash(pipeline.logical_effect_sha256, "DURABLE_PRODUCT_EFFECT_HASH_INVALID");
}

function assertReportReference(report: DurableReportReference): void {
  assertOpaque(report.report_id, "DURABLE_PRODUCT_REPORT_ID_INVALID");
  if (!Number.isSafeInteger(report.report_revision) || report.report_revision < 1) throw new Error("DURABLE_PRODUCT_REPORT_REVISION_INVALID");
  assertHash(report.report_sha256, "DURABLE_PRODUCT_REPORT_HASH_INVALID");
  assertHash(report.pdf_sha256, "DURABLE_PRODUCT_REPORT_HASH_INVALID");
}

function assertWorkerInput(input: Readonly<{ worker_id: string; job_id: string; now_ms: number; lease_ms: number }>): void {
  assertOpaque(input.worker_id, "DURABLE_PRODUCT_WORKER_ID_INVALID");
  assertOpaque(input.job_id, "DURABLE_PRODUCT_JOB_ID_INVALID");
  if (!Number.isSafeInteger(input.now_ms) || !Number.isSafeInteger(input.lease_ms) || input.now_ms < 1 || input.lease_ms < 10) {
    throw new Error("DURABLE_PRODUCT_WORKER_CLOCK_INVALID");
  }
}

function assertOpaque(value: string, code: string): void {
  if (typeof value !== "string" || !OPAQUE.test(value)) throw new Error(code);
}

function assertHash(value: string, code: string): void {
  if (!SHA256.test(value)) throw new Error(code);
}

function assertInstant(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error("DURABLE_PRODUCT_TIMESTAMP_INVALID");
  }
}

function bytes(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "utf8"));
}

function byteSha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeCount(value: unknown): number {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) throw new Error("DURABLE_PRODUCT_SNAPSHOT_INVALID");
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error("DURABLE_PRODUCT_SNAPSHOT_INVALID");
  return result;
}

function safeString(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 160) throw new Error("DURABLE_PRODUCT_SNAPSHOT_INVALID");
  return value;
}

export const __durableProductTest = Object.freeze({ reportReference, byteSha256 });
