import { describe, expect, it } from "vitest";

import { canonicalSha256 } from "../../../engine/rule-runtime/canonical.ts";
import { WAVE3_TOPICS } from "../../../engine/wave3/contracts.ts";
import type { VerifiedActor, V07Role } from "../../../engine/wave4/contracts.ts";
import type { TransactionScopedPostgresBundle } from "../../platform/composition/canonical-postgres.ts";
import type { PostgresAnalysisRepositories } from "../../platform/persistence/postgres/analysis/index.ts";
import type { PostgresIntakeAdapterBundle } from "../../platform/persistence/postgres/intake/index.ts";
import type { PostgresStatement } from "../../platform/persistence/postgres/contracts.ts";
import type { DurableProductRouteContext } from "../routes/durable-registration.ts";
import {
  DURABLE_LOCAL_PRODUCT_RUNTIME_SENTINEL,
  type DurableLocalProductRuntimeConfig,
} from "../runtime/durable-local-config.ts";
import {
  DURABLE_RUNTIME_JOB_KIND,
  createDurableRuntimeReportJobEnvelope,
} from "../durable-postgres/runtime-product-lane.ts";
import {
  CANONICAL_REPORT_IDENTITY_SCHEMA_VERSION,
  canonicalReportStorageObjectId,
  canonicalReportStorageObjectVersionId,
  createCanonicalReportIdentity,
} from "../durable-postgres/report-identity.ts";
import { INTERNAL_OPS_SCHEMA_VERSION } from "./contracts.ts";
import {
  createDurableInternalOpsLocalRuntimeClass,
  createDurableInternalOpsPostgresAdapter,
  DURABLE_INTERNAL_OPS_POSTGRES_SCHEMA_VERSION,
  type DurableInternalOpsLocalRuntimeClass,
  type DurableInternalOpsSyntheticReportPipelinePort,
} from "./durable-postgres-application.ts";
import { disabledInternalOpsFlags, type InternalOpsFlagSnapshot } from "./flags.ts";

const CASE_ID = "durable-case-001";
const TENANT_ID = "durable-tenant-001";
const NOW = "2030-02-01T10:00:00.000Z";
const SHA = Object.freeze({
  a: "a".repeat(64), b: "b".repeat(64), c: "c".repeat(64), d: "d".repeat(64),
  e: "e".repeat(64), f: "f".repeat(64),
});

type DurableBundle = TransactionScopedPostgresBundle<PostgresIntakeAdapterBundle, PostgresAnalysisRepositories>;

