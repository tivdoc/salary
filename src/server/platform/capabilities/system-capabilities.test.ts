import { describe, expect, it } from "vitest";

import {
  BoundedAdmissionController,
  LOCAL_SYSTEM_LIMITS,
  SYSTEM_CAPABILITY_SCHEMA_VERSION,
  SYSTEM_CAPABILITY_PREREQUISITES,
  assertRequestWithinSystemLimits,
  buildSystemCapabilityProjection,
  runBoundedAtomicMutation,
  type CapabilityStartupInput,
  type SystemCapabilityName,
} from "./system-capabilities.ts";

function declaration(state: "enabled" | "disabled" | "blocked" | "test_only", prerequisites: readonly SystemCapabilityName[] = []) {
  return {
    state,
    provider_target: state === "enabled" || state === "test_only" ? "local" as const : null,
    provider_id: state === "enabled" || state === "test_only" ? "local-test-provider" : null,
    provider_schema_version: state === "enabled" || state === "test_only" ? "v1" : null,
    prerequisite_capabilities: prerequisites,
    blocker_codes: state === "blocked" ? ["EXTERNAL_CAPABILITY_BLOCKED"] : [],
    evidence_codes: [],
  };
}

function safeInput(): CapabilityStartupInput {
  return {
    schema_version: SYSTEM_CAPABILITY_SCHEMA_VERSION,
    runtime_mode: "test",
    execution_scope: "local_only",
    fixture_mode: "synthetic_test",
    declarations: {
      identity: declaration("enabled"),
      session: declaration("enabled", SYSTEM_CAPABILITY_PREREQUISITES.session),
      postgresql: declaration("enabled", SYSTEM_CAPABILITY_PREREQUISITES.postgresql),
      storage: declaration("enabled", SYSTEM_CAPABILITY_PREREQUISITES.storage),
      parser: { ...declaration("blocked", SYSTEM_CAPABILITY_PREREQUISITES.parser), blocker_codes: ["PARSER_OS_SANDBOX_NOT_VERIFIED"] },
      controlled_import: declaration("disabled", SYSTEM_CAPABILITY_PREREQUISITES.controlled_import),
      extraction: declaration("enabled", SYSTEM_CAPABILITY_PREREQUISITES.extraction),
      legal_review: declaration("test_only", SYSTEM_CAPABILITY_PREREQUISITES.legal_review),
      parameter_approval: declaration("test_only", SYSTEM_CAPABILITY_PREREQUISITES.parameter_approval),
      rulespec_approval: declaration("test_only", SYSTEM_CAPABILITY_PREREQUISITES.rulespec_approval),
      analysis: declaration("test_only", SYSTEM_CAPABILITY_PREREQUISITES.analysis),
      operations: declaration("enabled", SYSTEM_CAPABILITY_PREREQUISITES.operations),
      portal: declaration("enabled", SYSTEM_CAPABILITY_PREREQUISITES.portal),
      export: declaration("enabled", SYSTEM_CAPABILITY_PREREQUISITES.export),
      download: declaration("enabled", SYSTEM_CAPABILITY_PREREQUISITES.download),
      shadow: declaration("disabled", SYSTEM_CAPABILITY_PREREQUISITES.shadow),
      customer_processing: declaration("disabled", SYSTEM_CAPABILITY_PREREQUISITES.customer_processing),
      delivery: declaration("disabled", SYSTEM_CAPABILITY_PREREQUISITES.delivery),
    } as CapabilityStartupInput["declarations"],
  };
}

