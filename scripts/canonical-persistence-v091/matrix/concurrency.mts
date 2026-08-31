import { canonicalSha256 } from "../../../src/server/platform/persistence/canonical.ts";
import type { AtomicCommand, TransactionReceipt } from "../../../src/server/platform/persistence/contracts.ts";
import { statement } from "../../../src/server/platform/persistence/postgres/contracts.ts";

import {
  analysisCommand,
  approvalDecision,
  boundaryHashes,
  matrixTimestamp,
  safeError,
  seedCase,
  seedReport,
  snapshotState,
  withMatrixApplication,
  type DynamicMatrixInput,
  type MatrixApplication,
  type SafeError,
  type StatementNameFailureInjector,
} from "./runtime.mts";

type SafeObservation = string | number | boolean | null;
type BarrierProof = Readonly<{
  arrived: number;
  released: boolean;
  release_reason: "participants" | "timeout" | "disarm" | null;
  arrived_at_release: number | null;
  timed_out: boolean;
}>;

export type ConcurrencyCaseResult = Readonly<{
  case_id: "CC-01" | "CC-02" | "CC-03" | "CC-04" | "CC-05" | "CC-06" | "CC-07";
  scenario: string;
  independent_transactions: number;
  barrier_statement: string | null;
  barrier_arrivals: number;
  barrier_release_reason: "participants" | "timeout" | "disarm" | null;
  barrier_timed_out: boolean;
  accepted_count: number;
  rejected_count: number;
  rejected_errors: readonly SafeError[];
  rejected_domain_codes: readonly string[];
  expected_rejection_semantics: boolean;
  observations: Readonly<Record<string, SafeObservation>>;
  status: "PASS" | "FAIL";
}>;

type RaceSummary = Readonly<{
  accepted: number;
  rejected: number;
  errors: readonly SafeError[];
  domain_codes: readonly string[];
  expected_rejections: boolean;
}>;

export type ConcurrencyMatrixReceipt = Readonly<{
  schema_version: "tivdoc-real-postgresql-concurrency-matrix-v0.9.1";
  proof_class: "REAL_POSTGRESQL_DYNAMIC_PROOF";
  application_root: "startCanonicalApplicationPostgres";
  driver: "node-postgres";
  cases: readonly ConcurrencyCaseResult[];
  case_count: 7;
  passed_case_count: number;
  independent_connection_proof: boolean;
  connection_attempts: number;
  acquisitions: number;
  credentials_recorded: 0;
  customer_data_used: false;
  legal_activation_used: false;
  findings_written: false;
  status: "PASS" | "FAIL";
}>;

/** Executes deterministic races through independent node-postgres clients. */
export async function runConcurrencyMatrix(input: DynamicMatrixInput): Promise<ConcurrencyMatrixReceipt> {
  if (input.max_connections !== undefined && input.max_connections < 2) {
    throw new TypeError("CONCURRENCY_MATRIX_REQUIRES_TWO_CONNECTIONS");
  }
  return withMatrixApplication(input, async ({ application, driver, injector, tenant_id: tenantId }) => {
    const cases: ConcurrencyCaseResult[] = [];
    cases.push(await duplicateAnalysisRun(application, injector, tenantId, input.matrix_run_id));
    cases.push(await jobClaimAndFence(application, injector, tenantId, input.matrix_run_id));
    cases.push(await approvalAndStaleRevision(application, injector, tenantId, input.matrix_run_id));
    cases.push(await idempotencyCollision(application, injector, tenantId, input.matrix_run_id));
    cases.push(await outboxRace(application, injector, tenantId, input.matrix_run_id));
    cases.push(await conflictingCaseUpdate(application, injector, tenantId, input.matrix_run_id));
    cases.push(await retryAfterAbort(application, injector, tenantId, input.matrix_run_id));
    const metrics = driver.metrics();
    const passed = cases.filter((entry) => entry.status === "PASS").length;
    const independentConnectionProof = cases.slice(0, 6).every((entry) =>
      entry.barrier_release_reason === "participants" && !entry.barrier_timed_out);
    return Object.freeze({
      schema_version: "tivdoc-real-postgresql-concurrency-matrix-v0.9.1",
      proof_class: "REAL_POSTGRESQL_DYNAMIC_PROOF",
      application_root: "startCanonicalApplicationPostgres",
      driver: "node-postgres",
      cases: Object.freeze(cases),
      case_count: 7,
      passed_case_count: passed,
      independent_connection_proof: independentConnectionProof,
      connection_attempts: metrics.connection_attempts,
      acquisitions: metrics.acquisitions,
      credentials_recorded: 0,
      customer_data_used: false,
      legal_activation_used: false,
      findings_written: false,
      status: passed === cases.length && independentConnectionProof ? "PASS" : "FAIL",
    });
  });
}