describe("durable InternalOps PostgreSQL application", () => {
  it("exposes a same-root least-privilege adapter and never opens the broad transaction root", async () => {
    const fixture = harness();
    const adapter = createDurableInternalOpsPostgresAdapter({
      context: fixture.context,
      flags: flags(),
      runtime_class: localRuntime(),
      synthetic_report_pipeline: fixture.syntheticReportPipeline,
      now: () => NOW,
    });

    expect(adapter).toMatchObject({
      postgres: fixture.context.postgres,
      product: fixture.context.product,
      session_context: fixture.context.session_context,
      proof_class: "POSTGRESQL_TRANSACTIONAL_ROUTE_SERVICE",
    });
    expect(adapter.service.proof()).toEqual({
      schema_version: DURABLE_INTERNAL_OPS_POSTGRES_SCHEMA_VERSION,
      persistence: "postgresql_required",
      session_context: "least_privilege_verified_operations",
      canonical_transaction_contexts: 1,
      product_reachable_memory_fallbacks: 0,
      service_role_allowed: false,
      bypass_rls_allowed: false,
      real_legal_mode: "blocked_not_ready",
    });

    await adapter.service.read(actor("legal_reviewer"), "case", CASE_ID);
    expect(fixture.broadTransactions()).toBe(0);
    expect(fixture.transactions).toHaveLength(1);
    expect(fixture.transactions[0]).toMatchObject({ audience: "operations", case_id: CASE_ID });
  });

  it("serves the complete stable operations UI read journey from verified transactions", async () => {
    const fixture = harness();
    const service = createDurableInternalOpsPostgresAdapter({
      context: fixture.context,
      flags: flags(),
      runtime_class: localRuntime(),
      synthetic_report_pipeline: fixture.syntheticReportPipeline,
      now: () => NOW,
    }).service;
    const reviewer = actor("legal_reviewer");

    const [capabilities, queue, overview, timeline, payment, documents, extraction, facts,
      readiness, analysis, report, audit] = await Promise.all([
      service.read(reviewer, "capabilities", null),
      service.read(reviewer, "queue", null),
      service.read(reviewer, "case", CASE_ID),
      service.read(reviewer, "timeline", CASE_ID),
      service.read(actor("report_approver"), "payment", CASE_ID),
      service.read(reviewer, "documents", CASE_ID),
      service.read(reviewer, "extraction", CASE_ID),
      service.read(reviewer, "facts", CASE_ID),
      service.read(reviewer, "readiness", CASE_ID),
      service.read(reviewer, "analysis", CASE_ID),
      service.read(reviewer, "report", CASE_ID),
      service.read(actor("auditor"), "audit", CASE_ID),
    ]);

    expect(capabilities).toMatchObject({ synthetic_enabled: true, customer_processing_enabled: false,
      customer_shadow_enabled: false, production_delivery_enabled: false });
    expect(queue).toMatchObject({ items: [{ case_id: CASE_ID, revision: 4 }] });
    expect(overview).toMatchObject({ case_id: CASE_ID, revision: 4, mode: "synthetic_test" });
    expect(timeline).toMatchObject({ events: [{ sequence: 1, event_sha256: SHA.a }] });
    expect(payment).toMatchObject({ status: "unmatched", evidence_revision: null });
    expect(documents).toMatchObject({ documents: [{ object_version_id: "document-001", byte_length: 2048 }] });
    expect(extraction).toMatchObject({ fields: [{ field_id: "extraction-001", status: "candidate" }] });
    expect(facts).toMatchObject({ snapshot_sha256: SHA.c, facts: [{ fact_id: "fact-001" }] });
    expect(readiness).toMatchObject({ all_topics_ready: true });
    expect("topics" in readiness && readiness.topics).toHaveLength(7);
    expect(analysis).toMatchObject({ runs: [{ status: "complete", result_sha256: SHA.d, coverage_complete: true }] });
    expect(report).toMatchObject({ report_id: "report-001", report_sha256: SHA.e, status: "awaiting_approval" });
    expect(audit).toMatchObject({ chain_valid: true, event_count: 1, events: [{ event_sha256: SHA.a }] });
    expect(fixture.transactions).toHaveLength(12);
    expect(fixture.transactions.every((transaction) => transaction.audience === "operations")).toBe(true);
    expect(fixture.broadTransactions()).toBe(0);
  });

  it("commits fact resolution once with exact revision and durable idempotent replay", async () => {
    const fixture = harness();
    const service = createDurableInternalOpsPostgresAdapter({
      context: fixture.context, flags: flags(), runtime_class: localRuntime(),
      synthetic_report_pipeline: fixture.syntheticReportPipeline, now: () => NOW,
    }).service;
    const reviewer = actor("fact_reviewer");
    const request = factResolution();

    const first = await service.mutate(reviewer, request, "correlation-fact-0001");
    const replay = await service.mutate(reviewer, request, "correlation-fact-0002");
    expect(first).toMatchObject({ revision: 5, state: "ready_for_legal_evaluation", idempotent_replay: false });
    expect(replay).toMatchObject({ revision: 5, state: "ready_for_legal_evaluation", idempotent_replay: true });
    expect(fixture.lifecycleAppends()).toBe(1);
    expect(fixture.auditAppends()).toBe(1);

    await expect(service.mutate(reviewer, { ...request, reason: "different durable fact decision" }, "correlation-fact-0003"))
      .rejects.toMatchObject({ code: "OPS_IDEMPOTENCY_CONFLICT" });
    expect(fixture.lifecycleAppends()).toBe(1);
  });

  it("approves only the exact current report hash and never duplicates the approval", async () => {
    const fixture = harness("awaiting_report_approval");
    const service = createDurableInternalOpsPostgresAdapter({
      context: fixture.context, flags: flags(), runtime_class: localRuntime(),
      synthetic_report_pipeline: fixture.syntheticReportPipeline, now: () => NOW,
    }).service;
    const approver = actor("report_approver");
    const valid = reportApproval();

    await expect(service.mutate(approver, {
      ...valid,
      payload: { ...valid.payload, report_sha256: SHA.a },
    }, "correlation-report-0001")).rejects.toMatchObject({ code: "OPS_EXACT_REPORT_APPROVAL_REQUIRED" });
    expect(fixture.reportDecisions()).toBe(0);

    const first = await service.mutate(approver, valid, "correlation-report-0002");
    const replay = await service.mutate(approver, valid, "correlation-report-0003");
    expect(first).toMatchObject({ revision: 4, state: "awaiting_report_approval",
      command_sha256: expect.stringMatching(/^[a-f0-9]{64}$/), idempotent_replay: false });
    expect(replay).toMatchObject({ revision: 4, state: "awaiting_report_approval", idempotent_replay: true });
    expect(fixture.reportDecisions()).toBe(1);
    expect(fixture.auditAppends()).toBe(1);
    expect(fixture.approvalFinalizations()).toBe(1);
    expect(fixture.lifecycleAppends()).toBe(0);
  });

  it("commits the canonical envelope before launching one fresh worker and retries the hook on replay", async () => {
    const fixture = harness("ready_for_legal_evaluation");
    const service = createDurableInternalOpsPostgresAdapter({
      context: fixture.context, flags: flags(), runtime_class: localRuntime(),
      synthetic_report_pipeline: fixture.syntheticReportPipeline, now: () => NOW,
    }).service;
    const reviewer = actor("legal_reviewer");
    const request = analysisRequest("synthetic_test");

    const first = await service.mutate(reviewer, request, "correlation-analysis-0001");
    const replay = await service.mutate(reviewer, request, "correlation-analysis-0001-replay");
    expect(first).toMatchObject({ revision: 5, state: "awaiting_report_approval", idempotent_replay: false });
    expect(replay).toMatchObject({ revision: 5, state: "awaiting_report_approval", idempotent_replay: true });
    expect(fixture.syntheticEnqueues()).toBe(1);
    expect(fixture.workerLaunches()).toBe(2);
    expect(fixture.lifecycleAppends()).toBe(1);
    expect(fixture.auditAppends()).toBe(1);
  });

  it("rejects a mismatched worker receipt after commit and safely relaunches the committed job", async () => {
    const fixture = harness("ready_for_legal_evaluation", { invalidFirstWorkerReceipt: true });
    const service = createDurableInternalOpsPostgresAdapter({
      context: fixture.context, flags: flags(), runtime_class: localRuntime(),
      synthetic_report_pipeline: fixture.syntheticReportPipeline, now: () => NOW,
    }).service;
    const request = analysisRequest("synthetic_test");
    const reviewer = actor("legal_reviewer");

    await expect(service.mutate(reviewer, request, "correlation-analysis-0002"))
      .rejects.toMatchObject({ code: "OPS_COMMAND_REJECTED" });
    expect(fixture.syntheticEnqueues()).toBe(1);
    expect(fixture.workerLaunches()).toBe(1);
    expect(fixture.lifecycleAppends()).toBe(1);

    const replay = await service.mutate(reviewer, request, "correlation-analysis-0002-replay");
    expect(replay).toMatchObject({ revision: 5, idempotent_replay: true });
    expect(fixture.syntheticEnqueues()).toBe(1);
    expect(fixture.workerLaunches()).toBe(2);
  });

  it("retries exact approval when private-object finalization previously failed", async () => {
    const fixture = harness("awaiting_report_approval", { failFirstApprovalFinalization: true });
    const service = createDurableInternalOpsPostgresAdapter({
      context: fixture.context, flags: flags(), runtime_class: localRuntime(),
      synthetic_report_pipeline: fixture.syntheticReportPipeline, now: () => NOW,
    }).service;
    const request = reportApproval();
    const approver = actor("report_approver");

    await expect(service.mutate(approver, request, "correlation-report-0004"))
      .rejects.toMatchObject({ code: "OPS_COMMAND_REJECTED" });
    expect(fixture.privateObjectBindings()).toBe(0);

    const retried = await service.mutate(approver, request, "correlation-report-0004");
    expect(retried).toMatchObject({ revision: 4, state: "awaiting_report_approval" });
    expect(fixture.reportDecisions()).toBe(1);
    expect(fixture.approvalFinalizations()).toBe(2);
    expect(fixture.privateObjectBindings()).toBe(1);
    expect(fixture.lifecycleAppends()).toBe(0);
  });

  it("keeps real legal analysis and unsafe product capabilities fail-closed", async () => {
    const fixture = harness();
    const service = createDurableInternalOpsPostgresAdapter({
      context: fixture.context, flags: flags(), runtime_class: localRuntime(),
      synthetic_report_pipeline: fixture.syntheticReportPipeline, now: () => NOW,
    }).service;
    const request = analysisRequest("real");
    await expect(service.mutate(actor("legal_reviewer"), request, "correlation-real-0001"))
      .rejects.toMatchObject({ code: "OPS_LEGAL_READINESS_BLOCKED" });
    expect(fixture.transactions).toHaveLength(0);

    expect(() => createDurableInternalOpsPostgresAdapter({
      context: fixture.context,
      flags: flags({ TIVDOC_CUSTOMER_PROCESSING_ENABLED: true }),
      runtime_class: localRuntime(),
      synthetic_report_pipeline: fixture.syntheticReportPipeline,
    })).toThrow("DURABLE_INTERNAL_OPS_UNSAFE_CAPABILITY_FORBIDDEN");
    expect(() => createDurableInternalOpsPostgresAdapter({
      context: fixture.context,
      flags: flags(),
      runtime_class: Object.freeze({
        runtime_class: "durable_local_explicit",
        sentinel: DURABLE_LOCAL_PRODUCT_RUNTIME_SENTINEL,
        postgres_target_sha256: SHA.a,
      }),
      synthetic_report_pipeline: fixture.syntheticReportPipeline,
    })).toThrow("DURABLE_INTERNAL_OPS_UNSAFE_CAPABILITY_FORBIDDEN");
    expect(() => createDurableInternalOpsLocalRuntimeClass({
      sentinel: DURABLE_LOCAL_PRODUCT_RUNTIME_SENTINEL,
      config: Object.freeze({ ...localConfig(), connection_urls: Object.freeze({
        ...localConfig().connection_urls,
        operations: "postgresql://tivdoc_operations_runtime:secret@192.0.2.1:5432/tivdoc_v09_runtime01",
      }) }),
    })).toThrow("DURABLE_INTERNAL_OPS_LOCAL_RUNTIME_CLASS_INVALID");
    expect(() => createDurableInternalOpsLocalRuntimeClass({
      sentinel: DURABLE_LOCAL_PRODUCT_RUNTIME_SENTINEL,
      config: Object.freeze({ ...localConfig(), allowed_origin: "https://remote.example.test:443",
        allow_loopback_http: false }),
    })).toThrow("DURABLE_INTERNAL_OPS_LOCAL_RUNTIME_CLASS_INVALID");
  });
});

