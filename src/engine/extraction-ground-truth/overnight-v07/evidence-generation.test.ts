import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { expect, it } from "vitest";
import { canonicalSha256, canonicalStringify } from "../../rule-runtime/canonical.ts";
import { evaluateExtendedGroundTruth } from "./evaluator.ts";
import { overnightV07Policies, overnightV07Predictions } from "./fixtures.ts";
import { buildOfflineGroundTruthWorkspace, existingPublicBenchmarkProvenanceInventory, syntheticFixtureProvenanceInventory } from "./workspace.ts";

it("V07-P4-GT emits deterministic ignored evidence through canonical mechanics", () => {
  const mode = process.env.TIVDOC_GT_V07_COMMAND ?? "all";
  const repo = process.cwd();
  const output = path.join(repo, "output/overnight-v0.7/p4/ground-truth");
  const write = (name: string, value: unknown) => {
    mkdirSync(output, { recursive: true });
    const bytes = `${canonicalStringify(value)}\n`;
    const target = path.join(output, name);
    writeFileSync(target, bytes, "utf8");
    return { path: path.relative(repo, target).replaceAll("\\", "/"), sha256: createHash("sha256").update(bytes, "utf8").digest("hex"), byte_count: Buffer.byteLength(bytes) };
  };

  const workspace = buildOfflineGroundTruthWorkspace();
  const report = evaluateExtendedGroundTruth({ benchmark_id: "synthetic.gt.v07", benchmark_version: "0.7.0", manifest: workspace.workflow.locked_ground_truth, policies: overnightV07Policies, predictions: overnightV07Predictions, evaluated_at: "2040-05-04T00:00:00Z" });
  const acceptedProvenance = syntheticFixtureProvenanceInventory();
  const existingPublicInventory = existingPublicBenchmarkProvenanceInventory();
  const provenance = { accepted: acceptedProvenance, existing_public_inventory: existingPublicInventory };
  const artifacts = [write("workspace.json", workspace), write("evaluation.json", report), write("provenance.json", provenance)];
  const receipt = { schema_version: "tivdoc-gt-workspace-receipt-v0.7.0", status: "PASS", command: mode, workflow_states: ["annotation_1", "annotation_2", "disagreement", "human_adjudication", "locked_ground_truth"], locked_sha256: workspace.workflow.locked_ground_truth.locked_sha256, workspace_sha256: workspace.workspace_sha256, evaluation_sha256: report.report_sha256, fixture_counts: { deterministic_synthetic: acceptedProvenance.length, approved_public_non_identifying: 0, existing_public_excluded_pending_approval: existingPublicInventory[0].declared_neutral_fixture_count, customer: 0 }, artifacts, blockers: ["HUMAN_GROUND_TRUTH_REQUIRED"] };
  const manifest = { ...receipt, receipt_sha256: canonicalSha256(receipt) };
  const manifestArtifact = write("manifest.json", manifest);

  expect(acceptedProvenance).toHaveLength(1);
  expect(existingPublicInventory[0].fixture_bytes_read_by_p4).toBe(0);
  expect(workspace.workflow.locked_ground_truth.status).toBe("locked_ground_truth");
  expect(report.fields).toHaveLength(4);
  expect(artifacts.every((artifact) => /^[a-f0-9]{64}$/.test(artifact.sha256))).toBe(true);
  console.log(JSON.stringify({ ...manifest, manifest_artifact: manifestArtifact }));
});
