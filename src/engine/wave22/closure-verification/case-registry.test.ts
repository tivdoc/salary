import { describe, expect, it } from "vitest";
import { validateWave22RawCaseMatrices, wave22ClosureCaseIds } from "./case-registry.ts";

function validMatrices() {
  return Object.fromEntries(Object.entries(wave22ClosureCaseIds).map(([group, ids]) => [
    group,
    ids.map((case_id) => ({ case_id, passed: true })),
  ]));
}

describe("Wave 2.2 closure case registry", () => {
  it("requires all 28 stable raw cases exactly once", () => {
    expect(validateWave22RawCaseMatrices(validMatrices())).toMatchObject({ group_count: 6, case_count: 28, passed: true });
  });

  it("rejects missing and renamed cases", () => {
    const missing = validMatrices();
    missing.crash.pop();
    expect(() => validateWave22RawCaseMatrices(missing)).toThrow("wave22_raw_matrix_count_mismatch:crash");
    const renamed = validMatrices();
    renamed.ground_truth[0].case_id = "GT_NEG_999_RENAMED";
    expect(() => validateWave22RawCaseMatrices(renamed)).toThrow("wave22_raw_matrix_id_mismatch:ground_truth:0");
  });
});
