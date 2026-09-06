if (typeof window !== "undefined") {
  throw new Error("SYSTEM_CAPABILITY_RUNTIME_SERVER_ONLY");
}

import inventoryJson from "../../system-marathon/canonical-entrypoints.v0.10.0.json" with { type: "json" };

import { deepFreeze } from "../../../engine/rule-runtime/canonical.ts";
import type { CanonicalEntrypoint, CanonicalEntrypointInventory } from "../../system-marathon/closure-contracts.ts";
import {
  BoundedAdmissionController,
  LOCAL_SYSTEM_LIMITS,
  SYSTEM_CAPABILITY_SCHEMA_VERSION,
  assertRequestWithinSystemLimits,
  systemLimitsSchema,
  type SystemCapabilityName,
  type SystemCapabilityProjection,
  type SystemLimits,
} from "./system-capabilities.ts";

const inventory = inventoryJson as CanonicalEntrypointInventory;

export const STABLE_ENTRYPOINT_CAPABILITY_SCHEMA_VERSION = "tivdoc-stable-entrypoint-capabilities-v0.10.2" as const;

export type EntrypointExecutionClass =
  | "product_runtime"
  | "evidence_cli"
  | "maintenance_cli"
  | "external_or_human_gate"
  | "non_product_contract";

export type StableEntrypointCapabilityRequirement = Readonly<{
  entrypoint_id: string;
  stable_entry: string;
  source_path: string;
  kind: CanonicalEntrypoint["kind"];
  product_stable: boolean;
  execution_class: EntrypointExecutionClass;
  required_capabilities: readonly SystemCapabilityName[];
  static_reason_codes: readonly string[];
  fixture_capabilities_allowed: boolean;
}>;

export type EntrypointCapabilityDecision = Readonly<{
  schema_version: typeof STABLE_ENTRYPOINT_CAPABILITY_SCHEMA_VERSION;
  entrypoint_id: string;
  projection_sha256: string;
  outcome: "ALLOW" | "BLOCK";
  reason_codes: readonly string[];
  external_reason_codes: readonly string[];
  blocked_capabilities: readonly SystemCapabilityName[];
}>;

export type StableEntrypointRuntime = Readonly<{
  projection: SystemCapabilityProjection;
  limits: SystemLimits;
  admission: BoundedAdmissionController;
  evaluate(entrypointId: string): EntrypointCapabilityDecision;
  assert(entrypointId: string): EntrypointCapabilityDecision;
  assertRequest(entrypointId: string, request: Parameters<typeof assertRequestWithinSystemLimits>[0]): EntrypointCapabilityDecision;
  /**
   * L9-4 / D3. True for a dispatcher this runtime serves as `main` serves it:
   * no capability is consulted and no limit is applied, because the route's
   * own code — the live site's — decides. Only the closed production runtime
   * declares any; the local runtimes declare none.
   */
  servesAsMain(entrypointId: string): boolean;
}>;

export const STABLE_ENTRYPOINT_CAPABILITY_REQUIREMENTS: readonly StableEntrypointCapabilityRequirement[] = deepFreeze(
  inventory.entries.map((entry) => requirementFor(entry)),
);

/** Frozen product dispatcher denominator: 32 Next roots plus the route registrar (UX Run 1 / U0 added CEP-096..CEP-101: 26 → 32). */
export const STABLE_PRODUCT_DISPATCHER_ROOTS: readonly StableEntrypointCapabilityRequirement[] = deepFreeze(
  STABLE_ENTRYPOINT_CAPABILITY_REQUIREMENTS.filter((entry) =>
    entry.product_stable
    && (entry.kind === "app_route" || entry.kind === "api_route" || entry.entrypoint_id === "CEP-078")),
);

const requirementById = new Map(STABLE_ENTRYPOINT_CAPABILITY_REQUIREMENTS.map((entry) => [entry.entrypoint_id, entry]));
const createdRuntimes = new WeakSet<object>();

