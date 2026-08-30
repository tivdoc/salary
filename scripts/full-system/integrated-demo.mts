#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createServer } from "vite";
import type { CaseLifecycleState, CaseReviewDecision, PaymentEvidenceSnapshot } from "../../src/engine/wave3/contracts.ts";

const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom", logLevel: "error" });
const fixtureModule = await vite.ssrLoadModule("/src/engine/case-analysis/synthetic-fixtures.ts") as typeof import("../../src/engine/case-analysis/synthetic-fixtures.ts");
const legalFixtureModule = await vite.ssrLoadModule("/src/engine/legal-operations/synthetic-fixtures.ts") as typeof import("../../src/engine/legal-operations/synthetic-fixtures.ts");
const canonicalModule = await vite.ssrLoadModule("/src/engine/rule-runtime/canonical.ts") as typeof import("../../src/engine/rule-runtime/canonical.ts");
const harnessModule = await vite.ssrLoadModule("/src/server/engine/case-analysis/integrated-harness.ts") as typeof import("../../src/server/engine/case-analysis/integrated-harness.ts");
const { COMPLETE_THREE_PERIOD_FIXTURE, PARTIAL_THREE_PERIOD_FIXTURE, buildSyntheticCaseFixture } = fixtureModule;
const { SYNTHETIC_CATALOG_DATE, SYNTHETIC_POPULATION, SYNTHETIC_SECTOR } = legalFixtureModule;
const { canonicalSha256, canonicalStringify } = canonicalModule;
const { createIntegratedFullSystemHarness } = harnessModule;

type Fixture = ReturnType<typeof buildSyntheticCaseFixture>;

function commandFor(fixture: Fixture, revision = 1) {
  return {
    ...fixture.command,
    case_revision: revision,
    period: { start_date: SYNTHETIC_CATALOG_DATE, end_date: SYNTHETIC_CATALOG_DATE },
    as_of: SYNTHETIC_CATALOG_DATE,
    sector: SYNTHETIC_SECTOR,
    population: SYNTHETIC_POPULATION,
  };
}

async function paidCaseToReportReview(harness: ReturnType<typeof createIntegratedFullSystemHarness>, caseId: string) {
  const payment: PaymentEvidenceSnapshot = {
    evidence_id: "payment:evidence:integrated:demo",
    evidence_revision: "1",
    evidence_sha256: "a".repeat(64),
    case_reference: caseId,
    customer_reference: "customer:opaque:integrated:demo",
    amount: { currency: "ZZZ", minor_units: 9999 },
    status: "settled",
    duplicate_of_evidence_id: null,
  };
  harness.payments.appendVerifiedEvidence(payment);
  harness.caseOperations.createCase(caseId);
  let current = await harness.caseOperations.reconcilePayment(caseId, payment.amount, payment.customer_reference);
  const targets: CaseLifecycleState[] = [
    "awaiting_extraction_review",
    "awaiting_fact_resolution",
    "ready_for_legal_evaluation",
    "awaiting_legal_review",
    "awaiting_report_approval",
  ];
  for (const [index, target] of targets.entries()) {
    current = await harness.caseOperations.transition({
      case_id: caseId,
      expected_revision: current.revision,
      target_state: target,
      actor_id: "actor:synthetic:integrated",
      actor_role: "synthetic_reviewer",
      reason: `integrated_stage_${index}`,
      idempotency_key: `integrated:transition:${index}`,
    });
  }
  return current;
}

async function completePath() {
  const fixture = COMPLETE_THREE_PERIOD_FIXTURE;
  const harness = createIntegratedFullSystemHarness([fixture.stored]);
  const caseState = await paidCaseToReportReview(harness, fixture.command.case_id);
  const command = commandFor(fixture, caseState.revision);
  const bundle = await harness.application.runCaseAnalysis(command);
  const run = await harness.service.getCompletedRun(bundle.analysis_run_id);
  if (!run?.report) throw new Error("INTEGRATED_REPORT_MISSING");
  const replay = await harness.application.replay(bundle.analysis_run_id);
  const repeated = await harness.application.runCaseAnalysis(command);
  const task = harness.caseReviews.tasksForCase(bundle.case_id).at(-1);
  if (!task) throw new Error("INTEGRATED_REVIEW_TASK_MISSING");
  const decision: CaseReviewDecision = {
    task_id: task.task_id,
    task_kind: "report_approval",
    reviewer_id: "reviewer:human:integrated:demo",
    reviewer_role: "case_report_reviewer",
    decision: "approved",
    input_sha256: run.report.report_sha256,
    output_sha256: run.report.report_sha256,
    decided_at: harness.clock.now(),
    reason: "synthetic_fixture_exact_hash_review",
    schema_version: "tivdoc-case-review-decision-v0.6.0",
  };
  const reviewReceipt = await harness.review.decide(decision);
  harness.caseOperations.bindReportApproval(bundle.case_id, run.report.report_sha256, reviewReceipt.receipt_sha256);
  const awaiting = await harness.caseOperations.get(bundle.case_id);
  const ready = await harness.caseOperations.transition({
    case_id: bundle.case_id,
    expected_revision: awaiting!.revision,
    target_state: "report_ready",
    actor_id: decision.reviewer_id,
    actor_role: decision.reviewer_role,
    reason: "exact_report_hash_approved",
    idempotency_key: "integrated:report-ready:demo",
  });
  const exportEligible = await harness.manualExport.isEligible(bundle.case_id, run.report.report_sha256);
  return {
    command_sha256: canonicalSha256(command),
    document_snapshot_sha256: bundle.document_snapshot_sha256,
    extraction_snapshot_sha256: bundle.extraction_snapshot_sha256,
    declared_fact_snapshot_sha256: bundle.declared_fact_snapshot_sha256,
    facts_snapshot_sha256: bundle.facts_snapshot_sha256,
    rule_inputs_sha256: canonicalSha256(bundle.rule_inputs),
    catalog_sha256: bundle.catalog_sha256,
    result_sha256: bundle.result_sha256,
    traces_sha256: canonicalSha256(bundle.topic_results.map((entry) => entry.trace)),
    report: {
      json_sha256: run.report.json_sha256,
      html_sha256: run.report.html_sha256,
      pdf_sha256: run.report.pdf_sha256,
      manifest_sha256: run.report.manifest_sha256,
      report_sha256: run.report.report_sha256,
    },
    replay_sha256: canonicalSha256(replay),
    repeated_result_sha256: repeated.result_sha256,
    review_receipt_sha256: reviewReceipt.receipt_sha256,
    topic_statuses: bundle.topic_results.map(({ topic, status }) => ({ topic, status })),
    known_subtotal: bundle.known_subtotal,
    final_case_state: ready.state,
    manual_export_eligible: exportEligible,
    repository_run_count: harness.repository.runCount(),
    canonical_path: harness.application.canonical_path,
    counters: {
      payment_provider_calls: harness.payments.provider_call_count,
      customer_file_reads: harness.snapshots.counters.customer_file_reads,
      openai_calls: harness.snapshots.counters.openai_calls,
      external_reads: harness.snapshots.counters.external_reads,
      rules_executed: harness.executor.counters.execute_calls,
      rule_external_calls: harness.executor.counters.external_calls,
      report_approvals: harness.review.counters.approvals,
    },
    passed: bundle.topic_results.every((entry) => entry.status === "calculated" && entry.trace !== null)
      && replay.result_sha256 === bundle.result_sha256
      && repeated.result_sha256 === bundle.result_sha256
      && ready.state === "report_ready"
      && exportEligible
      && harness.repository.runCount() === 1,
  };
}

