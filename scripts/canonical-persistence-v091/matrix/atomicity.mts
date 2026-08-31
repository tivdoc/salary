import { canonicalSha256 } from "../../../src/server/platform/persistence/canonical.ts";
import type { AtomicCommand, TransactionReceipt } from "../../../src/server/platform/persistence/contracts.ts";
import type { AuditEventInput } from "../../../src/engine/wave4/contracts.ts";
import { createSyntheticCapabilityFixtures } from "./synthetic-fixtures.mts";

import {
  analysisCommand,
  approvalDecision,
  boundaryHashes,
  matrixTimestamp,
  reportFixture,
  safeError,
  seedCase,
  seedConversation,
  seedReport,
  snapshotState,
  snapshotTable,
  withMatrixApplication,
  type DynamicMatrixInput,
  type MatrixApplication,
  type SafeError,
  type SafeStateSnapshot,
  type StatementNameFailureInjector,
} from "./runtime.mts";

type Coverage = "EXACT" | "CONSTRAINED_PARTIAL";

const POST_COMMIT_REPLAY_BOUNDARIES = new Set<AtomicityBoundaryResult["boundary_id"]>([
  "TX-02", "TX-03", "TX-04", "TX-05", "TX-07",
]);

const EXPECTED_ROW_DELTAS: Readonly<Record<AtomicityBoundaryResult["boundary_id"], Readonly<Record<string, number>>>> = Object.freeze({
  "TX-01": Object.freeze({ engine_case_identity: 1, engine_case_state: 1, engine_case_lifecycle_revisions: 1, engine_platform_audit_events: 1 }),
  "TX-02": Object.freeze({ engine_case_lifecycle_revisions: 1, case_messages: 1, engine_idempotency_records: 1, engine_platform_audit_events: 1 }),
  "TX-03": Object.freeze({
    analysis_runs: 1,
    engine_analysis_stage_versions: 1,
    engine_legal_version_pins: 6,
    engine_topic_result_versions: 7,
    engine_calculation_trace_versions: 1,
    engine_report_versions: 1,
  }),
  "TX-04": Object.freeze({ analysis_runs: 1, engine_report_versions: 1 }),
  "TX-05": Object.freeze({ engine_review_task_versions: 1, engine_idempotency_records: 1, engine_platform_audit_events: 1 }),
  "TX-06": Object.freeze({ engine_payment_evidence_refs: 1, engine_review_task_versions: 1, engine_outbox_events: 1, engine_platform_audit_events: 1 }),
  "TX-07": Object.freeze({ engine_case_lifecycle_revisions: 1, engine_idempotency_records: 1, engine_durable_jobs: 1, engine_outbox_events: 1, engine_platform_audit_events: 1 }),
  "TX-08": Object.freeze({ engine_platform_audit_events: 1 }),
});

export type AtomicityBoundaryResult = Readonly<{
  boundary_id: `TX-0${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`;
  boundary: string;
  tenant_id?: string;
  injected_statement: string;
  injection_matches: number;
  injection_count: number;
  failure_rejected: boolean;
  failure_error: SafeError | null;
  rollback_snapshot_unchanged: boolean;
  before: SafeStateSnapshot;
  after_failure: SafeStateSnapshot;
  retry_succeeded: boolean;
  retry_error: SafeError | null;
  retry_changed_state: boolean;
  retry_expected_deltas_valid: boolean;
  after_retry: SafeStateSnapshot;
  post_commit_replay_required: boolean;
  post_commit_replay_succeeded: boolean | null;
  post_commit_replay_result_stable: boolean | null;
  post_commit_replay_snapshot_unchanged: boolean | null;
  semantic_coverage: Coverage;
  coverage_gap: string | null;
  status: "PASS" | "FAIL";
}>;

export type AtomicityMatrixReceipt = Readonly<{
  schema_version: "tivdoc-real-postgresql-atomicity-matrix-v0.9.1";
  proof_class: "REAL_POSTGRESQL_DYNAMIC_PROOF";
  application_root: "startCanonicalApplicationPostgres";
  driver: "node-postgres";
  boundaries: readonly AtomicityBoundaryResult[];
  boundary_count: 8;
  passed_boundary_count: number;
  exact_boundary_count: number;
  snapshot_table_count: number;
  connection_attempts: number;
  credentials_recorded: 0;
  customer_data_used: false;
  legal_activation_used: false;
  findings_written: false;
  complete_contract_coverage: boolean;
  status: "PASS" | "INCOMPLETE" | "FAIL";
}>;