export function validateStableEntrypointCapabilityRequirements(): readonly string[] {
  const issues: string[] = [];
  if (inventory.entries.length !== 105) issues.push("CAPABILITY_ENTRYPOINT_DENOMINATOR_CHANGED");
  if (STABLE_ENTRYPOINT_CAPABILITY_REQUIREMENTS.length !== inventory.entries.length) issues.push("CAPABILITY_ENTRYPOINT_MAPPING_INCOMPLETE");
  if (inventory.entries.filter((entry) => entry.product_stable).length !== 94) issues.push("CAPABILITY_PRODUCT_STABLE_DENOMINATOR_CHANGED");
  if (STABLE_PRODUCT_DISPATCHER_ROOTS.length !== 37) issues.push("CAPABILITY_PRODUCT_DISPATCHER_DENOMINATOR_CHANGED");
  if (requirementById.size !== inventory.entries.length) issues.push("CAPABILITY_ENTRYPOINT_ID_DUPLICATE");

  for (const entry of inventory.entries) {
    const requirement = requirementById.get(entry.entrypoint_id);
    if (!requirement) {
      issues.push(`CAPABILITY_ENTRYPOINT_UNMAPPED:${entry.entrypoint_id}`);
      continue;
    }
    if (requirement.stable_entry !== entry.stable_entry || requirement.source_path !== entry.source_path
        || requirement.kind !== entry.kind || requirement.product_stable !== entry.product_stable) {
      issues.push(`CAPABILITY_ENTRYPOINT_IDENTITY_CHANGED:${entry.entrypoint_id}`);
    }
    if (entry.kind === "cli" && !["evidence_cli", "maintenance_cli", "external_or_human_gate"].includes(requirement.execution_class)) {
      issues.push(`CAPABILITY_CLI_CLASSIFICATION_MISSING:${entry.entrypoint_id}`);
    }
    if (entry.kind !== "cli" && requirement.execution_class === "maintenance_cli") {
      issues.push(`CAPABILITY_NON_CLI_MAINTENANCE_CLASSIFICATION:${entry.entrypoint_id}`);
    }
    if (requirement.required_capabilities.some((capability, index, values) => values.indexOf(capability) !== index)) {
      issues.push(`CAPABILITY_ENTRYPOINT_REQUIREMENT_DUPLICATE:${entry.entrypoint_id}`);
    }
  }
  return deepFreeze(issues);
}

export const SERVED_AS_MAIN = "SERVED_AS_MAIN" as const;

