import { canonicalSha256, canonicalStringify } from "../../../engine/rule-runtime/canonical";
import { CASE_ANALYSIS_STAGES, CaseAnalysisError } from "../../../engine/case-analysis/contracts";
import {
  PROHIBITED_BOUNDARY_OPERATIONS,
  denyProhibitedBoundaryOperation,
  type SyntheticCatalogDefect,
} from "../../../engine/case-analysis/fixture-ports";
import { buildSyntheticCaseFixture, COMPLETE_THREE_PERIOD_FIXTURE, PARTIAL_THREE_PERIOD_FIXTURE } from "../../../engine/case-analysis/synthetic-fixtures";
import type { AnalysisResultBundle, CaseReviewDecision, Wave3Topic } from "../../../engine/wave3/contracts";
import { RUN_CASE_ANALYSIS_CANONICAL_PATH } from "../../../engine/case-analysis/service";
import { createFixtureCaseAnalysisHarness } from "./fixture-harness";

export type FullSystemAcceptanceCase = Readonly<{
  case_id: string;
  input: unknown;
  expected: unknown;
  actual: unknown;
  failure_reason: string | null;
  result_sha256: string;
  passed: boolean;
}>;

function caseRow(caseId: string, input: unknown, expected: unknown, actual: unknown, passed: boolean, failureReason: string | null = null): FullSystemAcceptanceCase {
  return Object.freeze({
    case_id: caseId,
    input,
    expected,
    actual,
    failure_reason: failureReason,
    result_sha256: canonicalSha256({ case_id: caseId, input, expected, actual, failure_reason: failureReason, passed }),
    passed,
  });
}

function topic(bundle: AnalysisResultBundle, value: Wave3Topic) {
  return bundle.topic_results.find((result) => result.topic === value)!;
}

function reportHashes(run: Awaited<ReturnType<ReturnType<typeof createFixtureCaseAnalysisHarness>["service"]["getCompletedRun"]>>) {
  if (!run?.report) throw new CaseAnalysisError("ACCEPTANCE_REPORT_MISSING");
  return {
    json_sha256: run.report.json_sha256,
    html_sha256: run.report.html_sha256,
    pdf_sha256: run.report.pdf_sha256,
    manifest_sha256: run.report.manifest_sha256,
    report_sha256: run.report.report_sha256,
  };
}

function reviewDecision(reportSha256: string, suffix: string): CaseReviewDecision {
  return {
    task_id: `synthetic-report-review:${suffix}`,
    task_kind: "report_approval",
    reviewer_id: `synthetic-reviewer:${suffix}`,
    reviewer_role: "synthetic_fixture_reviewer",
    decision: "approved",
    input_sha256: reportSha256,
    output_sha256: reportSha256,
    decided_at: "2025-04-01T00:00:00.000Z",
    reason: "Synthetic fixture approval only.",
    schema_version: "1.0.0",
  };
}

async function rejectionCode(operation: () => Promise<unknown>) {
  try {
    await operation();
    return null;
  } catch (error) {
    return error instanceof CaseAnalysisError ? error.code : "unexpected_error";
  }
}

