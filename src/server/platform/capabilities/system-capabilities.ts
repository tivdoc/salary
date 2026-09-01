import { randomUUID } from "node:crypto";
import { z } from "zod";

import { canonicalSha256, deepFreeze } from "../../../engine/rule-runtime/canonical.ts";

export const SYSTEM_CAPABILITY_SCHEMA_VERSION = "tivdoc-system-capabilities-v0.10.2" as const;

export const systemCapabilityNameSchema = z.enum([
  "identity",
  "session",
  "postgresql",
  "storage",
  "parser",
  "controlled_import",
  "extraction",
  "legal_review",
  "parameter_approval",
  "rulespec_approval",
  "analysis",
  "shadow",
  "operations",
  "portal",
  "export",
  "download",
  "customer_processing",
  "delivery",
]);

export const systemCapabilityStateSchema = z.enum(["enabled", "disabled", "blocked", "test_only"]);
export const providerTargetSchema = z.enum(["local", "isolated_supabase", "managed"]);

export type SystemCapabilityName = z.infer<typeof systemCapabilityNameSchema>;
export type SystemCapabilityState = z.infer<typeof systemCapabilityStateSchema>;
export type ProviderTarget = z.infer<typeof providerTargetSchema>;

export type CapabilityDeclaration = Readonly<{
  state: SystemCapabilityState;
  provider_target: ProviderTarget | null;
  provider_id: string | null;
  provider_schema_version: string | null;
  prerequisite_capabilities: readonly SystemCapabilityName[];
  blocker_codes: readonly string[];
  evidence_codes: readonly string[];
}>;

export type SystemCapabilityProjection = Readonly<{
  schema_version: typeof SYSTEM_CAPABILITY_SCHEMA_VERSION;
  runtime_mode: "test" | "development";
  execution_scope: "local_only";
  fixture_mode: "none" | "synthetic_test";
  capabilities: Readonly<Record<SystemCapabilityName, CapabilityDeclaration>>;
  enabled_capabilities: readonly SystemCapabilityName[];
  blocked_capabilities: readonly SystemCapabilityName[];
  projection_sha256: string;
}>;

const CAPABILITY_ORDER = systemCapabilityNameSchema.options;

/**
 * The only accepted server-side dependency graph. Callers declare state and
 * provider evidence; they cannot weaken prerequisites at an entrypoint.
 */
export const SYSTEM_CAPABILITY_PREREQUISITES: Readonly<Record<SystemCapabilityName, readonly SystemCapabilityName[]>> = deepFreeze({
  identity: [],
  session: ["identity"],
  postgresql: ["identity", "session"],
  storage: ["identity", "session"],
  parser: [],
  controlled_import: ["parser", "postgresql"],
  extraction: ["storage"],
  legal_review: ["identity", "session", "postgresql"],
  parameter_approval: ["identity", "session", "postgresql", "legal_review"],
  rulespec_approval: ["identity", "session", "postgresql", "legal_review"],
  analysis: ["postgresql", "storage", "extraction", "legal_review", "parameter_approval", "rulespec_approval"],
  shadow: ["postgresql", "analysis"],
  operations: ["identity", "session", "postgresql"],
  portal: ["identity", "session", "postgresql", "storage"],
  export: ["identity", "session", "postgresql", "storage"],
  download: ["identity", "session", "postgresql", "storage"],
  customer_processing: ["identity", "session", "postgresql", "storage", "parser", "extraction", "legal_review", "parameter_approval", "rulespec_approval", "analysis"],
  delivery: ["identity", "session", "storage", "export", "download", "customer_processing"],
});

export type CapabilityStartupInput = Readonly<{
  schema_version: string;
  runtime_mode: string;
  execution_scope: string;
  fixture_mode: string;
  declarations: Readonly<Partial<Record<SystemCapabilityName, CapabilityDeclaration>>>;
}>;