function harness(
  initialState: "awaiting_fact_resolution" | "ready_for_legal_evaluation" | "awaiting_report_approval" = "awaiting_fact_resolution",
  options: Readonly<{
    invalidFirstWorkerReceipt?: boolean;
    failFirstApprovalFinalization?: boolean;
  }> = Object.freeze({}),
) {
  let broadTransactions = 0;
  let lifecycleRevision = 4;
  let lifecycleState: "awaiting_fact_resolution" | "ready_for_legal_evaluation" | "awaiting_report_approval" | "report_ready" = initialState;
  let lifecycleStateSha256 = SHA.f;
  let lifecycleAppends = 0;
  let auditAppends = 0;
  let reportDecisions = 0;
  let syntheticEnqueues = 0;
  let workerLaunches = 0;
  let approvalFinalizations = 0;
  let privateObjectBindings = 0;
  let transactionDepth = 0;
  let approvalDecision: Readonly<{ task_id: string; revision: number; receipt_sha256: string }> | null = null;
  let committedSyntheticEnvelope: ReturnType<typeof syntheticEnvelope> | null = null;
  const transactions: Array<Readonly<{ actor: VerifiedActor; audience: string; case_id: string; correlation_id: string }>> = [];
  const idempotency = new Map<string, Readonly<{ commandSha256: string; receipt: Readonly<Record<string, unknown>> }>>();

  const client = Object.freeze({
    async query(input: PostgresStatement) {
      const rows = rowsFor(input.name, lifecycleRevision, lifecycleState, lifecycleStateSha256);
      return Object.freeze({ rows: Object.freeze(rows), row_count: rows.length });
    },
  });

  const bundle = Object.freeze({
    context: Object.freeze({ client, transaction_id: "verified-operations-transaction-001" }),
    intake: Object.freeze({
      case_lifecycle: Object.freeze({
        async get() {
          return Object.freeze({ revision: lifecycleRevision, lifecycle_state: lifecycleState, state_sha256: lifecycleStateSha256 });
        },
        async append(_context: unknown, command: Readonly<Record<string, unknown>>) {
          if (command.expected_revision !== lifecycleRevision) throw Object.assign(new Error("revision"), { code: "INTAKE_REVISION_CONFLICT" });
          lifecycleAppends += 1;
          lifecycleRevision += 1;
          lifecycleState = command.state_after as typeof lifecycleState;
          lifecycleStateSha256 = command.state_sha256 as string;
          return Object.freeze({ revision: lifecycleRevision, lifecycle_state: lifecycleState, state_sha256: lifecycleStateSha256 });
        },
      }),
      payment_evidence: Object.freeze({ async list() { return Object.freeze([]); } }),
    }),
    analysis: Object.freeze({ reports: Object.freeze({
      async decide(input: Readonly<Record<string, unknown>>) {
        if (input.input_sha256 !== SHA.e || input.output_sha256 !== SHA.e) throw new Error("hash mismatch");
        if (approvalDecision) return approvalDecision;
        reportDecisions += 1;
        approvalDecision = Object.freeze({ task_id: String(input.task_id), revision: 1, receipt_sha256: SHA.b });
        return approvalDecision;
      },
    }) }),
    runtime: Object.freeze({
      idempotency: Object.freeze({
        async execute(_context: unknown, command: Readonly<Record<string, unknown>>, operation: () => Promise<Readonly<Record<string, unknown>>>) {
          const key = command.idempotency_key as string;
          const commandSha256 = command.command_sha256 as string;
          const existing = idempotency.get(key);
          if (existing) {
            if (existing.commandSha256 !== commandSha256) {
              throw Object.assign(new Error("idempotency"), { code: "IDEMPOTENCY_KEY_COMMAND_MISMATCH" });
            }
            return Object.freeze({ ...existing.receipt, idempotent_replay: true });
          }
          const receipt = await operation();
          idempotency.set(key, Object.freeze({ commandSha256, receipt }));
          return receipt;
        },
      }),
      jobs_outbox_audit: Object.freeze({
        async enqueue() { return Object.freeze({}); },
        async append() { auditAppends += 1; return Object.freeze({ event_sha256: SHA.a }); },
        async verify() { return Object.freeze({ valid: true, event_count: 1, tail_sha256: SHA.a }); },
      }),
    }),
  }) as unknown as DurableBundle;

  const syntheticReportPipeline: DurableInternalOpsSyntheticReportPipelinePort = Object.freeze({
    async enqueue(input: Parameters<DurableInternalOpsSyntheticReportPipelinePort["enqueue"]>[0]) {
      if (input.transaction !== bundle || transactionDepth !== 1) throw new Error("PIPELINE_TRANSACTION_REQUIRED");
      syntheticEnqueues += 1;
      const envelope = syntheticEnvelope({
        actor_id: input.actor.actor_id,
        tenant_id: input.tenant_id,
        case_id: input.case_id,
        correlation_id: input.correlation_id,
        target_revision: input.target_revision,
        command_id: input.command_id,
        idempotency_key: input.idempotency_key,
      });
      committedSyntheticEnvelope = envelope;
      return envelopeReceipt(envelope);
    },
    async launchCommitted(input: Parameters<DurableInternalOpsSyntheticReportPipelinePort["launchCommitted"]>[0]) {
      if (transactionDepth !== 0) throw new Error("WORKER_MUST_LAUNCH_AFTER_COMMIT");
      if (!committedSyntheticEnvelope) throw new Error("COMMITTED_ENVELOPE_REQUIRED");
      workerLaunches += 1;
      const envelope = committedSyntheticEnvelope;
      if (envelope.timeline.tenant_id !== input.tenant_id || envelope.timeline.case_id !== input.case_id
          || envelope.timeline.case_revision !== input.target_revision
          || envelope.pipeline.idempotency_key !== input.idempotency_key
          || (!input.committed_idempotent_replay && envelope.timeline.correlation_id !== input.correlation_id)) {
        throw new Error("COMMITTED_ENVELOPE_MISMATCH");
      }
      return Object.freeze({
        ...envelopeReceipt(envelope),
        fresh_process_verified: true as const,
        worker_state: (workerLaunches === 1 ? "SUCCEEDED" : "IDEMPOTENT_REPLAY") as "SUCCEEDED" | "IDEMPOTENT_REPLAY",
        report_sha256: options.invalidFirstWorkerReceipt && workerLaunches === 1
          ? SHA.a
          : envelope.timeline.report_sha256,
        artifact_sha256: envelope.timeline.pdf_sha256,
        logical_effect_sha256: envelope.pipeline.logical_effect_sha256,
        storage_locator_sha256: envelope.storage.locator_sha256,
        worker_process_sha256: SHA.d,
        audit_event_sha256: workerLaunches === 1 ? SHA.a : null,
      });
    },
    async finalizeApproved(input: Parameters<DurableInternalOpsSyntheticReportPipelinePort["finalizeApproved"]>[0]) {
      if (input.transaction !== bundle || transactionDepth !== 1) throw new Error("FINALIZER_TRANSACTION_REQUIRED");
      approvalFinalizations += 1;
      if (options.failFirstApprovalFinalization && approvalFinalizations === 1) {
        throw new Error("PRIVATE_OBJECT_FINALIZATION_FAILED");
      }
      const envelope = syntheticEnvelope({
        actor_id: input.actor.actor_id,
        tenant_id: input.tenant_id,
        case_id: input.case_id,
        correlation_id: input.correlation_id,
        target_revision: input.case_revision,
        command_id: input.command_id,
        idempotency_key: input.idempotency_key,
        report_id: input.report_id,
        report_sha256: input.report_sha256,
      });
      privateObjectBindings += 1;
      return Object.freeze({
        envelope,
        envelope_sha256: canonicalSha256(envelope),
        analysis_result_sha256: input.analysis_result_sha256,
        canonical_identity: approvedIdentity(input, envelope),
        storage_locator_sha256: SHA.f,
        audit_event_sha256: SHA.a,
        idempotent_replay: false,
      });
    },
  });

  const postgres = Object.freeze({
    mode: "isolated_postgres" as const,
    durable: true as const,
    target_id: "loopback-durable-ops",
    schema_version: "tivdoc-canonical-postgresql-v0.9.0" as const,
    async transaction() { broadTransactions += 1; throw new Error("BROAD_TRANSACTION_FORBIDDEN"); },
    async verified_transaction() { throw new Error("DIRECT_VERIFIED_TRANSACTION_FORBIDDEN"); },
  });
  const sessionContext = Object.freeze({
    proof_class: "LEAST_PRIVILEGE_VERIFIED_SESSION_CONTEXT" as const,
    uses_service_role: false as const,
    bypasses_rls: false as const,
    postgres,
    async transaction<T>(input: Readonly<{ actor: VerifiedActor; audience: string; case_id: string; correlation_id: string }>, operation: (value: DurableBundle) => Promise<T>) {
      transactions.push(input);
      transactionDepth += 1;
      try {
        return await operation(bundle);
      } finally {
        transactionDepth -= 1;
      }
    },
  });
  const context = Object.freeze({ postgres, product: Object.freeze({}), session_context: sessionContext }) as unknown as DurableProductRouteContext;
  return Object.freeze({ context, transactions, syntheticReportPipeline, broadTransactions: () => broadTransactions,
    lifecycleAppends: () => lifecycleAppends, auditAppends: () => auditAppends,
    reportDecisions: () => reportDecisions, syntheticEnqueues: () => syntheticEnqueues,
    workerLaunches: () => workerLaunches, approvalFinalizations: () => approvalFinalizations,
    privateObjectBindings: () => privateObjectBindings });
}

