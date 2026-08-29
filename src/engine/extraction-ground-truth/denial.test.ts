import { describe, expect, it } from "vitest";
import {
  openVerifiedSyntheticFixture,
  SYNTHETIC_ALLOWED_ROOT,
  SYNTHETIC_PROHIBITED_SENTINEL,
} from "./denial.ts";

describe("Ground Truth path denial", () => {
  it("stops a synthetic prohibited sentinel before injected I/O", () => {
    let openerCalls = 0;
    expect(() => openVerifiedSyntheticFixture({
      source_kind: "prohibited_sentinel",
      path: SYNTHETIC_PROHIBITED_SENTINEL,
      opener: () => {
        openerCalls += 1;
        return "unreachable";
      },
    })).toThrow("ground_truth_prohibited_path_denied_before_io");
    expect(openerCalls).toBe(0);
  });

  it("rejects traversal before injected I/O and permits a synthetic fixture", () => {
    let openerCalls = 0;
    expect(() => openVerifiedSyntheticFixture({
      source_kind: "synthetic_fixture",
      path: `${SYNTHETIC_ALLOWED_ROOT}\\..\\outside.bin`,
      opener: () => {
        openerCalls += 1;
        return "unreachable";
      },
    })).toThrow("ground_truth_path_outside_synthetic_root");
    expect(openerCalls).toBe(0);
    expect(openVerifiedSyntheticFixture({
      source_kind: "synthetic_fixture",
      path: `${SYNTHETIC_ALLOWED_ROOT}\\fixture-001.json`,
      opener: (verifiedPath) => {
        openerCalls += 1;
        return verifiedPath;
      },
    })).toBe(`${SYNTHETIC_ALLOWED_ROOT}\\fixture-001.json`);
    expect(openerCalls).toBe(1);
  });
});
