import "../routes/server-boundary.ts";

import { CaseAnalysisService } from "../../../engine/case-analysis/service.ts";
import { buildSyntheticCaseFixture } from "../../../engine/case-analysis/synthetic-fixtures.ts";
import {
  ContentAddressedIdPort,
  FixedClock,
  FixtureLegalRuleCatalog,
  FixtureReportBuilder,
  FixtureRuleSpecExecutor,
  NodeCanonicalHashPort,
} from "../../../engine/case-analysis/fixture-ports.ts";
import { canonicalSha256 } from "../../../engine/rule-runtime/canonical.ts";
import {
  WAVE3_TOPICS,
  type CaseAnalysisCommand,
  type DeterministicReportArtifacts,
  type ReportBuilderPort,
} from "../../../engine/wave3/contracts.ts";
import type { StoredCaseInputSnapshot, StoredCaseSnapshotPort } from "../../../engine/case-analysis/contracts.ts";
import type { CanonicalApplicationPostgresComposition } from "../../platform/composition/canonical-postgres-application.ts";
import { statement, type PostgresQueryResult } from "../../platform/persistence/postgres/contracts.ts";
import { LocalRuntimePrivateBlobProvider } from "../../platform/storage/local-runtime/private-blob-provider.ts";
import { durableProductIdentityFromActor } from "../auth/identity-session.ts";
import {
  DURABLE_RUNTIME_EFFECT_KIND,
  DURABLE_RUNTIME_JOB_KIND,
  createDurableRuntimeProductIdentityContext,
  createDurableRuntimeReportJobEnvelope,
  type DurableRuntimeReportJobEnvelope,
  type DurableRuntimeTimelineBinding,
} from "../durable-postgres/runtime-product-lane.ts";
import {
  PostgresPrivateReportObjectRepository,
} from "../durable-postgres/boundary-repositories.ts";
import { withCanonicalReportGrantRevision } from "../durable-postgres/report-identity.ts";
import { decodeDurableReportArtifacts } from "../durable-postgres/report-artifacts.ts";
import type {
  DurableInternalOpsSyntheticEnvelopeReceipt,
  DurableInternalOpsSyntheticReportPipelinePort,
  DurableInternalOpsTransactionBundle,
} from "../internal-ops/durable-postgres-application.ts";
import {
  FRESH_WORKER_PROTOCOL_SCHEMA_VERSION,
  type FreshWorkerRequest,
} from "../durable-postgres/fresh-worker-protocol.ts";
import type { FreshWorkerChildProcessLauncher } from "../worker-runtime/fresh-child-launcher.ts";

const HASH = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{2,159}$/u;
const ENVELOPE_KEYS = Object.freeze([
  "schema_version", "analysis_mode", "legal_rules_activated", "timeline", "pipeline", "storage",
] as const);
const TIMELINE_KEYS = Object.freeze([
  "correlation_id", "tenant_id", "case_id", "case_revision", "owner_binding_revision",
  "owner_binding_sha256", "actor_id", "session_binding_sha256", "session_revision",
  "analysis_run_id", "report_id", "report_revision", "report_sha256", "pdf_sha256",
] as const);
const PIPELINE_KEYS = Object.freeze([
  "job_id", "outbox_id", "logical_effect_id", "idempotency_key", "logical_effect_sha256",
] as const);
const STORAGE_KEYS = Object.freeze([
  "provider_class", "managed_platform_verified", "staging_object_key", "quarantine_locator", "locator_sha256",
] as const);

export type DurableSyntheticReportPipelineProof = Readonly<{
  schema_version: "tivdoc-durable-synthetic-report-pipeline-v0.10.2";
  ordinary_runtime_reachable: false;
  durable_postgresql: true;
  fresh_process_required: true;
  private_storage: "local_private_immutable_filesystem";
  analysis_mode: "synthetic_seven_topic_only";
  real_legal_activations: 0;
  product_reachable_memory_repositories: 0;
}>;

type PipelineInput = ConstructorParameters<typeof DurableSyntheticReportPipeline>[0];

/**
 * Explicit local-only coordinator for the one synthetic product proof lane.
 * Its authoritative analysis, report, job, outbox, approval and audit state is
 * PostgreSQL-backed; the immutable input fixture is a value object, not a
 * product repository or a fallback.
 */
export class DurableSyntheticReportPipeline implements DurableInternalOpsSyntheticReportPipelinePort {
  readonly #postgres: CanonicalApplicationPostgresComposition;
  readonly #storage: LocalRuntimePrivateBlobProvider;
  readonly #launcher: FreshWorkerChildProcessLauncher;
  readonly #workerIdentity: PipelineInput["worker_identity"];