function rowsFor(name: string, revision: number, state: string, stateSha256: string): readonly Readonly<Record<string, unknown>>[] {
  switch (name) {
    case "ops_queue_read": return [Object.freeze({ case_id: CASE_ID, revision: String(revision), state, blocker_count: "1", next_action_code: "FACT_REVIEW_REQUIRED", updated_at: NOW })];
    case "ops_case_projection_read": return [Object.freeze({ revision: String(revision), state, updated_at: NOW, created_at: "2030-01-01T10:00:00.000Z", mode: "synthetic_test" })];
    case "ops_timeline_read": return [Object.freeze({ sequence: "1", event_code: "CASE_CREATED", revision: "1", occurred_at: NOW, actor_id: "durable-actor-001", event_sha256: SHA.a })];
    case "ops_documents_read": return [Object.freeze({ object_version_id: "document-001", object_sha256: SHA.a, byte_length: "2048", detected_mime: "application/pdf", status: "accepted" })];
    case "ops_extraction_read": return [Object.freeze({ field_id: "extraction-001", snapshot_sha256: SHA.b, canonical_path: "salary.base", status: "candidate", confidence_micros: "900000", source_document_id: "document-001" })];
    case "ops_snapshot_hashes_read":
    case "ops_snapshot_hashes_lock": return [Object.freeze({ documents: SHA.a, extraction: SHA.b, facts: SHA.c, analysis: SHA.d, report: SHA.e })];
    case "ops_facts_read": return [Object.freeze({ fact_id: "fact-001", payload_sha256: SHA.c, canonical_path: "salary.base", status: "needs_confirmation", provenance_count: "1", conflict_count: "0" })];
    case "ops_fact_ids_lock": return [Object.freeze({ matched: "1" })];
    case "ops_readiness_read": return WAVE3_TOPICS.map((topic) => Object.freeze({ topic, status: "calculated", result_sha256: SHA.a, mode: "synthetic_test" }));
    case "ops_analysis_read": return [Object.freeze({ analysis_run_id: "analysis-001", status: "completed", mode: "synthetic_test", input_snapshot_sha256: SHA.c, result_sha256: SHA.d, known_subtotal_minor_units: null, coverage_complete: true })];
    case "ops_report_exact_read":
    case "ops_report_exact_lock": return [Object.freeze({ report_id: "report-001", report_revision: "4", case_revision: String(revision), report_sha256: SHA.e, analysis_result_sha256: SHA.d, coverage_complete: true, release_state: null, approval_receipt_sha256: null })];
    case "ops_case_state_lock": return [Object.freeze({ revision: String(revision), lifecycle_state: state, state_sha256: stateSha256 })];
    case "ops_lifecycle_tail_read": return [Object.freeze({ event_sha256: SHA.f })];
    case "ops_audit_projection_read": return [Object.freeze({ sequence: "1", action: "CASE_CREATED", resource_revision: "1", resource_sha256: SHA.a, event_sha256: SHA.a, occurred_at: NOW })];
    default: throw new Error(`UNEXPECTED_STATEMENT:${name}`);
  }
}