export function buildSystemCapabilityProjection(input: CapabilityStartupInput): SystemCapabilityProjection {
  if (input.schema_version !== SYSTEM_CAPABILITY_SCHEMA_VERSION) throw new Error("CAPABILITY_SCHEMA_VERSION_UNSUPPORTED");
  if (input.runtime_mode !== "test" && input.runtime_mode !== "development") throw new Error("CAPABILITY_RUNTIME_MODE_UNSAFE");
  if (input.execution_scope !== "local_only") throw new Error("CAPABILITY_EXECUTION_SCOPE_UNSAFE");
  if (input.fixture_mode !== "none" && input.fixture_mode !== "synthetic_test") throw new Error("CAPABILITY_FIXTURE_MODE_INVALID");
  if (input.fixture_mode === "synthetic_test" && input.runtime_mode !== "test") throw new Error("CAPABILITY_TEST_FIXTURE_LEAKAGE");
  const unknown = Object.keys(input.declarations).filter((name) => !CAPABILITY_ORDER.includes(name as SystemCapabilityName));
  if (unknown.length > 0) throw new Error("CAPABILITY_NAME_UNKNOWN");

  const capabilities = Object.fromEntries(CAPABILITY_ORDER.map((name) => {
    const candidate = input.declarations[name] ?? {
      state: "disabled",
      provider_target: null,
      provider_id: null,
      provider_schema_version: null,
      prerequisite_capabilities: SYSTEM_CAPABILITY_PREREQUISITES[name],
      blocker_codes: [],
      evidence_codes: [],
    };
    const declaration = parseDeclaration(name, candidate);
    return [name, declaration];
  })) as Record<SystemCapabilityName, CapabilityDeclaration>;

  if (input.runtime_mode === "development" && CAPABILITY_ORDER.some((name) => {
    const declaration = capabilities[name];
    return declaration.state === "enabled" && declaration.provider_id !== null
      && /(?:^|[._-])(?:test|fixture|synthetic|hermetic)(?:$|[._-])/u.test(declaration.provider_id);
  })) {
    throw new Error("CAPABILITY_TEST_PROVIDER_LEAKAGE");
  }

  if (capabilities.customer_processing.state !== "disabled" || capabilities.delivery.state !== "disabled") {
    throw new Error("CAPABILITY_CUSTOMER_OR_DELIVERY_FORBIDDEN_LOCAL");
  }
  if (capabilities.shadow.state === "enabled") throw new Error("CAPABILITY_CUSTOMER_SHADOW_FORBIDDEN_LOCAL");
  if (capabilities.parser.state === "enabled" && !capabilities.parser.evidence_codes.includes("PARSER_OS_SANDBOX_VERIFIED")) {
    throw new Error("CAPABILITY_PARSER_SANDBOX_UNVERIFIED");
  }
  if (capabilities.controlled_import.state === "enabled" && capabilities.parser.state !== "enabled") {
    throw new Error("CAPABILITY_IMPORT_REQUIRES_PARSER");
  }

  for (const name of CAPABILITY_ORDER) {
    const declaration = capabilities[name];
    if (declaration.state === "test_only" && input.fixture_mode !== "synthetic_test") {
      throw new Error(`CAPABILITY_TEST_ONLY_WITHOUT_FIXTURE:${name}`);
    }
    if (declaration.state === "enabled" || declaration.state === "test_only") {
      for (const dependency of declaration.prerequisite_capabilities) {
        const dependencyState = capabilities[dependency].state;
        const satisfied = dependencyState === "enabled"
          || (declaration.state === "test_only" && dependencyState === "test_only");
        if (!satisfied) throw new Error(`CAPABILITY_PREREQUISITE_DISABLED:${name}:${dependency}`);
      }
    }
  }
  const sortedCapabilities = Object.fromEntries(CAPABILITY_ORDER.map((name) => [name, capabilities[name]])) as Record<SystemCapabilityName, CapabilityDeclaration>;
  const unsigned = {
    schema_version: SYSTEM_CAPABILITY_SCHEMA_VERSION,
    runtime_mode: input.runtime_mode as "test" | "development",
    execution_scope: "local_only" as const,
    fixture_mode: input.fixture_mode as "none" | "synthetic_test",
    capabilities: sortedCapabilities,
    enabled_capabilities: CAPABILITY_ORDER.filter((name) => capabilities[name].state === "enabled"),
    blocked_capabilities: CAPABILITY_ORDER.filter((name) => capabilities[name].state === "blocked"),
  };
  return deepFreeze({ ...unsigned, projection_sha256: canonicalSha256(unsigned) });
}

