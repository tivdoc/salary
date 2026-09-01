import { afterEach, describe, expect, it } from "vitest";

import { installProductSessionBoundary, resetProductSessionBoundaryForTests } from "../auth/runtime.ts";
import type { CustomerPortalService } from "../customer-portal/service.ts";
import {
  installCanonicalProductApplicationComposition,
  resetCanonicalProductRouteServicesForTests,
  resolveCanonicalApplicationProofClass,
} from "./runtime.ts";

const services = Object.freeze({ portal: {} as CustomerPortalService });

afterEach(() => {
  resetCanonicalProductRouteServicesForTests();
  resetProductSessionBoundaryForTests();
});

describe("canonical product route composition", () => {
  it("requires a matching identity proof class for every installed composition", () => {
    expect(() => installCanonicalProductApplicationComposition({
      services,
      persistence: null,
      proof_class: "HERMETIC_MEMORY_TEST_ONLY",
    })).toThrow("CANONICAL_PRODUCT_SESSION_BOUNDARY_REQUIRED");

    installProductSessionBoundary(Object.freeze({
      proof_class: "HERMETIC_LOOPBACK_TEST_SESSION" as const,
      verify() { return null; },
    }));
    expect(() => installCanonicalProductApplicationComposition({
      services,
      persistence: { mode: "isolated_postgres", durable: true },
      proof_class: "POSTGRESQL_EXECUTION_PROOF",
    })).toThrow("CANONICAL_PRODUCT_DURABLE_COMPOSITION_INVALID");
    installCanonicalProductApplicationComposition({
      services,
      persistence: null,
      proof_class: "HERMETIC_MEMORY_TEST_ONLY",
    });
    expect(resolveCanonicalApplicationProofClass()).toBe("HERMETIC_MEMORY_TEST_ONLY");
  });
});