function flags(overrides: Partial<InternalOpsFlagSnapshot> = {}): InternalOpsFlagSnapshot {
  return Object.freeze({
    ...disabledInternalOpsFlags(),
    TIVDOC_INTERNAL_OPS_UI_ENABLED: true,
    TIVDOC_INTERNAL_OPS_API_ENABLED: true,
    TIVDOC_SYNTHETIC_OPS_ENABLED: true,
    ...overrides,
  });
}

function localRuntime(): DurableInternalOpsLocalRuntimeClass {
  return createDurableInternalOpsLocalRuntimeClass({
    sentinel: DURABLE_LOCAL_PRODUCT_RUNTIME_SENTINEL,
    config: localConfig(),
  });
}

function localConfig(): DurableLocalProductRuntimeConfig {
  const database = "tivdoc_v09_runtime01";
  return Object.freeze({
    build_identity_sha: "1".repeat(40),
    allowed_origin: "http://127.0.0.1:45124",
    allow_loopback_http: true,
    identity: Object.freeze({
      issuer: "https://identity.test.invalid",
      key_id: "key-00000001",
      algorithm: "RS256" as const,
      public_key_spki_pem: "test-public-key",
      key_not_before_epoch: 1_800_000_000,
      key_expires_at_epoch: 2_000_000_000,
      clock_skew_seconds: 5,
      max_token_lifetime_seconds: 900,
    }),
    connection_urls: Object.freeze({
      identity: `postgresql://tivdoc_identity_runtime:secret@127.0.0.1:5432/${database}`,
      web: `postgresql://tivdoc_web_runtime:secret@127.0.0.1:5432/${database}`,
      operations: `postgresql://tivdoc_operations_runtime:secret@127.0.0.1:5432/${database}`,
      worker: `postgresql://tivdoc_worker_runtime:secret@127.0.0.1:5432/${database}`,
    }),
    private_storage_root: "C:\\ignored\\durable-ops-private",
    download_grant_hmac_key: new Uint8Array(32).fill(7),
    worker_identity: Object.freeze({
      actor_id: "worker-runtime-001",
      tenant_id: TENANT_ID,
      session_id: "worker-session-001",
      token_id: "worker-token-001",
      rotation_counter: 1,
    }),
  });
}