function parseDeclaration(name: SystemCapabilityName, candidate: CapabilityDeclaration): CapabilityDeclaration {
  const state = systemCapabilityStateSchema.parse(candidate.state);
  const providerTarget = candidate.provider_target === null ? null : providerTargetSchema.parse(candidate.provider_target);
  const providerId = candidate.provider_id;
  const providerSchemaVersion = candidate.provider_schema_version;
  const prerequisites = candidate.prerequisite_capabilities.map((entry) => systemCapabilityNameSchema.parse(entry));
  const canonicalPrerequisites = SYSTEM_CAPABILITY_PREREQUISITES[name];
  if (new Set(prerequisites).size !== prerequisites.length || prerequisites.includes(name)
      || !sameStringSet(prerequisites, canonicalPrerequisites)) {
    throw new Error(`CAPABILITY_PREREQUISITE_INVALID:${name}`);
  }
  const blockers = [...new Set(candidate.blocker_codes)].sort(compareStrings);
  const evidence = [...new Set(candidate.evidence_codes)].sort(compareStrings);
  if (blockers.some((entry) => !/^[A-Z][A-Z0-9_]{2,119}$/.test(entry))) throw new Error(`CAPABILITY_BLOCKER_CODE_INVALID:${name}`);
  if (evidence.some((entry) => !/^[A-Z][A-Z0-9_]{2,119}$/.test(entry))) throw new Error(`CAPABILITY_EVIDENCE_CODE_INVALID:${name}`);
  if ((state === "enabled" || state === "test_only") && providerTarget === null) throw new Error(`CAPABILITY_PROVIDER_TARGET_REQUIRED:${name}`);
  if ((providerTarget === null) !== (providerId === null) || (providerTarget === null) !== (providerSchemaVersion === null)) {
    throw new Error(`CAPABILITY_PROVIDER_METADATA_MISMATCH:${name}`);
  }
  if (providerId !== null && !/^[a-z][a-z0-9._-]{2,79}$/u.test(providerId)) throw new Error(`CAPABILITY_PROVIDER_ID_INVALID:${name}`);
  if (providerSchemaVersion !== null && !/^v\d+(?:\.\d+){0,2}$/u.test(providerSchemaVersion)) {
    throw new Error(`CAPABILITY_PROVIDER_SCHEMA_VERSION_INVALID:${name}`);
  }
  if ((state === "blocked") !== (blockers.length > 0)) throw new Error(`CAPABILITY_BLOCKER_STATE_MISMATCH:${name}`);
  if ((providerTarget === "managed" || providerTarget === "isolated_supabase") && state !== "blocked") {
    throw new Error(`CAPABILITY_REMOTE_PROVIDER_FORBIDDEN_LOCAL:${name}`);
  }
  return deepFreeze({
    state,
    provider_target: providerTarget,
    provider_id: providerId,
    provider_schema_version: providerSchemaVersion,
    prerequisite_capabilities: [...canonicalPrerequisites],
    blocker_codes: blockers,
    evidence_codes: evidence,
  });
}

export const systemLimitsSchema = z
  .object({
    maximum_upload_bytes: z.number().int().positive().max(50 * 1024 * 1024),
    maximum_json_body_bytes: z.number().int().positive().max(1024 * 1024),
    maximum_pages_per_document: z.number().int().positive().max(1_000),
    maximum_fields_per_document: z.number().int().positive().max(10_000),
    maximum_jobs_per_batch: z.number().int().positive().max(1_000),
    maximum_report_bytes: z.number().int().positive().max(32 * 1024 * 1024),
    maximum_operation_milliseconds: z.number().int().positive().max(10 * 60 * 1_000),
    maximum_queue_wait_milliseconds: z.number().int().positive().max(60 * 1_000),
    maximum_in_flight_per_actor: z.number().int().positive().max(100),
    maximum_in_flight_per_case: z.number().int().positive().max(100),
    maximum_total_in_flight: z.number().int().positive().max(1_000),
  })
  .strict()
  .readonly();

