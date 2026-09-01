import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { writeDeterministicStoreZip } from "../../../scripts/canonical-persistence-v091/evidence/deterministic-zip.mts";
import { createEvidenceManifest, verifyEvidenceDirectory } from "../../../scripts/full-local-system-marathon/evidence-core.mts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "tivdoc-marathon-evidence-"));
  temporaryRoots.push(root);
  const acceptance = Array.from({ length: 39 }, (_, index) => ({
    id: `MC-${String(index + 1).padStart(2, "0")}`,
    status: [3, 10, 17, 27, 31, 32].includes(index + 1) ? "BLOCKED" : "PASS",
    evidence: `synthetic-evidence-${index + 1}`,
  }));
  const assessment = {
    schema_version: "tivdoc-full-local-system-marathon-assessment-v0.10.0",
    acceptance,
    acceptance_counts: { PASS: 33, BLOCKED: 6, FAILED_LOCAL_WITH_EVIDENCE: 0, SKIPPED: 0 },
    truth_counters: {
      REAL_LEGAL_TOPICS_READY: "0/7",
      REAL_SOURCES_ACTIVE: 0,
      REAL_PARAMETERS_ACTIVE: 0,
      REAL_RULES_ACTIVE: 0,
      REAL_CALCULATIONS_OR_FINDINGS: 0,
      HUMAN_GROUND_TRUTH_LOCKED: 0,
      REAL_CUSTOMER_DATA_READS: 0,
      CUSTOMER_PROCESSING_ENABLED: "NO",
      CUSTOMER_SHADOW_AUTHORIZED: "NO",
      PRODUCTION_DELIVERY_ENABLED: "NO",
      DEPLOYMENTS: 0,
      REMOTE_MIGRATIONS: 0,
      LIVE_PROVIDER_CALLS: 0,
      OPENAI_CALLS: 0,
      PRODUCT_REACHABLE_MEMORY_FALLBACKS: 0,
      FULL_SUITE_RUN_COUNT: 1,
      PRODUCTION_BUILD_RUN_COUNT: 1,
      BROWSER_E2E_FULL_RUN_COUNT: 1,
    },
  };
  const commands = ["focused_marathon", "full_suite", "eslint", "typescript", "production_build", "browser_e2e"]
    .map((commandId) => ({ command_id: commandId, status: "PASS", exit_code: 0, stdout_sha256: "a".repeat(64) }));
  const files: Record<string, string> = {
    "assessment.json": `${JSON.stringify(assessment)}\n`,
    "ledgers/marathon.ndjson": `${JSON.stringify({ event_id: "MCL-0001", status: "PASS" })}\n`,
    "ledgers/focused-checks.ndjson": `${JSON.stringify({ check_id: "CHECK-0001", status: "PASS" })}\n`,
    "verification/final-verification.json": `${JSON.stringify({ schema_version: "tivdoc-full-local-system-marathon-final-verification-v0.10.0", commands })}\n`,
    "git/base-final.json": `${JSON.stringify({ schema_version: "tivdoc-full-local-system-marathon-git-v0.10.0", branch: "codex/tivdoc-engine-foundation", base_head: "28d18da69108913252736f4b8a39c4ef614984a3", base_tree: "2a9859470003a095521a13e21474a45e1f69620e", final_head: "b".repeat(40), final_tree: "c".repeat(40), base_is_ancestor: true, worktree_clean: true })}\n`,
  };
  for (const [name, value] of Object.entries(files)) {
    const target = path.join(root, ...name.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, value, "utf8");
  }
  const names = Object.keys(files).sort();
  const manifest = await createEvidenceManifest(root, names);
  await writeFile(path.join(root, "evidence-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const archive = path.join(root, "marathon-evidence-v0.10.0.zip");
  await writeDeterministicStoreZip({ root, output: archive, entries: [...names, "evidence-manifest.json"].sort() });
  return { root, archive, assessment, manifest };
}

describe("Marathon independent evidence verifier", () => {
  it("recomputes every payload and the deterministic archive", async () => {
    const value = await fixture();
    const receipt = await verifyEvidenceDirectory(value);
    expect(receipt.status).toBe("PASS");
    expect(receipt.acceptance_pass).toBe(33);
    expect(receipt.acceptance_non_pass).toBe(6);
  });

  it("rejects case-folded duplicate and self-referential payload paths", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tivdoc-marathon-evidence-paths-"));
    temporaryRoots.push(root);
    await writeFile(path.join(root, "a.json"), "{}\n");
    await writeFile(path.join(root, "A.json"), "{}\n");
    await expect(createEvidenceManifest(root, ["a.json", "A.json"])).rejects.toThrow("DUPLICATE_NORMALIZED_PATH");
    await expect(createEvidenceManifest(root, ["evidence-manifest.json"])).rejects.toThrow("PAYLOAD_PATH_UNSAFE");
  });

  it("rejects a false external-gate PASS even when hashes are rebuilt", async () => {
    const value = await fixture();
    const assessment = structuredClone(value.assessment);
    assessment.acceptance[2]!.status = "PASS";
    assessment.acceptance_counts.PASS += 1;
    assessment.acceptance_counts.BLOCKED -= 1;
    await writeFile(path.join(value.root, "assessment.json"), `${JSON.stringify(assessment)}\n`);
    const names = value.manifest.payload_files.map((entry) => entry.path);
    const manifest = await createEvidenceManifest(value.root, names);
    await writeFile(path.join(value.root, "evidence-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await rm(value.archive);
    await writeDeterministicStoreZip({ root: value.root, output: value.archive, entries: [...names, "evidence-manifest.json"].sort() });
    await expect(verifyEvidenceDirectory(value)).rejects.toThrow("BLOCKED_GATE_FALSE_PASS:MC-03");
  });

  it("rejects byte tampering before interpreting claims", async () => {
    const value = await fixture();
    await writeFile(path.join(value.root, "assessment.json"), "{}\n");
    await expect(verifyEvidenceDirectory(value)).rejects.toThrow("MANIFEST_RECOMPUTE_MISMATCH");
    expect((await readFile(value.archive)).byteLength).toBeGreaterThan(0);
  });
});