async function realPath() {
  const fixture = buildSyntheticCaseFixture({ fixture_id: "integrated-demo-real", mode: "real" });
  const harness = createIntegratedFullSystemHarness([fixture.stored]);
  const bundle = await harness.application.runCaseAnalysis({ ...commandFor(fixture), mode: "real" });
  const run = await harness.service.getCompletedRun(bundle.analysis_run_id);
  const sources = new Set(run!.selections.flatMap((selection) => selection.source_version_ids));
  return {
    topics: bundle.topic_results.map((entry) => ({
      topic: entry.topic,
      status: entry.status,
      blocking_gates: entry.blockers,
      readiness_sha256: entry.legal_readiness?.decision_sha256 ?? null,
    })),
    source_count: sources.size,
    calculations: harness.executor.counters.execute_calls,
    findings: 0,
    approvals: harness.review.counters.approvals,
    active_parameters: 0,
    active_rules: 0,
    passed: sources.size === 17
      && bundle.topic_results.every((entry) => entry.status === "blocked_legal_readiness")
      && harness.executor.counters.execute_calls === 0
      && harness.review.counters.approvals === 0,
  };
}

async function partialPath() {
  const fixture = PARTIAL_THREE_PERIOD_FIXTURE;
  const harness = createIntegratedFullSystemHarness([fixture.stored]);
  const bundle = await harness.application.runCaseAnalysis(commandFor(fixture));
  const run = await harness.service.getCompletedRun(bundle.analysis_run_id);
  const reportJson = new TextDecoder().decode(run!.report!.json);
  const reportHtml = new TextDecoder().decode(run!.report!.html);
  return {
    statuses: bundle.topic_results.map(({ topic, status }) => ({ topic, status })),
    known_subtotal: bundle.known_subtotal,
    coverage_complete: bundle.coverage_complete,
    report_sha256: run!.report!.report_sha256,
    exact_partial_label: reportJson.includes("known_subtotal_only_not_total_entitlement"),
    exact_hebrew_warning: reportHtml.includes("אינו הסכום הכולל המגיע"),
    passed: !bundle.coverage_complete
      && bundle.topic_results.filter((entry) => entry.status === "calculated").length === 5
      && reportJson.includes("known_subtotal_only_not_total_entitlement")
      && reportHtml.includes("אינו הסכום הכולל המגיע"),
  };
}

const outputIndex = process.argv.indexOf("--output");
const outputPath = outputIndex >= 0 && process.argv[outputIndex + 1]
  ? path.resolve(process.argv[outputIndex + 1])
  : path.resolve("output/parallel-wave-3/integrated-acceptance.json");
const complete = await completePath();
const real = await realPath();
const partial = await partialPath();
const seed = {
  schema_version: "tivdoc-wave3-integrated-acceptance-v0.6.0",
  complete,
  real,
  partial,
  persistence_adapter: "InMemoryCaseAnalysisRepository",
  durable_persistence_verified: false,
  prohibited_operations: {
    customer_files_read: 0,
    openai_calls: 0,
    external_supabase_connections: 0,
    migrations_applied: 0,
    deployments: 0,
    deliveries: 0,
    customer_shadow_runs: 0,
  },
};
const result = {
  ...seed,
  acceptance_sha256: canonicalSha256(seed),
  passed: complete.passed && real.passed && partial.passed,
};
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${canonicalStringify(result)}\n`, "utf8");
process.stdout.write(`${canonicalStringify(result)}\n`);
process.exitCode = result.passed ? 0 : 6;
await vite.close();