export type SystemLimits = z.infer<typeof systemLimitsSchema>;

export const LOCAL_SYSTEM_LIMITS: SystemLimits = deepFreeze(systemLimitsSchema.parse({
  maximum_upload_bytes: 20 * 1024 * 1024,
  maximum_json_body_bytes: 64 * 1024,
  maximum_pages_per_document: 200,
  maximum_fields_per_document: 2_000,
  maximum_jobs_per_batch: 100,
  maximum_report_bytes: 16 * 1024 * 1024,
  maximum_operation_milliseconds: 30_000,
  maximum_queue_wait_milliseconds: 5_000,
  maximum_in_flight_per_actor: 4,
  maximum_in_flight_per_case: 2,
  maximum_total_in_flight: 32,
}));

export type AdmissionLease = Readonly<{
  lease_id: string;
  actor_id: string;
  case_id: string;
  release(): void;
}>;

export class BoundedAdmissionController {
  readonly #limits: SystemLimits;
  readonly #idFactory: () => string;
  readonly #actors = new Map<string, number>();
  readonly #cases = new Map<string, number>();
  #total = 0;

  constructor(input: Readonly<{ limits?: SystemLimits; id_factory?: () => string; runtime_mode: "test" | "development" }>) {
    this.#limits = systemLimitsSchema.parse(input.limits ?? LOCAL_SYSTEM_LIMITS);
    if (input.id_factory && input.runtime_mode !== "test") throw new Error("CAPABILITY_DETERMINISTIC_ID_FACTORY_TEST_ONLY");
    this.#idFactory = input.id_factory ?? randomUUID;
  }