async function duplicateAnalysisRun(
  application: MatrixApplication,
  injector: StatementNameFailureInjector,
  tenantId: string,
  runId: string,
): Promise<ConcurrencyCaseResult> {
  const caseId = `case-v091-${runId}-cc01`;
  await seedCase(application, tenantId, caseId, "cc01-seed");
  const idempotencyKey = `analysis-idem-${runId}-cc01`;
  const command = analysisCommand(caseId, idempotencyKey);
  const input = Object.freeze({
    analysis_run_id: `analysis-run-${runId}-cc01`,
    idempotency_key: idempotencyKey,
    command_sha256: canonicalSha256(command),
    command,
  });
  const race = await gatedRace(injector, "analysis_run_begin", [
    () => application.transaction(tenantId, caseId, (bundle) => bundle.analysis.caseAnalysis.begin(input)),
    () => application.transaction(tenantId, caseId, (bundle) => bundle.analysis.caseAnalysis.begin(input)),
  ]);
  const summary = summarize(race.results, ["ANALYSIS_RUN_ID_COLLISION"]);
  const rowCount = await count(application, tenantId, caseId, "matrix_count_cc01_runs", `
    select count(*)::text as row_count from public.analysis_runs
    where tenant_id = $1 and canonical_case_id = $2`, [tenantId, caseId]);
  const passed = barrierProven(race.barrier) && summary.accepted === 1 && summary.rejected === 1
    && summary.expected_rejections && rowCount === 1;
  return result("CC-01", "duplicate analysis-run creation", 2, "analysis_run_begin", race.barrier.arrived, summary, {
    durable_run_count: rowCount,
    duplicate_prevented: rowCount === 1,
  }, passed, race.barrier);
}

