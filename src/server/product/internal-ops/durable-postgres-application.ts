import "./server-boundary.ts";

import { canonicalSha256 } from "../../../engine/rule-runtime/canonical.ts";
import type { VerifiedActor } from "../../../engine/wave4/contracts.ts";
import { WAVE3_TOPICS, type CaseLifecycleState, type Wave3Topic } from "../../../engine/wave3/contracts.ts";
import type { TransactionScopedPostgresBundle } from "../../platform/composition/canonical-postgres.ts";
import { statement, type PostgresQueryResult } from "../../platform/persistence/postgres/contracts.ts";
import type { PostgresAnalysisRepositories } from "../../platform/persistence/postgres/analysis/index.ts";
import type { PostgresIntakeAdapterBundle } from "../../platform/persistence/postgres/intake/index.ts";
import type { InternalOpsApplicationPort } from "./application-port.ts";
import {
  INTERNAL_OPS_SCHEMA_VERSION,
  internalOpsMutationRequestSchema,
  type AnalysisProjection,
  type AuditProjection,
  type DocumentProjection,
  type ExtractionProjection,
  type FactsProjection,
  type InternalOpsCaseProjection,
  type InternalOpsCommandResult,
  type InternalOpsMutationRequest,
  type MutationResultProjection,
  type OpsCapabilityProjection,
  type OpsReadProjection,
  type PaymentProjection,
  type QueueProjection,
  type ReadinessProjection,
  type ReportProjection,
  type TimelineProjection,
} from "./contracts.ts";
import type { InternalOpsFlagSnapshot } from "./flags.ts";
import { actorScopePermits, capabilitiesForRole, rolePermits } from "./policy.ts";
import { InternalOpsError, type InternalOpsReadKind } from "./service.ts";
import type {
  DurableProductRouteContext,
  DurableProductRouteServiceAdapter,
} from "../routes/durable-registration.ts";
import {
  DURABLE_LOCAL_PRODUCT_RUNTIME_SENTINEL,
  type DurableLocalProductRuntimeConfig,
} from "../runtime/durable-local-config.ts";
import {
  DURABLE_RUNTIME_JOB_KIND,
  createDurableRuntimeReportJobEnvelope,
  type DurableRuntimeReportJobEnvelope,
} from "../durable-postgres/runtime-product-lane.ts";
import {
  assertCanonicalReportIdentity,
  type CanonicalReportIdentity,
} from "../durable-postgres/report-identity.ts";

export type DurableInternalOpsTransactionBundle = TransactionScopedPostgresBundle<
  PostgresIntakeAdapterBundle,
  PostgresAnalysisRepositories
>;

type DurableBundle = DurableInternalOpsTransactionBundle;

export type DurableInternalOpsSyntheticEnvelopeReceipt = Readonly<{
  job_kind: typeof DURABLE_RUNTIME_JOB_KIND;
  job_id: string;
  envelope: DurableRuntimeReportJobEnvelope;
  envelope_sha256: string;
}>;

/**
 * Root-supplied atomic coordinator. It materializes the synthetic report and
 * enqueues the canonical worker envelope using the verified transaction below.
 */
export interface DurableInternalOpsSyntheticReportPipelinePort {
  enqueue(input: Readonly<{
    transaction: DurableInternalOpsTransactionBundle;
    actor: VerifiedActor;
    tenant_id: string;
    case_id: string;
    correlation_id: string;
    target_revision: number;
    command_id: string;
    idempotency_key: string;
    command_sha256: string;
    input_snapshot_sha256: string;
    requested_topics: readonly Wave3Topic[];
    occurred_at: string;
  }>): Promise<DurableInternalOpsSyntheticEnvelopeReceipt>;
  launchCommitted(input: Readonly<{
    actor: VerifiedActor;
    tenant_id: string;
    case_id: string;
    correlation_id: string;
    target_revision: number;
    command_id: string;
    idempotency_key: string;
    committed_idempotent_replay: boolean;
  }>): Promise<DurableInternalOpsSyntheticEnvelopeReceipt & Readonly<{
    fresh_process_verified: true;
    worker_state: "SUCCEEDED" | "IDEMPOTENT_REPLAY";
    report_sha256: string;
    artifact_sha256: string;
    logical_effect_sha256: string;
    storage_locator_sha256: string;
    worker_process_sha256: string;
    audit_event_sha256: string | null;
  }>>;
  finalizeApproved(input: Readonly<{
    transaction: DurableInternalOpsTransactionBundle;
    actor: VerifiedActor;
    tenant_id: string;
    case_id: string;
    correlation_id: string;
    command_id: string;
    idempotency_key: string;
    case_revision: number;
    report_id: string;
    report_revision: number;
    report_sha256: string;
    analysis_result_sha256: string;
    approval_revision: number;
    approval_decision_sha256: string;
    occurred_at: string;
  }>): Promise<Readonly<{
    envelope: DurableRuntimeReportJobEnvelope;
    envelope_sha256: string;
    analysis_result_sha256: string;
    canonical_identity: CanonicalReportIdentity;
    storage_locator_sha256: string;
    audit_event_sha256: string;
    idempotent_replay: boolean;
  }>>;
}

const HASH = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{2,159}$/u;
const CORRELATION = /^[A-Za-z0-9][A-Za-z0-9:._-]{2,95}$/u;
const SUPPORTED_DURABLE_COMMANDS = new Set([
  "command.fact_resolution",
  "command.analysis_request",
  "command.report_approve",
]);
const STATES = new Set<CaseLifecycleState>([
  "awaiting_payment", "awaiting_documents", "awaiting_extraction_review", "awaiting_fact_resolution",
  "ready_for_legal_evaluation", "awaiting_legal_review", "awaiting_report_approval", "report_ready",
  "release_hold", "delivered", "cancelled",
]);

export const DURABLE_INTERNAL_OPS_POSTGRES_SCHEMA_VERSION = "tivdoc-durable-internal-ops-postgresql-v0.10.2" as const;

export type DurableInternalOpsPostgresProof = Readonly<{
  schema_version: typeof DURABLE_INTERNAL_OPS_POSTGRES_SCHEMA_VERSION;
  persistence: "postgresql_required";
  session_context: "least_privilege_verified_operations";
  canonical_transaction_contexts: 1;
  product_reachable_memory_fallbacks: 0;
  service_role_allowed: false;
  bypass_rls_allowed: false;
  real_legal_mode: "blocked_not_ready";
}>;

export type DurableInternalOpsLocalRuntimeClass = Readonly<{
  runtime_class: "durable_local_explicit";
  sentinel: typeof DURABLE_LOCAL_PRODUCT_RUNTIME_SENTINEL;
  postgres_target_sha256: string;
}>;

const issuedLocalRuntimeClasses = new WeakSet<object>();
const RUNTIME_CONNECTION_ROLES = Object.freeze(["identity", "web", "operations", "worker"] as const);
const EXPECTED_RUNTIME_USERS = Object.freeze({
  identity: "tivdoc_identity_runtime",
  web: "tivdoc_web_runtime",
  operations: "tivdoc_operations_runtime",
  worker: "tivdoc_worker_runtime",
} as const);

