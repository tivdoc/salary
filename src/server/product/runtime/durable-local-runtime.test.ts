import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { DURABLE_LOCAL_PRODUCT_STARTUP_SCHEMA_VERSION } from "./durable-local-runtime.ts";

describe("durable local product startup root", () => {
  it("owns one fail-closed non-test composition with role-separated durable boundaries", () => {
    const source = readFileSync(resolve(process.cwd(),
      "src/server/product/runtime/durable-local-runtime.ts"), "utf8");

    expect(DURABLE_LOCAL_PRODUCT_STARTUP_SCHEMA_VERSION)
      .toBe("tivdoc-durable-local-product-startup-v0.10.2");
    expect(source).toContain('execution_boundary: "non_test"');
    expect(source).toContain("PostgresIdentitySessionStateReader(identityFactory)");
    expect(source).toContain("DurableCryptographicProductSessionBoundary");
    expect(source).toContain("createLeastPrivilegeProductSessionContext(postgres)");
    expect(source).toContain("createDurableCustomerPortalAdapter");
    expect(source).toContain("createDurableInternalOpsPostgresAdapter");
    expect(source).toContain("createDurableGovernanceOperationsRouteAdapter");
    expect(source).toContain("createDurableMultiDocumentProductRouteAdapter(registration.context)");
    expect(source).toContain("createDurablePostgresGlobalDependencyInvalidationService");
    expect(source).toContain("DURABLE_GLOBAL_INVALIDATION_POSTGRES_PROOF.worker_fence_required");
    expect(source).toContain("createDurableSyntheticReportPipeline");
    expect(source).toContain("createDurableFreshWorkerLauncher(config)");
    expect(source).toContain("LocalRuntimePrivateBlobProvider");
    expect(source).not.toMatch(/InMemory|StrictRecording|runtimeHermeticSessionManager/u);
  });

  it("installs capabilities, identity and the application only after full construction", () => {
    const source = readFileSync(resolve(process.cwd(),
      "src/server/product/runtime/durable-local-runtime.ts"), "utf8");
    const registration = source.indexOf("const registration = createDurableProductRouteRegistration");
    const capabilities = source.indexOf("const capabilities = createStableEntrypointRuntime");
    const installCapabilities = source.indexOf("installCanonicalProductEntrypointCapabilities(capabilities)");
    const installSession = source.indexOf("installProductSessionBoundary(registration.session_boundary)");
    const installComposition = source.indexOf("installCanonicalProductApplicationComposition(registration.application_composition)");

    expect(registration).toBeGreaterThan(0);
    expect(capabilities).toBeGreaterThan(registration);
    expect(installCapabilities).toBeGreaterThan(capabilities);
    expect(installSession).toBeGreaterThan(installCapabilities);
    expect(installComposition).toBeGreaterThan(installSession);
  });

  it("keeps the ordinary instrumentation import Node-only and mutually exclusive from hermetic mode", () => {
    const source = readFileSync(resolve(process.cwd(), "src/instrumentation.ts"), "utf8");
    const register = source.slice(source.indexOf("export async function register"));
    expect(register).toContain('process.env.NEXT_RUNTIME === "nodejs"');
    expect(register).toContain("PRODUCT_RUNTIME_BOOTSTRAP_MODE_CONFLICT");
    expect(register).toContain('import(\n        "./server/product/runtime/durable-local-runtime"');
    expect(source).not.toMatch(/^import .*durable-local-runtime/mu);
  });
});