  admit(input: Readonly<{ actor_id: string; case_id: string; signal?: AbortSignal }>): AdmissionLease {
    if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{2,159}$/.test(input.actor_id)
        || !/^[A-Za-z0-9][A-Za-z0-9:._-]{2,159}$/.test(input.case_id)) throw new Error("CAPABILITY_ADMISSION_SUBJECT_INVALID");
    if (input.signal?.aborted) throw abortError();
    const actorCount = this.#actors.get(input.actor_id) ?? 0;
    const caseCount = this.#cases.get(input.case_id) ?? 0;
    if (this.#total >= this.#limits.maximum_total_in_flight) throw new Error("CAPABILITY_GLOBAL_BACKPRESSURE");
    if (actorCount >= this.#limits.maximum_in_flight_per_actor) throw new Error("CAPABILITY_ACTOR_CONCURRENCY_LIMIT");
    if (caseCount >= this.#limits.maximum_in_flight_per_case) throw new Error("CAPABILITY_CASE_CONCURRENCY_LIMIT");
    this.#total += 1;
    this.#actors.set(input.actor_id, actorCount + 1);
    this.#cases.set(input.case_id, caseCount + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.#total -= 1;
      decrement(this.#actors, input.actor_id);
      decrement(this.#cases, input.case_id);
    };
    input.signal?.addEventListener("abort", release, { once: true });
    return deepFreeze({ lease_id: `lease:${this.#idFactory()}`, actor_id: input.actor_id, case_id: input.case_id, release });
  }

  snapshot(): Readonly<{ total: number; actors: readonly (readonly [string, number])[]; cases: readonly (readonly [string, number])[] }> {
    return deepFreeze({
      total: this.#total,
      actors: [...this.#actors.entries()].sort(([left], [right]) => compareStrings(left, right)),
      cases: [...this.#cases.entries()].sort(([left], [right]) => compareStrings(left, right)),
    });
  }
}

export type AtomicMutationPort<TStaged, TResult> = Readonly<{
  stage(signal: AbortSignal): Promise<TStaged>;
  commit(staged: TStaged, signal: AbortSignal): Promise<TResult>;
  rollback(staged: TStaged): Promise<void>;
}>;

export async function runBoundedAtomicMutation<TStaged, TResult>(input: Readonly<{
  controller: BoundedAdmissionController;
  limits?: SystemLimits;
  actor_id: string;
  case_id: string;
  signal?: AbortSignal;
  timeout_milliseconds?: number;
  operation: AtomicMutationPort<TStaged, TResult>;
}>): Promise<TResult> {
  const limits = systemLimitsSchema.parse(input.limits ?? LOCAL_SYSTEM_LIMITS);
  const timeoutMilliseconds = input.timeout_milliseconds ?? limits.maximum_operation_milliseconds;
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds <= 0
      || timeoutMilliseconds > limits.maximum_operation_milliseconds) {
    throw new Error("CAPABILITY_OPERATION_TIMEOUT_INVALID");
  }
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", forwardAbort, { once: true });
  if (input.signal?.aborted) forwardAbort();
  const timeout = setTimeout(() => controller.abort(new Error("CAPABILITY_OPERATION_TIMEOUT")), timeoutMilliseconds);
  let lease: AdmissionLease;
  try {
    lease = input.controller.admit({ actor_id: input.actor_id, case_id: input.case_id, signal: controller.signal });
  } catch (error) {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", forwardAbort);
    throw error;
  }
  let staged: TStaged | undefined;
  try {
    staged = await input.operation.stage(controller.signal);
    if (controller.signal.aborted) throw abortError();
    const result = await input.operation.commit(staged, controller.signal);
    if (controller.signal.aborted) throw abortError();
    return result;
  } catch (error) {
    if (staged !== undefined) await input.operation.rollback(staged);
    if (controller.signal.aborted && !input.signal?.aborted
        && controller.signal.reason instanceof Error
        && controller.signal.reason.message === "CAPABILITY_OPERATION_TIMEOUT") {
      throw controller.signal.reason;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    lease.release();
    input.signal?.removeEventListener("abort", forwardAbort);
  }
}

export function assertRequestWithinSystemLimits(input: Readonly<{
  limits?: SystemLimits;
  content_length: number | null;
  body_bytes: number;
  body_kind?: "json" | "upload";
  page_count?: number;
  field_count?: number;
  batch_size?: number;
  report_bytes?: number;
}>): void {
  const limits = systemLimitsSchema.parse(input.limits ?? LOCAL_SYSTEM_LIMITS);
  const maximumBodyBytes = input.body_kind === "upload" ? limits.maximum_upload_bytes : limits.maximum_json_body_bytes;
  const checks = [
    [input.content_length, maximumBodyBytes, "CAPABILITY_CONTENT_LENGTH_LIMIT"],
    [input.body_bytes, maximumBodyBytes, "CAPABILITY_BODY_LIMIT"],
    [input.page_count, limits.maximum_pages_per_document, "CAPABILITY_PAGE_LIMIT"],
    [input.field_count, limits.maximum_fields_per_document, "CAPABILITY_FIELD_LIMIT"],
    [input.batch_size, limits.maximum_jobs_per_batch, "CAPABILITY_BATCH_LIMIT"],
    [input.report_bytes, limits.maximum_report_bytes, "CAPABILITY_REPORT_LIMIT"],
  ] as const;
  for (const [value, maximum, code] of checks) {
    if (value === undefined || value === null) continue;
    if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error(code);
  }
}

function decrement(map: Map<string, number>, key: string): void {
  const next = (map.get(key) ?? 1) - 1;
  if (next === 0) map.delete(key);
  else map.set(key, next);
}

function abortError(): Error {
  const error = new Error("CAPABILITY_OPERATION_CANCELLED");
  error.name = "AbortError";
  return error;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort(compareStrings);
  const sortedRight = [...right].sort(compareStrings);
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}
