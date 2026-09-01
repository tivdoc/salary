import { randomBytes } from "node:crypto";

import { canonicalSha256 } from "../../../src/engine/rule-runtime/canonical.ts";
import type { AtomicCommand, TransactionReceipt } from "../../../src/server/platform/persistence/contracts.ts";
import {
  CANONICAL_POSTGRES_CAPABILITY_BINDINGS,
  startCanonicalApplicationPostgres,
  type CanonicalApplicationPostgresComposition,
} from "../../../src/server/platform/composition/canonical-postgres-application.ts";
import type { CanonicalVerifiedRuntimeIdentity } from "../../../src/server/platform/composition/canonical-postgres.ts";
import { statement } from "../../../src/server/platform/persistence/postgres/contracts.ts";
import {
  NodePostgresConnectionFactory,
  type NodePostgresDriverMetrics,
} from "../../../src/server/platform/persistence/postgres/runtime/node-pg-driver.ts";
import {
  createSyntheticCapabilityFixtures,
  type SyntheticCapabilityFixtures,
} from "./synthetic-fixtures.mts";

type Application = Extract<CanonicalApplicationPostgresComposition, { mode: "isolated_postgres" }>;
type CapabilityTransactionBundle = Parameters<Parameters<Application["transaction"]>[2]>[0];
type Capability = (typeof CANONICAL_POSTGRES_CAPABILITY_BINDINGS)[number]["capability"];

export type CapabilityMatrixRow = Readonly<{
  capability: Capability;
  binding: (typeof CANONICAL_POSTGRES_CAPABILITY_BINDINGS)[number]["binding"];
  status: "PASS";
  persisted_rows: number;
  evidence_sha256: string;
  proof_class: "REAL_NODE_POSTGRES_PARAMETERIZED_SQL";
  forbidden_rows?: 0;
}>;

export type DurableCapabilityState = Readonly<{
  schema_version: "tivdoc-canonical-persistence-v091-durable-state-v1";
  fixture_suffix: string;
  tenant_id: string;
  case_id: string;
  case_revision: 7;
  analysis_run_id: string;
  report_id: string;
  report_sha256: string;
  review_task_id: string;
  job_id: string;
  outbox_id: string;
  idempotency_key: string;
  audit_tail_sha256: string;
  capability_matrix_sha256: string;
  durable_state_sha256: string;
}>;

export type DurableAdapterReplayReceipt = Readonly<{
  schema_version: "tivdoc-canonical-persistence-v091-adapter-replay-v1";
  case_state_reloaded: true;
  completed_analysis_reloaded: true;
  approval_reloaded: true;
  idempotency_replayed: true;
  audit_chain_verified: true;
  terminal_job_not_reclaimed: true;
  published_outbox_not_reclaimed: true;
  durable_effects_unchanged: true;
  status: "PASS";
}>;

export type CapabilityMatrixReceipt = Readonly<{
  schema_version: "tivdoc-canonical-persistence-v091-capability-matrix-v1";
  proof_class: "REAL_NODE_POSTGRES_EXECUTION";
  target_id: string;
  matrix: readonly CapabilityMatrixRow[];
  durable_state: DurableCapabilityState;
  idempotency_replay_verified: true;
  report_export_eligibility_verified: true;
  findings_persisted: 0;
  customer_documents_used: 0;
  real_legal_activations: 0;
  worker_runtime_principal: "tivdoc_worker_runtime";
  worker_runtime_verified_session: true;
  worker_runtime_service_role_calls: 0;
  broad_application_scope: "LEGACY_CANONICAL_V091_MIGRATION_COMPATIBILITY";
  driver_metrics: NodePostgresDriverMetrics;
}>;

type CapabilityMatrixBaseInput = Readonly<{
  build_identity_sha: string;
  fixture_suffix?: string;
  connection_url?: string;
  connection_factory?: NodePostgresConnectionFactory;
  close_injected_factory?: boolean;
}>;

type CapabilityWorkerRuntimeInput =
  | Readonly<{
      worker_runtime_connection_url: string;
      worker_runtime_connection_factory?: never;
      worker_runtime_principal?: "tivdoc_worker_runtime";
    }>
  | Readonly<{
      worker_runtime_connection_url?: never;
      worker_runtime_connection_factory: NodePostgresConnectionFactory;
      worker_runtime_principal: "tivdoc_worker_runtime";
    }>;

export type CapabilityMatrixInput = CapabilityMatrixBaseInput & CapabilityWorkerRuntimeInput;

type CapabilityResources = Readonly<{
  application_factory: NodePostgresConnectionFactory;
  worker_factory: NodePostgresConnectionFactory;
  close(): Promise<void>;
  metrics(): NodePostgresDriverMetrics;
}>;

type Probe = Readonly<{
  capability: Capability;
  binding: CapabilityMatrixRow["binding"];
  statement_name: string;
  evidence_sql: string;
  minimum_rows: number;
  maximum_rows: number;
  findings_guard?: true;
}>;