/** Root-owned validation seam. Returned instances cannot be forged as plain configuration. */
export function createDurableInternalOpsLocalRuntimeClass(input: Readonly<{
  sentinel: typeof DURABLE_LOCAL_PRODUCT_RUNTIME_SENTINEL;
  config: DurableLocalProductRuntimeConfig;
}>): DurableInternalOpsLocalRuntimeClass {
  if (input.sentinel !== DURABLE_LOCAL_PRODUCT_RUNTIME_SENTINEL
      || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(input.config.build_identity_sha)) {
    throw new Error("DURABLE_INTERNAL_OPS_LOCAL_RUNTIME_CLASS_INVALID");
  }
  const origin = new URL(input.config.allowed_origin);
  const transportMatches = origin.protocol === "https:"
    ? input.config.allow_loopback_http === false
    : origin.protocol === "http:" && input.config.allow_loopback_http === true;
  if (!transportMatches || origin.hostname !== "127.0.0.1" || !origin.port
      || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) {
    throw new Error("DURABLE_INTERNAL_OPS_LOCAL_RUNTIME_CLASS_INVALID");
  }
  const urls = RUNTIME_CONNECTION_ROLES.map((role) => {
    const raw = input.config.connection_urls[role];
    const url = new URL(raw);
    if (url.username !== EXPECTED_RUNTIME_USERS[role]
        || !["127.0.0.1", "::1", "[::1]", "localhost"].includes(url.hostname)
        || !url.port || !url.pathname || url.pathname === "/") {
      throw new Error("DURABLE_INTERNAL_OPS_LOCAL_RUNTIME_CLASS_INVALID");
    }
    return url;
  });
  const first = urls[0];
  if (!first || urls.some((url) => url.hostname !== first.hostname || url.port !== first.port || url.pathname !== first.pathname)) {
    throw new Error("DURABLE_INTERNAL_OPS_LOCAL_RUNTIME_CLASS_INVALID");
  }
  const runtimeClass = Object.freeze({
    runtime_class: "durable_local_explicit" as const,
    sentinel: DURABLE_LOCAL_PRODUCT_RUNTIME_SENTINEL,
    postgres_target_sha256: canonicalSha256({ host: first.hostname, port: first.port, database: first.pathname }),
  });
  issuedLocalRuntimeClasses.add(runtimeClass);
  return runtimeClass;
}

export interface DurableInternalOpsPostgresApplication extends InternalOpsApplicationPort {
  proof(): DurableInternalOpsPostgresProof;
}

export type DurableInternalOpsPostgresRouteAdapter = DurableProductRouteServiceAdapter<
  DurableInternalOpsPostgresApplication
>;

class PostgresInternalOpsApplication implements DurableInternalOpsPostgresApplication {
  readonly #context: DurableProductRouteContext;
  readonly #flags: InternalOpsFlagSnapshot;
  readonly #syntheticReportPipeline: DurableInternalOpsSyntheticReportPipelinePort;
  readonly #now: () => string;

  constructor(input: Readonly<{
    context: DurableProductRouteContext;
    flags: InternalOpsFlagSnapshot;
    synthetic_report_pipeline: DurableInternalOpsSyntheticReportPipelinePort;
    now: () => string;
  }>) {
    this.#context = input.context;
    this.#flags = input.flags;
    this.#syntheticReportPipeline = input.synthetic_report_pipeline;
    this.#now = input.now;
  }

  proof(): DurableInternalOpsPostgresProof {
    return Object.freeze({
      schema_version: DURABLE_INTERNAL_OPS_POSTGRES_SCHEMA_VERSION,
      persistence: "postgresql_required",
      session_context: "least_privilege_verified_operations",
      canonical_transaction_contexts: 1,
      product_reachable_memory_fallbacks: 0,
      service_role_allowed: false,
      bypass_rls_allowed: false,
      real_legal_mode: "blocked_not_ready",
    });
  }

  async read(actor: VerifiedActor, kind: InternalOpsReadKind, caseId: string | null): Promise<OpsReadProjection> {
    this.#guardRead(actor, kind, caseId);
    const scopeCaseId = caseId ?? actor.assigned_case_ids[0] ?? "operations-global";
    return this.#transaction(actor, scopeCaseId, `ops-read-${kind}`, async (bundle, tenantId) => {
      switch (kind) {
        case "capabilities": return capabilityProjection(actor, this.#flags);
        case "queue": return readQueue(bundle, tenantId, actor);
        case "case": return readCase(bundle, tenantId, requireCaseId(caseId));
        case "timeline": return readTimeline(bundle, tenantId, requireCaseId(caseId));
        case "payment": return readPayment(bundle, tenantId, requireCaseId(caseId));
        case "documents": return readDocuments(bundle, tenantId, requireCaseId(caseId));
        case "extraction": return readExtraction(bundle, tenantId, requireCaseId(caseId));
        case "facts": return readFacts(bundle, tenantId, requireCaseId(caseId));
        case "readiness": return readReadiness(bundle, tenantId, requireCaseId(caseId));
        case "analysis": return readAnalysis(bundle, tenantId, requireCaseId(caseId));
        case "report": return readReport(bundle, tenantId, requireCaseId(caseId));
        case "audit": return readAudit(bundle, tenantId, requireCaseId(caseId));
      }
    });
  }

  async mutate(actor: VerifiedActor, raw: unknown, correlationId: string): Promise<InternalOpsCommandResult> {
    const parsed = internalOpsMutationRequestSchema.safeParse(raw);
    if (!parsed.success || !ID.test(correlationId)) throw new InternalOpsError("OPS_INVALID_REQUEST");
    const request = parsed.data;
    const caseId = request.payload.case_id;
    const durableCorrelationId = normalizeCorrelation(correlationId);
    this.#guardMutation(actor, request);
    try {
      const result = await this.#transaction(actor, caseId, durableCorrelationId, async (bundle, tenantId) => {
        const commandSha256 = canonicalSha256(request);
        const occurredAt = this.#now();
        const receipt = await bundle.runtime.idempotency.execute(bundle.context, {
          tenant_id: tenantId,
          case_id: caseId,
          actor_id: actor.actor_id,
          scope: `internal_ops.${request.payload.action}`,
          idempotency_key: request.idempotency_key,
          expected_case_revision: request.expected_revision,
          command_sha256: commandSha256,
          command: request,
          occurred_at: occurredAt,
          writes: Object.freeze([]),
          invalidates: Object.freeze([]),
          outbox: Object.freeze([]),
        }, async () => executeMutation(
          bundle,
          tenantId,
          actor,
          request,
          commandSha256,
          occurredAt,
          durableCorrelationId,
          this.#syntheticReportPipeline,
        ));
        const current = await requireCaseState(bundle, tenantId, caseId);
        const hashes = await readSnapshotHashes(bundle, tenantId, caseId);
        return Object.freeze({
          schema_version: INTERNAL_OPS_SCHEMA_VERSION,
          case_id: caseId,
          revision: receipt.case_revision,
          state: current.state,
          command_sha256: receipt.command_sha256,
          audit_event_sha256: receipt.audit_event_sha256,
          idempotent_replay: receipt.idempotent_replay,
          snapshot_hashes: hashes,
          invalidation_codes: Object.freeze([]),
          blocker_codes: Object.freeze([]),
          correlation_id: durableCorrelationId,
        }) satisfies MutationResultProjection;
      });
      if (request.payload.action === "analysis_request") {
        const worker = await this.#syntheticReportPipeline.launchCommitted({
          actor,
          tenant_id: requireTenant(actor),
          case_id: caseId,
          correlation_id: durableCorrelationId,
          target_revision: result.revision,
          command_id: request.command_id,
          idempotency_key: request.idempotency_key,
          committed_idempotent_replay: result.idempotent_replay,
        });
        assertCommittedWorkerReceipt(
          worker,
          requireTenant(actor),
          caseId,
          actor.actor_id,
          result.idempotent_replay ? null : durableCorrelationId,
          result.revision,
          request.idempotency_key,
        );
      }
      return result;
    } catch (error) {
      throw mapPersistenceError(error);
    }
  }

  #guardRead(actor: VerifiedActor, kind: InternalOpsReadKind, caseId: string | null): void {
    const capability = kind === "capabilities" ? "ops.read"
      : kind === "queue" ? "queue.read"
        : kind === "case" || kind === "timeline" ? "case.read"
          : kind === "payment" ? "payment.read"
            : kind === "documents" ? "document.read"
              : kind === "extraction" ? "extraction.read"
                : kind === "facts" ? "fact.read"
                  : kind === "readiness" ? "readiness.read"
                    : kind === "analysis" ? "analysis.read"
                      : kind === "report" ? "report.read" : "audit.read";
    if (!rolePermits(actor.role, capability) || !actorScopePermits(actor, caseId, this.#now())) {
      throw new InternalOpsError("OPS_FORBIDDEN");
    }
    requireTenant(actor);
  }

  #guardMutation(actor: VerifiedActor, request: InternalOpsMutationRequest): void {
    const action = request.payload.action;
    const caseId = request.payload.case_id;
    if (!rolePermits(actor.role, `command.${action}`) || !actorScopePermits(actor, caseId, this.#now())) {
      throw new InternalOpsError("OPS_FORBIDDEN");
    }
    requireTenant(actor);
    if (action !== "fact_resolution" && action !== "analysis_request" && action !== "report_approve") {
      throw new InternalOpsError("OPS_COMMAND_REJECTED");
    }
    if (action === "analysis_request") {
      if (request.payload.mode === "real") throw new InternalOpsError("OPS_LEGAL_READINESS_BLOCKED");
      if (!this.#flags.TIVDOC_SYNTHETIC_OPS_ENABLED) throw new InternalOpsError("OPS_SYNTHETIC_DISABLED");
    }
  }

  #transaction<T>(
    actor: VerifiedActor,
    caseId: string,
    correlationId: string,
    operation: (bundle: DurableBundle, tenantId: string) => Promise<T>,
  ): Promise<T> {
    const tenantId = requireTenant(actor);
    return this.#context.session_context.transaction({
      actor,
      audience: "operations",
      case_id: caseId,
      correlation_id: normalizeCorrelation(correlationId),
    }, (bundle) => operation(bundle, tenantId));
  }
}

