import { describe, expect, it } from "vitest";
import { reportingReconciliation } from "./reporting-reconciliation.ts";

describe("reporting ambiguity reconciliation", () => {
  it("names each dimension, stable case ID, and denominator", () => {
    const report = reportingReconciliation();
    expect(report.passed).toBe(true);
    expect(report.totals).toEqual({ reconciliation_count: 4, reconciled_count: 4 });
    const gt = report.reconciliations[0];
    expect(gt.dimensions[0]).toMatchObject({ numerator: 7, denominator: 7 });
    expect(gt.dimensions[1]).toMatchObject({ numerator: 5, denominator: 5 });
    const controlledImport = report.reconciliations[1];
    expect(controlledImport.dimensions).toEqual(expect.arrayContaining([expect.objectContaining({ command_id: 38, expectation_matched: true, subject_passed: true }), expect.objectContaining({ command_id: 30, expectation_matched: true, subject_passed: false })]));
    const commandLedger = report.reconciliations[3];
    expect(commandLedger.dimensions[1]).toMatchObject({ listed_command_count: 51, expectation_matched_count: 51, denominator: 51 });
  });
});