  constructor(input: Readonly<{
    postgres: CanonicalApplicationPostgresComposition;
    storage: LocalRuntimePrivateBlobProvider;
    worker_launcher: FreshWorkerChildProcessLauncher;
    worker_identity: Readonly<{ actor_id: string; tenant_id: string }>;
  }>) {
    const storageProof = input.storage.proof();
    const launcherProof = input.worker_launcher.proof();
    if (input.postgres.mode !== "isolated_postgres" || input.postgres.durable !== true
        || storageProof.provider_kind !== "local_private_immutable_filesystem"
        || storageProof.managed_platform_verified !== false
        || launcherProof.direct_child_required !== true
        || launcherProof.shell !== false
        || launcherProof.inherited_runtime_configuration !== false
        || !ID.test(input.worker_identity.actor_id)
        || !ID.test(input.worker_identity.tenant_id)) {
      throw new Error("DURABLE_SYNTHETIC_REPORT_PIPELINE_DEPENDENCY_INVALID");
    }
    this.#postgres = input.postgres;
    this.#storage = input.storage;
    this.#launcher = input.worker_launcher;
    this.#workerIdentity = Object.freeze({ ...input.worker_identity });
  }

  proof(): DurableSyntheticReportPipelineProof {
    return Object.freeze({
      schema_version: "tivdoc-durable-synthetic-report-pipeline-v0.10.2",
      ordinary_runtime_reachable: false,
      durable_postgresql: true,
      fresh_process_required: true,
      private_storage: "local_private_immutable_filesystem",
      analysis_mode: "synthetic_seven_topic_only",
      real_legal_activations: 0,
      product_reachable_memory_repositories: 0,
    });
  }

