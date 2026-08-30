import { describe, expect, it } from "vitest";
import { CASE_ANALYSIS_STAGES } from "../../../engine/case-analysis/contracts";
import { COMPLETE_THREE_PERIOD_FIXTURE, PARTIAL_THREE_PERIOD_FIXTURE } from "../../../engine/case-analysis/synthetic-fixtures";
import { runFullSystemAcceptanceMatrix } from "./acceptance";
import { createFixtureCaseAnalysisHarness } from "./fixture-harness";

describe("canonical offline case analysis", () => {
  it("runs the complete and partial three-period fixtures through the same canonical path", async () => {
    const harness = createFixtureCaseAnalysisHarness([
      COMPLETE_THREE_PERIOD_FIXTURE.stored,
      PARTIAL_THREE_PERIOD_FIXTURE.stored,
    ]);
    const complete = await harness.application.runCaseAnalysis(COMPLETE_THREE_PERIOD_FIXTURE.command);
    const partial = await harness.application.runCaseAnalysis(PARTIAL_THREE_PERIOD_FIXTURE.command);
    expect(complete.topic_results).toHaveLength(7);
    expect(complete.topic_results.every((result) => result.status === "calculated")).toBe(true);
    expect(complete.known_subtotal).toEqual({ currency: "XTS", minor_units: 28_000 });
    expect(partial.coverage_complete).toBe(false);
    expect(partial.topic_results.filter((result) => result.status === "calculated")).toHaveLength(5);
    expect(harness.snapshots.counters.openai_calls).toBe(0);
  });

  it("emits every required raw acceptance ID with deterministic hashes", async () => {
    const report = await runFullSystemAcceptanceMatrix();
    expect(report.passed).toBe(true);
    expect(report.case_count).toBe(38);
    expect(report.passed_count).toBe(38);
    expect(report.cases.map((entry) => entry.case_id)).toEqual(expect.arrayContaining([
      "INT_E2E_001", "INT_E2E_002", "INT_E2E_003",
      "INT_LEGAL_001", "INT_LEGAL_002", "INT_TOTAL_001",
      "INT_IDEM_001", "INT_IDEM_002",
      "INT_REPLAY_001", "INT_REPLAY_002", "INT_REPLAY_003",
      "INT_REVIEW_001", "INT_REVIEW_002", "INT_REVIEW_003",
      "INT_PRIVACY_001", "INT_BOUNDARY_001", "INT_CANONICAL_001",
    ]));
    expect(report.cases.filter((entry) => entry.case_id.startsWith("INT_BLOCK_"))).toHaveLength(7);
    expect(report.cases.filter((entry) => entry.case_id.startsWith("INT_CONFLICT_"))).toHaveLength(7);
    expect(report.cases.filter((entry) => entry.case_id.startsWith("INT_CRASH_"))).toHaveLength(CASE_ANALYSIS_STAGES.length);
    expect(report.cases.every((entry) => /^[a-f0-9]{64}$/u.test(entry.result_sha256))).toBe(true);
  }, 30_000);
});