async function jobClaimAndFence(
  application: MatrixApplication,
  injector: StatementNameFailureInjector,
  tenantId: string,
  runId: string,
): Promise<ConcurrencyCaseResult> {
  const caseId = `case-v091-${runId}-cc02`;
  await seedCase(application, tenantId, caseId, "cc02-seed");
  const payload = Object.freeze({ kind: "synthetic_concurrent_job", legally_neutral: true });
  const now = Date.parse(matrixTimestamp(120));
  await application.transaction(tenantId, caseId, async (bundle) => {
    await bundle.runtime.jobs_outbox_audit.enqueue({
      job_id: `job-${runId}-cc02`, tenant_id: tenantId, case_id: caseId,
      job_kind: "synthetic_concurrent_job", idempotency_key: `job-idem-${runId}-cc02`,
      payload_sha256: canonicalSha256(payload), payload, pinned_version_sha256s: [],
      max_attempts: 3, available_at_ms: now - 1_000,
    });
  });
  const race = await gatedRace(injector, "job_claim", [
    () => application.transaction(tenantId, caseId, (bundle) => bundle.runtime.jobs_outbox_audit.claim(`worker-${runId}-a`, now, 60_000, 1)),
    () => application.transaction(tenantId, caseId, (bundle) => bundle.runtime.jobs_outbox_audit.claim(`worker-${runId}-b`, now, 60_000, 1)),
  ]);
  const claimed = race.results.flatMap((entry) => entry.status === "fulfilled" ? [...entry.value] : []);
  const emptyClaims = race.results.filter((entry) => entry.status === "fulfilled" && entry.value.length === 0).length;
  const winner = claimed[0];
  let staleRejected = false;
  let staleError: SafeError | null = null;
  let staleDomainCode: string | null = null;
  let finalState: string | null = null;
  if (winner?.lease_owner) {
    try {
      await application.transaction(tenantId, caseId, (bundle) => bundle.runtime.jobs_outbox_audit.start(
        winner.job_id, winner.lease_owner!, Math.max(0, winner.fencing_token - 1), now + 1,
      ));
    } catch (error) {
      staleRejected = true;
      staleError = safeError(error);
      staleDomainCode = safeDomainCode(error);
    }
    const started = await application.transaction(tenantId, caseId, (bundle) => bundle.runtime.jobs_outbox_audit.start(
      winner.job_id, winner.lease_owner!, winner.fencing_token, now + 2,
    ));
    const retried = await application.transaction(tenantId, caseId, (bundle) => bundle.runtime.jobs_outbox_audit.fail(
      started.job_id, winner.lease_owner!, started.fencing_token, now + 3, 5_000,
    ));
    finalState = retried.state;
  }
  const summary = summarize(race.results, []);
  const errors = staleError ? Object.freeze([...summary.errors, staleError]) : summary.errors;
  const augmented: RaceSummary = Object.freeze({
    accepted: summary.accepted,
    rejected: summary.rejected + (staleRejected ? 1 : 0),
    errors,
    domain_codes: Object.freeze([
      ...summary.domain_codes,
      ...(staleDomainCode ? [staleDomainCode] : []),
    ]),
    expected_rejections: summary.expected_rejections
      && staleRejected
      && staleDomainCode === "STALE_FENCING_TOKEN",
  });
  const passed = barrierProven(race.barrier) && claimed.length === 1 && emptyClaims === 1
    && augmented.expected_rejections && finalState === "retry_wait";
  return result("CC-02", "duplicate job claim and fencing token", 5, "job_claim", race.barrier.arrived, augmented, {
    claimed_job_count: claimed.length,
    empty_claim_count: emptyClaims,
    stale_fence_rejected: staleRejected,
    final_job_state: finalState,
  }, passed, race.barrier);
}

