import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalSha256 } from "../rule-runtime/canonical.ts";

// Q-8 guard. The sensitivity report is produced by
// scripts/legal-review-projection/decision-sensitivity-report.mts against DEV,
// so it lives under the git-ignored output tree and a clean checkout has none.
// What is guarded here is that the artifact, when present, still carries the
// properties that make it safe to exist at all: internal only, never a Finding,
// never delivered, self-hashing, and reporting zero of everything the counters
// forbid.

const REPORT_PATH = path.resolve("output/next/pool-q/decision-sensitivity-report.json");

type Report = Readonly<{
  classification: string;
  delivery_allowed: boolean;
  is_finding: boolean;
  is_legal_advice: boolean;
  execution_mode: string;
  scenarios_run: number;
  scenarios_attempted: number;
  counters: Readonly<Record<string, number>>;
  open_decisions: ReadonlyArray<Readonly<{
    decision_id: string;
    branches: ReadonlyArray<Readonly<{ branch: string; value: string }>>;
    parameter_level_difference: string | null;
    scenario_level_difference: string;
  }>>;
  withdrawn_decisions: readonly unknown[];
  resolved_decisions: readonly unknown[];
  report_sha256: string;
}>;

async function loadReport(): Promise<Report | null> {
  if (!existsSync(REPORT_PATH)) return null;
  return JSON.parse(await readFile(REPORT_PATH, "utf8")) as Report;
}

describe("Q-8 decision-sensitivity report stays internal and inert", () => {
  it("is internal only, never a Finding, never delivered, never advice", async () => {
    const report = await loadReport();
    if (!report) { expect(existsSync(REPORT_PATH)).toBe(false); return; }
    expect(report.classification).toBe("internal_only");
    expect(report.delivery_allowed).toBe(false);
    expect(report.is_finding).toBe(false);
    expect(report.is_legal_advice).toBe(false);
    expect(report.execution_mode).toBe("offline_synthetic_only");
  });

  it("hashes itself, so a later edit to the numbers cannot pass as the same document", async () => {
    const report = await loadReport();
    if (!report) return;
    const { report_sha256: signature, ...content } = report;
    expect(canonicalSha256(content)).toBe(signature);
  });

  it("every counter it reports is zero — nothing became active to produce it", async () => {
    const report = await loadReport();
    if (!report) return;
    for (const [name, value] of Object.entries(report.counters)) expect(value, name).toBe(0);
    expect(report.scenarios_run).toBe(0);
    expect(report.scenarios_attempted).toBe(42);
  });

  it("states a parameter-level difference for each open decision and never claims a scenario-level one", async () => {
    const report = await loadReport();
    if (!report) return;
    expect(report.open_decisions.length).toBeGreaterThan(0);
    for (const decision of report.open_decisions) {
      // Both branches present, and neither is silently preferred: the report
      // states two values and their difference, and stops there.
      expect(decision.branches.length, decision.decision_id).toBe(2);
      expect(decision.parameter_level_difference, decision.decision_id).not.toBeNull();
      // The scenario-level claim is exactly the one thing this report must not
      // invent while the draft specs cannot execute.
      expect(decision.scenario_level_difference, decision.decision_id).toBe("not_computable_yet");
    }
  });
});