const PROBES: readonly Probe[] = Object.freeze([
  probe(0, "matrix_cap_01_cases", 8, 8, `
    select 'state:' || ecs.revision::text || ':' || ecs.lifecycle_state || ':' || ecs.state_sha256 as token
      from public.engine_case_state ecs, scope s
     where ecs.tenant_id = s.tenant_id and ecs.canonical_case_id = s.case_id
    union all
    select 'lifecycle:' || l.revision::text || ':' || l.event_sha256
      from public.engine_case_lifecycle_revisions l
      join public.engine_case_state ecs on ecs.case_id = l.case_id and ecs.tenant_id = l.tenant_id
      cross join scope s
     where l.tenant_id = s.tenant_id and ecs.canonical_case_id = s.case_id`),
  probe(1, "matrix_cap_02_payment", 1, 1, `
    select 'payment:' || p.evidence_id || ':' || p.evidence_revision || ':' || p.status || ':' || p.evidence_sha256 as token
      from public.engine_payment_evidence_refs p
      join public.engine_case_state ecs on ecs.case_id = p.case_id and ecs.tenant_id = p.tenant_id
      cross join scope s
     where p.tenant_id = s.tenant_id and ecs.canonical_case_id = s.case_id`),
  probe(2, "matrix_cap_03_conversation", 2, 2, `
    select 'conversation:' || c.canonical_conversation_id || ':' || c.status || ':' || c.idempotency_key as token
      from public.case_conversations c, scope s
     where c.tenant_id = s.tenant_id and c.canonical_case_id = s.case_id
    union all
    select 'message:' || m.canonical_message_id || ':' || m.idempotency_key
      from public.case_messages m, scope s
     where m.tenant_id = s.tenant_id and m.canonical_case_id = s.case_id`),
  probe(3, "matrix_cap_04_documents", 2, 2, `
    select 'document:' || d.canonical_document_id || ':' || d.content_sha256 as token
      from public.documents d, scope s
     where d.tenant_id = s.tenant_id and d.canonical_case_id = s.case_id
    union all
    select 'artifact:' || o.reservation_id || ':' || o.state || ':' || o.expected_sha256
      from public.engine_object_write_sagas o
      join public.engine_case_state ecs on ecs.case_id = o.case_id and ecs.tenant_id = o.tenant_id
      cross join scope s
     where o.tenant_id = s.tenant_id and ecs.canonical_case_id = s.case_id`),
  probe(4, "matrix_cap_05_extractions", 1, 1, `
    select 'extraction:' || e.canonical_extraction_id || ':' || e.status || ':' || e.source_content_sha256 as token
      from public.document_extractions e, scope s
     where e.tenant_id = s.tenant_id and e.canonical_case_id = s.case_id`),
  probe(5, "matrix_cap_06_facts", 1, 1, `
    select 'fact:' || f.fact_id || ':' || f.revision::text || ':' || f.payload_sha256 as token
      from public.engine_canonical_fact_versions f, scope s
     where f.tenant_id = s.tenant_id and f.canonical_case_id = s.case_id`),
  probe(6, "matrix_cap_07_investigation", 2, 2, `
    select 'hypothesis:' || h.canonical_hypothesis_id || ':' || h.status || ':' || h.idempotency_key as token
      from public.analysis_hypotheses h, scope s
     where h.tenant_id = s.tenant_id and h.canonical_case_id = s.case_id
    union all
    select 'rule-input:' || r.rule_input_id || ':' || r.revision::text || ':' || r.payload_sha256
      from public.engine_rule_input_versions r, scope s
     where r.tenant_id = s.tenant_id and r.canonical_case_id = s.case_id`),
  probe(7, "matrix_cap_08_pins", 6, 6, `
    select 'pin:' || p.pin_kind || ':' || p.version_id || ':' || p.version_sha256 as token
      from public.engine_legal_version_pins p
      join public.analysis_runs ar on ar.id = p.analysis_run_id
      cross join scope s
     where p.tenant_id = s.tenant_id and ar.canonical_analysis_run_id = s.run_id`),
  probe(8, "matrix_cap_09_analysis", 2, 2, `
    select 'run:' || ar.canonical_analysis_run_id || ':' || ar.status || ':' || ar.command_sha256 as token
      from public.analysis_runs ar, scope s
     where ar.tenant_id = s.tenant_id and ar.canonical_case_id = s.case_id and ar.canonical_analysis_run_id = s.run_id
    union all
    select 'stage:' || st.stage || ':' || st.payload_sha256
      from public.engine_analysis_stage_versions st
      join public.analysis_runs ar on ar.id = st.analysis_run_id
      cross join scope s
     where st.tenant_id = s.tenant_id and ar.canonical_analysis_run_id = s.run_id`),
  probe(9, "matrix_cap_10_topics", 7, 7, `
    select 'topic:' || t.topic || ':' || t.result_sha256 as token
      from public.engine_topic_result_versions t
      join public.analysis_runs ar on ar.id = t.analysis_run_id
      cross join scope s
     where t.tenant_id = s.tenant_id and ar.canonical_analysis_run_id = s.run_id`),
  probe(10, "matrix_cap_11_traces", 2, 2, `
    select 'trace:' || t.trace_id || ':' || t.trace_sha256 as token
      from public.engine_calculation_trace_versions t
      join public.analysis_runs ar on ar.id = t.analysis_run_id
      cross join scope s
     where t.tenant_id = s.tenant_id and ar.canonical_analysis_run_id = s.run_id
    union all
    select 'confirmation:' || c.canonical_confirmation_id || ':' || c.status
      from public.case_confirmations c, scope s
     where c.tenant_id = s.tenant_id and c.canonical_case_id = s.case_id
       and c.canonical_analysis_run_id = s.run_id`, true),
  probe(11, "matrix_cap_12_reports", 2, 2, `
    select 'report:' || r.report_id || ':' || r.revision::text || ':' || r.review_eligible::text || ':' || r.report_sha256 as token
      from public.engine_report_versions r
      join public.analysis_runs ar on ar.id = r.analysis_run_id
      cross join scope s
     where r.tenant_id = s.tenant_id and ar.canonical_analysis_run_id = s.run_id
    union all
    select 'review:' || rv.task_id || ':' || rv.revision::text || ':' || rv.release_state || ':' || rv.decision_sha256
      from public.engine_review_task_versions rv
      join public.engine_case_state ecs on ecs.case_id = rv.case_id and ecs.tenant_id = rv.tenant_id
      cross join scope s
     where rv.tenant_id = s.tenant_id and ecs.canonical_case_id = s.case_id`),
  probe(12, "matrix_cap_13_idempotency", 1, 1, `
    select 'idempotency:' || i.scope || ':' || i.idempotency_key || ':' || i.state || ':' || i.command_sha256 as token
      from public.engine_idempotency_records i, scope s
     where i.tenant_id = s.tenant_id and i.canonical_case_id = s.case_id and i.state = 'committed'`),
  probe(13, "matrix_cap_14_runtime", 5, 5, `
    select 'job:' || j.job_id || ':' || j.revision::text || ':' || j.state || ':' || coalesce(j.terminal_effect_sha256, '') || ':' || j.payload_sha256 as token
      from public.engine_durable_jobs j, scope s
     where j.tenant_id = s.tenant_id and j.canonical_case_id = s.case_id
    union all
    select 'outbox:' || o.outbox_id || ':' || o.state || ':' || o.payload_sha256
      from public.engine_outbox_events o, scope s
     where o.tenant_id = s.tenant_id and o.canonical_case_id = s.case_id
    union all
    select 'effect:' || e.logical_effect_id || ':' || e.logical_effect_sha256
      from public.engine_logical_effect_receipts e
      join public.engine_outbox_events o on o.outbox_id = e.outbox_id and o.tenant_id = e.tenant_id
      cross join scope s
     where e.tenant_id = s.tenant_id and o.canonical_case_id = s.case_id
    union all
    select 'audit:' || a.case_sequence::text || ':' || a.event_sha256
      from public.engine_platform_audit_events a, scope s
     where a.tenant_id = s.tenant_id and a.canonical_case_id = s.case_id`),
]);