async function approvalAndStaleRevision(
  application: MatrixApplication,
  injector: StatementNameFailureInjector,
  tenantId: string,
  runId: string,
): Promise<ConcurrencyCaseResult> {
  const caseId = `case-v091-${runId}-cc03`;
  await seedCase(application, tenantId, caseId, "cc03-seed");
  const report = await seedReport(application, tenantId, caseId, `analysis-run-${runId}-cc03`, `analysis-idem-${runId}-cc03`, `report-${runId}-cc03`);
  const approvalRace = await gatedRace(injector, "analysis_review_approve", [
    () => application.transaction(tenantId, caseId, (bundle) => bundle.analysis.reports.decide(approvalDecision(`review-${runId}-cc03-a`, report))),
    () => application.transaction(tenantId, caseId, (bundle) => bundle.analysis.reports.decide(approvalDecision(`review-${runId}-cc03-b`, report))),
  ]);
  const approvalSummary = summarize(approvalRace.results, ["REPORT_REVIEW_NOT_ELIGIBLE"]);
  const winner = approvalRace.results.find((entry) => entry.status === "fulfilled");
  const winningTaskId = winner?.status === "fulfilled" ? winner.value.task_id : null;

  let invalidationArrivals = 0;
  let invalidationBarrier: BarrierProof | null = null;
  let invalidationSummary: RaceSummary = Object.freeze({
    accepted: 0,
    rejected: 0,
    errors: Object.freeze([]),
    domain_codes: Object.freeze([]),
    expected_rejections: false,
  });
  if (winningTaskId) {
    const invalidate = (suffix: string) => application.transaction(tenantId, caseId, (bundle) => bundle.analysis.reports.invalidate({
      case_id: caseId,
      report_sha256: report.report_sha256,
      task_id: winningTaskId,
      expected_revision: 1,
      invalidated_at: matrixTimestamp(131),
      reason_sha256: canonicalSha256({ runId, suffix, reason: "synthetic_stale_revision_race" }),
    }));
    const invalidationRace = await gatedRace(injector, "analysis_review_invalidate", [() => invalidate("a"), () => invalidate("b")]);
    invalidationArrivals = invalidationRace.barrier.arrived;
    invalidationBarrier = invalidationRace.barrier;
    invalidationSummary = summarize(invalidationRace.results, ["STALE_REPORT_REVISION"]);
  }
  const versionCount = await count(application, tenantId, caseId, "matrix_count_cc03_reviews", `
    select count(*)::text as row_count from public.engine_review_task_versions
    where tenant_id = $1 and report_sha256 = $2`, [tenantId, report.report_sha256]);
  const combined: RaceSummary = Object.freeze({
    accepted: approvalSummary.accepted + invalidationSummary.accepted,
    rejected: approvalSummary.rejected + invalidationSummary.rejected,
    errors: Object.freeze([...approvalSummary.errors, ...invalidationSummary.errors]),
    domain_codes: Object.freeze([...approvalSummary.domain_codes, ...invalidationSummary.domain_codes]),
    expected_rejections: approvalSummary.expected_rejections && invalidationSummary.expected_rejections,
  });
  const combinedBarrier = combineBarriers(approvalRace.barrier, invalidationBarrier);
  const passed = barrierProven(approvalRace.barrier) && invalidationBarrier !== null && barrierProven(invalidationBarrier)
    && approvalSummary.accepted === 1 && approvalSummary.rejected === 1
    && invalidationSummary.accepted === 1 && invalidationSummary.rejected === 1
    && combined.expected_rejections
    && versionCount === 2;
  return result("CC-03", "concurrent approval and stale report revision", 4, "analysis_review_approve + analysis_review_invalidate", approvalRace.barrier.arrived + invalidationArrivals, combined, {
    approval_winner_count: approvalSummary.accepted,
    approval_rejection_count: approvalSummary.rejected,
    invalidation_winner_count: invalidationSummary.accepted,
    stale_revision_rejection_count: invalidationSummary.rejected,
    durable_review_version_count: versionCount,
  }, passed, combinedBarrier);
}

async function idempotencyCollision(
  application: MatrixApplication,
  injector: StatementNameFailureInjector,
  tenantId: string,
  runId: string,
): Promise<ConcurrencyCaseResult> {
  const caseId = `case-v091-${runId}-cc04`;
  await seedCase(application, tenantId, caseId, "cc04-seed");
  const first = collisionCommand(tenantId, caseId, runId, "first");
  const second = collisionCommand(tenantId, caseId, runId, "second");
  const execute = (command: AtomicCommand) => application.transaction(tenantId, caseId, (bundle) =>
    bundle.runtime.idempotency.execute(bundle.context, command, async () => Object.freeze({
      tenant_id: tenantId,
      case_id: caseId,
      case_revision: 1,
      command_sha256: command.command_sha256,
      audit_event_sha256: canonicalSha256({ command: command.command_sha256, kind: "synthetic_audit_binding" }),
      outbox_ids: Object.freeze([]),
      idempotent_replay: false,
    } satisfies TransactionReceipt)));
  const race = await gatedRace(injector, "idempotency_reserve", [() => execute(first), () => execute(second)]);
  const summary = summarize(race.results, ["IDEMPOTENCY_KEY_COMMAND_MISMATCH"]);
  const rowCount = await count(application, tenantId, caseId, "matrix_count_cc04_idempotency", `
    select count(*)::text as row_count from public.engine_idempotency_records
    where tenant_id = $1 and scope = $2 and idempotency_key = $3`, [tenantId, first.scope, first.idempotency_key]);
  const passed = barrierProven(race.barrier) && summary.accepted === 1 && summary.rejected === 1
    && summary.expected_rejections && rowCount === 1;
  return result("CC-04", "idempotency-key collision with different command hashes", 2, "idempotency_reserve", race.barrier.arrived, summary, {
    durable_idempotency_record_count: rowCount,
    single_command_won: summary.accepted === 1,
    conflicting_command_rejected: summary.rejected === 1,
  }, passed, race.barrier);
}

