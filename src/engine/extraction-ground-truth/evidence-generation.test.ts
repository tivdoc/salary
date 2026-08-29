import { describe, expect, it } from "vitest";
import {
  generateGroundTruthEvidence,
  type GroundTruthEvidenceCommand,
} from "./evidence.ts";

describe("synthetic Ground Truth evidence command", () => {
  it("writes deterministic ignored workflow/evaluator evidence", async () => {
    const requested = process.env.TIVDOC_GROUND_TRUTH_COMMAND ?? "all";
    expect(["validate", "evaluate", "all"]).toContain(requested);
    const result = await generateGroundTruthEvidence(requested as GroundTruthEvidenceCommand);
    expect(result.status).toBe("GROUND_TRUTH_SYNTHETIC_TOOLING_VERIFIED");
    expect(result.evidence_manifest_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.evidence_files).toBe(requested === "all" ? 3 : requested === "validate" ? 2 : 1);
  });
});