type BoundaryDefinition = Readonly<{
  boundary_id: AtomicityBoundaryResult["boundary_id"];
  boundary: string;
  tenant_id?: string;
  case_id: string;
  injected_statement: string;
  semantic_coverage: Coverage;
  coverage_gap: string | null;
  seed(): Promise<void>;
  execute(): Promise<unknown>;
}>;

/**
 * Runs every failure through the real canonical application root.  The
 * statement-name injector delegates all non-target statements to node-postgres;
 * an exact tenant-wide count/hash snapshot proves that the failed transaction
 * left no durable residue before the same operation is retried.
 */
export async function runAtomicityMatrix(input: DynamicMatrixInput): Promise<AtomicityMatrixReceipt> {
  return withMatrixApplication(input, async ({ application, driver, injector, tenant_id: tenantId }) => {
    const definitions = atomicityDefinitions(application, injector, tenantId, input.matrix_run_id);
    const boundaries: AtomicityBoundaryResult[] = [];
    for (const definition of definitions) boundaries.push(await exerciseBoundary(application, injector, tenantId, definition));

    const passed = boundaries.filter((entry) => entry.status === "PASS").length;
    const exact = boundaries.filter((entry) => entry.semantic_coverage === "EXACT").length;
    const complete = exact === boundaries.length;
    const mechanicsPassed = passed === boundaries.length;
    const metrics = driver.metrics();
    return Object.freeze({
      schema_version: "tivdoc-real-postgresql-atomicity-matrix-v0.9.1",
      proof_class: "REAL_POSTGRESQL_DYNAMIC_PROOF",
      application_root: "startCanonicalApplicationPostgres",
      driver: "node-postgres",
      boundaries: Object.freeze(boundaries),
      boundary_count: 8,
      passed_boundary_count: passed,
      exact_boundary_count: exact,
      snapshot_table_count: boundaries[0]?.before.tables.length ?? 0,
      connection_attempts: metrics.connection_attempts,
      credentials_recorded: 0,
      customer_data_used: false,
      legal_activation_used: false,
      findings_written: false,
      complete_contract_coverage: complete,
      status: mechanicsPassed ? (complete ? "PASS" : "INCOMPLETE") : "FAIL",
    });
  });
}

async function exerciseBoundary(
  application: MatrixApplication,
  injector: StatementNameFailureInjector,
  tenantId: string,
  definition: BoundaryDefinition,
): Promise<AtomicityBoundaryResult> {
  const boundaryTenantId = definition.tenant_id ?? tenantId;
  await definition.seed();
  const before = await snapshotState(application, boundaryTenantId, definition.case_id);
  injector.arm(definition.injected_statement);
  let failureError: SafeError | null = null;
  let failureRejected = false;
  let injection: Readonly<{ matched: number; injected: number }> = Object.freeze({ matched: 0, injected: 0 });
  try {
    await definition.execute();
  } catch (error) {
    failureRejected = true;
    failureError = safeError(error);
  } finally {
    injection = injector.disarm();
  }
  const afterFailure = await snapshotState(application, boundaryTenantId, definition.case_id);
  const rollbackUnchanged = before.snapshot_sha256 === afterFailure.snapshot_sha256;

  let retryError: SafeError | null = null;
  let retrySucceeded = false;
  let retryResult: unknown = null;
  try {
    retryResult = await definition.execute();
    retrySucceeded = true;
  } catch (error) {
    retryError = safeError(error);
  }
  const afterRetry = await snapshotState(application, boundaryTenantId, definition.case_id);
  const retryChangedState = afterRetry.snapshot_sha256 !== before.snapshot_sha256;
  const expectedDeltasValid = validateExpectedDeltas(definition.boundary_id, before, afterRetry);
  const replayRequired = POST_COMMIT_REPLAY_BOUNDARIES.has(definition.boundary_id);
  let replaySucceeded: boolean | null = replayRequired ? false : null;
  let replayResultStable: boolean | null = replayRequired ? false : null;
  let replaySnapshotUnchanged: boolean | null = replayRequired ? false : null;
  if (replayRequired && retrySucceeded) {
    try {
      const replayResult = await definition.execute();
      replaySucceeded = true;
      replayResultStable = semanticResultSha256(replayResult) === semanticResultSha256(retryResult);
      const afterReplay = await snapshotState(application, boundaryTenantId, definition.case_id);
      replaySnapshotUnchanged = afterReplay.snapshot_sha256 === afterRetry.snapshot_sha256;
    } catch {
      replaySucceeded = false;
    }
  }
  const replayValid = !replayRequired || (replaySucceeded === true && replayResultStable === true && replaySnapshotUnchanged === true);
  const status = failureRejected && injection.matched === 1 && injection.injected === 1
    && rollbackUnchanged && retrySucceeded && retryChangedState && expectedDeltasValid && replayValid ? "PASS" : "FAIL";
  return Object.freeze({
    boundary_id: definition.boundary_id,
    boundary: definition.boundary,
    injected_statement: definition.injected_statement,
    injection_matches: injection.matched,
    injection_count: injection.injected,
    failure_rejected: failureRejected,
    failure_error: failureError,
    rollback_snapshot_unchanged: rollbackUnchanged,
    before,
    after_failure: afterFailure,
    retry_succeeded: retrySucceeded,
    retry_error: retryError,
    retry_changed_state: retryChangedState,
    retry_expected_deltas_valid: expectedDeltasValid,
    after_retry: afterRetry,
    post_commit_replay_required: replayRequired,
    post_commit_replay_succeeded: replaySucceeded,
    post_commit_replay_result_stable: replayResultStable,
    post_commit_replay_snapshot_unchanged: replaySnapshotUnchanged,
    semantic_coverage: definition.semantic_coverage,
    coverage_gap: definition.coverage_gap,
    status,
  });
}