export function createDurableInternalOpsPostgresAdapter(input: Readonly<{
  context: DurableProductRouteContext;
  flags: InternalOpsFlagSnapshot;
  runtime_class: DurableInternalOpsLocalRuntimeClass;
  synthetic_report_pipeline: DurableInternalOpsSyntheticReportPipelinePort;
  now?: () => string;
}>): DurableInternalOpsPostgresRouteAdapter {
  const { context, flags } = input;
  if (!context || context.postgres.mode !== "isolated_postgres" || context.postgres.durable !== true
      || context.session_context.postgres !== context.postgres
      || context.session_context.proof_class !== "LEAST_PRIVILEGE_VERIFIED_SESSION_CONTEXT"
      || context.session_context.uses_service_role !== false
      || context.session_context.bypasses_rls !== false) {
    throw new Error("DURABLE_INTERNAL_OPS_SESSION_CONTEXT_REQUIRED");
  }
  if (!input.synthetic_report_pipeline || typeof input.synthetic_report_pipeline.enqueue !== "function"
      || typeof input.synthetic_report_pipeline.launchCommitted !== "function"
      || typeof input.synthetic_report_pipeline.finalizeApproved !== "function"
      || !issuedLocalRuntimeClasses.has(input.runtime_class)
      || input.runtime_class.runtime_class !== "durable_local_explicit"
      || input.runtime_class.sentinel !== DURABLE_LOCAL_PRODUCT_RUNTIME_SENTINEL
      || !HASH.test(input.runtime_class.postgres_target_sha256)
      || flags.TIVDOC_PUBLIC_FIXTURE_OPS_ENABLED || flags.TIVDOC_CUSTOMER_PROCESSING_ENABLED
      || flags.TIVDOC_CUSTOMER_SHADOW_ENABLED || flags.TIVDOC_PRODUCTION_DELIVERY_ENABLED
      ) {
    throw new Error("DURABLE_INTERNAL_OPS_UNSAFE_CAPABILITY_FORBIDDEN");
  }
  const service = new PostgresInternalOpsApplication({
    context,
    flags,
    synthetic_report_pipeline: input.synthetic_report_pipeline,
    now: input.now ?? (() => new Date().toISOString()),
  });
  return Object.freeze({
    service,
    postgres: context.postgres,
    product: context.product,
    session_context: context.session_context,
    proof_class: "POSTGRESQL_TRANSACTIONAL_ROUTE_SERVICE" as const,
  });
}

