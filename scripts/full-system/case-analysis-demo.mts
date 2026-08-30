#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createServer } from "vite";
import type { createFixtureCaseAnalysisHarness } from "../../src/server/engine/case-analysis/fixture-harness.ts";
import type { StoredCaseInputSnapshot } from "../../src/engine/case-analysis/contracts.ts";
import type { CaseAnalysisCommand } from "../../src/engine/wave3/contracts.ts";

const actionIndex = process.argv.indexOf("--action");
const action = actionIndex >= 0 ? process.argv[actionIndex + 1] : "complete";
const outputIndex = process.argv.indexOf("--output");
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom", logLevel: "error" });
const fixtures = await vite.ssrLoadModule("/src/engine/case-analysis/synthetic-fixtures.ts") as {
  COMPLETE_THREE_PERIOD_FIXTURE: { command: CaseAnalysisCommand; stored: StoredCaseInputSnapshot };
  PARTIAL_THREE_PERIOD_FIXTURE: { command: CaseAnalysisCommand; stored: StoredCaseInputSnapshot };
  buildSyntheticCaseFixture(input: Record<string, unknown>): { command: CaseAnalysisCommand; stored: StoredCaseInputSnapshot };
};
const harnessModule = await vite.ssrLoadModule("/src/server/engine/case-analysis/fixture-harness.ts") as {
  createFixtureCaseAnalysisHarness: typeof createFixtureCaseAnalysisHarness;
};
const canonical = await vite.ssrLoadModule("/src/engine/rule-runtime/canonical.ts") as {
  canonicalStringify(value: unknown): string;
};
const fixture = action === "partial" ? fixtures.PARTIAL_THREE_PERIOD_FIXTURE
  : action === "real" ? fixtures.buildSyntheticCaseFixture({ fixture_id: "demo-real-fail-closed", mode: "real" })
    : fixtures.COMPLETE_THREE_PERIOD_FIXTURE;
const harness = harnessModule.createFixtureCaseAnalysisHarness([fixture.stored]);
const bundle = await harness.application.runCaseAnalysis(fixture.command);
const run = await harness.service.getCompletedRun(bundle.analysis_run_id);
if (!run?.report) throw new Error("demo_report_missing");
const replay = action === "replay" ? await harness.application.replay(bundle.analysis_run_id) : null;
let reviewReceipt: unknown = null;
if (action === "review") {
  reviewReceipt = await harness.review.decide({
    task_id: "synthetic-demo-report-review",
    task_kind: "report_approval",
    reviewer_id: "synthetic-demo-reviewer",
    reviewer_role: "synthetic_fixture_reviewer",
    decision: "approved",
    input_sha256: run.report.report_sha256,
    output_sha256: run.report.report_sha256,
    decided_at: "2025-04-01T00:00:00.000Z",
    reason: "Synthetic fixture approval only.",
    schema_version: "1.0.0",
  });
}
const result = {
  schema_version: "tivdoc-case-analysis-demo-v0.6.0",
  action,
  canonical_path: harness.application.canonical_path,
  bundle,
  stage_hashes: run.stages.map(({ stage, payload_sha256 }) => ({ stage, payload_sha256 })),
  report_hashes: {
    json_sha256: run.report.json_sha256,
    html_sha256: run.report.html_sha256,
    pdf_sha256: run.report.pdf_sha256,
    manifest_sha256: run.report.manifest_sha256,
    report_sha256: run.report.report_sha256,
  },
  review_receipt: reviewReceipt,
  replay_result_sha256: replay?.result_sha256 ?? null,
  zero_external_operations: harness.snapshots.counters,
};
const rendered = `${canonical.canonicalStringify(result)}\n`;
if (output) {
  const target = path.resolve(output);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, rendered, "utf8");
}
process.stdout.write(rendered);
await vite.close();