function actor(role: V07Role): VerifiedActor {
  return Object.freeze({ actor_id: `durable-actor-${role}`, role, tenant_id: TENANT_ID,
    assigned_case_ids: [CASE_ID], verified_server_side: true, break_glass_reason: null, break_glass_expires_at: null });
}

function factResolution() {
  return Object.freeze({ schema_version: INTERNAL_OPS_SCHEMA_VERSION, command_id: "command-fact-0001",
    idempotency_key: "idempotency-fact-0001", expected_revision: 4, reason: "durable fact resolution",
    payload: Object.freeze({ action: "fact_resolution" as const, case_id: CASE_ID, facts_snapshot_sha256: SHA.c,
      fact_ids: ["fact-001"], decision: "confirmed" as const }) });
}

function reportApproval() {
  return Object.freeze({ schema_version: INTERNAL_OPS_SCHEMA_VERSION, command_id: "command-report-0001",
    idempotency_key: "idempotency-report-0001", expected_revision: 4, reason: "exact durable report approval",
    payload: Object.freeze({ action: "report_approve" as const, case_id: CASE_ID, report_id: "report-001",
      report_revision: 4, report_sha256: SHA.e, analysis_result_sha256: SHA.d, decision: "approved" as const }) });
}

function analysisRequest(mode: "real" | "synthetic_test") {
  return Object.freeze({ schema_version: INTERNAL_OPS_SCHEMA_VERSION, command_id: "command-analysis-0001",
    idempotency_key: "idempotency-analysis-0001", expected_revision: 4, reason: "durable legal analysis request",
    payload: Object.freeze({ action: "analysis_request" as const, case_id: CASE_ID, analysis_run_id: null, mode,
      requested_topics: WAVE3_TOPICS, input_snapshot_sha256: SHA.c }) });
}