/** Executes all 14 canonical adapters against one real node-postgres target. */
export async function runCanonicalCapabilityMatrix(
  input: CapabilityMatrixInput,
): Promise<CapabilityMatrixReceipt> {
  const resources = createResources(input);
  let receipt: Omit<CapabilityMatrixReceipt, "driver_metrics">;
  try {
    const application = await startApplication(
      resources.application_factory,
      resources.worker_factory,
      input.build_identity_sha,
    );
    const suffix = input.fixture_suffix ?? randomBytes(6).toString("hex");
    const fixture = createSyntheticCapabilityFixtures(suffix);
    const workerIdentity = createCapabilityWorkerIdentity(fixture.suffix, fixture.tenant_id);

    await application.transaction(fixture.tenant_id, fixture.case_id, async (bundle) => {
      for (const transition of fixture.case_transitions) {
        await bundle.intake.case_lifecycle.append(bundle.context, transition);
      }
      const current = await bundle.intake.case_lifecycle.get(bundle.context, {
        tenant_id: fixture.tenant_id,
        case_id: fixture.case_id,
      });
      if (current?.revision !== 7) throw new Error("CAPABILITY_CASE_REVISION_INVALID");
      await bundle.intake.payment_evidence.append(bundle.context, fixture.payment_evidence);
      const payments = await bundle.intake.payment_evidence.list(bundle.context, {
        tenant_id: fixture.tenant_id,
        case_id: fixture.case_id,
      });
      if (payments.length !== 1) throw new Error("CAPABILITY_PAYMENT_INVALID");
      await bundle.intake.conversations.appendConversation(bundle.context, fixture.conversation);
      await bundle.intake.conversations.appendMessage(bundle.context, fixture.message);
      await bundle.intake.documents_and_artifacts.appendDocument(bundle.context, fixture.document);
      await bundle.intake.documents_and_artifacts.appendArtifact(bundle.context, fixture.artifact);
      await bundle.intake.extractions.append(bundle.context, fixture.extraction);
      await bundle.intake.canonical_facts.append(bundle.context, fixture.fact);
      await bundle.runtime.jobs_outbox_audit.enqueue(fixture.job);
      await bundle.runtime.jobs_outbox_audit.enqueueOutbox(fixture.outbox);
      await bundle.runtime.jobs_outbox_audit.append({
        actor_id: "actor:synthetic:matrix",
        action: "SYNTHETIC_MATRIX_SEEDED",
        resource_id: fixture.case_id,
        resource_revision: 7,
        resource_sha256: fixture.case_transitions[6]!.state_sha256,
        reason: "SYNTHETIC_DYNAMIC_VERIFICATION",
        occurred_at: "2026-08-31T10:00:40.000Z",
      });
      await seedCapabilityWorkerSession(bundle.context.client, workerIdentity);
    });

    await application.transaction(fixture.tenant_id, fixture.case_id, async (bundle) => {
      await bundle.analysis.caseAnalysis.begin({
        analysis_run_id: fixture.analysis_run_id,
        idempotency_key: fixture.analysis_command.idempotency_key,
        command_sha256: fixture.analysis_command_sha256,
        command: fixture.analysis_command,
      });
      await bundle.analysis.caseAnalysis.persistStage(fixture.analysis_stage);
      await bundle.intake.investigation.appendHypothesis(bundle.context, fixture.hypothesis);
      await bundle.intake.investigation.appendRuleInput(bundle.context, fixture.rule_input);
      // Eligibility is explicitly synthetic. Completion remains coverage-incomplete
      // and all legal selections remain blocked/non-operative.
      await bundle.analysis.reports.persistReport({
        case_id: fixture.case_id,
        analysis_run_id: fixture.analysis_run_id,
        report: fixture.report_artifacts,
        review_eligible: true,
      });
      const completed = await bundle.analysis.caseAnalysis.complete({
        analysis_run_id: fixture.analysis_run_id,
        selections: fixture.selections,
        dependencies: fixture.dependencies,
        bundle: fixture.analysis_bundle,
        report: fixture.report_artifacts,
      });
      if (!completed.completed
          || !completed.stages.some((stage) => stage.stage === fixture.analysis_stage.stage)) {
        throw new Error("CAPABILITY_ANALYSIS_NOT_COMPLETED");
      }
      await bundle.analysis.caseAnalysis.assertPinnedDependenciesAvailable(fixture.dependencies);
      await bundle.analysis.traceFindings.assertFindingsDisabled({
        case_id: fixture.case_id,
        analysis_run_id: fixture.analysis_run_id,
      });
      await bundle.analysis.traceFindings.persistConfirmation(fixture.confirmation);
    });

    const exportEligible = await application.transaction(
      fixture.tenant_id,
      fixture.case_id,
      async (bundle) => {
        await bundle.analysis.reports.decide({
          task_id: fixture.review_task_id,
          task_kind: "report_approval",
          reviewer_id: "synthetic-reviewer-v091",
          reviewer_role: "report_approver",
          decision: "approved",
          input_sha256: fixture.report_artifacts.report_sha256,
          output_sha256: fixture.report_artifacts.report_sha256,
          decided_at: "2026-08-31T10:00:50.000Z",
          reason: "Synthetic isolated PostgreSQL verification.",
          schema_version: "tivdoc-case-review-decision-v0.6.0",
        });
        return bundle.analysis.reports.isReportExportEligible(
          fixture.case_id,
          fixture.report_artifacts.report_sha256,
        );
      },
    );
    if (!exportEligible) throw new Error("CAPABILITY_REPORT_NOT_ELIGIBLE");

    const atomicCommand = capabilityAtomicCommand(fixture);
    const firstReceipt = await application.transaction(
      fixture.tenant_id,
      fixture.case_id,
      async (bundle) => bundle.runtime.idempotency.execute(bundle.context, atomicCommand, async () => {
        const audit = await bundle.runtime.jobs_outbox_audit.append({
          actor_id: atomicCommand.actor_id,
          action: "SYNTHETIC_IDEMPOTENT_COMMAND",
          resource_id: fixture.case_id,
          resource_revision: 7,
          resource_sha256: atomicCommand.command_sha256,
          reason: "SYNTHETIC_DYNAMIC_VERIFICATION",
          occurred_at: atomicCommand.occurred_at,
        });
        return Object.freeze({
          tenant_id: fixture.tenant_id,
          case_id: fixture.case_id,
          case_revision: 7,
          command_sha256: atomicCommand.command_sha256,
          audit_event_sha256: audit.event_sha256,
          outbox_ids: Object.freeze([fixture.outbox_id]),
          idempotent_replay: false,
        }) satisfies TransactionReceipt;
      }),
    );
    if (firstReceipt.idempotent_replay) throw new Error("CAPABILITY_FIRST_EXECUTION_REPLAYED");
    const replayReceipt = await application.transaction(
      fixture.tenant_id,
      fixture.case_id,
      async (bundle) => bundle.runtime.idempotency.execute(bundle.context, atomicCommand, async () => {
        throw new Error("CAPABILITY_REPLAY_CALLBACK_EXECUTED");
      }),
    );
    if (!replayReceipt.idempotent_replay
        || replayReceipt.audit_event_sha256 !== firstReceipt.audit_event_sha256) {
      throw new Error("CAPABILITY_IDEMPOTENCY_REPLAY_INVALID");
    }

    const auditTail = await workerRuntimeTransaction(
      application,
      workerIdentity,
      fixture.case_id,
      `capability:worker:${fixture.suffix}`,
      async (bundle) => {
        const worker = workerIdentity.actor_id;
        const claimed = await bundle.runtime.jobs_outbox_audit.claim(worker, fixture.job_clock_ms, 60_000, 1);
        const job = claimed.find((candidate) => candidate.job_id === fixture.job_id);
        if (!job) throw new Error("CAPABILITY_JOB_NOT_CLAIMED");
        await bundle.runtime.jobs_outbox_audit.start(
          fixture.job_id,
          worker,
          job.fencing_token,
          fixture.job_clock_ms + 1,
        );
        await bundle.runtime.jobs_outbox_audit.heartbeat(
          fixture.job_id,
          worker,
          job.fencing_token,
          fixture.job_clock_ms + 2,
          60_000,
        );
        const outbox = await bundle.runtime.jobs_outbox_audit.claimOutbox(
          worker,
          fixture.job_clock_ms + 3,
          60_000,
        );
        if (outbox?.outbox_id !== fixture.outbox_id) throw new Error("CAPABILITY_OUTBOX_NOT_CLAIMED");
        const published = await bundle.runtime.jobs_outbox_audit.publishOutbox({
          outbox_id: fixture.outbox_id,
          worker_id: worker,
          fencing_token: outbox.fencing_token,
          now_ms: fixture.job_clock_ms + 4,
          logical_effect_sha256: fixture.logical_effect_sha256,
        });
        if (published.deduplicated) throw new Error("CAPABILITY_OUTBOX_UNEXPECTED_REPLAY");
        const succeeded = await bundle.runtime.jobs_outbox_audit.succeed(
          fixture.job_id,
          worker,
          job.fencing_token,
          fixture.job_clock_ms + 5,
          fixture.logical_effect_sha256,
        );
        if (succeeded.state !== "succeeded"
            || succeeded.terminal_effect_sha256 !== fixture.logical_effect_sha256) {
          throw new Error("CAPABILITY_JOB_NOT_SUCCEEDED");
        }
        const audit = await bundle.runtime.jobs_outbox_audit.verify();
        if (!audit.valid || audit.event_count !== 2 || audit.tail_sha256 === null) {
          throw new Error("CAPABILITY_AUDIT_CHAIN_INVALID");
        }
        return audit.tail_sha256;
      },
    );

    const matrix = await probeCapabilities(application, {
      tenant_id: fixture.tenant_id,
      case_id: fixture.case_id,
      analysis_run_id: fixture.analysis_run_id,
    });
    const capabilityMatrixSha256 = canonicalSha256(matrix);
    const durableSeed = Object.freeze({
      schema_version: "tivdoc-canonical-persistence-v091-durable-state-v1" as const,
      fixture_suffix: fixture.suffix,
      tenant_id: fixture.tenant_id,
      case_id: fixture.case_id,
      case_revision: 7 as const,
      analysis_run_id: fixture.analysis_run_id,
      report_id: fixture.report_id,
      report_sha256: fixture.report_artifacts.report_sha256,
      review_task_id: fixture.review_task_id,
      job_id: fixture.job_id,
      outbox_id: fixture.outbox_id,
      idempotency_key: fixture.idempotency_key,
      audit_tail_sha256: auditTail,
      capability_matrix_sha256: capabilityMatrixSha256,
    });
    const durableState: DurableCapabilityState = Object.freeze({
      ...durableSeed,
      durable_state_sha256: canonicalSha256(durableSeed),
    });
    receipt = Object.freeze({
      schema_version: "tivdoc-canonical-persistence-v091-capability-matrix-v1" as const,
      proof_class: "REAL_NODE_POSTGRES_EXECUTION" as const,
      target_id: application.target_id,
      matrix,
      durable_state: durableState,
      idempotency_replay_verified: true as const,
      report_export_eligibility_verified: true as const,
      findings_persisted: 0 as const,
      customer_documents_used: 0 as const,
      real_legal_activations: 0 as const,
      worker_runtime_principal: "tivdoc_worker_runtime" as const,
      worker_runtime_verified_session: true as const,
      worker_runtime_service_role_calls: 0 as const,
      // Non-worker fixture setup still uses the broad V0.9.1 application root
      // solely so clean/upgrade migration rehearsals remain compatible.
      broad_application_scope: "LEGACY_CANONICAL_V091_MIGRATION_COMPATIBILITY" as const,
    });
  } finally {
    await resources.close();
  }
  return Object.freeze({ ...receipt!, driver_metrics: resources.metrics() });
}

