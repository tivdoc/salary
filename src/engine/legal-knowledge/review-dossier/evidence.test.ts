import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeMinimumWageDossierEvidence } from "./evidence.ts";

describe("minimum wage dossier evidence", () => {
  it("writes byte-identical deterministic evidence and zero real parameter invariants", async () => {
    const rootA = await mkdtemp(path.join(tmpdir(), "tivdoc-wave2-b1-a-"));
    const rootB = await mkdtemp(path.join(tmpdir(), "tivdoc-wave2-b1-b-"));
    const [manifestA, manifestB] = await Promise.all([
      writeMinimumWageDossierEvidence(rootA),
      writeMinimumWageDossierEvidence(rootB),
    ]);
    expect(manifestA).toEqual(manifestB);
    expect(manifestA.invariant_counts).toEqual({
      real_numeric_candidates: 0,
      real_parameter_attestations: 0,
      active_parameters: 0,
    });
    for (const file of manifestA.files) {
      const [left, right] = await Promise.all([
        readFile(path.join(rootA, file.name), "utf8"),
        readFile(path.join(rootB, file.name), "utf8"),
      ]);
      expect(right).toBe(left);
      expect(createHash("sha256").update(left, "utf8").digest("hex")).toBe(file.sha256);
    }
  });

  const requestedOutput = process.env.TIVDOC_WAVE2_B1_EVIDENCE_ROOT;
  if (requestedOutput) {
    it("writes the explicitly requested ignored worker evidence", async () => {
      const result = await writeMinimumWageDossierEvidence(requestedOutput);
      expect(result.invariant_counts.active_parameters).toBe(0);
    });
  }
});