export function createStableEntrypointRuntime(input: Readonly<{
  projection: SystemCapabilityProjection;
  limits?: SystemLimits;
  admission?: BoundedAdmissionController;
  /** The dispatchers served as `main` serves them (the product half of a closed deployment); absent means none. */
  served_as_main?: (entrypointId: string) => boolean;
  /** The dispatchers blocked by declaration whatever they need — the engine half of a closed deployment — with the reason code; absent means none. */
  blocked_by_declaration?: (entrypointId: string) => string | null;
}>): StableEntrypointRuntime {
  const issues = validateStableEntrypointCapabilityRequirements();
  if (issues.length > 0) throw new Error(`CAPABILITY_ENTRYPOINT_REGISTRY_INVALID:${issues.join(",")}`);
  if (input.projection.schema_version !== SYSTEM_CAPABILITY_SCHEMA_VERSION) throw new Error("CAPABILITY_RUNTIME_PROJECTION_VERSION_INVALID");
  const limits = systemLimitsSchema.parse(input.limits ?? LOCAL_SYSTEM_LIMITS);
  const admission = input.admission ?? new BoundedAdmissionController({ runtime_mode: input.projection.runtime_mode, limits });

  const servesAsMain = (entrypointId: string): boolean => {
    if (!requirementById.has(entrypointId)) throw new Error(`CAPABILITY_ENTRYPOINT_UNKNOWN:${entrypointId}`);
    return input.served_as_main?.(entrypointId) === true;
  };

  const evaluate = (entrypointId: string): EntrypointCapabilityDecision => {
    const requirement = requirementById.get(entrypointId);
    if (!requirement) throw new Error(`CAPABILITY_ENTRYPOINT_UNKNOWN:${entrypointId}`);
    if (servesAsMain(entrypointId)) {
      return deepFreeze({
        schema_version: STABLE_ENTRYPOINT_CAPABILITY_SCHEMA_VERSION,
        entrypoint_id: entrypointId,
        projection_sha256: input.projection.projection_sha256,
        outcome: "ALLOW",
        reason_codes: [],
        external_reason_codes: [SERVED_AS_MAIN],
        blocked_capabilities: [],
      });
    }
    const blockedCapabilities: SystemCapabilityName[] = [];
    const reasonCodes: string[] = [];
    const declaredBlock = input.blocked_by_declaration?.(entrypointId) ?? null;
    if (declaredBlock !== null) reasonCodes.push(declaredBlock);
    for (const capability of requirement.required_capabilities) {
      const declaration = input.projection.capabilities[capability];
      const fixtureAllowed = declaration.state === "test_only"
        && requirement.fixture_capabilities_allowed
        && input.projection.runtime_mode === "test"
        && input.projection.fixture_mode === "synthetic_test";
      if (declaration.state !== "enabled" && !fixtureAllowed) {
        blockedCapabilities.push(capability);
        if (declaration.state === "blocked") reasonCodes.push(...declaration.blocker_codes);
        else reasonCodes.push(`CAPABILITY_${capability.toUpperCase()}_${declaration.state.toUpperCase()}`);
      }
    }
    if (requirement.execution_class === "external_or_human_gate") reasonCodes.push(...requirement.static_reason_codes);
    const normalizedReasons = [...new Set(reasonCodes)].sort(compareStrings);
    const normalizedCapabilities = [...new Set(blockedCapabilities)].sort(compareStrings);
    return deepFreeze({
      schema_version: STABLE_ENTRYPOINT_CAPABILITY_SCHEMA_VERSION,
      entrypoint_id: entrypointId,
      projection_sha256: input.projection.projection_sha256,
      outcome: normalizedReasons.length === 0 ? "ALLOW" : "BLOCK",
      reason_codes: normalizedReasons,
      external_reason_codes: requirement.static_reason_codes,
      blocked_capabilities: normalizedCapabilities,
    });
  };

  const assert = (entrypointId: string): EntrypointCapabilityDecision => {
    const decision = evaluate(entrypointId);
    if (decision.outcome === "BLOCK") {
      throw new Error(`CAPABILITY_ENTRYPOINT_BLOCKED:${entrypointId}:${decision.reason_codes.join("+")}`);
    }
    return decision;
  };

  const runtime: StableEntrypointRuntime = deepFreeze({
    projection: input.projection,
    limits,
    admission,
    evaluate,
    assert,
    assertRequest(entrypointId, request) {
      const decision = assert(entrypointId);
      if (!servesAsMain(entrypointId)) assertRequestWithinSystemLimits({ ...request, limits });
      return decision;
    },
    servesAsMain,
  });
  createdRuntimes.add(runtime);
  return runtime;
}

type CapabilityRuntimeGlobal = typeof globalThis & {
  __tivdocStableEntrypointRuntime?: StableEntrypointRuntime;
};

function runtimeGlobal(): CapabilityRuntimeGlobal {
  return globalThis as CapabilityRuntimeGlobal;
}

/** One-shot server composition seam. No request or client flag may install it. */
export function installStableEntrypointRuntime(runtime: StableEntrypointRuntime): void {
  if (runtimeGlobal().__tivdocStableEntrypointRuntime) throw new Error("CAPABILITY_RUNTIME_ALREADY_INSTALLED");
  if (!createdRuntimes.has(runtime)) throw new Error("CAPABILITY_RUNTIME_UNVERIFIED_INSTANCE");
  if (runtime.projection.schema_version !== SYSTEM_CAPABILITY_SCHEMA_VERSION) throw new Error("CAPABILITY_RUNTIME_PROJECTION_VERSION_INVALID");
  runtimeGlobal().__tivdocStableEntrypointRuntime = runtime;
}

/** True for the one error `assert` throws when a capability the entry point needs is not enabled. */
export function isCapabilityBlockedError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("CAPABILITY_ENTRYPOINT_BLOCKED:");
}

export function resolveStableEntrypointRuntime(): StableEntrypointRuntime {
  const runtime = runtimeGlobal().__tivdocStableEntrypointRuntime;
  if (!runtime) throw new Error("CAPABILITY_RUNTIME_NOT_INSTALLED");
  return runtime;
}