function atomicityDefinitions(
  application: MatrixApplication,
  _injector: StatementNameFailureInjector,
  tenantId: string,
  runId: string,
): readonly BoundaryDefinition[] {
  const caseId = (suffix: string): string => `case-v091-${runId}-${suffix}`;
  return Object.freeze([
    Object.freeze({
      boundary_id: "TX-01" as const,
      boundary: "case creation/intake plus first audit event",
      case_id: caseId("tx01"),
      injected_statement: "audit_append",
      semantic_coverage: "EXACT" as const,
      coverage_gap: null,
      seed: async () => undefined,
      execute: () => application.transaction(tenantId, caseId("tx01"), async (bundle) => {
        const marker = "tx01-create";
        const hashes = boundaryHashes(marker);
        const state = await bundle.intake.case_lifecycle.append(bundle.context, lifecycle({
          tenantId, caseId: caseId("tx01"), marker, expectedRevision: 0,
          stateBefore: null, stateAfter: "awaiting_documents", previousSha256: null, offset: 10,
        }));
        const recorded = await bundle.runtime.jobs_outbox_audit.append(audit(marker, state.revision, hashes.state, 11));
        if (state.revision !== 1 || recorded.sequence !== 1) throw new Error("TX01_FINAL_INVARIANT_FAILED");
        return Object.freeze({ revision: state.revision, event_sha256: recorded.event_sha256 });
      }),
    }),
    Object.freeze({
      boundary_id: "TX-02" as const,
      boundary: "clarification plus revision, idempotency and audit",
      case_id: caseId("tx02"),
      injected_statement: "audit_append",
      semantic_coverage: "EXACT" as const,
      coverage_gap: null,
      seed: async () => {
        await seedCase(application, tenantId, caseId("tx02"), "tx02-seed");
        await seedConversation(application, tenantId, caseId("tx02"), `conversation-${runId}-tx02`);
      },
      execute: () => application.transaction(tenantId, caseId("tx02"), async (bundle) => {
        const marker = "tx02-clarification";
        const command = atomicCommand(tenantId, caseId("tx02"), marker, 1, 20);
        return bundle.runtime.idempotency.execute(bundle.context, command, async (): Promise<TransactionReceipt> => {
          const state = await bundle.intake.case_lifecycle.append(bundle.context, lifecycle({
            tenantId, caseId: caseId("tx02"), marker, expectedRevision: 1,
            stateBefore: "awaiting_documents", stateAfter: "awaiting_fact_resolution",
            previousSha256: boundaryHashes("tx02-seed").event, offset: 21,
          }));
          await bundle.intake.conversations.appendMessage(bundle.context, {
            tenant_id: tenantId,
            case_id: caseId("tx02"),
            message_id: `message-${runId}-tx02`,
            conversation_id: `conversation-${runId}-tx02`,
            analysis_run_id: null,
            role: "system",
            agent: null,
            question_id: null,
            question_version: null,
            selected_option_ids: [],
            free_text_answer: null,
            content: "Synthetic clarification boundary marker; no customer content.",
            model_provider: null,
            model_identifier: null,
            prompt_version: null,
            idempotency_key: `message-idem-${runId}-tx02`,
            created_at: matrixTimestamp(22),
          });
          const recorded = await bundle.runtime.jobs_outbox_audit.append(audit(marker, state.revision, state.state_sha256, 23));
          return receipt(command, state.revision, recorded.event_sha256, []);
        });
      }),
    }),
    tx03(application, runId),
    Object.freeze({
      boundary_id: "TX-04" as const,
      boundary: "report creation plus exact model and PDF hashes",
      case_id: caseId("tx04"),
      injected_statement: "analysis_report_insert",
      semantic_coverage: "EXACT" as const,
      coverage_gap: null,
      seed: () => seedCase(application, tenantId, caseId("tx04"), "tx04-seed"),
      execute: () => application.transaction(tenantId, caseId("tx04"), async (bundle) => {
        const idempotencyKey = `analysis-idem-${runId}-tx04`;
        const command = analysisCommand(caseId("tx04"), idempotencyKey);
        const analysisRunId = `analysis-run-${runId}-tx04`;
        await bundle.analysis.caseAnalysis.begin({
          analysis_run_id: analysisRunId,
          idempotency_key: idempotencyKey,
          command_sha256: canonicalSha256(command),
          command,
        });
        const report = reportFixture(`report-${runId}-tx04`, 1, canonicalSha256({ runId, boundary: "TX-04" }));
        await bundle.analysis.reports.persistReport({
          case_id: caseId("tx04"),
          analysis_run_id: analysisRunId,
          report,
          review_eligible: true,
        });
        return Object.freeze({ report_sha256: report.report_sha256, pdf_sha256: report.pdf_sha256 });
      }),
    }),
    tx05(application, tenantId, runId, caseId("tx05")),
    tx06(application, tenantId, runId, caseId("tx06")),
    tx07(application, tenantId, runId, caseId("tx07")),
    tx08(application, tenantId, runId, caseId("tx08")),
  ]);
}

