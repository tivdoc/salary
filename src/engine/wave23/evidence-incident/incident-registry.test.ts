import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  evaluateReferencePartition,
  type DispositionLedger,
  type LiveReference,
  type LossRecord,
} from "./reference-partition.ts";
import { localArtifacts, resolvePython } from "../../../test-support/host.ts";

const ledger = JSON.parse(readFileSync(path.resolve(
  "src", "engine", "wave23", "evidence-incident", "reference-disposition.v0.10.11.json",
), "utf8")) as DispositionLedger;

const losses = JSON.parse(readFileSync(path.resolve(
  "src", "engine", "wave23", "evidence-incident", "evidence-loss.v0.10.11.json",
), "utf8")) as { records: LossRecord[] };

function pythonRuntime() {
  const runtime = resolvePython();
  if (!runtime) throw new Error("PYTHON_3_NOT_ON_HOST");
  return { command: runtime.command, prefix: [...runtime.prefix] };
}

function runIncidentCommand(command: "diagnostic" | "self-test") {
  const runtime = pythonRuntime();
  return spawnSync(runtime.command, [
    ...runtime.prefix,
    path.resolve("scripts", "wave23-evidence-incident", "incident_registry.py"),
    command,
    // The diagnostic walks every worktree and hashes every size candidate; it
    // takes ~110s alone and longer under a parallel suite. A 120s budget made
    // it die by signal under load, which surfaces as `status: null` and looks
    // like a failed assertion rather than a killed subprocess.
  ], { encoding: "utf8", windowsHide: true, timeout: 600_000 });
}

describe.skipIf(!(localArtifacts(["output/parallel-wave-2.3/workers/w1-evidence-incident/cross-package-incident-registry.json"])).holds)("Wave 2.3 cross-package incident registry", () => {
  it("freezes all four V0.4.1 mismatches and binds exact historical identities", () => {
    const declaration = JSON.parse(readFileSync(path.resolve(
      "src", "engine", "wave23", "evidence-incident", "incident-declaration.v0.5.0.json",
    ), "utf8")) as {
      required_reference_count: number;
      historical_roots_repaired: boolean;
      historical_packages: Array<{ package_id: string; zip_sha256: string; manifest_sha256: string }>;
      v0_4_1_references: Array<{ reference_id: string; json_pointers: Record<string, string> }>;
    };
    expect(declaration.required_reference_count).toBe(15);
    expect(declaration.historical_roots_repaired).toBe(false);
    expect(declaration.v0_4_1_references.map((item) => item.reference_id)).toEqual([
      "V041_MISMATCH_001",
      "V041_MISMATCH_002",
      "V041_MISMATCH_003",
      "V041_MISMATCH_004",
    ]);
    expect(declaration.v0_4_1_references.every((item) => Object.keys(item.json_pointers).length === 3)).toBe(true);
    expect(declaration.historical_packages).toHaveLength(3);
    expect(declaration.historical_packages.every((item) => item.zip_sha256.length === 64 && item.manifest_sha256.length === 64)).toBe(true);
  });

  it("runs the bounded registry and all required adversarial cases", () => {
    const result = runIncidentCommand("diagnostic");
    expect(result.status, result.stderr).toBe(0);
    const diagnostic = JSON.parse(result.stdout) as {
      status: string;
      reference_count: number;
      unique_path_hash_incident_count: number;
      exact_recovered_reference_count: number;
      unrecoverable_or_unavailable_reference_count: number;
    };
    // The material claim, unchanged: the historical roots are quarantined and
    // cannot satisfy admission, activation or shadow.
    expect(diagnostic).toMatchObject({
      status: "HISTORICAL_EVIDENCE_ROOTS_QUARANTINED_FAILED",
      reference_count: 15,
      unique_path_hash_incident_count: 11,
    });
    // The recovery figure is a class partition, not a bare count. Every
    // reference lands in exactly one class, `recovered` + `permanently_lost`
    // still sums to the original five, and a loss must be recorded to exist.
    const registry = JSON.parse(readFileSync(path.resolve(
      "output", "parallel-wave-2.3", "workers", "w1-evidence-incident",
      "cross-package-incident-registry.json",
    ), "utf8")) as { references: LiveReference[] };
    const outcome = evaluateReferencePartition({
      ledger, live: registry.references, losses: losses.records, live_summary: diagnostic,
    });
    expect(outcome.violations).toEqual([]);
    expect(ledger.recovered_plus_permanently_lost).toBe(5);
    const output = path.resolve("output", "parallel-wave-2.3", "workers", "w1-evidence-incident");
    const negatives = JSON.parse(readFileSync(path.join(output, "negative-case-matrix.json"), "utf8")) as {
      passed: boolean;
      case_count: number;
      cases: Array<{ case_id: string; passed: boolean }>;
    };
    expect(negatives.passed).toBe(true);
    expect(negatives.case_count).toBe(10);
    expect(negatives.cases.every((item) => item.passed)).toBe(true);
  }, 660_000);

  it("keeps the pure state-machine self-test independent from historical bytes", () => {
    const result = runIncidentCommand("self-test");
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ case_count: 2, passed_count: 2, passed: true });
  });
});