  async enqueue(
    input: Parameters<DurableInternalOpsSyntheticReportPipelinePort["enqueue"]>[0],
  ): Promise<DurableInternalOpsSyntheticEnvelopeReceipt> {
    assertExactSyntheticRequest(input);
    const fixture = exactCaseFixture(input);
    const hashes = new NodeCanonicalHashPort();
    const ids = new ContentAddressedIdPort();
    const service = new CaseAnalysisService({
      clock: new FixedClock(input.occurred_at),
      ids,
      hashes,
      snapshots: new ExactStoredSnapshot(fixture.stored),
      repository: input.transaction.analysis.caseAnalysis,
      legalCatalog: new FixtureLegalRuleCatalog("none"),
      executor: new FixtureRuleSpecExecutor(),
      reportBuilder: new RevisionBoundReportBuilder(input.target_revision, hashes, ids),
      reportRegistration: input.transaction.analysis.reports,
      logs: Object.freeze({ write() { /* Deliberately no payload-bearing process log. */ } }),
      templateVersion: "durable-local-synthetic-v0.10.2",
    });
    const bundle = await service.runCaseAnalysis(fixture.command);
    const completed = await service.getCompletedRun(bundle.analysis_run_id);
    const report = completed?.report;
    if (!completed?.completed || !report || !bundle.coverage_complete
        || bundle.case_id !== input.case_id || bundle.case_revision !== input.target_revision
        || report.report_revision !== input.target_revision
        || report.analysis_result_sha256 !== bundle.result_sha256
        || bundle.topic_results.length !== WAVE3_TOPICS.length
        || bundle.topic_results.some((result) => result.status !== "calculated")) {
      throw new Error("DURABLE_SYNTHETIC_REPORT_INCOMPLETE");
    }

    const owner = await exactOwner(input.transaction, input.tenant_id, input.case_id);
    const identity = durableProductIdentityFromActor(input.actor, "operations");
    const runtime = createDurableRuntimeProductIdentityContext({ postgres: this.#postgres, identity });
    const seed = canonicalSha256({
      schema_version: "tivdoc-durable-synthetic-job-coordinates-v0.10.2",
      tenant_id: input.tenant_id,
      case_id: input.case_id,
      case_revision: input.target_revision,
      correlation_id: input.correlation_id,
      idempotency_key: input.idempotency_key,
      analysis_run_id: bundle.analysis_run_id,
      report_sha256: report.report_sha256,
    });
    const timeline: DurableRuntimeTimelineBinding = Object.freeze({
      correlation_id: input.correlation_id,
      tenant_id: input.tenant_id,
      case_id: input.case_id,
      case_revision: input.target_revision,
      owner_binding_revision: owner.revision,
      owner_binding_sha256: owner.binding_sha256,
      actor_id: input.actor.actor_id,
      session_binding_sha256: runtime.session_binding_sha256,
      session_revision: runtime.session_revision,
      analysis_run_id: bundle.analysis_run_id,
      report_id: report.report_id,
      report_revision: report.report_revision,
      report_sha256: report.report_sha256,
      pdf_sha256: report.pdf_sha256,
    });
    const envelope = createDurableRuntimeReportJobEnvelope({
      timeline,
      pipeline: Object.freeze({
        job_id: `job_${seed.slice(0, 48)}`,
        outbox_id: `outbox_${canonicalSha256({ seed, kind: "outbox" }).slice(0, 48)}`,
        logical_effect_id: `effect_${canonicalSha256({ seed, kind: "effect" }).slice(0, 48)}`,
        idempotency_key: input.idempotency_key,
      }),
    });
    const envelopeSha256 = canonicalSha256(envelope);
    const availableAt = Date.parse(input.occurred_at);
    if (!Number.isSafeInteger(availableAt) || availableAt < 1) {
      throw new Error("DURABLE_SYNTHETIC_REPORT_CLOCK_INVALID");
    }
    const job = await input.transaction.runtime.jobs_outbox_audit.enqueue({
      job_id: envelope.pipeline.job_id,
      tenant_id: input.tenant_id,
      case_id: input.case_id,
      job_kind: DURABLE_RUNTIME_JOB_KIND,
      idempotency_key: input.idempotency_key,
      payload_sha256: envelopeSha256,
      payload: envelope,
      pinned_version_sha256s: Object.freeze([
        timeline.owner_binding_sha256,
        timeline.session_binding_sha256,
        timeline.report_sha256,
        timeline.pdf_sha256,
      ]),
      max_attempts: 3,
      available_at_ms: availableAt,
    });
    if (job.job_id !== envelope.pipeline.job_id || job.payload_sha256 !== envelopeSha256) {
      throw new Error("DURABLE_SYNTHETIC_REPORT_JOB_MISMATCH");
    }
    await input.transaction.runtime.jobs_outbox_audit.enqueueOutbox({
      outbox_id: envelope.pipeline.outbox_id,
      tenant_id: input.tenant_id,
      case_id: input.case_id,
      logical_effect_id: envelope.pipeline.logical_effect_id,
      effect_kind: DURABLE_RUNTIME_EFFECT_KIND,
      payload_sha256: envelopeSha256,
      payload: envelope,
      created_at: input.occurred_at,
    });
    await appendBoundaryTimeline(input.transaction, envelope, input.command_sha256,
      input.input_snapshot_sha256, input.command_id, input.occurred_at);
    await appendTimelineAudit(input.transaction, {
      binding: timeline,
      actor_id: input.actor.actor_id,
      action: "RUNTIME_PRODUCT_JOB_OUTBOX_ENQUEUED",
      suffix: "job-outbox",
      resource_revision: timeline.case_revision,
      resource_sha256: timelineEventSha256(timeline, "job_outbox", {
        payload_sha256: envelopeSha256,
        storage_locator_sha256: envelope.storage.locator_sha256,
      }),
      session_or_process_sha256: timeline.session_binding_sha256,
      occurred_at: input.occurred_at,
    });
    return Object.freeze({
      job_kind: DURABLE_RUNTIME_JOB_KIND,
      job_id: envelope.pipeline.job_id,
      envelope,
      envelope_sha256: envelopeSha256,
    });
  }

  async launchCommitted(
    input: Parameters<DurableInternalOpsSyntheticReportPipelinePort["launchCommitted"]>[0],
  ): ReturnType<DurableInternalOpsSyntheticReportPipelinePort["launchCommitted"]> {
    if (input.tenant_id !== this.#workerIdentity.tenant_id || !ID.test(input.command_id)
        || !ID.test(input.idempotency_key) || !Number.isSafeInteger(input.target_revision)
        || input.target_revision < 1) {
      throw new Error("DURABLE_SYNTHETIC_WORKER_SCOPE_INVALID");
    }
    const identity = durableProductIdentityFromActor(input.actor, "operations");
    const runtime = createDurableRuntimeProductIdentityContext({ postgres: this.#postgres, identity });
    const envelope = await runtime.transaction({
      case_id: input.case_id,
      correlation_id: input.correlation_id,
    }, async (transaction) => readEnvelope(transaction, {
      tenant_id: input.tenant_id,
      case_id: input.case_id,
      correlation_id: input.committed_idempotent_replay ? undefined : input.correlation_id,
      case_revision: input.target_revision,
      idempotency_key: input.idempotency_key,
    }));
    const nowMs = Math.max(Date.now(), 1);
    const request: FreshWorkerRequest = Object.freeze({
      schema_version: FRESH_WORKER_PROTOCOL_SCHEMA_VERSION,
      request_id: `request_${canonicalSha256({ command_id: input.command_id, envelope: canonicalSha256(envelope) }).slice(0, 48)}`,
      parent_process_id: process.pid,
      worker_id: this.#workerIdentity.actor_id,
      tenant_id: input.tenant_id,
      case_id: input.case_id,
      correlation_id: envelope.timeline.correlation_id,
      job_id: envelope.pipeline.job_id,
      now_ms: nowMs,
      lease_ms: 60_000,
      retry_delay_ms: 500,
    });
    const response = await this.#launcher.launch({ request });
    if (response.result.state !== "SUCCEEDED" && response.result.state !== "IDEMPOTENT_REPLAY") {
      throw new Error("DURABLE_SYNTHETIC_WORKER_DID_NOT_COMMIT");
    }
    return Object.freeze({
      job_kind: DURABLE_RUNTIME_JOB_KIND,
      job_id: envelope.pipeline.job_id,
      envelope,
      envelope_sha256: canonicalSha256(envelope),
      fresh_process_verified: true,
      worker_state: response.result.state,
      report_sha256: response.result.report_sha256,
      artifact_sha256: response.result.artifact_sha256,
      logical_effect_sha256: response.result.logical_effect_sha256,
      storage_locator_sha256: response.result.storage_locator_sha256,
      worker_process_sha256: response.result.worker_process_sha256,
      audit_event_sha256: response.result.audit_event_sha256,
    });
  }

  async finalizeApproved(
    input: Parameters<DurableInternalOpsSyntheticReportPipelinePort["finalizeApproved"]>[0],
  ): ReturnType<DurableInternalOpsSyntheticReportPipelinePort["finalizeApproved"]> {
    const envelope = await readEnvelope(input.transaction, {
      tenant_id: input.tenant_id,
      case_id: input.case_id,
      report_id: input.report_id,
      report_revision: input.report_revision,
      report_sha256: input.report_sha256,
    });
    if (envelope.timeline.case_revision !== input.case_revision
        || envelope.timeline.report_id !== input.report_id
        || envelope.timeline.report_revision !== input.report_revision
        || envelope.timeline.report_sha256 !== input.report_sha256) {
      throw new Error("DURABLE_SYNTHETIC_APPROVAL_ENVELOPE_MISMATCH");
    }
    const identity = durableProductIdentityFromActor(input.actor, "operations");
    const runtime = createDurableRuntimeProductIdentityContext({ postgres: this.#postgres, identity });
    const repository = new PostgresPrivateReportObjectRepository(input.transaction.context.client);
    const report = await exactReportBytes(input.transaction, envelope);
    if (report.analysis_result_sha256 !== input.analysis_result_sha256) {
      throw new Error("DURABLE_SYNTHETIC_APPROVAL_ANALYSIS_MISMATCH");
    }
    const stagingIdentity = await repository.currentCanonicalIdentity({
      tenant_id: input.tenant_id,
      case_id: input.case_id,
      report_id: input.report_id,
      report_revision: input.report_revision,
      download_grant_revision: 0,
    });
    if (!stagingIdentity
        || stagingIdentity.approval_task_id !== input.command_id
        || stagingIdentity.approval_revision !== input.approval_revision
        || stagingIdentity.approval_decision_sha256 !== input.approval_decision_sha256) {
      throw new Error("DURABLE_SYNTHETIC_APPROVAL_IDENTITY_MISMATCH");
    }
    const grantedIdentity = withCanonicalReportGrantRevision(stagingIdentity, 1);
    const existing = await repository.approvedRead(reportReadInput(grantedIdentity));
    let activeLocator: string;
    let idempotentReplay = existing !== null;
    if (existing) {
      await this.#storage.readExact({
        locator: existing.provider_locator,
        expected_sha256: existing.artifact_sha256,
        expected_length: existing.byte_length,
      });
      activeLocator = existing.provider_locator;
    } else {
      await this.#storage.readExact({
        locator: envelope.storage.quarantine_locator,
        expected_sha256: envelope.timeline.pdf_sha256,
        expected_length: report.pdf.byteLength,
      });
      const promoted = await this.#storage.promoteQuarantined({
        quarantine_locator: envelope.storage.quarantine_locator,
        object_key: stagingIdentity.storage_object_version_id,
        expected_sha256: envelope.timeline.pdf_sha256,
        expected_length: report.pdf.byteLength,
      });
      activeLocator = promoted.active_locator;
      await repository.bind({
        tenant_id: input.tenant_id,
        case_id: input.case_id,
        report_id: input.report_id,
        report_revision: input.report_revision,
        report_sha256: input.report_sha256,
        object_version_id: stagingIdentity.storage_object_version_id,
        provider_locator: activeLocator,
        byte_length: report.pdf.byteLength,
        artifact_sha256: envelope.timeline.pdf_sha256,
        created_at: input.occurred_at,
        canonical_identity: stagingIdentity,
      });
      await repository.approve({
        tenant_id: input.tenant_id,
        case_id: input.case_id,
        object_version_id: stagingIdentity.storage_object_version_id,
        expected_grant_epoch: 0,
        canonical_identity: stagingIdentity,
      });
      if (!await repository.approvedRead(reportReadInput(grantedIdentity))) {
        throw new Error("DURABLE_SYNTHETIC_APPROVAL_BIND_FAILED");
      }
      idempotentReplay = false;
    }
    const storageLocatorSha256 = canonicalSha256({ locator: activeLocator });
    const auditSha256 = timelineEventSha256(envelope.timeline, "exact_approval", {
      canonical_identity_sha256: grantedIdentity.identity_sha256,
      storage_locator_sha256: storageLocatorSha256,
    }, {
      actor_id: input.actor.actor_id,
      session_or_process_sha256: runtime.session_binding_sha256,
      session_revision: runtime.session_revision,
    });
    const audit = await appendTimelineAudit(input.transaction, {
      binding: envelope.timeline,
      actor_id: input.actor.actor_id,
      action: "RUNTIME_PRODUCT_EXACT_REPORT_GRANTED",
      suffix: "approval",
      resource_revision: grantedIdentity.approval_revision,
      resource_sha256: auditSha256,
      session_or_process_sha256: runtime.session_binding_sha256,
      occurred_at: input.occurred_at,
    });
    return Object.freeze({
      envelope,
      envelope_sha256: canonicalSha256(envelope),
      analysis_result_sha256: input.analysis_result_sha256,
      canonical_identity: grantedIdentity,
      storage_locator_sha256: storageLocatorSha256,
      audit_event_sha256: audit.event_sha256,
      idempotent_replay: idempotentReplay || audit.idempotent_replay,
    });
  }
}