function tx03(application: MatrixApplication, runId: string): BoundaryDefinition {
  const suffix = canonicalSha256({ matrix_run_id: runId, boundary: "TX-03" }).slice(0, 16);
  const fixture = createSyntheticCapabilityFixtures(suffix);
  return Object.freeze({
    boundary_id: "TX-03",
    boundary: "analysis run, inert pins, seven topic results, trace and completion",
    tenant_id: fixture.tenant_id,
    case_id: fixture.case_id,
    injected_statement: "analysis_run_complete",
    semantic_coverage: "EXACT",
    coverage_gap: null,
    seed: () => application.transaction(fixture.tenant_id, fixture.case_id, async (bundle) => {
      for (const transition of fixture.case_transitions) {
        await bundle.intake.case_lifecycle.append(bundle.context, transition);
      }
    }),
    execute: () => application.transaction(fixture.tenant_id, fixture.case_id, async (bundle) => {
      await bundle.analysis.caseAnalysis.begin({
        analysis_run_id: fixture.analysis_run_id,
        idempotency_key: fixture.analysis_command.idempotency_key,
        command_sha256: fixture.analysis_command_sha256,
        command: fixture.analysis_command,
      });
      await bundle.analysis.caseAnalysis.persistStage(fixture.analysis_stage);
      const completed = await bundle.analysis.caseAnalysis.complete({
        analysis_run_id: fixture.analysis_run_id,
        selections: fixture.selections,
        dependencies: fixture.dependencies,
        bundle: fixture.analysis_bundle,
        report: fixture.report_artifacts,
      });
      await bundle.analysis.caseAnalysis.assertPinnedDependenciesAvailable(fixture.dependencies);
      await bundle.analysis.traceFindings.assertFindingsDisabled({
        case_id: fixture.case_id,
        analysis_run_id: fixture.analysis_run_id,
      });
      if (!completed.completed
          || completed.selections.length !== 7
          || completed.bundle?.topic_results.length !== 7
          || completed.bundle.topic_results.filter((result) => result.trace !== null).length !== 1
          || !completed.stages.some((stage) => stage.stage === fixture.analysis_stage.stage)
          || completed.selections.some((selection) => selection.readiness.usable_for_rules
            || selection.readiness.status !== "BLOCKED_NOT_READY"
            || selection.readiness.operative_candidate_source_version_ids.length !== 0)) {
        throw new Error("TX03_FINAL_INVARIANT_FAILED");
      }
      return completed;
    }),
  });
}