async function executeMutation(
  bundle: DurableBundle,
  tenantId: string,
  actor: VerifiedActor,
  request: InternalOpsMutationRequest,
  commandSha256: string,
  occurredAt: string,
  correlationId: string,
  syntheticReportPipeline: DurableInternalOpsSyntheticReportPipelinePort,
) {
  const caseId = request.payload.case_id;
  const current = await requireCaseState(bundle, tenantId, caseId, true);
  if (current.revision !== request.expected_revision) throw new InternalOpsError("OPS_REVISION_CONFLICT");

  let revision = current.revision;
  let resourceSha256 = current.state_sha256;
  let outboxIds: readonly string[] = Object.freeze([]);
  if (request.payload.action === "fact_resolution") {
    if (current.state !== "awaiting_fact_resolution") {
      throw new InternalOpsError("OPS_REVISION_CONFLICT");
    }
    if (request.payload.decision !== "confirmed") throw new InternalOpsError("OPS_COMMAND_REJECTED");
    const hashes = await readSnapshotHashes(bundle, tenantId, caseId, true);
    if (hashes.facts !== request.payload.facts_snapshot_sha256) {
      throw new InternalOpsError("OPS_UPSTREAM_INVALIDATED");
    }
    const matchedFacts = await bundle.context.client.query(statement("ops_fact_ids_lock", `
      with locked as (
        select fact_id from public.engine_canonical_fact_versions
        where tenant_id = $1 and canonical_case_id = $2
          and fact_id in (select jsonb_array_elements_text($3::jsonb))
        for share
      ) select count(distinct fact_id)::text as matched from locked`, [
      tenantId, caseId, JSON.stringify(request.payload.fact_ids),
    ]));
    if (count(one(matchedFacts).matched) !== new Set(request.payload.fact_ids).size) {
      throw new InternalOpsError("OPS_UPSTREAM_INVALIDATED");
    }
    const advanced = await advanceLifecycle(
      bundle, tenantId, caseId, current, "ready_for_legal_evaluation",
      commandSha256, "operations.fact_resolution", occurredAt,
    );
    revision = advanced.revision;
    resourceSha256 = advanced.state_sha256;
  } else if (request.payload.action === "analysis_request") {
    if (current.state !== "ready_for_legal_evaluation") {
      throw new InternalOpsError("OPS_REVISION_CONFLICT");
    }
    const hashes = await readSnapshotHashes(bundle, tenantId, caseId, true);
    if (hashes.facts !== request.payload.input_snapshot_sha256 || request.payload.mode !== "synthetic_test") {
      throw new InternalOpsError("OPS_LEGAL_READINESS_BLOCKED");
    }
    const advanced = await advanceLifecycle(
      bundle, tenantId, caseId, current, "awaiting_report_approval",
      commandSha256, "operations.synthetic_analysis_requested", occurredAt,
    );
    const pipeline = await syntheticReportPipeline.enqueue({
      transaction: bundle,
      actor,
      tenant_id: tenantId,
      case_id: caseId,
      correlation_id: correlationId,
      target_revision: advanced.revision,
      command_id: request.command_id,
      idempotency_key: request.idempotency_key,
      command_sha256: commandSha256,
      input_snapshot_sha256: request.payload.input_snapshot_sha256,
      requested_topics: request.payload.requested_topics,
      occurred_at: occurredAt,
    });
    assertSyntheticPipelineReceipt(pipeline, tenantId, caseId, actor.actor_id, correlationId, advanced.revision, request.idempotency_key);
    revision = advanced.revision;
    resourceSha256 = pipeline.envelope.timeline.report_sha256;
    outboxIds = Object.freeze([pipeline.envelope.pipeline.outbox_id]);
  } else if (request.payload.action === "report_approve") {
    const exact = await readExactReportForUpdate(bundle, tenantId, caseId);
    if (!exact || exact.report_id !== request.payload.report_id
        || exact.report_revision !== request.payload.report_revision
        || exact.report_revision !== current.revision
        || exact.report_sha256 !== request.payload.report_sha256
        || exact.analysis_result_sha256 !== request.payload.analysis_result_sha256
        || exact.status !== "awaiting_approval"
        || current.state !== "awaiting_report_approval") {
      throw new InternalOpsError("OPS_EXACT_REPORT_APPROVAL_REQUIRED");
    }
    const decision = await bundle.analysis.reports.decide({
      task_id: request.command_id,
      task_kind: "report_approval",
      reviewer_id: actor.actor_id,
      reviewer_role: actor.role,
      decision: "approved",
      input_sha256: exact.report_sha256,
      output_sha256: exact.report_sha256,
      decided_at: occurredAt,
      reason: request.reason,
      schema_version: INTERNAL_OPS_SCHEMA_VERSION,
    });
    const finalized = await syntheticReportPipeline.finalizeApproved({
      transaction: bundle,
      actor,
      tenant_id: tenantId,
      case_id: caseId,
      correlation_id: correlationId,
      command_id: request.command_id,
      idempotency_key: request.idempotency_key,
      case_revision: current.revision,
      report_id: exact.report_id,
      report_revision: exact.report_revision,
      report_sha256: exact.report_sha256,
      analysis_result_sha256: exact.analysis_result_sha256,
      approval_revision: decision.revision,
      approval_decision_sha256: decision.receipt_sha256,
      occurred_at: occurredAt,
    });
    assertFinalizedApprovalReceipt(finalized, {
      tenant_id: tenantId,
      case_id: caseId,
      case_revision: current.revision,
      command_id: request.command_id,
      report_id: exact.report_id,
      report_revision: exact.report_revision,
      report_sha256: exact.report_sha256,
      analysis_result_sha256: exact.analysis_result_sha256,
      approval_revision: decision.revision,
      approval_decision_sha256: decision.receipt_sha256,
    });
    resourceSha256 = finalized.canonical_identity.identity_sha256;
  }

  const audit = await bundle.runtime.jobs_outbox_audit.append({
    actor_id: actor.actor_id,
    action: `INTERNAL_OPS_${request.payload.action.toUpperCase()}`,
    resource_id: caseId,
    resource_revision: revision,
    resource_sha256: resourceSha256,
    reason: request.reason,
    occurred_at: occurredAt,
  });
  return Object.freeze({
    tenant_id: tenantId,
    case_id: caseId,
    case_revision: revision,
    command_sha256: commandSha256,
    audit_event_sha256: audit.event_sha256,
    outbox_ids: outboxIds,
    idempotent_replay: false,
  });
}

function assertSyntheticPipelineReceipt(
  receipt: Awaited<ReturnType<DurableInternalOpsSyntheticReportPipelinePort["enqueue"]>>,
  tenantId: string,
  caseId: string,
  actorId: string,
  correlationId: string | null,
  targetRevision: number,
  idempotencyKey: string,
): void {
  try {
    const { envelope } = receipt;
    if (receipt.job_kind !== DURABLE_RUNTIME_JOB_KIND
        || !ID.test(receipt.job_id)
        || !HASH.test(receipt.envelope_sha256)
        || envelope.analysis_mode !== "synthetic_seven_topic_only"
        || envelope.legal_rules_activated !== 0
        || envelope.timeline.tenant_id !== tenantId
        || envelope.timeline.case_id !== caseId
        || envelope.timeline.actor_id !== actorId
        || (correlationId !== null && envelope.timeline.correlation_id !== correlationId)
        || envelope.timeline.case_revision !== targetRevision
        || envelope.timeline.report_revision !== targetRevision
        || envelope.pipeline.job_id !== receipt.job_id
        || envelope.pipeline.idempotency_key !== idempotencyKey
        || envelope.storage.provider_class !== "local_private_immutable_filesystem"
        || envelope.storage.managed_platform_verified !== false) {
      throw new Error("DURABLE_INTERNAL_OPS_SYNTHETIC_PIPELINE_INVALID");
    }
    const rebuilt = createDurableRuntimeReportJobEnvelope({
      timeline: envelope.timeline,
      pipeline: {
        job_id: envelope.pipeline.job_id,
        outbox_id: envelope.pipeline.outbox_id,
        logical_effect_id: envelope.pipeline.logical_effect_id,
        idempotency_key: envelope.pipeline.idempotency_key,
      },
    });
    if (canonicalSha256(envelope) !== receipt.envelope_sha256
        || canonicalSha256(rebuilt) !== receipt.envelope_sha256) {
      throw new Error("DURABLE_INTERNAL_OPS_SYNTHETIC_PIPELINE_INVALID");
    }
  } catch {
    throw new InternalOpsError("OPS_COMMAND_REJECTED");
  }
}

function assertCommittedWorkerReceipt(
  receipt: Awaited<ReturnType<DurableInternalOpsSyntheticReportPipelinePort["launchCommitted"]>>,
  tenantId: string,
  caseId: string,
  actorId: string,
  correlationId: string | null,
  targetRevision: number,
  idempotencyKey: string,
): void {
  assertSyntheticPipelineReceipt(
    receipt,
    tenantId,
    caseId,
    actorId,
    correlationId,
    targetRevision,
    idempotencyKey,
  );
  try {
    const { envelope } = receipt;
    if (receipt.fresh_process_verified !== true
        || (receipt.worker_state !== "SUCCEEDED" && receipt.worker_state !== "IDEMPOTENT_REPLAY")
        || receipt.report_sha256 !== envelope.timeline.report_sha256
        || receipt.artifact_sha256 !== envelope.timeline.pdf_sha256
        || receipt.logical_effect_sha256 !== envelope.pipeline.logical_effect_sha256
        || receipt.storage_locator_sha256 !== envelope.storage.locator_sha256
        || !HASH.test(receipt.worker_process_sha256)
        || (receipt.audit_event_sha256 !== null && !HASH.test(receipt.audit_event_sha256))
        || (receipt.worker_state === "SUCCEEDED" && receipt.audit_event_sha256 === null)) {
      throw new Error("DURABLE_INTERNAL_OPS_FRESH_WORKER_INVALID");
    }
  } catch {
    throw new InternalOpsError("OPS_COMMAND_REJECTED");
  }
}

