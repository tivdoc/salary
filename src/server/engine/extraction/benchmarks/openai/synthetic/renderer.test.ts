import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { renderedPayslipFixtureSpecs } from "./fixtures";
import { renderedPayslipGroundTruth } from "./ground-truth";
import { RenderedPayslipDocumentSource, renderSyntheticPayslipCorpus } from "./renderer";

describe("deterministic synthetic rendered payslip corpus", () => {
  it("generates ten actual PDF/JPG/PNG artifacts without embedding ground truth in the manifest", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tivdoc-rendered-payslips-"));
    try {
      const artifacts = await renderSyntheticPayslipCorpus(directory);
      expect(artifacts).toHaveLength(10);
      expect(new Set(artifacts.map((artifact) => artifact.format))).toEqual(new Set(["pdf", "png", "jpg"]));
      expect(artifacts.map((artifact) => artifact.fixture_id)).toEqual(renderedPayslipFixtureSpecs.map((fixture) => fixture.fixture_id));
      expect(renderedPayslipGroundTruth.map((truth) => truth.fixture_id)).toEqual(artifacts.map((artifact) => artifact.fixture_id));

      const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")) as unknown;
      const serialized = JSON.stringify(manifest);
      expect(serialized).not.toContain("expected_fields");
      expect(serialized).not.toContain("minor_units");

      for (const artifact of artifacts) {
        const bytes = await readFile(artifact.file_path);
        expect(bytes.byteLength).toBeGreaterThan(5_000);
        if (artifact.format === "pdf") {
          expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
        } else {
          const metadata = await sharp(bytes).metadata();
          expect(metadata.width).toBeGreaterThan(300);
          expect(metadata.height).toBeGreaterThan(400);
        }
      }

      const source = new RenderedPayslipDocumentSource(artifacts);
      const first = artifacts[0];
      expect(await source.read(first.request.document)).toHaveLength(first.request.document.size_bytes);
      await expect(source.read({ ...first.request.document, document_id: "99999999-9999-4999-8999-999999999999" }))
        .rejects.toThrow("outside the approved corpus");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("reproduces identical bytes and degradation metadata", async () => {
    const firstDirectory = await mkdtemp(path.join(os.tmpdir(), "tivdoc-render-a-"));
    const secondDirectory = await mkdtemp(path.join(os.tmpdir(), "tivdoc-render-b-"));
    try {
      const first = await renderSyntheticPayslipCorpus(firstDirectory);
      const second = await renderSyntheticPayslipCorpus(secondDirectory);
      expect(first.map((artifact) => artifact.sha256)).toEqual(second.map((artifact) => artifact.sha256));
      expect(first.map((artifact) => artifact.quality)).toEqual([
        "clean", "clean", "clean", "clean", "dense", "low_resolution", "rotated", "blurred", "ambiguous", "contradictory",
      ]);
    } finally {
      await Promise.all([
        rm(firstDirectory, { recursive: true, force: true }),
        rm(secondDirectory, { recursive: true, force: true }),
      ]);
    }
  }, 60_000);
});
