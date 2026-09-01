import { afterEach, describe, expect, it } from "vitest";

import {
  SYSTEM_CAPABILITY_PREREQUISITES,
  SYSTEM_CAPABILITY_SCHEMA_VERSION,
  buildSystemCapabilityProjection,
  type CapabilityDeclaration,
  type CapabilityStartupInput,
  type SystemCapabilityName,
} from "./system-capabilities.ts";
import {
  STABLE_ENTRYPOINT_CAPABILITY_REQUIREMENTS,
  assertStableEntrypointCapability,
  assertStableEntrypointRequest,
  createStableEntrypointRuntime,
  installStableEntrypointRuntime,
  resetStableEntrypointRuntimeForTests,
  validateStableEntrypointCapabilityRequirements,
} from "./stable-entrypoint-runtime.ts";

function declaration(name: SystemCapabilityName, state: CapabilityDeclaration["state"]): CapabilityDeclaration {
  const hasProvider = state === "enabled" || state === "test_only";
  return {
    state,
    provider_target: hasProvider ? "local" : null,
    provider_id: hasProvider ? `local-${name.replaceAll("_", "-")}` : null,
    provider_schema_version: hasProvider ? "v1" : null,
    prerequisite_capabilities: SYSTEM_CAPABILITY_PREREQUISITES[name],
    blocker_codes: state === "blocked" ? [name === "parser" ? "PARSER_OS_SANDBOX_NOT_VERIFIED" : "EXTERNAL_CAPABILITY_BLOCKED"] : [],
    evidence_codes: [],
  };
}

function projection(overrides: Partial<Record<SystemCapabilityName, CapabilityDeclaration>> = {}) {
  const enabled = new Set<SystemCapabilityName>(["identity", "session", "postgresql", "storage", "extraction", "operations", "portal", "export", "download"]);
  const declarations = Object.fromEntries(
    Object.keys(SYSTEM_CAPABILITY_PREREQUISITES).map((name) => {
      const capability = name as SystemCapabilityName;
      return [capability, declaration(capability, capability === "parser" ? "blocked" : enabled.has(capability) ? "enabled" : "disabled")];
    }),
  ) as Record<SystemCapabilityName, CapabilityDeclaration>;
  return buildSystemCapabilityProjection({
    schema_version: SYSTEM_CAPABILITY_SCHEMA_VERSION,
    runtime_mode: "test",
    execution_scope: "local_only",
    fixture_mode: "synthetic_test",
    declarations: { ...declarations, ...overrides } as CapabilityStartupInput["declarations"],
  });
}

afterEach(() => resetStableEntrypointRuntimeForTests());

describe("stable entrypoint capability registry", () => {
  it("preserves the complete frozen denominator and separates CLI execution classes", () => {
    expect(validateStableEntrypointCapabilityRequirements()).toEqual([]);
    expect(STABLE_ENTRYPOINT_CAPABILITY_REQUIREMENTS).toHaveLength(95);
    expect(STABLE_ENTRYPOINT_CAPABILITY_REQUIREMENTS.filter((entry) => entry.product_stable)).toHaveLength(84);
    expect(countBy(STABLE_ENTRYPOINT_CAPABILITY_REQUIREMENTS, "kind")).toEqual({
      api_route: 14,
      app_route: 12,
      application_service: 19,
      cli: 45,
      durable_worker: 5,
    });
    const cliClasses = new Set(
      STABLE_ENTRYPOINT_CAPABILITY_REQUIREMENTS.filter((entry) => entry.kind === "cli").map((entry) => entry.execution_class),
    );
    expect(cliClasses).toEqual(new Set(["evidence_cli", "maintenance_cli"]));
  });

  it("allows a configured portal but blocks customer, parser and external surfaces with visible reasons", () => {
    const runtime = createStableEntrypointRuntime({ projection: projection() });
    expect(runtime.evaluate("CEP-025")).toMatchObject({ outcome: "ALLOW", reason_codes: [] });
    expect(runtime.evaluate("CEP-013")).toMatchObject({
      outcome: "BLOCK",
      blocked_capabilities: ["customer_processing"],
      reason_codes: ["CAPABILITY_CUSTOMER_PROCESSING_DISABLED"],
    });
    expect(runtime.evaluate("CEP-087")).toMatchObject({ outcome: "BLOCK" });
    expect(runtime.evaluate("CEP-087").reason_codes).toContain("PARSER_OS_SANDBOX_NOT_VERIFIED");
    expect(runtime.evaluate("CEP-022")).toMatchObject({ outcome: "BLOCK" });
    expect(runtime.evaluate("CEP-022").reason_codes).toContain("LIVE_PROVIDER_CALLS_0");
  });

  it("lets bounded detector CLIs execute without treating their external blocker as a product capability", () => {
    const runtime = createStableEntrypointRuntime({ projection: projection() });
    expect(runtime.evaluate("CEP-037")).toMatchObject({
      outcome: "ALLOW",
      reason_codes: [],
      external_reason_codes: ["ISOLATED_SUPABASE_EXTERNAL"],
    });
    expect(STABLE_ENTRYPOINT_CAPABILITY_REQUIREMENTS.find((entry) => entry.entrypoint_id === "CEP-037")).toMatchObject({
      execution_class: "evidence_cli",
      static_reason_codes: ["ISOLATED_SUPABASE_EXTERNAL"],
    });
  });

  it("fails closed before one-shot installation and enforces request limits after installation", () => {
    expect(() => assertStableEntrypointCapability("CEP-025")).toThrow("CAPABILITY_RUNTIME_NOT_INSTALLED");
    const runtime = createStableEntrypointRuntime({ projection: projection() });
    expect(() => installStableEntrypointRuntime({ ...runtime })).toThrow("CAPABILITY_RUNTIME_UNVERIFIED_INSTANCE");
    installStableEntrypointRuntime(runtime);
    expect(() => installStableEntrypointRuntime(runtime)).toThrow("CAPABILITY_RUNTIME_ALREADY_INSTALLED");
    expect(assertStableEntrypointCapability("CEP-025").outcome).toBe("ALLOW");
    expect(() => assertStableEntrypointRequest("CEP-025", {
      content_length: runtime.limits.maximum_json_body_bytes + 1,
      body_bytes: 0,
    })).toThrow("CAPABILITY_CONTENT_LENGTH_LIMIT");
    expect(() => assertStableEntrypointCapability("CEP-013")).toThrow("CAPABILITY_ENTRYPOINT_BLOCKED:CEP-013");
  });
});

function countBy<T extends Record<string, unknown>, K extends keyof T>(rows: readonly T[], key: K): Record<string, number> {
  return Object.fromEntries([...rows.reduce((counts, row) => {
    const value = String(row[key]);
    counts.set(value, (counts.get(value) ?? 0) + 1);
    return counts;
  }, new Map<string, number>())].sort(([left], [right]) => left.localeCompare(right)));
}