function syntheticEnvelope(input: Readonly<{
  actor_id: string;
  tenant_id: string;
  case_id: string;
  correlation_id: string;
  target_revision: number;
  command_id: string;
  idempotency_key: string;
  report_id?: string;
  report_sha256?: string;
}>) {
  return createDurableRuntimeReportJobEnvelope({
    timeline: Object.freeze({
      correlation_id: input.correlation_id,
      tenant_id: input.tenant_id,
      case_id: input.case_id,
      case_revision: input.target_revision,
      owner_binding_revision: 1,
      owner_binding_sha256: SHA.a,
      actor_id: input.actor_id,
      session_binding_sha256: SHA.b,
      session_revision: 1,
      analysis_run_id: `analysis-${input.command_id}`,
      report_id: input.report_id ?? `report-${input.command_id}`,
      report_revision: input.target_revision,
      report_sha256: input.report_sha256 ?? SHA.e,
      pdf_sha256: SHA.f,
    }),
    pipeline: Object.freeze({
      job_id: `job-${input.command_id}`,
      outbox_id: `outbox-${input.command_id}`,
      logical_effect_id: `effect-${input.command_id}`,
      idempotency_key: input.idempotency_key,
    }),
  });
}

function envelopeReceipt(envelope: ReturnType<typeof syntheticEnvelope>) {
  return Object.freeze({
    job_kind: DURABLE_RUNTIME_JOB_KIND,
    job_id: envelope.pipeline.job_id,
    envelope,
    envelope_sha256: canonicalSha256(envelope),
  });
}

