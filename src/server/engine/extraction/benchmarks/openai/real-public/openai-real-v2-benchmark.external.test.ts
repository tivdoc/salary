import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { resolvedPayslipFactPaths } from "@/engine/extraction/resolver";
import { createOpenAiPayslipV2ExtractorFromEnv, runOpenAiPayslipExtractionV2 } from "../../../providers/openai/v2-adapter";
import { resolveOpenAiExtractionConfig } from "../../../providers/openai/config";
import { buildOpenAiV2BenchmarkReport } from "../v2-benchmark";
import { loadRealPublicPayslipArtifacts, RealPublicPayslipDocumentSource, sha256File } from "./artifacts";
import { realPublicPayslipGroundTruth } from "./ground-truth";

function uuid(number: number) {
  return `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
}

async function latestSuccessfulV1Report() {
  const directory = path.resolve("output", "payslip-openai", "real-public-v1", "results");
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort().reverse();
  for (const name of names) {
    const report = JSON.parse(await readFile(path.join(directory, name), "utf8")) as {
      exact_field_accuracy?: number | null;
      extraction_failures?: number;
      fixtures_total?: number;
    };
    if ((report.exact_field_accuracy ?? 0) > 0 && report.extraction_failures !== report.fixtures_total) return report;
  }
  return null;
}

describe("opt-in redacted real-public OpenAI payslip V2 benchmark", () => {
  it("reports first pass and targeted recovery separately using a confirmed rotated key", async () => {
    const redactedDirectory = path.resolve("eval", "real-payslips", "redacted");
    const outputDirectory = path.resolve("output", "payslip-openai", "real-public-v2");
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
    }, null, 2)}\n`, "utf8");

    const config = resolveOpenAiExtractionConfig(process.env);
    const rotationConfirmed = process.env.OPENAI_API_KEY_ROTATED_AFTER_2026_08_29 === "true";
    if (!config.apiKey || !rotationConfirmed) {
      console.log("OPENAI_REAL_PAYSLIP_V2_BENCHMARK_SKIPPED rotated_key_not_confirmed redacted_corpus_verified=5");
      return;
    }

    const safeLogs: unknown[] = [];
    const extractor = createOpenAiPayslipV2ExtractorFromEnv(process.env, { log: (entry) => safeLogs.push(entry) });
    const source = new RealPublicPayslipDocumentSource(artifacts);
    const runs = [];
    for (const [artifactIndex, artifact] of artifacts.entries()) {
      const run = await runOpenAiPayslipExtractionV2({
        request: artifact.request,
        source,
        extractor,
        snapshot_context: {
          snapshot_id: uuid(90_000 + artifactIndex),
          case_id: artifact.request.case_id,
          analysis_run_id: artifact.request.analysis_run_id,
          schema_version: "1.0",
          created_at: artifact.request.requested_at,
          fact_ids: Object.fromEntries(
            resolvedPayslipFactPaths.map((factPath, index) => [factPath, uuid(91_000 + artifactIndex * 100 + index)]),
          ),
        },
        reference_year: 2026,
      });
      runs.push({ artifact, run });
    }
    const report = buildOpenAiV2BenchmarkReport({
      runs,
      groundTruth: realPublicPayslipGroundTruth,
      model: config.model,
      v1Report: await latestSuccessfulV1Report(),
      groundTruthSha256,
      explicitSalaryTypeFixtureIds: [],
    });
    const resultName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${config.model}.json`;
    const resultPath = path.join(resultDirectory, resultName);
    await writeFile(resultPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`OPENAI_REAL_PAYSLIP_V2_BENCHMARK fixtures=${report.first_pass.fixtures_total} calls=${report.final_after_targeted_recovery.provider_calls} report=${resultPath}`);

    expect(report.first_pass.fixtures_total).toBe(5);
    expect(report.final_after_targeted_recovery.fixtures_total).toBe(5);
    expect(report.per_document.every((fixture) => fixture.api_calls <= 2)).toBe(true);
    expect(JSON.stringify(safeLogs)).not.toMatch(/raw_value|text_fragment|source_label|minor_units|file_data|image_url/);
  }, 20 * 60_000);
});