async function outboxRace(
  application: MatrixApplication,
  injector: StatementNameFailureInjector,
  tenantId: string,
  runId: string,
): Promise<ConcurrencyCaseResult> {
  const caseId = `case-v091-${runId}-cc05`;
  await seedCase(application, tenantId, caseId, "cc05-seed");
  const payload = Object.freeze({ kind: "synthetic_outbox_race", legally_neutral: true });
  const now = Date.parse(matrixTimestamp(150));
  await application.transaction(tenantId, caseId, async (bundle) => {
    await bundle.runtime.jobs_outbox_audit.enqueueOutbox({
      outbox_id: `outbox-${runId}-cc05`, tenant_id: tenantId, case_id: caseId,
      logical_effect_id: `effect-${runId}-cc05`, effect_kind: "synthetic.outbox.race",
      payload_sha256: canonicalSha256(payload), payload, created_at: matrixTimestamp(149),
    });
  });
  const claimRace = await gatedRace(injector, "outbox_claim", [
    () => application.transaction(tenantId, caseId, (bundle) => bundle.runtime.jobs_outbox_audit.claimOutbox(`worker-${runId}-a`, now, 5_000)),
    () => application.transaction(tenantId, caseId, (bundle) => bundle.runtime.jobs_outbox_audit.claimOutbox(`worker-${runId}-b`, now, 5_000)),
  ]);
  const claimed = claimRace.results.flatMap((entry) => entry.status === "fulfilled" && entry.value ? [entry.value] : []);
  const emptyClaims = claimRace.results.filter((entry) => entry.status === "fulfilled" && entry.value === null).length;
  const expired = claimed[0];
  const reclaimNow = now + 5_001;
  const reclaimed = expired?.lease_owner
    ? await application.transaction(tenantId, caseId, (bundle) =>
      bundle.runtime.jobs_outbox_audit.claimOutbox(`worker-${runId}-reclaimer`, reclaimNow, 60_000))
    : null;
  let publishRace: Awaited<ReturnType<typeof gatedRace<Readonly<{ deduplicated: boolean }>>>> | null = null;
  if (expired?.lease_owner && reclaimed?.lease_owner) {
    const logicalEffectSha256 = canonicalSha256({ runId, kind: "synthetic_effect" });
    const publish = (workerId: string, fencingToken: number) => application.transaction(tenantId, caseId, (bundle) =>
      bundle.runtime.jobs_outbox_audit.publishOutbox({
        outbox_id: expired.outbox_id,
        worker_id: workerId,
        fencing_token: fencingToken,
        now_ms: reclaimNow + 1,
        logical_effect_sha256: logicalEffectSha256,
      }));
    publishRace = await gatedRace(injector, "outbox_publish", [
      () => publish(expired.lease_owner!, expired.fencing_token),
      () => publish(reclaimed.lease_owner!, reclaimed.fencing_token),
    ]);
  }
  const effectCount = await count(application, tenantId, caseId, "matrix_count_cc05_effects", `
    select count(*)::text as row_count from public.engine_logical_effect_receipts
    where tenant_id = $1 and logical_effect_id = $2`, [tenantId, `effect-${runId}-cc05`]);
  const base = summarize(claimRace.results, []);
  const publishSummary = publishRace
    ? summarize(publishRace.results, ["STALE_FENCING_TOKEN"])
    : Object.freeze({
      accepted: 0,
      rejected: 0,
      errors: Object.freeze([]) as readonly SafeError[],
      domain_codes: Object.freeze([]) as readonly string[],
      expected_rejections: false,
    });
  const combined: RaceSummary = Object.freeze({
    accepted: base.accepted + (reclaimed ? 1 : 0) + publishSummary.accepted,
    rejected: base.rejected + publishSummary.rejected,
    errors: Object.freeze([...base.errors, ...publishSummary.errors]),
    domain_codes: Object.freeze([...base.domain_codes, ...publishSummary.domain_codes]),
    expected_rejections: base.expected_rejections && publishSummary.expected_rejections,
  });
  const reclaimAdvancedFence = Boolean(expired && reclaimed
    && reclaimed.fencing_token === expired.fencing_token + 1
    && reclaimed.lease_owner !== expired.lease_owner);
  const publishBarrier = publishRace?.barrier ?? null;
  const combinedBarrier = combineBarriers(claimRace.barrier, publishBarrier);
  const passed = barrierProven(claimRace.barrier) && publishBarrier !== null && barrierProven(publishBarrier)
    && claimed.length === 1 && emptyClaims === 1 && reclaimAdvancedFence
    && publishSummary.accepted === 1 && publishSummary.rejected === 1
    && combined.expected_rejections && effectCount === 1;
  return result("CC-05", "outbox claim, expiry/reclaim and fenced publish race", 5, "outbox_claim + outbox_publish", claimRace.barrier.arrived + (publishBarrier?.arrived ?? 0), combined, {
    claimed_event_count: claimed.length,
    empty_claim_count: emptyClaims,
    expired_lease_reclaimed: reclaimAdvancedFence,
    stale_publish_rejected: publishSummary.rejected === 1,
    published: publishSummary.accepted === 1,
    logical_effect_receipt_count: effectCount,
  }, passed, combinedBarrier);
}