export function createDurableSyntheticReportPipeline(
  input: PipelineInput,
): DurableSyntheticReportPipeline {
  return new DurableSyntheticReportPipeline(input);
}

class ExactStoredSnapshot implements StoredCaseSnapshotPort {
  readonly #snapshot: StoredCaseInputSnapshot;

  constructor(snapshot: StoredCaseInputSnapshot) {
    this.#snapshot = snapshot;
  }

  async loadPinned(command: CaseAnalysisCommand): Promise<StoredCaseInputSnapshot> {
    if (command.document_snapshot_id !== this.#snapshot.document_snapshot_id
        || command.extraction_snapshot_id !== this.#snapshot.extraction_snapshot_id
        || command.declared_fact_snapshot_id !== this.#snapshot.declared_fact_snapshot.snapshot_id) {
      throw new Error("DURABLE_SYNTHETIC_PINNED_INPUT_MISMATCH");
    }
    return this.#snapshot;
  }
}

class RevisionBoundReportBuilder implements ReportBuilderPort {
  readonly #revision: number;
  readonly #delegate: FixtureReportBuilder;

  constructor(revision: number, hashes: NodeCanonicalHashPort, ids: ContentAddressedIdPort) {
    this.#revision = revision;
    this.#delegate = new FixtureReportBuilder(hashes, ids);
  }

