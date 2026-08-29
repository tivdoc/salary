import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { resolvedPayslipFactPaths } from "@/engine/extraction/resolver";
import {
  createOpenAiPayslipV21ExtractorFromEnv,
  runOpenAiPayslipExtractionV21,
} from "../../../providers/openai/v21-adapter";
import { resolveOpenAiExtractionConfig } from "../../../providers/openai/config";
import { buildOpenAiV21BenchmarkReport } from "../v21-benchmark";
import { loadRealPublicPayslipArtifacts, RealPublicPayslipDocumentSource, sha256File } from "./artifacts";
import { realPublicPayslipGroundTruth } from "./ground-truth";

function uuid(number: number) {
  return `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
}

describe("opt-in redacted real-public OpenAI payslip V2.1 benchmark", () => {
  it("reports non-degrading selective recovery using a confirmed rotated key", async () => {
    const redactedDirectory = path.resolve("eval", "real-payslips", "redacted");
    const outputDirectory = path.resolve("output", "payslip-openai", "real-public-v2.1");
    const resultDirectory = path.join(outputDirectory, "results");
    const groundTruthPath = path.resolve(
      "src", "server", "engine", "extraction", "benchmarks", "openai", "real-public", "ground-truth.ts",
    );
    const artifacts = await loadRealPublicPayslipArtifacts(redactedDirectory);
    const groundTruthSha256 = await sha256File(groundTruthPath);
    await mkdir(resultDirectory, { recursive: true });
    await writeFile(path.join(outputDirectory, "ground-truth-freeze.json"), `${JSON.stringify({
      frozen_before_provider_calls: true,
      ground_truth_sha256: groundTruthSha256,
      fixture_ids: realPublicPayslipGroundTruth.map((truth) => truth.fixture_id),
      salary_type_scoring: "documented_only",
      explicit_salary_type_fixture_ids: [],
      extractor_version: "2.1",
      recovery_policy: "non_degrading_selective",
    }, null, 2)}\n`, "utf8");

    const config = resolveOpenAiExtractionConfig(process.env);
    const rotationConfirmed = process.env.OPENAI_API_KEY_ROTATED_AFTER_2026_08_29 === "true";
    if (!config.apiKey || !rotationConfirmed) {
      console.log("OPENAI_REAL_PAYSLIP_V21_BENCHMARK_SKIPPED rotated_key_not_confirmed redacted_corpus_verified=5");
      return;
    }

    const safeLogs: unknown[] = [];
    const extractor = createOpenAiPayslipV21ExtractorFromEnv(process.env, {
      log: (entry) => safeLogs.push(entry),
    });
    const source = new RealPublicPayslipDocumentSource(artifacts);
    const runs = [];
    for (const [artifactIndex, artifact] of artifacts.entries()) {
      const run = await runOpenAiPayslipExtractionV21({
        request: artifact.request,
        source,
        extractor,
        snapshot_context: {
          snapshot_id: uuid(92_000 + artifactIndex),
          case_id: artifact.request.case_id,
          analysis_run_id: artifact.request.analysis_run_id,
          schema_version: "1.0",
          created_at: artifact.request.requested_at,
          fact_ids: Object.fromEntries(
            resolvedPayslipFactPaths.map((factPath, index) => [factPath, uuid(93_000 + artifactIndex * 100 + index)]),
          ),
        },
        reference_year: 2026,
      });
      runs.push({ artifact, run });
    }
    const report = buildOpenAiV21BenchmarkReport({
      runs,
      groundTruth: realPublicPayslipGroundTruth,
      model: config.model,
      groundTruthSha256,
      explicitSalaryTypeFixtureIds: [],
    });
    const resultName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${config.model}.json`;
    const resultPath = path.join(resultDirectory, resultName);
    await writeFile(resultPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(
      `OPENAI_REAL_PAYSLIP_V21_BENCHMARK fixtures=${report.first_pass.fixtures_total} calls=${report.final_after_selective_recovery.provider_calls} recovery_calls=${report.recovery_summary.additional_api_calls} report=${resultPath}`,
    );

    expect(report.first_pass.fixtures_total).toBe(5);
    expect(report.final_after_selective_recovery.fixtures_total).toBe(5);
    expect(report.per_document.every((fixture) => fixture.api_calls <= 2)).toBe(true);
    expect(report.safety_metrics.recovery_regressions.silent_count).toBe(0);
    expect(report.recovery_summary.total_fields_requested).toBeLessThan(49);
    expect(JSON.stringify(safeLogs)).not.toMatch(/raw_value|text_fragment|source_label|minor_units|file_data|image_url/);
  }, 20 * 60_000);
});
