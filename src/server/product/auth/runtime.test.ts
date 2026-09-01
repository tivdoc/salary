import { afterEach, describe, expect, it } from "vitest";

import {
  installProductSessionBoundary,
  resetProductSessionBoundaryForTests,
  resolveProductSessionBoundary,
  type ProductSessionBoundary,
} from "./runtime.ts";

afterEach(() => resetProductSessionBoundaryForTests());

function boundary(): ProductSessionBoundary {
  return Object.freeze({
    proof_class: "HERMETIC_LOOPBACK_TEST_SESSION" as const,
    verify() { return null; },
  });
}

describe("canonical product session boundary runtime", () => {
  it("fails closed until exactly one boundary is installed", () => {
    expect(resolveProductSessionBoundary()).toBeNull();
    const installed = boundary();
    installProductSessionBoundary(installed);
    expect(resolveProductSessionBoundary()).toBe(installed);
    expect(() => installProductSessionBoundary(boundary())).toThrow("PRODUCT_SESSION_BOUNDARY_ALREADY_INSTALLED");
  });
});