describe("typed system capability projection", () => {
  it("is deterministic and keeps external/customer/delivery gates fail-closed", () => {
    const first = buildSystemCapabilityProjection(safeInput());
    const second = buildSystemCapabilityProjection({ ...safeInput(), declarations: Object.fromEntries(Object.entries(safeInput().declarations).reverse()) });
    expect(second).toEqual(first);
    expect(first.enabled_capabilities).toEqual(["identity", "session", "postgresql", "storage", "extraction", "operations", "portal", "export", "download"]);
    expect(first.blocked_capabilities).toEqual(["parser"]);
    expect(first.capabilities.customer_processing.state).toBe("disabled");
    expect(first.capabilities.delivery.state).toBe("disabled");
  });

  it.each([
    [{ ...safeInput(), schema_version: "unknown" }, "CAPABILITY_SCHEMA_VERSION_UNSUPPORTED"],
    [{ ...safeInput(), runtime_mode: "production" }, "CAPABILITY_RUNTIME_MODE_UNSAFE"],
    [{ ...safeInput(), runtime_mode: "development" }, "CAPABILITY_TEST_FIXTURE_LEAKAGE"],
    [{ ...safeInput(), execution_scope: "remote" }, "CAPABILITY_EXECUTION_SCOPE_UNSAFE"],
  ] as const)("fails startup for an unsafe projection", (input, code) => {
    expect(() => buildSystemCapabilityProjection(input)).toThrow(code);
  });

  it("rejects enabled capabilities with disabled prerequisites, managed targets or customer modes", () => {
    expect(() => buildSystemCapabilityProjection({
      ...safeInput(),
      declarations: { ...safeInput().declarations, storage: declaration("disabled", SYSTEM_CAPABILITY_PREREQUISITES.storage) },
    })).toThrow("CAPABILITY_PREREQUISITE_DISABLED");
    expect(() => buildSystemCapabilityProjection({
      ...safeInput(),
      declarations: { ...safeInput().declarations, storage: { ...declaration("enabled", SYSTEM_CAPABILITY_PREREQUISITES.storage), provider_target: "managed" } },
    })).toThrow("CAPABILITY_REMOTE_PROVIDER_FORBIDDEN_LOCAL");
    expect(() => buildSystemCapabilityProjection({
      ...safeInput(),
      declarations: { ...safeInput().declarations, customer_processing: declaration("enabled", SYSTEM_CAPABILITY_PREREQUISITES.customer_processing) },
    })).toThrow("CAPABILITY_CUSTOMER_OR_DELIVERY_FORBIDDEN_LOCAL");
    expect(() => buildSystemCapabilityProjection({
      ...safeInput(),
      declarations: { ...safeInput().declarations, delivery: declaration("test_only", SYSTEM_CAPABILITY_PREREQUISITES.delivery) },
    })).toThrow("CAPABILITY_CUSTOMER_OR_DELIVERY_FORBIDDEN_LOCAL");
    expect(() => buildSystemCapabilityProjection({
      ...safeInput(),
      fixture_mode: "none",
    })).toThrow("CAPABILITY_TEST_ONLY_WITHOUT_FIXTURE");
    expect(() => buildSystemCapabilityProjection({
      ...safeInput(),
      declarations: {
        ...safeInput().declarations,
        controlled_import: declaration("enabled", SYSTEM_CAPABILITY_PREREQUISITES.controlled_import),
      },
    })).toThrow("CAPABILITY_IMPORT_REQUIRES_PARSER");
  });

  it("rejects a weakened prerequisite graph or incomplete provider identity", () => {
    expect(() => buildSystemCapabilityProjection({
      ...safeInput(),
      declarations: { ...safeInput().declarations, portal: declaration("enabled", ["identity"]) },
    })).toThrow("CAPABILITY_PREREQUISITE_INVALID:portal");
    expect(() => buildSystemCapabilityProjection({
      ...safeInput(),
      declarations: {
        ...safeInput().declarations,
        portal: { ...declaration("enabled", SYSTEM_CAPABILITY_PREREQUISITES.portal), provider_schema_version: null },
      },
    })).toThrow("CAPABILITY_PROVIDER_METADATA_MISMATCH:portal");
  });

  it("requires explicit parser sandbox evidence before enabling parser and import", () => {
    expect(() => buildSystemCapabilityProjection({
      ...safeInput(),
      declarations: {
        ...safeInput().declarations,
        parser: declaration("enabled", SYSTEM_CAPABILITY_PREREQUISITES.parser),
      },
    })).toThrow("CAPABILITY_PARSER_SANDBOX_UNVERIFIED");
    expect(() => buildSystemCapabilityProjection({
      ...safeInput(),
      declarations: {
        ...safeInput().declarations,
        parser: {
          ...declaration("enabled", SYSTEM_CAPABILITY_PREREQUISITES.parser),
          evidence_codes: ["PARSER_OS_SANDBOX_VERIFIED"],
        },
        controlled_import: declaration("enabled", SYSTEM_CAPABILITY_PREREQUISITES.controlled_import),
      },
    })).not.toThrow();
  });

  it("records a remote provider only as blocked and rejects a test provider in development", () => {
    const blockedRemote = buildSystemCapabilityProjection({
      ...safeInput(),
      declarations: {
        ...safeInput().declarations,
        parser: {
          ...declaration("blocked", SYSTEM_CAPABILITY_PREREQUISITES.parser),
          provider_target: "isolated_supabase",
          provider_id: "isolated-parser",
          provider_schema_version: "v1",
          blocker_codes: ["ISOLATED_PROVIDER_NOT_VERIFIED"],
        },
      },
    });
    expect(blockedRemote.capabilities.parser).toMatchObject({
      state: "blocked",
      provider_target: "isolated_supabase",
      blocker_codes: ["ISOLATED_PROVIDER_NOT_VERIFIED"],
    });

    const developmentDeclarations = Object.fromEntries(Object.entries(safeInput().declarations).map(([name, value]) => {
      if (value?.state !== "test_only") return [name, value];
      return [name, {
        ...value,
        state: "disabled",
        provider_target: null,
        provider_id: null,
        provider_schema_version: null,
      }];
    })) as CapabilityStartupInput["declarations"];
    expect(() => buildSystemCapabilityProjection({
      ...safeInput(),
      runtime_mode: "development",
      fixture_mode: "none",
      declarations: {
        ...developmentDeclarations,
        identity: {
          ...developmentDeclarations.identity!,
          provider_id: "hermetic-test-identity",
        },
      },
    })).toThrow("CAPABILITY_TEST_PROVIDER_LEAKAGE");
  });
});