function assertFinalizedApprovalReceipt(
  receipt: Awaited<ReturnType<DurableInternalOpsSyntheticReportPipelinePort["finalizeApproved"]>>,
  expected: Readonly<{
    tenant_id: string;
    case_id: string;
    case_revision: number;
    command_id: string;
    report_id: string;
    report_revision: number;
    report_sha256: string;
    analysis_result_sha256: string;
    approval_revision: number;
    approval_decision_sha256: string;
  }>,
): void {
  try {
    const { envelope, canonical_identity: identity } = receipt;
    assertCanonicalReportIdentity(identity);
    const rebuilt = createDurableRuntimeReportJobEnvelope({
      timeline: envelope.timeline,
      pipeline: {
        job_id: envelope.pipeline.job_id,
        outbox_id: envelope.pipeline.outbox_id,
        logical_effect_id: envelope.pipeline.logical_effect_id,
        idempotency_key: envelope.pipeline.idempotency_key,
      },
    });
    if (!HASH.test(receipt.envelope_sha256)
        || canonicalSha256(envelope) !== receipt.envelope_sha256
        || canonicalSha256(rebuilt) !== receipt.envelope_sha256
        || envelope.timeline.tenant_id !== expected.tenant_id
        || envelope.timeline.case_id !== expected.case_id
        || envelope.timeline.case_revision !== expected.case_revision
        || envelope.timeline.report_id !== expected.report_id
        || envelope.timeline.report_revision !== expected.report_revision
        || envelope.timeline.report_sha256 !== expected.report_sha256
        || receipt.analysis_result_sha256 !== expected.analysis_result_sha256
        || identity.tenant_id !== expected.tenant_id
        || identity.case_id !== expected.case_id
        || identity.case_revision !== expected.case_revision
        || identity.owner_binding_revision !== envelope.timeline.owner_binding_revision
        || identity.owner_binding_sha256 !== envelope.timeline.owner_binding_sha256
        || identity.analysis_run_id !== envelope.timeline.analysis_run_id
        || identity.report_id !== expected.report_id
        || identity.report_revision !== expected.report_revision
        || identity.report_sha256 !== expected.report_sha256
        || identity.pdf_sha256 !== envelope.timeline.pdf_sha256
        || identity.approval_task_id !== expected.command_id
        || identity.approval_revision !== expected.approval_revision
        || identity.approval_decision_sha256 !== expected.approval_decision_sha256
        || identity.download_grant_revision !== 1
        || !HASH.test(receipt.storage_locator_sha256)
        || !HASH.test(receipt.audit_event_sha256)
        || typeof receipt.idempotent_replay !== "boolean") {
      throw new Error("DURABLE_INTERNAL_OPS_APPROVAL_FINALIZATION_INVALID");
    }
  } catch {
    throw new InternalOpsError("OPS_COMMAND_REJECTED");
  }
}

async function advanceLifecycle(
  bundle: DurableBundle,
  tenantId: string,
  caseId: string,
  current: Readonly<{ revision: number; state: CaseLifecycleState; state_sha256: string }>,
  nextState: CaseLifecycleState,
  commandSha256: string,
  eventKind: string,
  occurredAt: string,
): Promise<Readonly<{ revision: number; state_sha256: string }>> {
  const tail = await bundle.context.client.query(statement("ops_lifecycle_tail_read", `
    select history.event_sha256
    from public.engine_case_lifecycle_revisions history
    join public.engine_case_identity identity on identity.internal_case_id = history.case_id
    where history.tenant_id = $1 and identity.canonical_case_id = $2
    order by history.revision desc limit 1 for update`, [tenantId, caseId]));
  const previousSha256 = tail.rows[0] ? hash(tail.rows[0].event_sha256) : null;
  const revision = current.revision + 1;
  const stateSha256 = canonicalSha256({ tenant_id: tenantId, case_id: caseId, revision, state: nextState, command_sha256: commandSha256 });
  const eventSha256 = canonicalSha256({ previous_sha256: previousSha256, state_sha256: stateSha256, event_kind: eventKind, occurred_at: occurredAt });
  const appended = await bundle.intake.case_lifecycle.append(bundle.context, {
    tenant_id: tenantId,
    case_id: caseId,
    expected_revision: current.revision,
    state_before: current.state,
    state_after: nextState,
    event_kind: eventKind,
    command_sha256: commandSha256,
    event_sha256: eventSha256,
    previous_sha256: previousSha256,
    state_sha256: stateSha256,
    occurred_at: occurredAt,
  });
  return Object.freeze({ revision: appended.revision, state_sha256: appended.state_sha256 });
}

async function readQueue(bundle: DurableBundle, tenantId: string, actor: VerifiedActor): Promise<QueueProjection> {
  const breakGlass = actor.role === "break_glass_admin";
  const result = await bundle.context.client.query(statement("ops_queue_read", `
    select canonical_case_id as case_id, revision::text, lifecycle_state as state,
           case when lifecycle_state in ('report_ready','delivered') then 0 else 1 end as blocker_count,
           case when lifecycle_state = 'awaiting_fact_resolution' then 'FACT_REVIEW_REQUIRED'
                when lifecycle_state = 'awaiting_report_approval' then 'REPORT_APPROVAL_REQUIRED'
                else upper(lifecycle_state) end as next_action_code,
           updated_at::text
    from public.engine_case_state
    where tenant_id = $1
      and ($2::boolean or canonical_case_id in (select jsonb_array_elements_text($3::jsonb)))
    order by updated_at, canonical_case_id limit 500`, [tenantId, breakGlass, JSON.stringify(actor.assigned_case_ids)]));
  return Object.freeze({
    schema_version: INTERNAL_OPS_SCHEMA_VERSION,
    items: Object.freeze(result.rows.map((row) => Object.freeze({
      case_id: id(row.case_id), revision: count(row.revision), state: lifecycle(row.state),
      blocker_count: count(row.blocker_count), next_action_code: id(row.next_action_code), updated_at: timestamp(row.updated_at),
    }))),
    next_cursor: null,
  });
}

async function readCase(bundle: DurableBundle, tenantId: string, caseId: string): Promise<InternalOpsCaseProjection> {
  const result = await bundle.context.client.query(statement("ops_case_projection_read", `
    select state.revision::text, state.lifecycle_state as state, state.updated_at::text,
           coalesce((select min(history.occurred_at)::text from public.engine_case_lifecycle_revisions history
             where history.tenant_id = state.tenant_id and history.case_id = state.case_id), state.updated_at::text) as created_at,
           coalesce((select run.command_payload->>'mode' from public.analysis_runs run
             where run.tenant_id = state.tenant_id and run.canonical_case_id = state.canonical_case_id
             order by run.created_at desc limit 1), 'real') as mode
    from public.engine_case_state state
    where state.tenant_id = $1 and state.canonical_case_id = $2 limit 1`, [tenantId, caseId]));
  const row = one(result);
  const hashes = await readSnapshotHashes(bundle, tenantId, caseId);
  const mode = row.mode === "synthetic_test" ? "synthetic_test" as const : "real" as const;
  return Object.freeze({
    schema_version: INTERNAL_OPS_SCHEMA_VERSION, case_id: caseId, revision: count(row.revision), state: lifecycle(row.state),
    mode, created_at: timestamp(row.created_at), updated_at: timestamp(row.updated_at), snapshot_hashes: hashes,
    invalidation_codes: Object.freeze([]),
    blocker_codes: mode === "real" ? Object.freeze(["LEGAL_SOURCE_CORPUS_INCOMPLETE"]) : Object.freeze([]),
  });
}

