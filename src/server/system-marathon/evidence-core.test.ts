import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { writeDeterministicStoreZip } from "../../../scripts/canonical-persistence-v091/evidence/deterministic-zip.mts";
import {
  canonicalAcceptanceMarkdown,
  createEvidenceManifest,
  sha256,
  verifyEvidenceDirectory,
} from "../../../scripts/full-local-system-marathon/evidence-core.mts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "tivdoc-marathon-evidence-"));
  temporaryRoots.push(root);
  const acceptance = Array.from({ length: 39 }, (_, index) => ({
    id: `MC-${String(index + 1).padStart(2, "0")}`,
    status: [3, 10, 27].includes(index + 1) ? "BLOCKED" : "PASS",
    evidence: `synthetic-evidence-${index + 1}`,
  }));
  const assessment = {
    schema_version: "tivdoc-full-local-system-marathon-assessment-v0.10.0",
    final_status: "LOCAL_SYSTEM_ENGINEERING_MARATHON_PARTIAL",
    status_constants: [
      "LEGAL_SOURCE_CORPUS_INCOMPLETE",
      "CUSTOMER_SHADOW_NOT_AUTHORIZED",
      "PRODUCTION_DELIVERY_DISABLED",
    ],
    acceptance,
    acceptance_counts: { PASS: 36, FAIL: 0, BLOCKED: 3, SKIPPED_DEPENDENCY: 0, NOT_APPLICABLE: 0 },
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
  const commandIds = [
    "focused_marathon",
    "full_suite",
    "eslint",
    "typescript",
    "production_build",
    "browser_e2e",
    "prohibited_operation_audit",
    "canonical_reachability",
    "persistence_wiring",
  ];
  const files: Record<string, string | Buffer> = {};
  const commands = commandIds.map((commandId) => {
    const stdout = `PASS:${commandId}\n`;
    const stderr = "";
    const stdoutLog = `final-logs/attempt-01/${commandId}.stdout.log`;
    const stderrLog = `final-logs/attempt-01/${commandId}.stderr.log`;
    files[`verification/${stdoutLog}`] = stdout;
    files[`verification/${stderrLog}`] = stderr;
    return {
      command_id: commandId,
      status: "PASS",
      exit_code: 0,
      signal: null,
      elapsed_ms: 1,
      stdout_sha256: sha256(stdout),
      stderr_sha256: sha256(stderr),
      stdout_byte_count: Buffer.byteLength(stdout),
      stderr_byte_count: 0,
      stdout_log: stdoutLog,
      stderr_log: stderrLog,
    };
  });
  const attempt = {
    schema_version: "tivdoc-full-local-system-marathon-final-attempt-v0.10.0",
    attempt_number: 1,
    status: "PASS",
    migration_or_persistence_changed: false,
    verified_head: "b".repeat(40),
    verified_tree: "c".repeat(40),
    commands,
  };
  for (const command of commands) {
    files[`verification/final-attempts/attempt-01/${command.command_id}.json`] = `${JSON.stringify(command)}\n`;
    files[`verification/final-attempts/attempt-01/${command.command_id}.started.json`] = `${JSON.stringify({
      schema_version: "tivdoc-full-local-system-marathon-command-start-v0.10.0",
      attempt_number: 1,
      command_id: command.command_id,
    })}\n`;
  }
  const finalVerification = {
    schema_version: "tivdoc-full-local-system-marathon-final-verification-v0.10.0",
    status: "PASS",
    migration_or_persistence_changed: false,
    verified_head: "b".repeat(40),
    verified_tree: "c".repeat(40),
    commands,
    attempts: [attempt],
    run_counts: {
      full_suite: 1,
      production_build: 1,
      browser_e2e_full: 1,
      postgresql_regression: 0,
      complete_final_attempts: 1,
    },
    complete_attempt_limit: 2,
  };
  const snapshot = Buffer.from("synthetic rendered browser snapshot\n", "utf8");
  files["verification/browser/portal-desktop.md"] = snapshot;
  files["assessment.json"] = `${JSON.stringify(assessment)}\n`;
  files["assessment.md"] = canonicalAcceptanceMarkdown(assessment);
  files["ledgers/marathon.ndjson"] = `${JSON.stringify({ event_id: "MCL-0001", status: "PASS" })}\n`;
  files["ledgers/focused-checks.ndjson"] = `${JSON.stringify({ check_id: "CHECK-0001", status: "PASS" })}\n`;
  files["verification/final-verification.json"] = `${JSON.stringify(finalVerification)}\n`;
  files["verification/final-attempt-ledger.ndjson"] = `${JSON.stringify(attempt)}\n`;
  files["verification/final-attempts/attempt-01/attempt.json"] = `${JSON.stringify(attempt)}\n`;
  files["verification/final-attempts/attempt-01/attempt-start.json"] = `${JSON.stringify({
    schema_version: "tivdoc-full-local-system-marathon-final-attempt-start-v0.10.0",
    attempt_number: 1,
    migration_or_persistence_changed: false,
    verified_head: "b".repeat(40),
    verified_tree: "c".repeat(40),
    command_ids: commandIds,
  })}\n`;
  files["verification/browser/browser-e2e-receipt.json"] = `${JSON.stringify({
    schema_version: "tivdoc-full-local-system-marathon-browser-e2e-v0.10.0",
    status: "PASS",
    real_browser_cli: true,
    direct_service_shortcuts: false,
    snapshots: [{
      path: "output/playwright/v010-marathon/portal-desktop.md",
      byte_count: snapshot.byteLength,
      sha256: sha256(snapshot),
    }],
  })}\n`;
  files["git/base-final.json"] = `${JSON.stringify({ schema_version: "tivdoc-full-local-system-marathon-git-v0.10.0", branch: "codex/tivdoc-engine-foundation", base_head: "28d18da69108913252736f4b8a39c4ef614984a3", base_tree: "2a9859470003a095521a13e21474a45e1f69620e", final_head: "b".repeat(40), final_tree: "c".repeat(40), base_is_ancestor: true, worktree_clean: true })}\n`;
  files["git/commits.json"] = `${JSON.stringify({
    schema_version: "tivdoc-marathon-commit-receipts-v0.10.0",
    commits: [{
      sha: "b".repeat(40),
      tree: "c".repeat(40),
      parent: "28d18da69108913252736f4b8a39c4ef614984a3",
      subject: "test: synthetic evidence fixture",
      stable_patch_id: "d".repeat(40),
      diffstat: " fixture.txt | 1 +",
      changed_paths: ["fixture.txt"],
      focused_checks: [],
    }],
  })}\n`;
  files["git/full.diff"] = "diff --git a/fixture.txt b/fixture.txt\n+synthetic\n";
  files["security/prohibited-operation-scan.json"] = `${JSON.stringify({ schema_version: "tivdoc-marathon-prohibited-operation-scan-v0.10.0", status: "PASS", secret_or_customer_path_matches: 0, deployments: 0, remote_migrations: 0, live_provider_calls: 0, openai_calls: 0, customer_data_reads: 0 })}\n`;
  files["security/prohibited-operation-audit.json"] = `${JSON.stringify({ schema_version: "tivdoc-full-local-system-marathon-security-audit-v0.10.0", status: "PASS", finding_count: 0, findings: [], truth_counters: { customer_data_reads: 0, deployments: 0, remote_migrations: 0, live_provider_calls: 0, openai_calls: 0 } })}\n`;
  files["owner/action-index.json"] = `${JSON.stringify({
    schema_version: "tivdoc-owner-action-index-v0.10.0",
    baseline_truth: {
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
    },
    groups: Array.from({ length: 11 }, (_, index) => ({
      group_id: `OA-${String(index + 1).padStart(2, "0")}`,
      actions: [{ status: "BLOCKED_EXTERNAL", locally_solvable_engineering: false, evidence_required: ["real external evidence"] }],
    })),
  })}\n`;

  for (const [name, value] of Object.entries(files)) {
    const target = path.join(root, ...name.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, value);
  }
  const names = Object.keys(files).sort();
  const manifest = await createEvidenceManifest(root, names);
  await writeFile(path.join(root, "evidence-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const archive = path.join(root, "marathon-evidence-v0.10.0.zip");
  await writeDeterministicStoreZip({ root, output: archive, entries: [...names, "evidence-manifest.json"].sort() });
  return { root, archive, assessment, finalVerification, manifest };
}

async function rebuild(value: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  const names = value.manifest.payload_files.map((entry) => entry.path);
  const manifest = await createEvidenceManifest(value.root, names);
  value.manifest = manifest;
  await writeFile(path.join(value.root, "evidence-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await rm(value.archive);
  await writeDeterministicStoreZip({ root: value.root, output: value.archive, entries: [...names, "evidence-manifest.json"].sort() });
}

describe("Marathon independent evidence verifier", () => {
  it("recomputes every payload, final log, receipt and deterministic archive", async () => {
    const value = await fixture();
    const receipt = await verifyEvidenceDirectory(value);
    expect(receipt.status).toBe("PASS");
    expect(receipt.acceptance_pass).toBe(36);
    expect(receipt.acceptance_non_pass).toBe(3);
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
    await rebuild(value);
    await expect(verifyEvidenceDirectory(value)).rejects.toThrow("BLOCKED_GATE_FALSE_PASS:MC-03");
  });

  it("rejects truth-inflated run counts even when payload hashes are rebuilt", async () => {
    const value = await fixture();
    const assessment = structuredClone(value.assessment);
    assessment.truth_counters.FULL_SUITE_RUN_COUNT = 2;
    await writeFile(path.join(value.root, "assessment.json"), `${JSON.stringify(assessment)}\n`);
    await rebuild(value);
    await expect(verifyEvidenceDirectory(value)).rejects.toThrow("ASSESSMENT_RUN_COUNT_CONTRADICTION");
  });

  it("rejects a semantically mismatched final log even when manifest hashes are rebuilt", async () => {
    const value = await fixture();
    await writeFile(path.join(value.root, "verification", "final-logs", "attempt-01", "full_suite.stdout.log"), "tampered\n");
    await rebuild(value);
    await expect(verifyEvidenceDirectory(value)).rejects.toThrow("FINAL_LOG_HASH_MISMATCH");
  });

  it("rejects byte tampering before interpreting claims", async () => {
    const value = await fixture();
    await writeFile(path.join(value.root, "assessment.json"), "{}\n");
    await expect(verifyEvidenceDirectory(value)).rejects.toThrow("MANIFEST_RECOMPUTE_MISMATCH");
    expect((await readFile(value.archive)).byteLength).toBeGreaterThan(0);
  });
});
