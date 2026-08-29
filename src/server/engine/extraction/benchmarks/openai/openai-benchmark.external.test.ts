import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createOpenAiDocumentExtractorFromEnv } from "../../providers/openai/adapter";
import { resolveOpenAiExtractionConfig } from "../../providers/openai/config";
import { runRenderedOpenAiBenchmark, sensitiveValuesPresent } from "./benchmark";
import { renderedPayslipFixtureSpecs } from "./synthetic/fixtures";
import { renderedPayslipGroundTruth } from "./synthetic/ground-truth";
import { RenderedPayslipDocumentSource, renderSyntheticPayslipCorpus } from "./synthetic/renderer";

describe("opt-in synthetic OpenAI payslip benchmark", () => {
  it("sends only generated synthetic documents when credentials are explicitly available", async () => {
    const outputDirectory = path.resolve("output", "payslip-openai", "v1");
    const artifacts = await renderSyntheticPayslipCorpus(outputDirectory);
    const config = resolveOpenAiExtractionConfig(process.env);
    if (!config.apiKey) {
      console.log("OPENAI_PAYSLIP_BENCHMARK_SKIPPED openai_not_configured synthetic_corpus_generated=10");
      return;
    }

    const safeLogs: unknown[] = [];
    const extractor = createOpenAiDocumentExtractorFromEnv(process.env, { log: (entry) => safeLogs.push(entry) });
    const report = await runRenderedOpenAiBenchmark({
      extractor,
      source: new RenderedPayslipDocumentSource(artifacts),
      artifacts,
      groundTruth: renderedPayslipGroundTruth,
      model: config.model,
      referenceYear: 2026,
    });
    console.log(`OPENAI_PAYSLIP_BENCHMARK ${JSON.stringify(report)}`);
    const resultDirectory = path.join(outputDirectory, "results");
    await mkdir(resultDirectory, { recursive: true });
    const resultName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${config.model}.json`;
    await writeFile(path.join(resultDirectory, resultName), `${JSON.stringify(report, null, 2)}\n`, "utf8");

    expect(report.fixtures_total).toBe(10);
    expect(report.provider_id).toBe("openai");
    expect(report.critical_fields.length).toBeGreaterThan(0);
    const syntheticSensitiveValues = renderedPayslipFixtureSpecs.flatMap((fixture) => [
      fixture.employee_name,
      fixture.employer_name,
      fixture.employee_id,
    ]);
    expect(sensitiveValuesPresent(JSON.stringify(report), syntheticSensitiveValues)).toEqual([]);
    expect(sensitiveValuesPresent(JSON.stringify(safeLogs), syntheticSensitiveValues)).toEqual([]);
  }, 10 * 60_000);
});