/** Read-only replay proof intended to run after the driver/application is restarted. */
export async function replayCanonicalCapabilityMatrix(
  input: CapabilityMatrixInput,
  durableState: DurableCapabilityState,
): Promise<Readonly<{
  replayed: true;
  matrix: readonly CapabilityMatrixRow[];
  adapter_replay: DurableAdapterReplayReceipt;
  driver_metrics: NodePostgresDriverMetrics;
}>> {
  if (canonicalSha256(withoutStateHash(durableState)) !== durableState.durable_state_sha256) {
    throw new Error("DURABLE_CAPABILITY_STATE_HASH_INVALID");
  }
  const resources = createResources(input);
  let matrix: readonly CapabilityMatrixRow[];
  let adapterReplay: DurableAdapterReplayReceipt;
  try {
    const application = await startApplication(
      resources.application_factory,
      resources.worker_factory,
      input.build_identity_sha,
    );
    const owner = Object.freeze({
      tenant_id: durableState.tenant_id,
      case_id: durableState.case_id,
      analysis_run_id: durableState.analysis_run_id,
    });
    const before = await probeCapabilities(application, owner);
    if (canonicalSha256(before) !== durableState.capability_matrix_sha256) {
      throw new Error("DURABLE_CAPABILITY_REPLAY_MISMATCH");
    }
    adapterReplay = await replayDurableAdapters(
      application,
      durableState,
    );
    matrix = await probeCapabilities(application, owner);
    if (canonicalSha256(matrix) !== durableState.capability_matrix_sha256
        || canonicalSha256(matrix) !== canonicalSha256(before)) {
      throw new Error("DURABLE_CAPABILITY_REPLAY_MUTATED_STATE");
    }
  } finally {
    await resources.close();
  }
  return Object.freeze({
    replayed: true as const,
    matrix: matrix!,
    adapter_replay: adapterReplay!,
    driver_metrics: resources.metrics(),
  });
}