export function assertStableEntrypointCapability(entrypointId: string): EntrypointCapabilityDecision {
  return resolveStableEntrypointRuntime().assert(entrypointId);
}

export function assertStableEntrypointRequest(
  entrypointId: string,
  request: Parameters<typeof assertRequestWithinSystemLimits>[0],
): EntrypointCapabilityDecision {
  return resolveStableEntrypointRuntime().assertRequest(entrypointId, request);
}

export function resetStableEntrypointRuntimeForTests(): void {
  if (process.env.NODE_ENV !== "test") throw new Error("CAPABILITY_RUNTIME_RESET_FORBIDDEN");
  delete runtimeGlobal().__tivdocStableEntrypointRuntime;
}

function requirementFor(entry: CanonicalEntrypoint): StableEntrypointCapabilityRequirement {
  const required = new Set<SystemCapabilityName>();
  const text = `${entry.stable_entry} ${entry.canonical_contract_id} ${entry.canonical_target}`.toLowerCase();
  const add = (...capabilities: readonly SystemCapabilityName[]) => capabilities.forEach((capability) => required.add(capability));

  if (/identity|session|portal|operations|review|approval|download|export|ground-truth/u.test(text)) add("identity", "session");
  if (/postgres|persistence|durable|ledger|queue|job|outbox|audit|case|portal|operations|review|rulespec|parameter|ground-truth|privacy-storage/u.test(text)) add("postgresql");
  if (/storage|blob|document|upload|custody|backup|report|download|export|portal/u.test(text)) add("storage");
  if (/parser/u.test(text)) add("parser");
  if (/controlled-import|controlled_official|import\.controlled|import\.postgres/u.test(text)) add("controlled_import");
  if (/extraction|analysis|report|shadow/u.test(text)) add("extraction");
  if (/legal-operations|review|rulespec|parameter|analysis|finding/u.test(text)) add("legal_review");
  if (/parameter/u.test(text)) add("parameter_approval");
  if (/rulespec/u.test(text)) add("rulespec_approval");
  if (/analysis|finding|report/u.test(text)) add("analysis");
  if (/shadow/u.test(text)) add("shadow");
  if (/operations/u.test(text)) add("operations");
  if (/portal/u.test(text)) add("portal");
  if (/export/u.test(text)) add("export");
  if (/download/u.test(text)) add("download");
  if (/case-create|case-resume|case-status|funnel|payment|check(?:\/|\b)|customer-processing/u.test(text)) add("customer_processing");
  if (entry.kind === "api_route" && entry.blockers.includes("CUSTOMER_PROCESSING_DISABLED")) add("customer_processing");
  if (/payment|delivery|outbox-publisher/u.test(text)) add("delivery");

  const executionClass = executionClassFor(entry);
  return deepFreeze({
    entrypoint_id: entry.entrypoint_id,
    stable_entry: entry.stable_entry,
    source_path: entry.source_path,
    kind: entry.kind,
    product_stable: entry.product_stable,
    execution_class: executionClass,
    required_capabilities: [...required].sort(capabilityOrder),
    static_reason_codes: [...entry.blockers].sort(compareStrings),
    fixture_capabilities_allowed: executionClass === "evidence_cli" || executionClass === "non_product_contract",
  });
}

function executionClassFor(entry: CanonicalEntrypoint): EntrypointExecutionClass {
  if (entry.kind === "cli") {
    if (/(?:isolated:(?:bootstrap|teardown)|legal:ops:(?:import|propose-activation|activate|revoke|supersede))/u.test(entry.stable_entry)) {
      return "maintenance_cli";
    }
    return "evidence_cli";
  }
  if (entry.classification === "EXTERNAL_OR_HUMAN_BLOCKED") return "external_or_human_gate";
  if (!entry.product_stable) return "non_product_contract";
  return "product_runtime";
}

function capabilityOrder(left: SystemCapabilityName, right: SystemCapabilityName): number {
  const order = [
    "identity", "session", "postgresql", "storage", "parser", "controlled_import", "extraction",
    "legal_review", "parameter_approval", "rulespec_approval", "analysis", "shadow", "operations",
    "portal", "export", "download", "customer_processing", "delivery",
  ] satisfies readonly SystemCapabilityName[];
  return order.indexOf(left) - order.indexOf(right);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
