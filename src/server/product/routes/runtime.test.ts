import { afterEach, describe, expect, it } from "vitest";

import { SYSTEM_CAPABILITY_SCHEMA_VERSION, buildSystemCapabilityProjection } from "../../platform/capabilities/system-capabilities.ts";
import {
  assertStableEntrypointCapability,
  createStableEntrypointRuntime,
  resetStableEntrypointRuntimeForTests,
} from "../../platform/capabilities/stable-entrypoint-runtime.ts";
import { installProductSessionBoundary, resetProductSessionBoundaryForTests } from "../auth/runtime.ts";
import type { CustomerPortalService } from "../customer-portal/service.ts";
import {
  installCanonicalProductApplicationComposition,
  installCanonicalProductEntrypointCapabilities,
  resetCanonicalProductRouteServicesForTests,
  resolveCanonicalApplicationProofClass,
} from "./runtime.ts";

const services = Object.freeze({ portal: {} as CustomerPortalService });

afterEach(() => {
  resetCanonicalProductRouteServicesForTests();
  resetStableEntrypointRuntimeForTests();
  resetProductSessionBoundaryForTests();
});

describe("canonical product route composition", () => {
  it("installs and verifies the stable entrypoint capability registrar exactly once", () => {
    const projection = buildSystemCapabilityProjection({
      schema_version: SYSTEM_CAPABILITY_SCHEMA_VERSION,
      runtime_mode: "test",
      execution_scope: "local_only",
      fixture_mode: "none",
      declarations: {},
    });
    const runtime = createStableEntrypointRuntime({ projection });
    installCanonicalProductEntrypointCapabilities(runtime);
    expect(assertStableEntrypointCapability("CEP-078")).toMatchObject({ outcome: "ALLOW" });
    expect(() => installCanonicalProductEntrypointCapabilities(runtime)).toThrow("CAPABILITY_RUNTIME_ALREADY_INSTALLED");
  });

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