async function readTimeline(bundle: DurableBundle, tenantId: string, caseId: string): Promise<TimelineProjection> {
  const result = await bundle.context.client.query(statement("ops_timeline_read", `
    select history.revision::text as sequence, history.event_kind as event_code, history.revision::text,
           history.occurred_at::text, coalesce(event.actor_id, 'tivdoc_system') as actor_id,
           history.event_sha256
    from public.engine_case_lifecycle_revisions history
    join public.engine_case_identity identity on identity.internal_case_id = history.case_id
    left join lateral (select actor_id from public.engine_platform_audit_events audit
      where audit.tenant_id = history.tenant_id and audit.canonical_case_id = identity.canonical_case_id
      order by audit.case_sequence desc limit 1) event on true
    where history.tenant_id = $1 and identity.canonical_case_id = $2
    order by history.revision`, [tenantId, caseId]));
  return Object.freeze({ schema_version: INTERNAL_OPS_SCHEMA_VERSION, case_id: caseId, events: Object.freeze(result.rows.map((row) => Object.freeze({
    sequence: count(row.sequence), event_code: id(row.event_code), revision: count(row.revision), occurred_at: timestamp(row.occurred_at),
    actor_role: "scoped_background_worker" as const, event_sha256: hash(row.event_sha256),
  }))) });
}

async function readPayment(bundle: DurableBundle, tenantId: string, caseId: string): Promise<PaymentProjection> {
  const rows = await bundle.intake.payment_evidence.list(bundle.context, { tenant_id: tenantId, case_id: caseId });
  const latest = rows.at(-1);
  if (!latest) return Object.freeze({ schema_version: INTERNAL_OPS_SCHEMA_VERSION, case_id: caseId, status: "unmatched", evidence_revision: null, evidence_sha256: null, reference_sha256: null, hold: false });
  const status = latest.status === "cancelled" ? "failed" : latest.status;
  return Object.freeze({ schema_version: INTERNAL_OPS_SCHEMA_VERSION, case_id: caseId, status,
    evidence_revision: latest.evidence_revision, evidence_sha256: latest.evidence_sha256,
    reference_sha256: latest.evidence_sha256, hold: status === "refunded" || status === "chargeback" });
}

async function readDocuments(bundle: DurableBundle, tenantId: string, caseId: string): Promise<DocumentProjection> {
  const result = await bundle.context.client.query(statement("ops_documents_read", `
    select canonical_document_id as object_version_id, content_sha256 as object_sha256,
           size::text as byte_length, mime_type as detected_mime,
           case when processing_status = 'failed' then 'quarantined' else 'accepted' end as status
    from public.documents where tenant_id = $1 and canonical_case_id = $2 order by created_at`, [tenantId, caseId]));
  return Object.freeze({ schema_version: INTERNAL_OPS_SCHEMA_VERSION, case_id: caseId, documents: Object.freeze(result.rows.map((row) => Object.freeze({
    object_version_id: id(row.object_version_id), object_sha256: hash(row.object_sha256), byte_length: positive(row.byte_length),
    detected_mime: text(row.detected_mime), status: documentStatus(row.status),
  }))) });
}

async function readExtraction(bundle: DurableBundle, tenantId: string, caseId: string): Promise<ExtractionProjection> {
  const result = await bundle.context.client.query(statement("ops_extraction_read", `
    select canonical_extraction_id as field_id, source_content_sha256 as snapshot_sha256,
           coalesce(payload->>'canonical_path', canonical_extraction_id) as canonical_path,
           case when status = 'completed' then 'candidate' else 'missing' end as status,
           nullif(quality_metrics->>'confidence_micros','')::bigint::text as confidence_micros,
           canonical_document_id as source_document_id
    from public.document_extractions where tenant_id = $1 and canonical_case_id = $2 order by created_at`, [tenantId, caseId]));
  return Object.freeze({
    schema_version: INTERNAL_OPS_SCHEMA_VERSION, case_id: caseId,
    snapshot_sha256: result.rows[0] ? hash(result.rows[0].snapshot_sha256) : null,
    fields: Object.freeze(result.rows.map((row) => Object.freeze({
      field_id: id(row.field_id), canonical_path: id(row.canonical_path), status: extractionStatus(row.status),
      confidence_micros: row.confidence_micros === null ? null : count(row.confidence_micros),
      source_document_id: row.source_document_id === null ? null : id(row.source_document_id),
    }))),
  });
}

async function readFacts(bundle: DurableBundle, tenantId: string, caseId: string): Promise<FactsProjection> {
  const result = await bundle.context.client.query(statement("ops_facts_read", `
    select distinct on (fact_id) fact_id, payload_sha256,
           coalesce(payload->>'canonical_path', fact_id) as canonical_path,
           coalesce(payload->>'status', 'needs_confirmation') as status,
           coalesce((payload->>'provenance_count')::bigint, 1)::text as provenance_count,
           coalesce((payload->>'conflict_count')::bigint, 0)::text as conflict_count
    from public.engine_canonical_fact_versions
    where tenant_id = $1 and canonical_case_id = $2 order by fact_id, revision desc`, [tenantId, caseId]));
  const snapshot = (await readSnapshotHashes(bundle, tenantId, caseId)).facts;
  return Object.freeze({ schema_version: INTERNAL_OPS_SCHEMA_VERSION, case_id: caseId, snapshot_sha256: snapshot,
    facts: Object.freeze(result.rows.map((row) => Object.freeze({ fact_id: id(row.fact_id), canonical_path: id(row.canonical_path),
      status: factStatus(row.status), provenance_count: count(row.provenance_count), conflict_count: count(row.conflict_count) }))) });
}

async function readReadiness(bundle: DurableBundle, tenantId: string, caseId: string): Promise<ReadinessProjection> {
  const result = await bundle.context.client.query(statement("ops_readiness_read", `
    with topics(topic) as (values ('minimum_wage'),('working_time'),('pension'),('travel'),('convalescence'),('vacation'),('sick_leave'))
    select topics.topic, result.status, result.result_sha256,
           coalesce(run.command_payload->>'mode', 'real') as mode
    from topics
    left join lateral (select status, result_sha256, analysis_run_id from public.engine_topic_result_versions item
      where item.tenant_id = $1 and item.canonical_case_id = $2 and item.topic = topics.topic
      order by item.created_at desc limit 1) result on true
    left join public.analysis_runs run on run.id = result.analysis_run_id
    order by topics.topic`, [tenantId, caseId]));
  const topics = Object.freeze(result.rows.map((row) => readinessTopic(row)));
  if (topics.length !== WAVE3_TOPICS.length || WAVE3_TOPICS.some((topic) => !topics.some((item) => item.topic === topic))) {
    throw new InternalOpsError("OPS_COMMAND_REJECTED");
  }
  return Object.freeze({ schema_version: INTERNAL_OPS_SCHEMA_VERSION, case_id: caseId, topics,
    all_topics_ready: topics.every((topic) => topic.status === "READY") });
}