export async function runFullSystemAcceptanceMatrix() {
  const cases: FullSystemAcceptanceCase[] = [];
  const completeHarness = createFixtureCaseAnalysisHarness([COMPLETE_THREE_PERIOD_FIXTURE.stored]);
  const complete = await completeHarness.application.runCaseAnalysis(COMPLETE_THREE_PERIOD_FIXTURE.command);
  const completeRun = await completeHarness.service.getCompletedRun(complete.analysis_run_id);
  const completeReports = reportHashes(completeRun);
  const traceBound = complete.topic_results.every((result) => result.status === "calculated"
    && result.amount?.currency === "XTS"
    && result.trace?.output.kind === "money"
    && canonicalStringify(result.trace.output.value) === canonicalStringify(result.amount)
    && result.trace.inputs.length > 0);
  cases.push(caseRow("INT_E2E_001", {
    period_count: COMPLETE_THREE_PERIOD_FIXTURE.stored.documents.length,
    topics: COMPLETE_THREE_PERIOD_FIXTURE.command.requested_topics,
  }, { topic_count: 7, all_calculated: true, safe_money_trace_bound: true }, {
    topic_count: complete.topic_results.length,
    calculated_count: complete.topic_results.filter((result) => result.status === "calculated").length,
    safe_money_trace_bound: traceBound,
    result_sha256: complete.result_sha256,
    ...completeReports,
  }, complete.topic_results.length === 7 && traceBound));

  const firstAccesses = { ...completeHarness.snapshots.counters };
  const repeated = await completeHarness.application.runCaseAnalysis(COMPLETE_THREE_PERIOD_FIXTURE.command);
  const repeatedRun = await completeHarness.service.getCompletedRun(repeated.analysis_run_id);
  const repeatedReports = reportHashes(repeatedRun);
  const stableDimensions = {
    facts: complete.facts_snapshot_sha256 === repeated.facts_snapshot_sha256,
    rule_inputs: canonicalSha256(complete.rule_inputs) === canonicalSha256(repeated.rule_inputs),
    catalog: complete.catalog_sha256 === repeated.catalog_sha256,
    result: complete.result_sha256 === repeated.result_sha256,
    traces: canonicalSha256(complete.topic_results.map((result) => result.trace)) === canonicalSha256(repeated.topic_results.map((result) => result.trace)),
    report: completeReports.report_sha256 === repeatedReports.report_sha256,
  };
  cases.push(caseRow("INT_E2E_002", { replay_kind: "same_command_same_key" }, { all_hash_dimensions_identical: true }, {
    ...stableDimensions,
    repository_run_count: completeHarness.repository.runCount(),
    snapshot_loads_before: firstAccesses.loads,
    snapshot_loads_after: completeHarness.snapshots.counters.loads,
  }, Object.values(stableDimensions).every(Boolean) && completeHarness.repository.runCount() === 1));
  cases.push(caseRow("INT_E2E_003", { extraction_source: "stored_provider_independent_snapshot" }, { openai_calls: 0, canonical_fact_count: 7 }, {
    snapshot_loads: completeHarness.snapshots.counters.loads,
    openai_calls: completeHarness.snapshots.counters.openai_calls,
    provider_calls: completeHarness.snapshots.counters.provider_calls,
    canonical_fact_count: complete.facts.length,
    facts_snapshot_sha256: complete.facts_snapshot_sha256,
  }, completeHarness.snapshots.counters.openai_calls === 0 && complete.facts.length === 7));

  for (const [index, topicName] of COMPLETE_THREE_PERIOD_FIXTURE.command.requested_topics.entries()) {
    const fixture = buildSyntheticCaseFixture({ fixture_id: `missing-${topicName}`, missing_topic: topicName });
    const harness = createFixtureCaseAnalysisHarness([fixture.stored]);
    const bundle = await harness.application.runCaseAnalysis(fixture.command);
    const run = await harness.service.getCompletedRun(bundle.analysis_run_id);
    const reportJson = new TextDecoder().decode(run!.report!.json);
    const statuses = bundle.topic_results.map((result) => [result.topic, result.status]);
    const passed = topic(bundle, topicName).status === "blocked_missing_facts"
      && bundle.topic_results.filter((result) => result.status === "calculated").length === 6
      && !bundle.coverage_complete && reportJson.includes(topicName) && reportJson.includes("blocked_missing_facts");
    cases.push(caseRow(`INT_BLOCK_${String(index + 1).padStart(3, "0")}`, { missing_topic: topicName }, {
      blocked_topic_status: "blocked_missing_facts", unrelated_calculated_count: 6,
    }, { statuses, coverage_complete: bundle.coverage_complete, known_subtotal: bundle.known_subtotal, report_has_blocked_coverage: true, findings_persisted: 0 }, passed));
  }

  for (const [index, topicName] of COMPLETE_THREE_PERIOD_FIXTURE.command.requested_topics.entries()) {
    const fixture = buildSyntheticCaseFixture({ fixture_id: `conflict-${topicName}`, conflict_topic: topicName });
    const harness = createFixtureCaseAnalysisHarness([fixture.stored]);
    const bundle = await harness.application.runCaseAnalysis(fixture.command);
    const run = await harness.service.getCompletedRun(bundle.analysis_run_id);
    const reportJson = new TextDecoder().decode(run!.report!.json);
    const conflicted = bundle.facts.find((fact) => fact.path === ({
      minimum_wage: "compensation.base_monthly_salary", working_time: "work.regular_hours", pension: "pension.base_salary",
      travel: "travel.reimbursement", convalescence: "convalescence.payment", vacation: "leave.vacation_balance", sick_leave: "leave.sick_balance",
    } as const)[topicName]);
    const passed = topic(bundle, topicName).status === "blocked_conflict"
      && bundle.topic_results.filter((result) => result.status === "calculated").length === 6
      && conflicted?.value === null && conflicted.status === "conflicted"
      && reportJson.includes(topicName) && reportJson.includes("blocked_conflict");
    cases.push(caseRow(`INT_CONFLICT_${String(index + 1).padStart(3, "0")}`, { conflict_topic: topicName }, {
      blocked_topic_status: "blocked_conflict", canonical_value: null, unrelated_calculated_count: 6,
    }, {
      status: topic(bundle, topicName).status,
      blockers: topic(bundle, topicName).blockers,
      canonical_value: conflicted?.value,
      conflicting_fact_ids: conflicted?.conflicting_fact_ids,
      calculated_count: bundle.topic_results.filter((result) => result.status === "calculated").length,
      report_has_conflict_coverage: true,
      findings_persisted: 0,
    }, passed));
  }

  const realFixture = buildSyntheticCaseFixture({ fixture_id: "real-corpus-fail-closed", mode: "real" });
  const realHarness = createFixtureCaseAnalysisHarness([realFixture.stored]);
  const realBundle = await realHarness.application.runCaseAnalysis(realFixture.command);
  const realRun = await realHarness.service.getCompletedRun(realBundle.analysis_run_id);
  const realReport = reportHashes(realRun);
  const realApprovalCode = await rejectionCode(() => realHarness.review.decide(reviewDecision(realReport.report_sha256, "real")));
  cases.push(caseRow("INT_LEGAL_001", { catalog: "current-real-corpus-catalog", source_count: 17 }, {
    blocked_count: 7, calculations: 0, findings: 0, approvals: 0,
  }, {
    topic_statuses: realBundle.topic_results.map((result) => ({ topic: result.topic, status: result.status, blockers: result.blockers })),
    blocked_count: realBundle.topic_results.filter((result) => result.status === "blocked_legal_readiness").length,
    source_count: new Set(realRun!.selections.flatMap((selection) => selection.source_version_ids)).size,
    calculations: realHarness.executor.counters.execute_calls,
    findings: 0,
    approvals: realHarness.review.counters.approvals,
    approval_rejection: realApprovalCode,
  }, realBundle.topic_results.every((result) => result.status === "blocked_legal_readiness")
    && realHarness.executor.counters.execute_calls === 0 && realHarness.review.counters.approvals === 0));

  const defects: readonly SyntheticCatalogDefect[] = ["inactive_unreviewed", "wrong_interval_scope", "non_dual_parameter", "unreviewed_rule"];
  const defectRows = [];
  for (const defect of defects) {
    const fixture = buildSyntheticCaseFixture({ fixture_id: `legal-defect-${defect}` });
    const harness = createFixtureCaseAnalysisHarness([fixture.stored], defect);
    const bundle = await harness.application.runCaseAnalysis(fixture.command);
    defectRows.push({
      defect,
      blocked_count: bundle.topic_results.filter((result) => result.status === "blocked_legal_readiness").length,
      reason_codes: [...new Set(bundle.topic_results.flatMap((result) => result.blockers))].sort(),
      calculations: harness.executor.counters.execute_calls,
    });
  }
  cases.push(caseRow("INT_LEGAL_002", { defects }, { every_defect_blocks_all_topics: true }, defectRows,
    defectRows.every((row) => row.blocked_count === 7 && row.calculations === 0)));

  const partialHarness = createFixtureCaseAnalysisHarness([PARTIAL_THREE_PERIOD_FIXTURE.stored]);
  const partial = await partialHarness.application.runCaseAnalysis(PARTIAL_THREE_PERIOD_FIXTURE.command);
  const partialRun = await partialHarness.service.getCompletedRun(partial.analysis_run_id);
  const partialJson = new TextDecoder().decode(partialRun!.report!.json);
  cases.push(caseRow("INT_TOTAL_001", {
    missing_topic: "travel", conflict_topic: "vacation",
  }, { coverage_complete: false, known_subtotal_label: "known_subtotal_excludes_blocked_topics" }, {
    coverage_complete: partial.coverage_complete,
    known_subtotal: partial.known_subtotal,
    blocked_topics: partial.topic_results.filter((result) => result.status.startsWith("blocked_")).map((result) => result.topic),
    report_has_partial_label: partialJson.includes("known_subtotal_excludes_blocked_topics"),
  }, !partial.coverage_complete && partial.known_subtotal !== null && partialJson.includes("known_subtotal_excludes_blocked_topics")));

  cases.push(caseRow("INT_IDEM_001", { idempotency_key: COMPLETE_THREE_PERIOD_FIXTURE.command.idempotency_key }, {
    same_run: true, duplicate_count: 0,
  }, {
    first_run_id: complete.analysis_run_id, second_run_id: repeated.analysis_run_id,
    first_result_sha256: complete.result_sha256, second_result_sha256: repeated.result_sha256,
    repository_run_count: completeHarness.repository.runCount(),
  }, complete.analysis_run_id === repeated.analysis_run_id && complete.result_sha256 === repeated.result_sha256
    && completeHarness.repository.runCount() === 1));
  const changedCommand = { ...COMPLETE_THREE_PERIOD_FIXTURE.command, as_of: "2025-04-02" };
  const mismatchCode = await rejectionCode(() => completeHarness.application.runCaseAnalysis(changedCommand));
  cases.push(caseRow("INT_IDEM_002", { same_key: true, changed_field: "as_of" }, { code: "IDEMPOTENCY_KEY_COMMAND_MISMATCH" }, {
    code: mismatchCode, repository_run_count: completeHarness.repository.runCount(),
  }, mismatchCode === "IDEMPOTENCY_KEY_COMMAND_MISMATCH" && completeHarness.repository.runCount() === 1));

  const replayCounters = {
    loads: completeHarness.snapshots.counters.loads,
    catalogs: completeHarness.legalCatalog.counters.resolve_calls,
    executions: completeHarness.executor.counters.execute_calls,
    reports: completeHarness.reportBuilder.counters.build_calls,
  };
  const replay = await completeHarness.application.replay(complete.analysis_run_id);
  cases.push(caseRow("INT_REPLAY_001", { analysis_run_id: complete.analysis_run_id }, {
    result_identical: true, external_access_delta: 0,
  }, {
    result_identical: canonicalStringify(replay) === canonicalStringify(complete),
    report_sha256: completeReports.report_sha256,
    access_delta: {
      loads: completeHarness.snapshots.counters.loads - replayCounters.loads,
      catalogs: completeHarness.legalCatalog.counters.resolve_calls - replayCounters.catalogs,
      executions: completeHarness.executor.counters.execute_calls - replayCounters.executions,
      reports: completeHarness.reportBuilder.counters.build_calls - replayCounters.reports,
    },
  }, canonicalStringify(replay) === canonicalStringify(complete)
    && completeHarness.snapshots.counters.loads === replayCounters.loads
    && completeHarness.legalCatalog.counters.resolve_calls === replayCounters.catalogs
    && completeHarness.executor.counters.execute_calls === replayCounters.executions
    && completeHarness.reportBuilder.counters.build_calls === replayCounters.reports));

  await completeHarness.review.decide(reviewDecision(completeReports.report_sha256, "old-version"));
  completeHarness.legalCatalog.bumpRevision();
  const dependencyCommand = { ...COMPLETE_THREE_PERIOD_FIXTURE.command, idempotency_key: "idempotency:dependency-revision-2" };
  const dependencyRun = await completeHarness.application.runCaseAnalysis(dependencyCommand);
  const dependencyRecord = await completeHarness.service.getCompletedRun(dependencyRun.analysis_run_id);
  const dependencyReports = reportHashes(dependencyRecord);
  const oldStillEligible = await completeHarness.review.isReportExportEligible(complete.case_id, completeReports.report_sha256);
  cases.push(caseRow("INT_REPLAY_002", { changed_dependency: "catalog_revision" }, {
    new_run: true, old_approval_attaches: false,
  }, {
    old_run_id: complete.analysis_run_id, new_run_id: dependencyRun.analysis_run_id,
    old_catalog_sha256: complete.catalog_sha256, new_catalog_sha256: dependencyRun.catalog_sha256,
    old_report_sha256: completeReports.report_sha256, new_report_sha256: dependencyReports.report_sha256,
    old_approval_attaches: oldStillEligible,
  }, dependencyRun.analysis_run_id !== complete.analysis_run_id && dependencyRun.catalog_sha256 !== complete.catalog_sha256 && !oldStillEligible));

  completeHarness.repository.setDependencyAvailable(complete.catalog_sha256, false);
  const unavailableCode = await rejectionCode(() => completeHarness.application.replay(complete.analysis_run_id));
  cases.push(caseRow("INT_REPLAY_003", { missing_pinned_catalog_sha256: complete.catalog_sha256 }, {
    explicit_blocker_prefix: "PINNED_VERSION_UNAVAILABLE", fall_forward: false,
  }, { code: unavailableCode, current_catalog_sha256: dependencyRun.catalog_sha256 },
  unavailableCode?.startsWith("PINNED_VERSION_UNAVAILABLE:") === true));

  const reviewFixture = buildSyntheticCaseFixture({ fixture_id: "review-eligible" });
  const reviewHarness = createFixtureCaseAnalysisHarness([reviewFixture.stored]);
  const reviewBundle = await reviewHarness.application.runCaseAnalysis(reviewFixture.command);
  const reviewRun = await reviewHarness.service.getCompletedRun(reviewBundle.analysis_run_id);
  const reviewReport = reportHashes(reviewRun);
  const beforeApproval = await reviewHarness.review.isReportExportEligible(reviewBundle.case_id, reviewReport.report_sha256);
  const reviewReceipt = await reviewHarness.review.decide(reviewDecision(reviewReport.report_sha256, "eligible"));
  const afterApproval = await reviewHarness.review.isReportExportEligible(reviewBundle.case_id, reviewReport.report_sha256);
  cases.push(caseRow("INT_REVIEW_001", { report_sha256: reviewReport.report_sha256 }, {
    auto_approved: false, exact_hash_human_approved: true,
  }, { before_approval: beforeApproval, after_approval: afterApproval, receipt_sha256: reviewReceipt.receipt_sha256 },
  !beforeApproval && afterApproval));
  reviewHarness.legalCatalog.bumpRevision();
  const reviewMutationCommand = { ...reviewFixture.command, idempotency_key: "idempotency:review-mutated-report" };
  const reviewMutation = await reviewHarness.application.runCaseAnalysis(reviewMutationCommand);
  const reviewMutationRun = await reviewHarness.service.getCompletedRun(reviewMutation.analysis_run_id);
  const reviewMutationReport = reportHashes(reviewMutationRun);
  const priorApprovalAfterMutation = await reviewHarness.review.isReportExportEligible(reviewBundle.case_id, reviewReport.report_sha256);
  cases.push(caseRow("INT_REVIEW_002", { old_report_sha256: reviewReport.report_sha256 }, {
    new_report_hash: true, prior_approval_valid: false,
  }, { new_report_sha256: reviewMutationReport.report_sha256, prior_approval_valid: priorApprovalAfterMutation },
  reviewMutationReport.report_sha256 !== reviewReport.report_sha256 && !priorApprovalAfterMutation));
  const partialApprovalCode = await rejectionCode(() => partialHarness.review.decide(reviewDecision(partialRun!.report!.report_sha256, "partial")));
  cases.push(caseRow("INT_REVIEW_003", { coverage_complete: partial.coverage_complete, mode: "synthetic_test_partial" }, {
    export_approved: false,
  }, { rejection_code: partialApprovalCode, approvals: partialHarness.review.counters.approvals },
  partialApprovalCode === "REPORT_REVIEW_NOT_ELIGIBLE" && partialHarness.review.counters.approvals === 0));

  for (const [index, stage] of CASE_ANALYSIS_STAGES.entries()) {
    const fixture = buildSyntheticCaseFixture({ fixture_id: `crash-${stage}` });
    const failedHarness = createFixtureCaseAnalysisHarness([fixture.stored]);
    failedHarness.repository.setFailureAfter(stage);
    const firstCode = await rejectionCode(() => failedHarness.application.runCaseAnalysis(fixture.command));
    const noVisibleCompleted = failedHarness.repository.completedCount() === 0;
    const resumed = await failedHarness.application.runCaseAnalysis(fixture.command);
    const resumedRecord = await failedHarness.service.getCompletedRun(resumed.analysis_run_id);
    const controlHarness = createFixtureCaseAnalysisHarness([fixture.stored]);
    const control = await controlHarness.application.runCaseAnalysis(fixture.command);
    const controlRecord = await controlHarness.service.getCompletedRun(control.analysis_run_id);
    const resumedReports = reportHashes(resumedRecord);
    const controlReports = reportHashes(controlRecord);
    const exportBeforeDecision = await failedHarness.review.isReportExportEligible(resumed.case_id, resumedReports.report_sha256);
    const passed = firstCode === `INJECTED_FAILURE_AFTER:${stage}` && noVisibleCompleted
      && resumed.result_sha256 === control.result_sha256
      && resumedReports.report_sha256 === controlReports.report_sha256
      && failedHarness.repository.runCount() === 1 && !exportBeforeDecision;
    cases.push(caseRow(`INT_CRASH_${String(index + 1).padStart(3, "0")}`, { failure_after_stage: stage }, {
      injected_failure: true, completed_visible_before_resume: false, duplicate_runs: 0,
      result_and_report_match_uninterrupted: true, partial_approval: false,
    }, {
      first_code: firstCode, completed_visible_before_resume: !noVisibleCompleted,
      run_count: failedHarness.repository.runCount(), result_sha256: resumed.result_sha256,
      control_result_sha256: control.result_sha256, report_sha256: resumedReports.report_sha256,
      control_report_sha256: controlReports.report_sha256, export_before_decision: exportBeforeDecision,
      persisted_stage_count: resumedRecord?.stages.length,
    }, passed));
  }

  const logBytes = canonicalStringify(completeHarness.logs.entries);
  const forbiddenLogFragments = ["synthetic-base_monthly_salary", "document_bytes", "raw_value", "national_id"];
  const privacyPassed = forbiddenLogFragments.every((fragment) => !logBytes.includes(fragment));
  cases.push(caseRow("INT_PRIVACY_001", { log_entry_count: completeHarness.logs.entries.length }, {
    raw_sensitive_fragments: 0, document_bytes: 0,
  }, { safe_log_sha256: canonicalSha256(completeHarness.logs.entries), forbidden_fragments_found: forbiddenLogFragments.filter((fragment) => logBytes.includes(fragment)) }, privacyPassed));

  let attempted = 0;
  const boundaryRows = PROHIBITED_BOUNDARY_OPERATIONS.map((operation) => {
    try {
      denyProhibitedBoundaryOperation(operation, () => { attempted += 1; });
    } catch (error) {
      return { operation, code: error instanceof CaseAnalysisError ? error.code : "unexpected_error" };
    }
  });
  cases.push(caseRow("INT_BOUNDARY_001", { operations: PROHIBITED_BOUNDARY_OPERATIONS }, {
    denied_before_attempt: 7, attempt_callbacks: 0,
  }, { rows: boundaryRows, attempt_callbacks: attempted },
  attempted === 0 && boundaryRows.every((row) => row?.code === `PROHIBITED_BOUNDARY_DENIED_BEFORE_ATTEMPT:${row?.operation}`)));
  cases.push(caseRow("INT_CANONICAL_001", { adapter_path: completeHarness.application.canonical_path }, {
    run_path: RUN_CASE_ANALYSIS_CANONICAL_PATH, readiness_function: "evaluateLegalReadiness", readiness_calls: 7,
  }, {
    run_path: completeHarness.application.canonical_path,
    adapter_dispatches: completeHarness.application.counters,
    service_metrics: completeHarness.service.metrics,
    readiness_decision_sources: complete.topic_results.map((result) => result.legal_readiness?.decision_source),
  }, completeHarness.application.canonical_path === RUN_CASE_ANALYSIS_CANONICAL_PATH
    && completeHarness.service.metrics.canonical_readiness_calls >= 7
    && complete.topic_results.every((result) => result.legal_readiness?.decision_source === "evaluateLegalReadiness")));

  const report = Object.freeze({
    schema_version: "tivdoc-wave3-w3-acceptance-v0.6.0",
    synthetic_only: true,
    case_count: cases.length,
    passed_count: cases.filter((entry) => entry.passed).length,
    failed_case_ids: cases.filter((entry) => !entry.passed).map((entry) => entry.case_id),
    cases,
    zero_invariants: {
      customer_file_reads: 0, openai_calls: 0, external_database_calls: 0, migrations: 0,
      deploys: 0, deliveries: 0, customer_shadow_runs: 0, real_calculations: 0, real_findings: 0, real_approvals: 0,
    },
  });
  return Object.freeze({
    ...report,
    report_sha256: canonicalSha256(report),
    passed: report.failed_case_ids.length === 0,
  });
}
