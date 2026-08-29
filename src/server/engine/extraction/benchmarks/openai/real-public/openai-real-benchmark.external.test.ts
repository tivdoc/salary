import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createOpenAiDocumentExtractorFromEnv } from "../../../providers/openai/adapter";
import { resolveOpenAiExtractionConfig } from "../../../providers/openai/config";
import { runRenderedOpenAiBenchmark } from "../benchmark";
import { loadRealPublicPayslipArtifacts, RealPublicPayslipDocumentSource, sha256File } from "./artifacts";
import { realPublicPayslipGroundTruth } from "./ground-truth";

describe("opt-in redacted real-public OpenAI payslip benchmark", () => {
  it("runs the five frozen redacted documents once and persists field-level results", async () => {
    const redactedDirectory = path.resolve("eval", "real-payslips", "redacted");
    const outputDirectory = path.resolve("output", "payslip-openai", "real-public-v1");
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
    }, null, 2)}\n`, "utf8");

    const config = resolveOpenAiExtractionConfig(process.env);
    if (!config.apiKey) {
      console.log("OPENAI_REAL_PAYSLIP_BENCHMARK_SKIPPED openai_not_configured redacted_corpus_verified=5");
      return;
    }

    const safeLogs: unknown[] = [];
    const extractor = createOpenAiDocumentExtractorFromEnv(process.env, { log: (entry) => safeLogs.push(entry) });
    const report = await runRenderedOpenAiBenchmark({
      extractor,
      source: new RealPublicPayslipDocumentSource(artifacts),
      artifacts,
      groundTruth: realPublicPayslipGroundTruth,
      model: config.model,
      referenceYear: 2026,
      groundTruthSha256,
    });
    const resultName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${config.model}.json`;
    const resultPath = path.join(resultDirectory, resultName);
    await writeFile(resultPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`OPENAI_REAL_PAYSLIP_BENCHMARK fixtures=${report.fixtures_total} failures=${report.extraction_failures} report=${resultPath}`);

    expect(report.fixtures_total).toBe(5);
    expect(report.provider_id).toBe("openai");
    expect(report.ground_truth_sha256).toBe(groundTruthSha256);
    expect(report.per_fixture.every((fixture) => fixture.sensitive_metadata_candidates === 0)).toBe(true);
    expect(JSON.stringify(safeLogs)).not.toMatch(/raw_value|text_fragment|source_label|minor_units/);
  }, 10 * 60_000);
});