function tx05(application: MatrixApplication, tenantId: string, runId: string, caseId: string): BoundaryDefinition {
  let report: Awaited<ReturnType<typeof seedReport>> | null = null;
  return Object.freeze({
    boundary_id: "TX-05",
    boundary: "approval plus report hash and revision binding",
    case_id: caseId,
    injected_statement: "idempotency_commit",
    semantic_coverage: "EXACT",
    coverage_gap: null,
    seed: async () => {
      await seedCase(application, tenantId, caseId, "tx05-seed");
      report = await seedReport(application, tenantId, caseId, `analysis-run-${runId}-tx05`, `analysis-idem-${runId}-tx05`, `report-${runId}-tx05`);
    },
    execute: () => application.transaction(tenantId, caseId, async (bundle) => {
      if (!report) throw new Error("TX05_REPORT_NOT_SEEDED");
      const command = atomicCommand(tenantId, caseId, "tx05-approval", 1, 50);
      return bundle.runtime.idempotency.execute(bundle.context, command, async (): Promise<TransactionReceipt> => {
        const decision = await bundle.analysis.reports.decide(approvalDecision(`review-${runId}-tx05`, report!));
        const recorded = await bundle.runtime.jobs_outbox_audit.append(audit("tx05-approval", decision.revision, decision.receipt_sha256, 51));
        return receipt(command, 1, recorded.event_sha256, []);
      });
    }),
  });
}

function tx06(application: MatrixApplication, tenantId: string, runId: string, caseId: string): BoundaryDefinition {
  let report: Awaited<ReturnType<typeof seedReport>> | null = null;
  const taskId = `review-${runId}-tx06`;
  return Object.freeze({
    boundary_id: "TX-06",
    boundary: "chargeback/invalidation plus revocation, audit and outbox",
    case_id: caseId,
    injected_statement: "outbox_enqueue",
    semantic_coverage: "EXACT",
    coverage_gap: null,
    seed: async () => {
      await seedCase(application, tenantId, caseId, "tx06-seed");
      report = await seedReport(application, tenantId, caseId, `analysis-run-${runId}-tx06`, `analysis-idem-${runId}-tx06`, `report-${runId}-tx06`);
      await application.transaction(tenantId, caseId, async (bundle) => {
        await bundle.analysis.reports.decide(approvalDecision(taskId, report!));
      });
    },
    execute: () => application.transaction(tenantId, caseId, async (bundle) => {
      if (!report) throw new Error("TX06_REPORT_NOT_SEEDED");
      const marker = "tx06-chargeback";
      const hashes = boundaryHashes(marker);
      await bundle.intake.payment_evidence.append(bundle.context, {
        tenant_id: tenantId,
        case_id: caseId,
        evidence_id: `payment-${runId}-tx06`,
        evidence_revision: "rev-1",
        evidence_sha256: hashes.payload,
        status: "chargeback",
        bound_at: matrixTimestamp(61),
      });
      const invalidated = await bundle.analysis.reports.invalidate({
        case_id: caseId,
        report_sha256: report.report_sha256,
        task_id: taskId,
        expected_revision: 1,
        invalidated_at: matrixTimestamp(62),
        reason_sha256: hashes.command,
      });
      await bundle.runtime.jobs_outbox_audit.append(audit(marker, invalidated.revision, invalidated.receipt_sha256, 63));
      const payload = Object.freeze({ kind: "synthetic_report_revocation", report_sha256: report.report_sha256 });
      await bundle.runtime.jobs_outbox_audit.enqueueOutbox({
        outbox_id: `outbox-${runId}-tx06`,
        tenant_id: tenantId,
        case_id: caseId,
        logical_effect_id: `effect-${runId}-tx06`,
        effect_kind: "synthetic.report.revoked",
        payload_sha256: canonicalSha256(payload),
        payload,
        created_at: matrixTimestamp(64),
      });
      if (invalidated.revision !== 2) throw new Error("TX06_FINAL_INVARIANT_FAILED");
      return Object.freeze({ invalidation_revision: invalidated.revision, outbox_count: 1 });
    }),
  });
}