async function conflictingCaseUpdate(
  application: MatrixApplication,
  injector: StatementNameFailureInjector,
  tenantId: string,
  runId: string,
): Promise<ConcurrencyCaseResult> {
  const caseId = `case-v091-${runId}-cc06`;
  await seedCase(application, tenantId, caseId, "cc06-seed");
  const update = (suffix: string, stateAfter: "awaiting_fact_resolution" | "release_hold") =>
    application.transaction(tenantId, caseId, (bundle) => bundle.intake.case_lifecycle.append(bundle.context, {
      tenant_id: tenantId,
      case_id: caseId,
      expected_revision: 1,
      state_before: "awaiting_documents",
      state_after: stateAfter,
      event_kind: `cc06-${suffix}`,
      command_sha256: boundaryHashes(`cc06-${suffix}`).command,
      event_sha256: boundaryHashes(`cc06-${suffix}`).event,
      previous_sha256: boundaryHashes("cc06-seed").event,
      state_sha256: boundaryHashes(`cc06-${suffix}`).state,
      occurred_at: matrixTimestamp(160),
    }));
  const race = await gatedRace(injector, "intake_case_update", [
    () => update("facts", "awaiting_fact_resolution"),
    () => update("hold", "release_hold"),
  ]);
  const summary = summarize(race.results, ["INTAKE_REVISION_CONFLICT"]);
  const final = await application.transaction(tenantId, caseId, (bundle) =>
    bundle.intake.case_lifecycle.get(bundle.context, { tenant_id: tenantId, case_id: caseId }));
  const finalRevision = final?.revision ?? null;
  const passed = barrierProven(race.barrier) && summary.accepted === 1 && summary.rejected === 1
    && summary.expected_rejections && finalRevision === 2;
  return result("CC-06", "conflicting optimistic case update", 2, "intake_case_update", race.barrier.arrived, summary, {
    final_case_revision: finalRevision,
    one_update_won: summary.accepted === 1,
    stale_update_rejected: summary.rejected === 1,
  }, passed, race.barrier);
}

