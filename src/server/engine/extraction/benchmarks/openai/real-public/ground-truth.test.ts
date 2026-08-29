import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { payslipFieldKeySchema } from "@/engine/extraction/contracts";
import { realPublicPayslipGroundTruth } from "./ground-truth";

describe("real-public payslip ground truth", () => {
  it("uses five neutral IDs and classifies every supported field exactly once", () => {
    expect(realPublicPayslipGroundTruth.map((truth) => truth.fixture_id)).toEqual([
      "REAL_PUBLIC_001",
      "REAL_PUBLIC_002",
      "REAL_PUBLIC_003",
      "REAL_PUBLIC_004",
      "REAL_PUBLIC_005",
    ]);

    for (const truth of realPublicPayslipGroundTruth) {
      const expected = Object.keys(truth.expected_fields);
      const ambiguous = truth.ambiguous_fields.map((entry) => entry.field);
      const absent = [...truth.expected_absent_fields];
      const classified = [...expected, ...ambiguous, ...absent];
      expect(new Set(classified).size).toBe(classified.length);
      expect([...classified].sort()).toEqual([...payslipFieldKeySchema.options].sort());
      expect(truth.critical_fields.every((field) => expected.includes(field))).toBe(true);
      expect(truth.classification_complete).toBe(true);
    }
  });

  it("keeps layout metadata non-sensitive and records visually ambiguous fields without guessed values", () => {
    for (const truth of realPublicPayslipGroundTruth) {
      expect(truth.layout.pay_period).toMatch(/^20\d{2}-(?:0[1-9]|1[0-2])$/);
      expect(truth.layout.source_kind).toBe("raster_image");
      expect(truth.ambiguous_fields.every((entry) => !(entry.field in truth.expected_fields))).toBe(true);
      expect(JSON.stringify(truth.layout)).not.toMatch(/\b\d{7,9}\b/);
    }
  });
});