async function replayDurableAdapters(
  application: Application,
  durableState: DurableCapabilityState,
): Promise<DurableAdapterReplayReceipt> {
  const fixture = createSyntheticCapabilityFixtures(durableState.fixture_suffix);
  const workerIdentity = createCapabilityWorkerIdentity(fixture.suffix, fixture.tenant_id);
  if (fixture.tenant_id !== durableState.tenant_id
      || fixture.case_id !== durableState.case_id
      || fixture.analysis_run_id !== durableState.analysis_run_id
      || fixture.report_id !== durableState.report_id
      || fixture.report_artifacts.report_sha256 !== durableState.report_sha256
      || fixture.review_task_id !== durableState.review_task_id
      || fixture.job_id !== durableState.job_id
      || fixture.outbox_id !== durableState.outbox_id
      || fixture.idempotency_key !== durableState.idempotency_key) {
    throw new Error("DURABLE_CAPABILITY_FIXTURE_IDENTITY_MISMATCH");
  }

  await application.transaction(durableState.tenant_id, durableState.case_id, async (bundle) => {
    const state = await bundle.intake.case_lifecycle.get(bundle.context, {
      tenant_id: durableState.tenant_id,
      case_id: durableState.case_id,
    });
    if (state?.revision !== durableState.case_revision) throw new Error("DURABLE_CASE_STATE_NOT_RELOADED");

    const analysis = await bundle.analysis.caseAnalysis.getByRunId(durableState.analysis_run_id);
    if (!analysis?.completed
        || analysis.analysis_run_id !== durableState.analysis_run_id
        || analysis.report?.report_sha256 !== durableState.report_sha256) {
      throw new Error("DURABLE_ANALYSIS_NOT_RELOADED");
    }

    const approved = await bundle.analysis.reports.isReportExportEligible(
      durableState.case_id,
      durableState.report_sha256,
    );
    if (!approved) throw new Error("DURABLE_APPROVAL_NOT_RELOADED");

    const replayed = await bundle.runtime.idempotency.execute(
      bundle.context,
      capabilityAtomicCommand(fixture),
      async () => { throw new Error("DURABLE_IDEMPOTENCY_CALLBACK_EXECUTED"); },
    );
    if (!replayed.idempotent_replay
        || replayed.audit_event_sha256 !== durableState.audit_tail_sha256
        || replayed.outbox_ids.length !== 1
        || replayed.outbox_ids[0] !== durableState.outbox_id) {
      throw new Error("DURABLE_IDEMPOTENCY_REPLAY_INVALID");
    }

    const audit = await bundle.runtime.jobs_outbox_audit.verify();
    if (!audit.valid || audit.event_count !== 2 || audit.tail_sha256 !== durableState.audit_tail_sha256) {
      throw new Error("DURABLE_AUDIT_CHAIN_INVALID");
    }
  });

  await workerRuntimeTransaction(
    application,
    workerIdentity,
    durableState.case_id,
    `capability:restart:${durableState.fixture_suffix}`,
    async (bundle) => {
      const future = Date.parse("2099-01-01T00:00:00.000Z");
      const jobs = await bundle.runtime.jobs_outbox_audit.claim(
        workerIdentity.actor_id,
        future,
        60_000,
        10,
      );
      if (jobs.length !== 0) {
        throw new Error("DURABLE_TERMINAL_JOB_RECLAIMED");
      }
      const outbox = await bundle.runtime.jobs_outbox_audit.claimOutbox(
        workerIdentity.actor_id,
        future,
        60_000,
      );
      if (outbox !== null) throw new Error("DURABLE_PUBLISHED_OUTBOX_RECLAIMED");
    },
  );

  return Object.freeze({
    schema_version: "tivdoc-canonical-persistence-v091-adapter-replay-v1" as const,
    case_state_reloaded: true as const,
    completed_analysis_reloaded: true as const,
    approval_reloaded: true as const,
    idempotency_replayed: true as const,
    audit_chain_verified: true as const,
    terminal_job_not_reclaimed: true as const,
    published_outbox_not_reclaimed: true as const,
    durable_effects_unchanged: true as const,
    status: "PASS" as const,
  });
}