async function retryAfterAbort(
  application: MatrixApplication,
  injector: StatementNameFailureInjector,
  tenantId: string,
  runId: string,
): Promise<ConcurrencyCaseResult> {
  const caseId = `case-v091-${runId}-cc07`;
  await seedCase(application, tenantId, caseId, "cc07-seed");
  const execute = () => application.transaction(tenantId, caseId, async (bundle) => {
    const hashes = boundaryHashes("cc07-update");
    const state = await bundle.intake.case_lifecycle.append(bundle.context, {
      tenant_id: tenantId, case_id: caseId, expected_revision: 1,
      state_before: "awaiting_documents", state_after: "awaiting_fact_resolution",
      event_kind: "cc07-update", command_sha256: hashes.command, event_sha256: hashes.event,
      previous_sha256: boundaryHashes("cc07-seed").event, state_sha256: hashes.state,
      occurred_at: matrixTimestamp(170),
    });
    await bundle.runtime.jobs_outbox_audit.append({
      actor_id: "synthetic-matrix-actor", action: "cc07-retry", resource_id: "resource-cc07",
      resource_revision: state.revision, resource_sha256: state.state_sha256,
      reason: "SYNTHETIC_DYNAMIC_VERIFICATION", occurred_at: matrixTimestamp(171),
    });
  });
  const before = await snapshotState(application, tenantId, caseId);
  injector.arm("audit_append");
  let failureRejected = false;
  let failureError: SafeError | null = null;
  let failureDomainCode: string | null = null;
  try {
    await execute();
  } catch (error) {
    failureRejected = true;
    failureError = safeError(error);
    failureDomainCode = safeDomainCode(error);
  }
  const injection = injector.disarm();
  const afterFailure = await snapshotState(application, tenantId, caseId);
  let retrySucceeded = false;
  let retryError: SafeError | null = null;
  try {
    await execute();
    retrySucceeded = true;
  } catch (error) {
    retryError = safeError(error);
  }
  const final = await application.transaction(tenantId, caseId, (bundle) =>
    bundle.intake.case_lifecycle.get(bundle.context, { tenant_id: tenantId, case_id: caseId }));
  const rollbackUnchanged = before.snapshot_sha256 === afterFailure.snapshot_sha256;
  const errors = Object.freeze([...(failureError ? [failureError] : []), ...(retryError ? [retryError] : [])]);
  const summary: RaceSummary = Object.freeze({
    accepted: retrySucceeded ? 1 : 0,
    rejected: failureRejected ? 1 : 0,
    errors,
    domain_codes: Object.freeze(failureDomainCode ? [failureDomainCode] : []),
    expected_rejections: failureRejected
      && failureError?.code === "POSTGRES_TRANSACTION_FAILED"
      && failureDomainCode === null,
  });
  const passed = injection.matched === 1 && injection.injected === 1 && failureRejected
    && summary.expected_rejections && rollbackUnchanged && retrySucceeded && final?.revision === 2;
  return result("CC-07", "deterministic retry after transaction abort", 2, null, 0, summary, {
    injected_failure_count: injection.injected,
    rollback_snapshot_unchanged: rollbackUnchanged,
    retry_succeeded: retrySucceeded,
    final_case_revision: final?.revision ?? null,
  }, passed, null);
}

async function gatedRace<T>(
  injector: StatementNameFailureInjector,
  statementName: string,
  operations: readonly [() => Promise<T>, () => Promise<T>],
): Promise<Readonly<{
  results: readonly PromiseSettledResult<T>[];
  barrier: BarrierProof;
}>> {
  injector.armBarrier(statementName, 2);
  const results = await Promise.allSettled(operations.map((operation) => operation()));
  const barrier = injector.disarmBarrier();
  return Object.freeze({ results: Object.freeze(results), barrier });
}