describe("bounded local admission and atomic cancellation", () => {
  it("applies per-case, per-actor and global backpressure without counter leakage", () => {
    let next = 0;
    const controller = new BoundedAdmissionController({
      runtime_mode: "test",
      id_factory: () => `synthetic-${++next}`,
      limits: { ...LOCAL_SYSTEM_LIMITS, maximum_in_flight_per_actor: 2, maximum_in_flight_per_case: 1, maximum_total_in_flight: 2 },
    });
    const first = controller.admit({ actor_id: "actor.001", case_id: "case.001" });
    expect(() => controller.admit({ actor_id: "actor.002", case_id: "case.001" })).toThrow("CAPABILITY_CASE_CONCURRENCY_LIMIT");
    const second = controller.admit({ actor_id: "actor.001", case_id: "case.002" });
    expect(() => controller.admit({ actor_id: "actor.003", case_id: "case.003" })).toThrow("CAPABILITY_GLOBAL_BACKPRESSURE");
    first.release();
    second.release();
    second.release();
    expect(controller.snapshot()).toEqual({ total: 0, actors: [], cases: [] });
  });

  it("rolls back staged state on cancellation and leaves no partial visible state", async () => {
    const controller = new BoundedAdmissionController({ runtime_mode: "test", id_factory: () => "synthetic-lease" });
    const abort = new AbortController();
    const visible: string[] = [];
    const staged: string[] = [];
    await expect(runBoundedAtomicMutation({
      controller,
      actor_id: "actor.001",
      case_id: "case.001",
      signal: abort.signal,
      operation: {
        async stage() { staged.push("candidate"); abort.abort(); return "candidate"; },
        async commit(value) { visible.push(value); return value; },
        async rollback(value) { staged.splice(staged.indexOf(value), 1); },
      },
    })).rejects.toThrow("CAPABILITY_OPERATION_CANCELLED");
    expect(staged).toEqual([]);
    expect(visible).toEqual([]);
    expect(controller.snapshot().total).toBe(0);
  });

  it("completes a focused 250-operation synthetic load with deterministic zero partial state", async () => {
    let next = 0;
    const controller = new BoundedAdmissionController({ runtime_mode: "test", id_factory: () => `load-${++next}` });
    const visible = new Set<string>();
    for (let index = 0; index < 250; index += 1) {
      const result = await runBoundedAtomicMutation({
        controller,
        actor_id: `actor.${String(index % 8).padStart(3, "0")}`,
        case_id: `case.${String(index % 16).padStart(3, "0")}`,
        operation: {
          async stage() { return `record.${String(index).padStart(4, "0")}`; },
          async commit(value) { visible.add(value); return value; },
          async rollback(value) { visible.delete(value); },
        },
      });
      expect(visible.has(result)).toBe(true);
    }
    expect(visible.size).toBe(250);
    expect(controller.snapshot()).toEqual({ total: 0, actors: [], cases: [] });
  });

  it("enforces every declared request dimension", () => {
    expect(() => assertRequestWithinSystemLimits({ content_length: 64, body_bytes: 64, page_count: 2, field_count: 20, batch_size: 2, report_bytes: 64 })).not.toThrow();
    expect(() => assertRequestWithinSystemLimits({ content_length: LOCAL_SYSTEM_LIMITS.maximum_json_body_bytes + 1, body_bytes: 0 })).toThrow("CAPABILITY_CONTENT_LENGTH_LIMIT");
    expect(() => assertRequestWithinSystemLimits({ content_length: null, body_bytes: 0, page_count: LOCAL_SYSTEM_LIMITS.maximum_pages_per_document + 1 })).toThrow("CAPABILITY_PAGE_LIMIT");
    expect(() => assertRequestWithinSystemLimits({ content_length: null, body_bytes: 0, field_count: LOCAL_SYSTEM_LIMITS.maximum_fields_per_document + 1 })).toThrow("CAPABILITY_FIELD_LIMIT");
    expect(() => assertRequestWithinSystemLimits({ content_length: null, body_bytes: 0, batch_size: LOCAL_SYSTEM_LIMITS.maximum_jobs_per_batch + 1 })).toThrow("CAPABILITY_BATCH_LIMIT");
    expect(() => assertRequestWithinSystemLimits({ content_length: null, body_bytes: 0, report_bytes: LOCAL_SYSTEM_LIMITS.maximum_report_bytes + 1 })).toThrow("CAPABILITY_REPORT_LIMIT");
    expect(() => assertRequestWithinSystemLimits({
      content_length: LOCAL_SYSTEM_LIMITS.maximum_json_body_bytes + 1,
      body_bytes: LOCAL_SYSTEM_LIMITS.maximum_json_body_bytes + 1,
      body_kind: "upload",
    })).not.toThrow();
    expect(() => assertRequestWithinSystemLimits({
      content_length: LOCAL_SYSTEM_LIMITS.maximum_upload_bytes + 1,
      body_bytes: 0,
      body_kind: "upload",
    })).toThrow("CAPABILITY_CONTENT_LENGTH_LIMIT");
  });

  it("times out a cooperative staged mutation and rolls it back", async () => {
    const controller = new BoundedAdmissionController({ runtime_mode: "test", id_factory: () => "timeout-lease" });
    const staged: string[] = [];
    await expect(runBoundedAtomicMutation({
      controller,
      actor_id: "actor.timeout",
      case_id: "case.timeout",
      timeout_milliseconds: 5,
      operation: {
        async stage(signal) {
          staged.push("candidate");
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          return "candidate";
        },
        async commit(value) { return value; },
        async rollback(value) { staged.splice(staged.indexOf(value), 1); },
      },
    })).rejects.toThrow("CAPABILITY_OPERATION_TIMEOUT");
    expect(staged).toEqual([]);
    expect(controller.snapshot().total).toBe(0);
  });
});