async function readAnalysis(bundle: DurableBundle, tenantId: string, caseId: string): Promise<AnalysisProjection> {
  const result = await bundle.context.client.query(statement("ops_analysis_read", `
    select canonical_analysis_run_id as analysis_run_id, status,
           command_payload->>'mode' as mode, input_snapshot_hash as input_snapshot_sha256,
           completion_payload #>> '{bundle,result_sha256}' as result_sha256,
           completion_payload #>> '{bundle,known_subtotal_minor_units}' as known_subtotal_minor_units,
           coalesce((completion_payload #>> '{bundle,coverage_complete}')::boolean, false) as coverage_complete
    from public.analysis_runs where tenant_id = $1 and canonical_case_id = $2 order by created_at desc`, [tenantId, caseId]));
  return Object.freeze({ schema_version: INTERNAL_OPS_SCHEMA_VERSION, case_id: caseId, runs: Object.freeze(result.rows.map((row) => {
    const real = row.mode !== "synthetic_test";
    return Object.freeze({ analysis_run_id: id(row.analysis_run_id), status: real ? "blocked" as const : analysisStatus(row.status),
      input_snapshot_sha256: hash(row.input_snapshot_sha256), result_sha256: real || row.result_sha256 === null ? null : hash(row.result_sha256),
      known_subtotal_minor_units: real || row.known_subtotal_minor_units === null ? null : text(row.known_subtotal_minor_units),
      coverage_complete: real ? false : boolean(row.coverage_complete),
      blocker_codes: real ? Object.freeze(["LEGAL_SOURCE_CORPUS_INCOMPLETE"]) : Object.freeze([]) });
  })) });
}

async function readReport(bundle: DurableBundle, tenantId: string, caseId: string): Promise<ReportProjection> {
  const exact = await readExactReport(bundle, tenantId, caseId, false);
  if (!exact) return Object.freeze({ schema_version: INTERNAL_OPS_SCHEMA_VERSION, case_id: caseId, report_id: null,
    report_revision: null, report_sha256: null, analysis_result_sha256: null, status: "not_created", coverage_complete: false,
    watermark: "INTERNAL_DRAFT_NOT_FOR_CUSTOMER", exact_hash_approval_receipt_sha256: null,
    manual_export_eligible: false, blocker_codes: Object.freeze(["REPORT_NOT_CREATED"]) });
  return Object.freeze({ schema_version: INTERNAL_OPS_SCHEMA_VERSION, case_id: caseId, report_id: exact.report_id,
    report_revision: exact.report_revision, report_sha256: exact.report_sha256,
    analysis_result_sha256: exact.analysis_result_sha256, status: exact.status, coverage_complete: exact.coverage_complete,
    watermark: "INTERNAL_DRAFT_NOT_FOR_CUSTOMER", exact_hash_approval_receipt_sha256: exact.approval_receipt_sha256,
    manual_export_eligible: exact.status === "approved" && exact.report_revision === exact.case_revision,
    blocker_codes: exact.status === "approved" ? Object.freeze([]) : Object.freeze(["EXACT_REPORT_APPROVAL_REQUIRED"]) });
}

async function readAudit(bundle: DurableBundle, tenantId: string, caseId: string): Promise<AuditProjection> {
  const verified = await bundle.runtime.jobs_outbox_audit.verify();
  const result = await bundle.context.client.query(statement("ops_audit_projection_read", `
    select case_sequence::text as sequence, action, resource_revision::text, resource_sha256,
           event_sha256, occurred_at::text
    from public.engine_platform_audit_events
    where tenant_id = $1 and canonical_case_id = $2 order by case_sequence`, [tenantId, caseId]));
  return Object.freeze({ schema_version: INTERNAL_OPS_SCHEMA_VERSION, case_id: caseId, chain_valid: verified.valid,
    event_count: verified.event_count, tail_sha256: verified.tail_sha256,
    events: Object.freeze(result.rows.map((row) => Object.freeze({ sequence: positive(row.sequence), action: id(row.action),
      resource_revision: count(row.resource_revision), resource_sha256: hash(row.resource_sha256),
      event_sha256: hash(row.event_sha256), occurred_at: timestamp(row.occurred_at) }))) });
}

type ExactReport = Readonly<{
  report_id: string;
  report_revision: number;
  case_revision: number;
  report_sha256: string;
  analysis_result_sha256: string;
  status: ReportProjection["status"];
  coverage_complete: boolean;
  approval_receipt_sha256: string | null;
}>;

function readExactReportForUpdate(bundle: DurableBundle, tenantId: string, caseId: string): Promise<ExactReport | null> {
  return readExactReport(bundle, tenantId, caseId, true);
}

async function readExactReport(bundle: DurableBundle, tenantId: string, caseId: string, lock: boolean): Promise<ExactReport | null> {
  const result = await bundle.context.client.query(statement(lock ? "ops_report_exact_lock" : "ops_report_exact_read", `
    select report.report_id, report.revision::text as report_revision, state.revision::text as case_revision,
           report.report_sha256, report.analysis_result_sha256, report.review_eligible as coverage_complete,
           review.release_state, review.decision_sha256 as approval_receipt_sha256
    from public.engine_report_versions report
    join public.engine_case_state state on state.tenant_id = report.tenant_id and state.case_id = report.case_id
    left join lateral (select release_state, decision_sha256 from public.engine_review_task_versions item
      where item.tenant_id = report.tenant_id and item.case_id = report.case_id
        and item.report_id = report.report_id and item.report_revision = report.revision
        and item.report_sha256 = report.report_sha256
      order by item.revision desc limit 1) review on true
    where report.tenant_id = $1 and state.canonical_case_id = $2
    order by report.revision desc limit 1${lock ? " for update of report" : ""}`, [tenantId, caseId]));
  if (result.row_count === 0) return null;
  const row = one(result);
  const coverageComplete = boolean(row.coverage_complete);
  return Object.freeze({ report_id: id(row.report_id), report_revision: positive(row.report_revision),
    case_revision: positive(row.case_revision), report_sha256: hash(row.report_sha256),
    analysis_result_sha256: hash(row.analysis_result_sha256), status: reportStatus(row.release_state, coverageComplete),
    coverage_complete: coverageComplete,
    approval_receipt_sha256: row.approval_receipt_sha256 === null ? null : hash(row.approval_receipt_sha256) });
}

async function requireCaseState(bundle: DurableBundle, tenantId: string, caseId: string): Promise<Readonly<{
  revision: number;
  state: CaseLifecycleState;
  state_sha256: string;
}>>;
async function requireCaseState(bundle: DurableBundle, tenantId: string, caseId: string, lock: true): Promise<Readonly<{
  revision: number;
  state: CaseLifecycleState;
  state_sha256: string;
}>>;
async function requireCaseState(bundle: DurableBundle, tenantId: string, caseId: string, lock = false): Promise<Readonly<{
  revision: number;
  state: CaseLifecycleState;
  state_sha256: string;
}>> {
  if (lock) {
    const result = await bundle.context.client.query(statement("ops_case_state_lock", `
      select revision::text, lifecycle_state, state_sha256
      from public.engine_case_state
      where tenant_id = $1 and canonical_case_id = $2
      for update`, [tenantId, caseId]));
    const row = one(result);
    return Object.freeze({ revision: count(row.revision), state: lifecycle(row.lifecycle_state), state_sha256: hash(row.state_sha256) });
  }
  const state = await bundle.intake.case_lifecycle.get(bundle.context, { tenant_id: tenantId, case_id: caseId });
  if (!state) throw new InternalOpsError("OPS_NOT_FOUND");
  return Object.freeze({ revision: state.revision, state: state.lifecycle_state, state_sha256: state.state_sha256 });
}