  async build(bundle: Parameters<ReportBuilderPort["build"]>[0]): Promise<DeterministicReportArtifacts> {
    const report = await this.#delegate.build(bundle);
    return Object.freeze({
      ...report,
      report_revision: this.#revision,
      report_sha256: canonicalSha256({
        report_id: report.report_id,
        report_revision: this.#revision,
        analysis_result_sha256: report.analysis_result_sha256,
        json_sha256: report.json_sha256,
        html_sha256: report.html_sha256,
        pdf_sha256: report.pdf_sha256,
        manifest_sha256: report.manifest_sha256,
      }),
    });
  }
}

function exactCaseFixture(
  input: Parameters<DurableInternalOpsSyntheticReportPipelinePort["enqueue"]>[0],
): Readonly<{ command: CaseAnalysisCommand; stored: StoredCaseInputSnapshot }> {
  const seed = canonicalSha256({
    case_id: input.case_id,
    target_revision: input.target_revision,
    input_snapshot_sha256: input.input_snapshot_sha256,
    idempotency_key: input.idempotency_key,
  });
  const fixture = buildSyntheticCaseFixture({
    fixture_id: `durable-${seed.slice(0, 32)}`,
    mode: "synthetic_test",
    idempotency_key: `analysis:${seed.slice(0, 48)}`,
  });
  const documents = Object.freeze(fixture.stored.documents.map((document) => Object.freeze({
    ...document,
    case_id: input.case_id,
  })));
  const declaredFacts = Object.freeze(fixture.stored.declared_fact_snapshot.facts.map((fact) => Object.freeze({
    ...fact,
    case_id: input.case_id,
  })));
  const documentSha256 = canonicalSha256(documents);
  const extractionSha256 = canonicalSha256(fixture.stored.extractions);
  const declaredSha256 = canonicalSha256(declaredFacts);
  const stored: StoredCaseInputSnapshot = Object.freeze({
    document_snapshot_id: fixture.stored.document_snapshot_id,
    document_snapshot_sha256: documentSha256,
    documents,
    extraction_snapshot_id: fixture.stored.extraction_snapshot_id,
    extraction_snapshot_sha256: extractionSha256,
    extractions: fixture.stored.extractions,
    declared_fact_snapshot: Object.freeze({
      snapshot_id: fixture.stored.declared_fact_snapshot.snapshot_id,
      snapshot_sha256: declaredSha256,
      facts: declaredFacts,
    }),
  });
  const command: CaseAnalysisCommand = Object.freeze({
    ...fixture.command,
    case_id: input.case_id,
    case_revision: input.target_revision,
    document_snapshot_sha256: documentSha256,
    extraction_snapshot_sha256: extractionSha256,
    declared_fact_snapshot_sha256: declaredSha256,
    requested_topics: WAVE3_TOPICS,
  });
  return Object.freeze({ command, stored });
}