describe("V0.10.11 reference class partition", () => {
  const live = [
    { reference_id: "R1", exact_recovery_status: "exact_recovered" },
    { reference_id: "R2", exact_recovery_status: "unrecoverable_or_unavailable" },
    { reference_id: "R3", exact_recovery_status: "unrecoverable_or_unavailable" },
  ];
  const summary = {
    reference_count: 3,
    unique_path_hash_incident_count: 3,
    exact_recovered_reference_count: 1,
    unrecoverable_or_unavailable_reference_count: 2,
  };
  const lossRecord = {
    reference_id: "R3",
    repository_path: "a/b.ts",
    last_known_sha256: "a".repeat(64),
    last_known_byte_count: 10,
    lost_at: "2026-09-02",
    cause: "overwritten",
    attributable_commit: "abc1234",
    search_that_established_the_loss: { files_scanned: 1, digest_hits: 0 },
  };
  const baseline = {
    reference_total: 3,
    unique_incident_total: 3,
    class_totals: { recovered: 1, unresolved: 1, permanently_lost: 1 },
    recovered_plus_permanently_lost: 2,
    entries: [
      { reference_id: "R1", class: "recovered" },
      { reference_id: "R2", class: "unresolved" },
      { reference_id: "R3", class: "permanently_lost" },
    ],
  };
  const evaluate = (ledgerOverride: unknown, losses: unknown[] = [lossRecord]) =>
    evaluateReferencePartition({
      ledger: ledgerOverride as DispositionLedger,
      live,
      losses: losses as LossRecord[],
      live_summary: summary,
    });

  it("accepts an exhaustive, non-overlapping partition with its loss recorded", () => {
    expect(evaluate(baseline)).toMatchObject({ ok: true, violations: [] });
  });

  it("fails when a reference is silently dropped", () => {
    const mutated = { ...baseline, reference_total: 2, class_totals: { recovered: 1, unresolved: 1, permanently_lost: 0 },
      recovered_plus_permanently_lost: 1, entries: baseline.entries.slice(0, 2) };
    expect(evaluate(mutated, []).violations).toContain("ledger_missing_reference:R3");
  });

  it("fails when a reference is listed twice", () => {
    const mutated = { ...baseline, entries: [...baseline.entries, { reference_id: "R1", class: "unresolved" }] };
    expect(evaluate(mutated).violations).toContain("duplicate_ledger_entry:R1");
  });

  it("fails when a class changes without the live registry agreeing", () => {
    const mutated = { ...baseline, class_totals: { recovered: 0, unresolved: 2, permanently_lost: 1 },
      recovered_plus_permanently_lost: 1,
      entries: [{ reference_id: "R1", class: "unresolved" }, ...baseline.entries.slice(1)] };
    expect(evaluate(mutated).violations).toContain("class_mismatch:R1:unresolved:exact_recovered");
  });

  it("fails when a reference is called lost with no loss record", () => {
    expect(evaluate(baseline, []).violations).toContain("loss_record_missing:R3");
  });

  it("fails on a loss record for a reference that is not lost", () => {
    expect(evaluate(baseline, [lossRecord, { ...lossRecord, reference_id: "R2" }]).violations)
      .toContain("loss_record_orphan:R2");
  });

  it("fails on an incomplete loss record", () => {
    expect(evaluate(baseline, [{ ...lossRecord, cause: "" }]).violations)
      .toContain("loss_record_incomplete:R3:cause");
  });

  it("fails when a stated class total does not match the entries", () => {
    const mutated = { ...baseline, class_totals: { recovered: 2, unresolved: 1, permanently_lost: 1 } };
    expect(evaluate(mutated).violations).toContain("class_total_mismatch:recovered");
  });

  it("rejects a class the partition does not define", () => {
    const mutated = { ...baseline, entries: [{ reference_id: "R1", class: "preserved_v0_10_11" }, ...baseline.entries.slice(1)] };
    expect(evaluate(mutated).violations).toContain("unknown_class:R1:preserved_v0_10_11");
  });
});