async function startApplication(
  applicationFactory: NodePostgresConnectionFactory,
  workerFactory: NodePostgresConnectionFactory,
  buildIdentitySha: string,
): Promise<Application> {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(buildIdentitySha)) {
    throw new Error("BUILD_IDENTITY_SHA_INVALID");
  }
  const composition = await startCanonicalApplicationPostgres({
    mode: "isolated_postgres",
    execution_boundary: "non_test",
    target: applicationFactory.target,
    build_identity_sha: buildIdentitySha,
  }, {
    connection_factory: applicationFactory,
    runtime_connection_factories: Object.freeze({ worker: workerFactory }),
  });
  if (composition.mode !== "isolated_postgres") throw new Error("ISOLATED_POSTGRES_REQUIRED");
  return composition;
}

async function probeCapabilities(
  application: Application,
  owner: Readonly<{ tenant_id: string; case_id: string; analysis_run_id: string }>,
): Promise<readonly CapabilityMatrixRow[]> {
  return application.transaction(owner.tenant_id, owner.case_id, async (bundle) => {
    const rows: CapabilityMatrixRow[] = [];
    for (const definition of PROBES) {
      const query = `
        with scope as (
          select $1::text as tenant_id, $2::text as case_id, $3::text as run_id
        ), evidence as (${definition.evidence_sql})
        select count(*)::text as persisted_rows,
               encode(public.digest(coalesce(string_agg(token, E'\\n' order by token), ''), 'sha256'), 'hex') as evidence_sha256
          from evidence`;
      const result = await bundle.context.client.query(statement(definition.statement_name, query, [
        owner.tenant_id,
        owner.case_id,
        owner.analysis_run_id,
      ]));
      const persistedRows = decimalCount(result.rows[0]?.persisted_rows);
      const evidenceSha256 = sha256(result.rows[0]?.evidence_sha256);
      if (persistedRows < definition.minimum_rows || persistedRows > definition.maximum_rows) {
        throw new Error("CAPABILITY_PERSISTED_ROW_COUNT_INVALID");
      }
      if (definition.findings_guard) await assertFindingsZero(bundle.context.client, owner);
      rows.push(Object.freeze({
        capability: definition.capability,
        binding: definition.binding,
        status: "PASS" as const,
        persisted_rows: persistedRows,
        evidence_sha256: evidenceSha256,
        proof_class: "REAL_NODE_POSTGRES_PARAMETERIZED_SQL" as const,
        ...(definition.findings_guard ? { forbidden_rows: 0 as const } : {}),
      }));
    }
    if (rows.length !== 14 || new Set(rows.map((row) => row.capability)).size !== 14) {
      throw new Error("CAPABILITY_MATRIX_INCOMPLETE");
    }
    return Object.freeze(rows);
  });
}