function assertExactSyntheticRequest(
  input: Parameters<DurableInternalOpsSyntheticReportPipelinePort["enqueue"]>[0],
): void {
  if (input.actor.verified_server_side !== true || input.actor.tenant_id !== input.tenant_id
      || input.actor.actor_id.length < 3 || !input.actor.assigned_case_ids.includes(input.case_id)
      || input.target_revision < 1 || !Number.isSafeInteger(input.target_revision)
      || input.requested_topics.length !== WAVE3_TOPICS.length
      || input.requested_topics.some((topic, index) => topic !== WAVE3_TOPICS[index])
      || !HASH.test(input.command_sha256) || !HASH.test(input.input_snapshot_sha256)
      || Number.isNaN(Date.parse(input.occurred_at))) {
    throw new Error("DURABLE_SYNTHETIC_REPORT_REQUEST_INVALID");
  }
}

async function exactOwner(
  transaction: DurableInternalOpsTransactionBundle,
  tenantId: string,
  caseId: string,
): Promise<Readonly<{ revision: number; binding_sha256: string }>> {
  const result = await transaction.context.client.query(statement("durable_synthetic_owner_binding", `
    select revision::text, binding_sha256
    from public.product_case_owners
    where tenant_id = $1 and canonical_case_id = $2
      and status = 'active' and revoked_at is null
    order by revision desc limit 1`, [tenantId, caseId]));
  const row = one(result, "DURABLE_SYNTHETIC_OWNER_REQUIRED");
  return Object.freeze({ revision: positive(row.revision), binding_sha256: hash(row.binding_sha256) });
}

type EnvelopeSelector = Readonly<{
  tenant_id: string;
  case_id: string;
  correlation_id?: string;
  case_revision?: number;
  idempotency_key?: string;
  report_id?: string;
  report_revision?: number;
  report_sha256?: string;
}>;

async function readEnvelope(
  transaction: Pick<DurableInternalOpsTransactionBundle, "context">,
  selector: EnvelopeSelector,
): Promise<DurableRuntimeReportJobEnvelope> {
  const result = await transaction.context.client.query(statement("durable_synthetic_envelope_read", `
    select payload, payload_sha256, state, terminal_effect_sha256
    from public.engine_durable_jobs
    where tenant_id = $1 and canonical_case_id = $2 and job_kind = $3
      and ($4::text is null or payload -> 'timeline' ->> 'correlation_id' = $4)
      and ($5::bigint is null or (payload -> 'timeline' ->> 'case_revision')::bigint = $5)
      and ($6::text is null or idempotency_key = $6)
      and ($7::text is null or payload -> 'timeline' ->> 'report_id' = $7)
      and ($8::bigint is null or (payload -> 'timeline' ->> 'report_revision')::bigint = $8)
      and ($9::text is null or payload -> 'timeline' ->> 'report_sha256' = $9)
    order by created_at desc limit 1`, [
      selector.tenant_id, selector.case_id, DURABLE_RUNTIME_JOB_KIND,
      selector.correlation_id ?? null, selector.case_revision ?? null,
      selector.idempotency_key ?? null, selector.report_id ?? null,
      selector.report_revision ?? null, selector.report_sha256 ?? null,
    ]));
  const row = one(result, "DURABLE_SYNTHETIC_ENVELOPE_NOT_FOUND");
  const envelope = decodeEnvelope(row.payload);
  if (canonicalSha256(envelope) !== hash(row.payload_sha256)) {
    throw new Error("DURABLE_SYNTHETIC_ENVELOPE_HASH_MISMATCH");
  }
  if (selector.report_id !== undefined
      && (row.state !== "succeeded" || row.terminal_effect_sha256 !== envelope.pipeline.logical_effect_sha256)) {
    throw new Error("DURABLE_SYNTHETIC_WORKER_NOT_COMMITTED");
  }
  return envelope;
}