function tx07(application: MatrixApplication, tenantId: string, runId: string, caseId: string): BoundaryDefinition {
  return Object.freeze({
    boundary_id: "TX-07",
    boundary: "privacy request plus revision, idempotency, audit and job/outbox",
    case_id: caseId,
    injected_statement: "outbox_enqueue",
    semantic_coverage: "EXACT",
    coverage_gap: null,
    seed: () => seedCase(application, tenantId, caseId, "tx07-seed"),
    execute: () => application.transaction(tenantId, caseId, async (bundle) => {
      const marker = "tx07-privacy-hold";
      const command = atomicCommand(tenantId, caseId, marker, 1, 70);
      return bundle.runtime.idempotency.execute(bundle.context, command, async (): Promise<TransactionReceipt> => {
        const state = await bundle.intake.case_lifecycle.append(bundle.context, lifecycle({
          tenantId, caseId, marker, expectedRevision: 1, stateBefore: "awaiting_documents", stateAfter: "release_hold",
          previousSha256: boundaryHashes("tx07-seed").event, offset: 71,
        }));
        const payload = Object.freeze({ kind: "synthetic_privacy_hold", case_revision: state.revision });
        await bundle.runtime.jobs_outbox_audit.enqueue({
          job_id: `job-${runId}-tx07`,
          tenant_id: tenantId,
          case_id: caseId,
          job_kind: "synthetic_privacy_hold",
          idempotency_key: `job-idem-${runId}-tx07`,
          payload_sha256: canonicalSha256(payload),
          payload,
          pinned_version_sha256s: [],
          max_attempts: 3,
          available_at_ms: Date.parse(matrixTimestamp(72)),
        });
        const recorded = await bundle.runtime.jobs_outbox_audit.append(audit(marker, state.revision, state.state_sha256, 73));
        await bundle.runtime.jobs_outbox_audit.enqueueOutbox({
          outbox_id: `outbox-${runId}-tx07`,
          tenant_id: tenantId,
          case_id: caseId,
          logical_effect_id: `effect-${runId}-tx07`,
          effect_kind: "synthetic.privacy.hold",
          payload_sha256: canonicalSha256(payload),
          payload,
          created_at: matrixTimestamp(74),
        });
        return receipt(command, state.revision, recorded.event_sha256, [`outbox-${runId}-tx07`]);
      });
    }),
  });
}

function tx08(application: MatrixApplication, tenantId: string, runId: string, caseId: string): BoundaryDefinition {
  const payload = Object.freeze({ kind: "synthetic_retry_boundary", legally_neutral: true });
  const now = Date.parse(matrixTimestamp(90));
  return Object.freeze({
    boundary_id: "TX-08",
    boundary: "job claim, lease/fencing and completion or retry",
    case_id: caseId,
    injected_statement: "audit_append",
    semantic_coverage: "EXACT",
    coverage_gap: null,
    seed: async () => {
      await seedCase(application, tenantId, caseId, "tx08-seed");
      await application.transaction(tenantId, caseId, async (bundle) => {
        await bundle.runtime.jobs_outbox_audit.enqueue({
          job_id: `job-${runId}-tx08`,
          tenant_id: tenantId,
          case_id: caseId,
          job_kind: "synthetic_retry_boundary",
          idempotency_key: `job-idem-${runId}-tx08`,
          payload_sha256: canonicalSha256(payload),
          payload,
          pinned_version_sha256s: [],
          max_attempts: 3,
          available_at_ms: now - 1_000,
        });
      });
    },
    execute: () => application.transaction(tenantId, caseId, async (bundle) => {
      const jobs = await bundle.runtime.jobs_outbox_audit.claim(`worker-${runId}-tx08`, now, 60_000, 1);
      const claimed = jobs[0];
      if (!claimed || jobs.length !== 1) throw new Error("TX08_CLAIM_INVARIANT_FAILED");
      await bundle.runtime.jobs_outbox_audit.start(claimed.job_id, claimed.lease_owner!, claimed.fencing_token, now + 1);
      const retried = await bundle.runtime.jobs_outbox_audit.fail(claimed.job_id, claimed.lease_owner!, claimed.fencing_token, now + 2, 5_000);
      await bundle.runtime.jobs_outbox_audit.append(audit("tx08-retry", retried.revision, retried.payload_sha256, 91));
      if (retried.state !== "retry_wait" || retried.revision !== 4 || retried.attempt_count !== 1
          || retried.fencing_token !== 1 || retried.lease_owner !== null) {
        throw new Error("TX08_FINAL_INVARIANT_FAILED");
      }
      return Object.freeze({
        state: retried.state,
        revision: retried.revision,
        attempt_count: retried.attempt_count,
        fencing_token: retried.fencing_token,
      });
    }),
  });
}