function approvedIdentity(
  input: Parameters<DurableInternalOpsSyntheticReportPipelinePort["finalizeApproved"]>[0],
  envelope: ReturnType<typeof syntheticEnvelope>,
) {
  const storageBinding = Object.freeze({
    tenant_id: input.tenant_id,
    case_id: input.case_id,
    case_revision: input.case_revision,
    analysis_run_id: envelope.timeline.analysis_run_id,
    analysis_run_revision: 1,
    rule_input_dependency_sha256: SHA.c,
    report_model_sha256: SHA.d,
    report_id: input.report_id,
    report_revision: input.report_revision,
    report_sha256: input.report_sha256,
    pdf_sha256: envelope.timeline.pdf_sha256,
  });
  return createCanonicalReportIdentity(Object.freeze({
    schema_version: CANONICAL_REPORT_IDENTITY_SCHEMA_VERSION,
    tenant_id: input.tenant_id,
    owner_binding_revision: envelope.timeline.owner_binding_revision,
    owner_binding_sha256: envelope.timeline.owner_binding_sha256,
    case_id: input.case_id,
    case_revision: input.case_revision,
    analysis_run_id: envelope.timeline.analysis_run_id,
    analysis_run_revision: storageBinding.analysis_run_revision,
    rule_input_dependency_sha256: storageBinding.rule_input_dependency_sha256,
    report_model_sha256: storageBinding.report_model_sha256,
    report_id: input.report_id,
    report_revision: input.report_revision,
    report_sha256: input.report_sha256,
    pdf_sha256: envelope.timeline.pdf_sha256,
    storage_object_id: canonicalReportStorageObjectId(storageBinding),
    storage_object_version_id: canonicalReportStorageObjectVersionId(storageBinding),
    approval_task_id: input.command_id,
    approval_revision: input.approval_revision,
    approval_decision_sha256: input.approval_decision_sha256,
    download_grant_revision: 1,
  }));
}