function decodeEnvelope(value: unknown): DurableRuntimeReportJobEnvelope {
  const root = record(value);
  exactKeys(root, ENVELOPE_KEYS);
  const timelineValue = record(root.timeline);
  const pipelineValue = record(root.pipeline);
  const storageValue = record(root.storage);
  exactKeys(timelineValue, TIMELINE_KEYS);
  exactKeys(pipelineValue, PIPELINE_KEYS);
  exactKeys(storageValue, STORAGE_KEYS);
  const timeline: DurableRuntimeTimelineBinding = Object.freeze({
    correlation_id: id(timelineValue.correlation_id),
    tenant_id: id(timelineValue.tenant_id),
    case_id: id(timelineValue.case_id),
    case_revision: positive(timelineValue.case_revision),
    owner_binding_revision: positive(timelineValue.owner_binding_revision),
    owner_binding_sha256: hash(timelineValue.owner_binding_sha256),
    actor_id: id(timelineValue.actor_id),
    session_binding_sha256: hash(timelineValue.session_binding_sha256),
    session_revision: counter(timelineValue.session_revision),
    analysis_run_id: id(timelineValue.analysis_run_id),
    report_id: id(timelineValue.report_id),
    report_revision: positive(timelineValue.report_revision),
    report_sha256: hash(timelineValue.report_sha256),
    pdf_sha256: hash(timelineValue.pdf_sha256),
  });
  const rebuilt = createDurableRuntimeReportJobEnvelope({
    timeline,
    pipeline: Object.freeze({
      job_id: id(pipelineValue.job_id),
      outbox_id: id(pipelineValue.outbox_id),
      logical_effect_id: id(pipelineValue.logical_effect_id),
      idempotency_key: id(pipelineValue.idempotency_key),
    }),
  });
  if (root.schema_version !== rebuilt.schema_version
      || root.analysis_mode !== rebuilt.analysis_mode
      || root.legal_rules_activated !== 0
      || storageValue.provider_class !== rebuilt.storage.provider_class
      || storageValue.managed_platform_verified !== false
      || canonicalSha256(root) !== canonicalSha256(rebuilt)) {
    throw new Error("DURABLE_SYNTHETIC_ENVELOPE_INVALID");
  }
  return rebuilt;
}

async function exactReportBytes(
  transaction: DurableInternalOpsTransactionBundle,
  envelope: DurableRuntimeReportJobEnvelope,
): Promise<DeterministicReportArtifacts> {
  const result = await transaction.context.client.query(statement("durable_synthetic_report_bytes", `
    select artifacts_payload
    from public.engine_report_versions
    where tenant_id = $1 and canonical_case_id = $2 and report_id = $3
      and revision = $4 and report_sha256 = $5 and pdf_sha256 = $6
    limit 1`, [
      envelope.timeline.tenant_id, envelope.timeline.case_id, envelope.timeline.report_id,
      envelope.timeline.report_revision, envelope.timeline.report_sha256, envelope.timeline.pdf_sha256,
    ]));
  const report = decodeDurableReportArtifacts(
    one(result, "DURABLE_SYNTHETIC_REPORT_NOT_FOUND").artifacts_payload,
  );
  if (report.report_sha256 !== envelope.timeline.report_sha256
      || report.pdf_sha256 !== envelope.timeline.pdf_sha256) {
    throw new Error("DURABLE_SYNTHETIC_REPORT_BYTES_MISMATCH");
  }
  return report;
}

async function appendBoundaryTimeline(
  transaction: DurableInternalOpsTransactionBundle,
  envelope: DurableRuntimeReportJobEnvelope,
  commandSha256: string,
  inputSnapshotSha256: string,
  commandId: string,
  occurredAt: string,
): Promise<void> {
  const relevant = Object.freeze({
    ui: Object.freeze({ command_id: commandId, command_sha256: commandSha256 }),
    http: Object.freeze({ command_sha256: commandSha256, input_snapshot_sha256: inputSnapshotSha256 }),
    identity_session: Object.freeze({ session_revision: envelope.timeline.session_revision }),
    canonical_root: Object.freeze({ analysis_run_id: envelope.timeline.analysis_run_id }),
    postgres_transaction: Object.freeze({ report_sha256: envelope.timeline.report_sha256 }),
  });
  for (const kind of ["ui", "http", "identity_session", "canonical_root", "postgres_transaction"] as const) {
    await appendTimelineAudit(transaction, {
      binding: envelope.timeline,
      actor_id: envelope.timeline.actor_id,
      action: kind === "ui" ? "RUNTIME_PRODUCT_BOUNDARY_UI"
        : kind === "http" ? "RUNTIME_PRODUCT_BOUNDARY_HTTP"
          : kind === "identity_session" ? "RUNTIME_PRODUCT_BOUNDARY_IDENTITY_SESSION"
            : kind === "canonical_root" ? "RUNTIME_PRODUCT_BOUNDARY_CANONICAL_ROOT"
              : "RUNTIME_PRODUCT_BOUNDARY_POSTGRES_TRANSACTION",
      suffix: `boundary-${kind}`,
      resource_revision: kind === "identity_session"
        ? envelope.timeline.session_revision + 1
        : envelope.timeline.case_revision,
      resource_sha256: timelineEventSha256(envelope.timeline, kind, relevant[kind]),
      session_or_process_sha256: envelope.timeline.session_binding_sha256,
      occurred_at: occurredAt,
    });
  }
}