function summarize<T>(
  results: readonly PromiseSettledResult<T>[],
  expectedDomainCodes: readonly string[],
): RaceSummary {
  const rejected = results.filter((entry): entry is PromiseRejectedResult => entry.status === "rejected");
  const domainCodes = rejected.map((entry) => safeDomainCode(entry.reason));
  const observed = domainCodes.filter((value): value is string => value !== null).sort();
  const expected = [...expectedDomainCodes].sort();
  return Object.freeze({
    accepted: results.length - rejected.length,
    rejected: rejected.length,
    errors: Object.freeze(rejected.map((entry) => safeError(entry.reason))),
    domain_codes: Object.freeze(observed),
    expected_rejections: rejected.length === expected.length
      && JSON.stringify(observed) === JSON.stringify(expected),
  });
}

function result(
  caseId: ConcurrencyCaseResult["case_id"],
  scenario: string,
  independentTransactions: number,
  barrierStatement: string | null,
  barrierArrivals: number,
  summary: RaceSummary,
  observations: Readonly<Record<string, SafeObservation>>,
  passed: boolean,
  barrier: BarrierProof | null,
): ConcurrencyCaseResult {
  return Object.freeze({
    case_id: caseId,
    scenario,
    independent_transactions: independentTransactions,
    barrier_statement: barrierStatement,
    barrier_arrivals: barrierArrivals,
    barrier_release_reason: barrier?.release_reason ?? null,
    barrier_timed_out: barrier?.timed_out ?? false,
    accepted_count: summary.accepted,
    rejected_count: summary.rejected,
    rejected_errors: summary.errors,
    rejected_domain_codes: summary.domain_codes,
    expected_rejection_semantics: summary.expected_rejections,
    observations: Object.freeze({ ...observations }),
    status: passed ? "PASS" : "FAIL",
  });
}

function safeDomainCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("domain_code" in error)) return null;
  const value = (error as { domain_code?: unknown }).domain_code;
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{2,80}$/u.test(value) ? value : null;
}

function barrierProven(barrier: BarrierProof): boolean {
  return barrier.release_reason === "participants"
    && !barrier.timed_out
    && barrier.arrived_at_release === 2;
}

function combineBarriers(first: BarrierProof, second: BarrierProof | null): BarrierProof {
  if (!second) return first;
  const proven = barrierProven(first) && barrierProven(second);
  return Object.freeze({
    arrived: first.arrived + second.arrived,
    released: first.released && second.released,
    release_reason: proven ? "participants" : (first.timed_out || second.timed_out ? "timeout" : "disarm"),
    arrived_at_release: (first.arrived_at_release ?? 0) + (second.arrived_at_release ?? 0),
    timed_out: first.timed_out || second.timed_out,
  });
}

async function count(
  application: MatrixApplication,
  tenantId: string,
  caseId: string,
  name: string,
  text: string,
  values: readonly string[],
): Promise<number> {
  return application.transaction(tenantId, caseId, async (bundle) => {
    const response = await bundle.context.client.query(statement(name, text, values));
    const raw = response.rows[0]?.row_count;
    if (typeof raw !== "string" || !/^\d+$/u.test(raw)) throw new Error("MATRIX_COUNT_ROW_INVALID");
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed)) throw new Error("MATRIX_COUNT_ROW_INVALID");
    return parsed;
  });
}

function collisionCommand(
  tenantId: string,
  caseId: string,
  runId: string,
  variant: "first" | "second",
): AtomicCommand {
  const payload = Object.freeze({ schema_version: "tivdoc-v091-collision-command", variant, case_id: caseId });
  return Object.freeze({
    tenant_id: tenantId,
    case_id: caseId,
    actor_id: "synthetic-matrix-actor",
    scope: `matrix.cc04.${runId}`,
    idempotency_key: `idem-${runId}-cc04-shared`,
    expected_case_revision: 1,
    command_sha256: canonicalSha256(payload),
    command: payload,
    occurred_at: matrixTimestamp(140),
    writes: Object.freeze([]),
    invalidates: Object.freeze([]),
    outbox: Object.freeze([]),
  });
}
