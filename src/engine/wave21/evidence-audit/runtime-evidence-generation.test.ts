import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stableJson } from "./common.ts";
import { buildGroundTruthNegativeMatrix, buildRuleInputNegativeMatrix } from "./negative-matrices.ts";
import { buildCanonicalReachabilityReport } from "./reachability.ts";

describe("Wave 2.1 W1 deterministic runtime evidence", () => {
  it("generates the canonical reachability and negative matrices when requested", async () => {
    const reachability = await buildCanonicalReachabilityReport(process.cwd());
    const ruleInput = buildRuleInputNegativeMatrix();
    const groundTruth = buildGroundTruthNegativeMatrix();
    expect(reachability.blocking_finding_count).toBe(3);
    expect(ruleInput.passed).toBe(true);
    expect(groundTruth.passed).toBe(true);
    const outputRoot = process.env.TIVDOC_WAVE21_W1_OUTPUT_ROOT;
    if (outputRoot) {
      const resolved = path.resolve(outputRoot);
      await mkdir(resolved, { recursive: true });
      await Promise.all([
        writeFile(path.join(resolved, "canonical-reachability.json"), stableJson(reachability), "utf8"),
        writeFile(path.join(resolved, "rule-input-negative-matrix.json"), stableJson(ruleInput), "utf8"),
        writeFile(path.join(resolved, "ground-truth-negative-matrix.json"), stableJson(groundTruth), "utf8"),
      ]);
    }
  }, 30_000);
});