function lifecycle(input: Readonly<{
  tenantId: string;
  caseId: string;
  marker: string;
  expectedRevision: number;
  stateBefore: null | "awaiting_documents";
  stateAfter: "awaiting_documents" | "awaiting_fact_resolution" | "release_hold";
  previousSha256: string | null;
  offset: number;
}>) {
  const hashes = boundaryHashes(input.marker);
  return Object.freeze({
    tenant_id: input.tenantId,
    case_id: input.caseId,
    expected_revision: input.expectedRevision,
    state_before: input.stateBefore,
    state_after: input.stateAfter,
    event_kind: input.marker,
    command_sha256: hashes.command,
    event_sha256: hashes.event,
    previous_sha256: input.previousSha256,
    state_sha256: hashes.state,
    occurred_at: matrixTimestamp(input.offset),
  });
}

function atomicCommand(
  tenantId: string,
  caseId: string,
  marker: string,
  expectedRevision: number,
  offset: number,
): AtomicCommand {
  const payload = Object.freeze({ schema_version: "tivdoc-v091-synthetic-command", marker, case_id: caseId });
  return Object.freeze({
    tenant_id: tenantId,
    case_id: caseId,
    actor_id: "synthetic-matrix-actor",
    scope: `matrix.${marker}`,
    idempotency_key: `idem-${marker}`,
    expected_case_revision: expectedRevision,
    command_sha256: canonicalSha256(payload),
    command: payload,
    occurred_at: matrixTimestamp(offset),
    writes: Object.freeze([]),
    invalidates: Object.freeze([]),
    outbox: Object.freeze([]),
  });
}

function receipt(
  command: AtomicCommand,
  caseRevision: number,
  auditEventSha256: string,
  outboxIds: readonly string[],
): TransactionReceipt {
  return Object.freeze({
    tenant_id: command.tenant_id,
    case_id: command.case_id,
    case_revision: caseRevision,
    command_sha256: command.command_sha256,
    audit_event_sha256: auditEventSha256,
    outbox_ids: Object.freeze([...outboxIds]),
    idempotent_replay: false,
  });
}

function audit(marker: string, revision: number, resourceSha256: string, offset: number): AuditEventInput {
  return Object.freeze({
    actor_id: "synthetic-matrix-actor",
    action: marker,
    resource_id: `resource-${marker}`,
    resource_revision: revision,
    resource_sha256: resourceSha256,
    reason: "SYNTHETIC_DYNAMIC_VERIFICATION",
    occurred_at: matrixTimestamp(offset),
  });
}

function validateExpectedDeltas(
  boundaryId: AtomicityBoundaryResult["boundary_id"],
  before: SafeStateSnapshot,
  after: SafeStateSnapshot,
): boolean {
  const expected = EXPECTED_ROW_DELTAS[boundaryId];
  return before.tables.every((entry) => {
    const actual = snapshotTable(after, entry.table).row_count - entry.row_count;
    return actual === (expected[entry.table] ?? 0);
  });
}

function semanticResultSha256(value: unknown): string {
  if (typeof value === "object" && value !== null && !Array.isArray(value) && "idempotent_replay" in value) {
    const stable = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "idempotent_replay"));
    return canonicalSha256(stable);
  }
  return canonicalSha256(value ?? null);
}