async function assertFindingsZero(
  client: Parameters<Parameters<Application["transaction"]>[2]>[0]["context"]["client"],
  owner: Readonly<{ tenant_id: string; case_id: string; analysis_run_id: string }>,
): Promise<void> {
  const result = await client.query(statement(
    "matrix_cap_findings_zero",
    `select count(*)::text as finding_count
       from public.analysis_findings f
       join public.analysis_runs ar on ar.id = f.analysis_run_id
      where ar.tenant_id = $1 and ar.canonical_case_id = $2 and ar.canonical_analysis_run_id = $3`,
    [owner.tenant_id, owner.case_id, owner.analysis_run_id],
  ));
  if (decimalCount(result.rows[0]?.finding_count) !== 0) throw new Error("FINDINGS_DISABLED");
}

function probe(
  index: number,
  statementName: string,
  minimumRows: number,
  maximumRows: number,
  evidenceSql: string,
  findingsGuard?: true,
): Probe {
  const binding = CANONICAL_POSTGRES_CAPABILITY_BINDINGS[index];
  if (!binding) throw new Error("CAPABILITY_BINDING_MISSING");
  return Object.freeze({
    capability: binding.capability,
    binding: binding.binding,
    statement_name: statementName,
    evidence_sql: evidenceSql,
    minimum_rows: minimumRows,
    maximum_rows: maximumRows,
    ...(findingsGuard ? { findings_guard: true as const } : {}),
  });
}

function capabilityAtomicCommand(fixture: SyntheticCapabilityFixtures): AtomicCommand {
  const payload = Object.freeze({
    fixture: "canonical-persistence-v091",
    operation: "durable-replay-proof",
  });
  return Object.freeze({
    tenant_id: fixture.tenant_id,
    case_id: fixture.case_id,
    actor_id: "actor:synthetic:matrix",
    scope: "canonical_capability_matrix",
    idempotency_key: fixture.idempotency_key,
    expected_case_revision: 7,
    command_sha256: canonicalSha256(payload),
    command: payload,
    occurred_at: "2026-08-31T10:01:00.000Z",
    writes: Object.freeze([]),
    invalidates: Object.freeze([]),
    outbox: Object.freeze([{
      logical_effect_id: fixture.logical_effect_id,
      effect_kind: fixture.outbox.effect_kind,
      payload_sha256: fixture.outbox.payload_sha256,
      payload: fixture.outbox.payload,
    }]),
  });
}

function createResources(input: CapabilityMatrixInput): CapabilityResources {
  const supplied = Number(input.connection_url !== undefined) + Number(input.connection_factory !== undefined);
  if (supplied !== 1) throw new Error("EXACTLY_ONE_POSTGRES_CONNECTION_REQUIRED");
  const workerSupplied = Number(input.worker_runtime_connection_url !== undefined)
    + Number(input.worker_runtime_connection_factory !== undefined);
  if (workerSupplied !== 1) throw new Error("EXACTLY_ONE_WORKER_RUNTIME_CONNECTION_REQUIRED");
  if (input.worker_runtime_connection_url !== undefined) {
    assertWorkerRuntimeConnectionUrl(input.worker_runtime_connection_url);
  }
  if (input.worker_runtime_connection_factory !== undefined
      && input.worker_runtime_principal !== "tivdoc_worker_runtime") {
    throw new Error("WORKER_RUNTIME_PRINCIPAL_REQUIRED");
  }
  const applicationFactory = input.connection_factory ?? NodePostgresConnectionFactory.fromConnectionUrl({
      connection_url: input.connection_url!,
      max_connections: 16,
      application_name: "tivdoc-canonical-postgresql-v091-capability-matrix",
  });
  const applicationOwned = input.connection_factory === undefined;
  const workerFactory = input.worker_runtime_connection_factory
    ?? NodePostgresConnectionFactory.fromConnectionUrl({
      connection_url: input.worker_runtime_connection_url,
      max_connections: 4,
      application_name: "tivdoc-canonical-postgresql-v0102-capability-worker",
    });
  const workerOwned = input.worker_runtime_connection_url !== undefined;
  if (workerFactory === applicationFactory) {
    throw new Error("WORKER_RUNTIME_FACTORY_MUST_BE_DISTINCT");
  }
  if (workerFactory && !sameTarget(applicationFactory, workerFactory)) {
    throw new Error("WORKER_RUNTIME_TARGET_MISMATCH");
  }
  const factories = Object.freeze([applicationFactory, workerFactory]);
  return Object.freeze({
    application_factory: applicationFactory,
    worker_factory: workerFactory,
    close: async (): Promise<void> => {
      const closures = factories.filter((factory) => (
        factory === applicationFactory ? applicationOwned : workerOwned
      ) || input.close_injected_factory === true).map((factory) => factory.close());
      await Promise.all(closures);
    },
    metrics: (): NodePostgresDriverMetrics => combinedMetrics(factories),
  });
}