async function readSnapshotHashes(
  bundle: DurableBundle,
  tenantId: string,
  caseId: string,
  lock = false,
): Promise<InternalOpsCaseProjection["snapshot_hashes"]> {
  const result = await bundle.context.client.query(statement(lock ? "ops_snapshot_hashes_lock" : "ops_snapshot_hashes_read", `
    select
      (select encode(digest(string_agg(content_sha256, '' order by canonical_document_id), 'sha256'), 'hex')
         from public.documents where tenant_id = $1 and canonical_case_id = $2) as documents,
      (select source_content_sha256 from public.document_extractions where tenant_id = $1 and canonical_case_id = $2
         order by created_at desc limit 1) as extraction,
      (select encode(digest(string_agg(payload_sha256, '' order by fact_id, revision), 'sha256'), 'hex')
         from public.engine_canonical_fact_versions where tenant_id = $1 and canonical_case_id = $2) as facts,
      (select completion_payload #>> '{bundle,result_sha256}' from public.analysis_runs
         where tenant_id = $1 and canonical_case_id = $2 order by created_at desc limit 1) as analysis,
      (select report_sha256 from public.engine_report_versions report
         join public.engine_case_state state on state.case_id = report.case_id and state.tenant_id = report.tenant_id
         where report.tenant_id = $1 and state.canonical_case_id = $2 order by report.revision desc limit 1) as report
    `, [tenantId, caseId]));
  const row = one(result);
  return Object.freeze({ documents: nullableHash(row.documents), extraction: nullableHash(row.extraction),
    facts: nullableHash(row.facts), analysis: nullableHash(row.analysis), report: nullableHash(row.report) });
}

function readinessTopic(row: Readonly<Record<string, unknown>>) {
  const topic = wave3Topic(row.topic);
  const real = row.mode !== "synthetic_test";
  const rawStatus = row.status;
  const status = real ? "BLOCKED_NOT_READY" as const
    : rawStatus === "calculated" ? "READY" as const
      : rawStatus === "not_applicable" ? "NOT_APPLICABLE" as const : "BLOCKED_NOT_READY" as const;
  return Object.freeze({ topic, status,
    blocker_codes: status === "BLOCKED_NOT_READY"
      ? Object.freeze([real ? "LEGAL_SOURCE_CORPUS_INCOMPLETE" : rawStatus === null ? "TOPIC_RESULT_MISSING" : `TOPIC_${String(rawStatus).toUpperCase()}`])
      : Object.freeze([]),
    decision_sha256: real || row.result_sha256 === null ? null : hash(row.result_sha256),
    decision_source: "evaluateLegalReadiness" as const });
}

function capabilityProjection(actor: VerifiedActor, flags: InternalOpsFlagSnapshot): OpsCapabilityProjection {
  const capabilities = capabilitiesForRole(actor.role).filter((capability) =>
    !capability.startsWith("command.") || SUPPORTED_DURABLE_COMMANDS.has(capability));
  return Object.freeze({ schema_version: INTERNAL_OPS_SCHEMA_VERSION, actor_role: actor.role,
    capabilities: Object.freeze(capabilities), manual_export_enabled: false,
    synthetic_enabled: flags.TIVDOC_SYNTHETIC_OPS_ENABLED, customer_processing_enabled: false,
    customer_shadow_enabled: false, production_delivery_enabled: false });
}

function normalizeCorrelation(value: string): string {
  return CORRELATION.test(value) ? value : `ops:${canonicalSha256(value).slice(0, 48)}`;
}

function requireTenant(actor: VerifiedActor): string {
  if (actor.verified_server_side !== true || actor.tenant_id === null || !ID.test(actor.tenant_id)) {
    throw new InternalOpsError("OPS_FORBIDDEN");
  }
  return actor.tenant_id;
}

function requireCaseId(value: string | null): string {
  if (value === null || !ID.test(value)) throw new InternalOpsError("OPS_INVALID_REQUEST");
  return value;
}

function mapPersistenceError(error: unknown): InternalOpsError {
  if (error instanceof InternalOpsError) return error;
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "CASE_REVISION_CONFLICT" || code === "INTAKE_REVISION_CONFLICT") return new InternalOpsError("OPS_REVISION_CONFLICT");
  if (code === "IDEMPOTENCY_KEY_COMMAND_MISMATCH") return new InternalOpsError("OPS_IDEMPOTENCY_CONFLICT");
  if (code === "RECORD_NOT_FOUND") return new InternalOpsError("OPS_NOT_FOUND");
  return new InternalOpsError("OPS_COMMAND_REJECTED");
}

function one(result: PostgresQueryResult): Readonly<Record<string, unknown>> {
  if (result.row_count !== 1 || result.rows.length !== 1 || !result.rows[0]) throw new InternalOpsError("OPS_NOT_FOUND");
  return result.rows[0];
}

function id(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) throw new InternalOpsError("OPS_COMMAND_REJECTED");
  return value;
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_000) throw new InternalOpsError("OPS_COMMAND_REJECTED");
  return value;
}

function hash(value: unknown): string {
  if (typeof value !== "string" || !HASH.test(value)) throw new InternalOpsError("OPS_COMMAND_REJECTED");
  return value;
}

function nullableHash(value: unknown): string | null {
  return value === null ? null : hash(value);
}

function count(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new InternalOpsError("OPS_COMMAND_REJECTED");
  return parsed;
}

function positive(value: unknown): number {
  const parsed = count(value);
  if (parsed < 1) throw new InternalOpsError("OPS_COMMAND_REJECTED");
  return parsed;
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new InternalOpsError("OPS_COMMAND_REJECTED");
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new InternalOpsError("OPS_COMMAND_REJECTED");
  return new Date(value).toISOString();
}

function lifecycle(value: unknown): CaseLifecycleState {
  if (typeof value !== "string" || !STATES.has(value as CaseLifecycleState)) throw new InternalOpsError("OPS_COMMAND_REJECTED");
  return value as CaseLifecycleState;
}

function documentStatus(value: unknown): "staged" | "accepted" | "quarantined" {
  if (value === "staged" || value === "accepted" || value === "quarantined") return value;
  throw new InternalOpsError("OPS_COMMAND_REJECTED");
}

function extractionStatus(value: unknown): "missing" | "candidate" | "confirmed" | "conflicted" {
  if (value === "missing" || value === "candidate" || value === "confirmed" || value === "conflicted") return value;
  throw new InternalOpsError("OPS_COMMAND_REJECTED");
}

function factStatus(value: unknown): "missing" | "needs_confirmation" | "confirmed" | "conflicted" | "not_applicable" {
  if (value === "missing" || value === "needs_confirmation" || value === "confirmed" || value === "conflicted" || value === "not_applicable") return value;
  throw new InternalOpsError("OPS_COMMAND_REJECTED");
}

function analysisStatus(value: unknown): "requested" | "running" | "blocked" | "complete" | "failed" {
  if (value === "pending") return "requested";
  if (value === "running") return "running";
  if (value === "completed") return "complete";
  if (value === "failed") return "failed";
  return "blocked";
}

function reportStatus(value: unknown, reviewEligible: boolean): ReportProjection["status"] {
  if (value === "approved" || value === "released") return "approved";
  if (value === "review_pending") return "awaiting_approval";
  if (value === "invalidated" || value === "release_hold") return "invalidated";
  if (value === "rejected") return "rejected";
  if (value === null && reviewEligible) return "awaiting_approval";
  return "internal_draft";
}

function wave3Topic(value: unknown): Wave3Topic {
  if (typeof value !== "string" || !WAVE3_TOPICS.includes(value as Wave3Topic)) throw new InternalOpsError("OPS_COMMAND_REJECTED");
  return value as Wave3Topic;
}