async function appendTimelineAudit(
  transaction: DurableInternalOpsTransactionBundle,
  input: Readonly<{
    binding: DurableRuntimeTimelineBinding;
    actor_id: string;
    action: string;
    suffix: string;
    resource_revision: number;
    resource_sha256: string;
    session_or_process_sha256: string;
    occurred_at: string;
  }>,
): Promise<Readonly<{ event_sha256: string; idempotent_replay: boolean }>> {
  const resourceId = `${input.binding.correlation_id}:${input.suffix}`;
  const existing = await transaction.context.client.query(statement("durable_synthetic_audit_exact", `
    select event_sha256
    from public.engine_platform_audit_events
    where tenant_id = $1 and canonical_case_id = $2 and actor_id = $3
      and action = $4 and resource_id = $5 and resource_revision = $6
      and resource_sha256 = $7
    limit 1`, [
      input.binding.tenant_id, input.binding.case_id, input.actor_id, input.action,
      resourceId, input.resource_revision, input.resource_sha256,
    ]));
  if (existing.row_count === 1 && existing.rows[0]) {
    return Object.freeze({ event_sha256: hash(existing.rows[0].event_sha256), idempotent_replay: true });
  }
  if (existing.row_count !== 0 || existing.rows.length !== 0) {
    throw new Error("DURABLE_SYNTHETIC_AUDIT_MISMATCH");
  }
  const appended = await transaction.runtime.jobs_outbox_audit.append({
    actor_id: input.actor_id,
    action: input.action,
    resource_id: resourceId,
    resource_revision: input.resource_revision,
    resource_sha256: input.resource_sha256,
    reason: `TIVDOC_TIMELINE:${input.session_or_process_sha256}`,
    occurred_at: input.occurred_at,
  });
  return Object.freeze({ event_sha256: appended.event_sha256, idempotent_replay: false });
}

function timelineEventSha256(
  binding: DurableRuntimeTimelineBinding,
  eventKind: string,
  relevant: Readonly<Record<string, unknown>>,
  eventBinding: Readonly<{
    actor_id: string;
    session_or_process_sha256: string;
    session_revision: number;
  }> = Object.freeze({
    actor_id: binding.actor_id,
    session_or_process_sha256: binding.session_binding_sha256,
    session_revision: binding.session_revision,
  }),
): string {
  return canonicalSha256({
    schema_version: "tivdoc-runtime-timeline-event-v0.10.2",
    event_kind: eventKind,
    correlation_id: binding.correlation_id,
    tenant_id: binding.tenant_id,
    case_id: binding.case_id,
    case_revision: binding.case_revision,
    owner_binding_revision: binding.owner_binding_revision,
    owner_binding_sha256: binding.owner_binding_sha256,
    actor_id: eventBinding.actor_id,
    session_or_process_sha256: eventBinding.session_or_process_sha256,
    session_revision: eventBinding.session_revision,
    report_sha256: binding.report_sha256,
    pdf_sha256: binding.pdf_sha256,
    relevant,
  });
}

function reportReadInput(identity: ReturnType<typeof withCanonicalReportGrantRevision>) {
  return Object.freeze({
    tenant_id: identity.tenant_id,
    case_id: identity.case_id,
    report_id: identity.report_id,
    report_revision: identity.report_revision,
    report_sha256: identity.report_sha256,
    artifact_sha256: identity.pdf_sha256,
    canonical_identity: identity,
  });
}

function one(result: PostgresQueryResult, code: string): Readonly<Record<string, unknown>> {
  if (result.row_count !== 1 || result.rows.length !== 1 || !result.rows[0]) throw new Error(code);
  return result.rows[0];
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("DURABLE_SYNTHETIC_VALUE_INVALID");
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error("DURABLE_SYNTHETIC_VALUE_INVALID");
  }
}

function id(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) throw new Error("DURABLE_SYNTHETIC_VALUE_INVALID");
  return value;
}

function hash(value: unknown): string {
  if (typeof value !== "string" || !HASH.test(value)) throw new Error("DURABLE_SYNTHETIC_VALUE_INVALID");
  return value;
}

function positive(value: unknown): number {
  const parsed = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("DURABLE_SYNTHETIC_VALUE_INVALID");
  }
  return parsed;
}

function counter(value: unknown): number {
  const parsed = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("DURABLE_SYNTHETIC_VALUE_INVALID");
  }
  return parsed;
}