export function createCapabilityWorkerIdentity(
  fixtureSuffix: string,
  tenantId: string,
): CanonicalVerifiedRuntimeIdentity {
  if (!/^[a-z0-9]{6,32}$/u.test(fixtureSuffix)
      || !/^[A-Za-z0-9][A-Za-z0-9:._-]{2,159}$/u.test(tenantId)) {
    throw new Error("CAPABILITY_WORKER_IDENTITY_INVALID");
  }
  return Object.freeze({
    session_id: `session:capability-worker:${fixtureSuffix}`,
    token_id: `token:capability-worker:${fixtureSuffix}`,
    tenant_id: tenantId,
    actor_id: `worker:dynamic:${fixtureSuffix}`,
    reviewer_organization_id: null,
    rotation_counter: 0,
  });
}

async function seedCapabilityWorkerSession(
  client: Parameters<Parameters<Application["transaction"]>[2]>[0]["context"]["client"],
  identity: CanonicalVerifiedRuntimeIdentity,
): Promise<void> {
  const sessionSha256 = canonicalSha256({
    schema_version: "tivdoc-capability-worker-session-v0.10.2",
    ...identity,
  });
  await client.query(statement(
    "capability_worker_session_seed",
    `insert into public.product_identity_sessions(
       tenant_id,sid,subject,current_jti,rotation_counter,valid_after,expires_at,
       revoked_at,reviewer_org_id,session_sha256,created_at
     ) values ($1,$2,$3,$4,$5::bigint,$6::timestamptz,$7::timestamptz,null,null,$8,$6::timestamptz)
     on conflict (sid) do nothing`,
    [identity.tenant_id, identity.session_id, identity.actor_id, identity.token_id,
      identity.rotation_counter, "2020-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z", sessionSha256],
  ));
  const verified = await client.query(statement(
    "capability_worker_session_verify",
    `select tenant_id,sid,subject,current_jti,rotation_counter::text,reviewer_org_id,session_sha256
       from public.product_identity_sessions where sid=$1`,
    [identity.session_id],
  ));
  const row = verified.rows[0];
  if (verified.row_count !== 1 || !row || row.tenant_id !== identity.tenant_id
      || row.sid !== identity.session_id || row.subject !== identity.actor_id
      || row.current_jti !== identity.token_id || row.rotation_counter !== "0"
      || row.reviewer_org_id !== null || row.session_sha256 !== sessionSha256) {
    throw new Error("CAPABILITY_WORKER_SESSION_SEED_INVALID");
  }
}

function workerRuntimeTransaction<T>(
  application: Application,
  identity: CanonicalVerifiedRuntimeIdentity,
  caseId: string,
  correlationId: string,
  operation: (bundle: CapabilityTransactionBundle) => Promise<T>,
): Promise<T> {
  return application.verified_transaction({
    identity,
    runtime_role: "worker",
    case_id: caseId,
    correlation_id: correlationId,
  }, operation);
}

function assertWorkerRuntimeConnectionUrl(connectionUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(connectionUrl);
  } catch {
    throw new Error("WORKER_RUNTIME_CONNECTION_INVALID");
  }
  let username: string;
  try {
    username = decodeURIComponent(parsed.username);
  } catch {
    throw new Error("WORKER_RUNTIME_CONNECTION_INVALID");
  }
  if (username !== "tivdoc_worker_runtime") {
    throw new Error("WORKER_RUNTIME_PRINCIPAL_INVALID");
  }
}

function sameTarget(
  left: NodePostgresConnectionFactory,
  right: NodePostgresConnectionFactory,
): boolean {
  return left.target.host === right.target.host && left.target.port === right.target.port
    && left.target.database === right.target.database;
}

function combinedMetrics(factories: readonly NodePostgresConnectionFactory[]): NodePostgresDriverMetrics {
  const metrics = factories.map((factory) => factory.metrics());
  const first = metrics[0]!;
  return Object.freeze({
    driver: "node-postgres" as const,
    target: first.target,
    connection_attempts: metrics.reduce((sum, entry) => sum + entry.connection_attempts, 0),
    acquisitions: metrics.reduce((sum, entry) => sum + entry.acquisitions, 0),
    queries: metrics.reduce((sum, entry) => sum + entry.queries, 0),
    releases: metrics.reduce((sum, entry) => sum + entry.releases, 0),
    active_clients: metrics.reduce((sum, entry) => sum + entry.active_clients, 0),
    closed: metrics.every((entry) => entry.closed),
  });
}

function decimalCount(value: unknown): number {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) throw new Error("CAPABILITY_COUNT_INVALID");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("CAPABILITY_COUNT_INVALID");
  return parsed;
}

function sha256(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error("CAPABILITY_HASH_INVALID");
  }
  return value;
}

function withoutStateHash(state: DurableCapabilityState) {
  return Object.fromEntries(
    Object.entries(state).filter(([key]) => key !== "durable_state_sha256"),
  );
}
