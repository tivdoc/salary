import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalStringify } from "../rule-runtime/canonical.ts";
import {
  openVerifiedSyntheticFixture,
  SYNTHETIC_PROHIBITED_SENTINEL,
} from "./denial.ts";
import { evaluateLockedGroundTruth } from "./evaluator.ts";
import {
  buildSyntheticGroundTruthWorkflow,
  syntheticFieldProfiles,
  syntheticPredictions,
} from "./synthetic-fixtures.ts";
import { validateGroundTruthManifest } from "./validation.ts";
import { projectVersionedGroundTruth } from "./versioned-view.ts";

export const GROUND_TRUTH_OUTPUT_RELATIVE = "output/parallel-wave-2/batch-b/ground-truth";
export type GroundTruthEvidenceCommand = "validate" | "evaluate" | "all";

function sha256(bytes: string) {
  return createHash("sha256").update(bytes, "utf8").digest("hex");
}

async function writeJson(outputDirectory: string, name: string, value: unknown) {
  const bytes = `${canonicalStringify(value)}\n`;
  await writeFile(path.join(outputDirectory, name), bytes, { encoding: "utf8", flag: "w" });
  return { path: name, bytes: Buffer.byteLength(bytes), sha256: sha256(bytes) };
}

export async function generateGroundTruthEvidence(command: GroundTruthEvidenceCommand) {
  const outputDirectory = path.resolve(GROUND_TRUTH_OUTPUT_RELATIVE);
  const expectedDirectory = path.join(path.resolve("output", "parallel-wave-2", "batch-b"), "ground-truth");
  if (outputDirectory !== expectedDirectory) throw new Error("ground_truth_evidence_output_path_mismatch");
  await mkdir(outputDirectory, { recursive: true });
  const workflow = buildSyntheticGroundTruthWorkflow();
  const files: Array<{ path: string; bytes: number; sha256: string }> = [];

  if (command === "validate" || command === "all") {
    for (const manifest of Object.values(workflow)) validateGroundTruthManifest(manifest);
    let openerCalls = 0;
    let denialCode = "";
    try {
      openVerifiedSyntheticFixture({
        source_kind: "prohibited_sentinel",
        path: SYNTHETIC_PROHIBITED_SENTINEL,
        opener: () => {
          openerCalls += 1;
          return null;
        },
      });
    } catch (error) {
      denialCode = error instanceof Error ? error.message : "unknown_denial_error";
    }
    if (openerCalls !== 0 || denialCode !== "ground_truth_prohibited_path_denied_before_io") {
      throw new Error("ground_truth_denial_canary_failed");
    }
    files.push(await writeJson(outputDirectory, "workflow-evidence.json", {
      schema_version: "wave2-ground-truth-workflow-evidence-v0.4",
      synthetic_only: true,
      llm_used: false,
      states: Object.keys(workflow),
      manifests: workflow,
      versioned_locked_view: projectVersionedGroundTruth(workflow.locked_ground_truth),
    }));
    files.push(await writeJson(outputDirectory, "denial-evidence.json", {
      schema_version: "wave2-ground-truth-denial-evidence-v0.4",
      synthetic_sentinel_only: true,
      denial_code: denialCode,
      opener_calls: openerCalls,
      io_attempted: false,
    }));
  }

  if (command === "evaluate" || command === "all") {
    const report = evaluateLockedGroundTruth({
      benchmark_id: "SYNTHETIC_EXTRACTION_BENCHMARK_001",
      benchmark_version: "1.0",
      manifest: workflow.locked_ground_truth,
      field_profiles: syntheticFieldProfiles,
      predictions: syntheticPredictions,
      evaluated_at: "2040-05-04T10:00:00Z",
    });
    files.push(await writeJson(outputDirectory, "evaluator-evidence.json", {
      schema_version: "wave2-ground-truth-evaluator-evidence-v0.4",
      synthetic_only: true,
      report,
    }));
  }

  files.sort((left, right) => left.path.localeCompare(right.path));
  const manifest = {
    schema_version: "wave2-ground-truth-evidence-manifest-v0.4",
    output_directory: GROUND_TRUTH_OUTPUT_RELATIVE,
    files,
  };
  const manifestEntry = await writeJson(outputDirectory, "evidence-manifest.json", manifest);
  return {
    status: "GROUND_TRUTH_SYNTHETIC_TOOLING_VERIFIED" as const,
    command,
    evidence_files: files.length,
    evidence_manifest_sha256: manifestEntry.sha256,
    output_directory: GROUND_TRUTH_OUTPUT_RELATIVE,
  };
}
