import "../routes/server-boundary.ts";

import { Buffer } from "node:buffer";

import {
  SYSTEM_CAPABILITY_PREREQUISITES,
  SYSTEM_CAPABILITY_SCHEMA_VERSION,
  buildSystemCapabilityProjection,
  type CapabilityDeclaration,
  type SystemCapabilityName,
  type SystemCapabilityProjection,
} from "../../platform/capabilities/system-capabilities.ts";
import {
  deriveNodePostgresTargetDescriptor,
  type NodePostgresRemoteDevTarget,
} from "../../platform/persistence/postgres/runtime/node-pg-driver.ts";
import type { InternalOpsFlagSnapshot } from "../internal-ops/flags.ts";

export const DURABLE_LOCAL_PRODUCT_RUNTIME_SENTINEL =
  "TIVDOC_DURABLE_LOCAL_PRODUCT_V0102" as const;

const BUILD_SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9:._-]{2,159}$/u;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u;
const EXPECTED_DATABASE_USERS = Object.freeze({
  identity: "tivdoc_identity_runtime",
  web: "tivdoc_web_runtime",
  operations: "tivdoc_operations_runtime",
  worker: "tivdoc_worker_runtime",
} as const);

export type DurableLocalProductRuntimeConfig = Readonly<{
  build_identity_sha: string;
  allowed_origin: string;
  allow_loopback_http: boolean;
  identity: Readonly<{
    issuer: string;
    key_id: string;
    algorithm: "RS256" | "EdDSA";
    public_key_spki_pem: string;
    key_not_before_epoch: number;
    key_expires_at_epoch: number;
    clock_skew_seconds: number;
    max_token_lifetime_seconds: number;
  }>;
  connection_urls: Readonly<{
    identity: string;
    web: string;
    operations: string;
    worker: string;
  }>;
  /**
   * Declared non-loopback target, or null. The driver refuses any host that is
   * not loopback unless the caller names it here first, so this is the only way
   * an isolated development project becomes reachable and a typo cannot make
   * one up.
   */
  remote_dev_target: NodePostgresRemoteDevTarget | null;
  private_storage_root: string;
  download_grant_hmac_key: Uint8Array;
  worker_identity: Readonly<{
    actor_id: string;
    tenant_id: string;
    session_id: string;
    token_id: string;
    rotation_counter: number;
  }>;
}>;

export function durableLocalProductRuntimeEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  nextRuntime: string | undefined = process.env.NEXT_RUNTIME,
): boolean {
  if (nextRuntime !== "nodejs" || !enabled(environment.TIVDOC_DURABLE_PRODUCT_RUNTIME_ENABLED)) return false;
  if (environment.VERCEL_ENV === "production" || environment.VERCEL_ENV === "preview") {
    throw new Error("DURABLE_LOCAL_PRODUCT_REMOTE_RUNTIME_FORBIDDEN");
  }
  if (environment.TIVDOC_DURABLE_PRODUCT_RUNTIME_SENTINEL !== DURABLE_LOCAL_PRODUCT_RUNTIME_SENTINEL
      || environment.TIVDOC_RUNTIME_TARGET !== "local_only"
      || environment.TIVDOC_PRODUCT_PERSISTENCE_MODE !== "isolated_postgres"
      || !enabled(environment.TIVDOC_DURABLE_IDENTITY_ENABLED)
      || !enabled(environment.TIVDOC_PRIVATE_STORAGE_ENABLED)) {
    throw new Error("DURABLE_LOCAL_PRODUCT_RUNTIME_SENTINEL_INVALID");
  }
  requireFixedFlags(environment);
  return true;
}

export function readDurableLocalProductRuntimeConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DurableLocalProductRuntimeConfig {
  if (!durableLocalProductRuntimeEnabled(environment, "nodejs")) {
    throw new Error("DURABLE_LOCAL_PRODUCT_RUNTIME_DISABLED");
  }
  const buildIdentitySha = required(environment, "TIVDOC_RUNTIME_BUILD_IDENTITY_SHA", 64);
  if (!BUILD_SHA.test(buildIdentitySha)) throw new Error("DURABLE_LOCAL_PRODUCT_BUILD_IDENTITY_INVALID");
  const allowedOrigin = strictLocalOrigin(required(environment, "TIVDOC_LOCAL_PRODUCT_ALLOWED_ORIGIN", 512));
  const issuer = strictHttpsOrigin(required(environment, "TIVDOC_IDENTITY_ISSUER", 512));
  const keyId = required(environment, "TIVDOC_IDENTITY_KEY_ID", 128);
  if (!KEY_ID.test(keyId)) throw new Error("DURABLE_LOCAL_PRODUCT_IDENTITY_CONFIG_INVALID");
  const algorithm = required(environment, "TIVDOC_IDENTITY_ALGORITHM", 8);
  if (algorithm !== "RS256" && algorithm !== "EdDSA") {
    throw new Error("DURABLE_LOCAL_PRODUCT_IDENTITY_CONFIG_INVALID");
  }
  const publicKey = required(environment, "TIVDOC_IDENTITY_PUBLIC_KEY_SPKI_PEM", 16_384, true);
  const keyNotBeforeEpoch = integer(environment.TIVDOC_IDENTITY_KEY_NOT_BEFORE_EPOCH, 0, 4_102_444_800);
  const keyExpiresAtEpoch = integer(environment.TIVDOC_IDENTITY_KEY_EXPIRES_AT_EPOCH, 1, 4_102_444_800);
  if (keyExpiresAtEpoch <= keyNotBeforeEpoch) throw new Error("DURABLE_LOCAL_PRODUCT_IDENTITY_CONFIG_INVALID");
  const clockSkewSeconds = integer(environment.TIVDOC_IDENTITY_CLOCK_SKEW_SECONDS, 0, 60);
  const maxTokenLifetimeSeconds = integer(environment.TIVDOC_IDENTITY_MAX_TOKEN_LIFETIME_SECONDS, 1, 86_400);
  const connectionUrls = Object.freeze({
    identity: required(environment, "TIVDOC_IDENTITY_POSTGRES_URL", 4_096),
    web: required(environment, "TIVDOC_WEB_POSTGRES_URL", 4_096),
    operations: required(environment, "TIVDOC_OPERATIONS_POSTGRES_URL", 4_096),
    worker: required(environment, "TIVDOC_WORKER_POSTGRES_URL", 4_096),
  });
  const remoteDevTarget = readRemoteDevTarget(environment);
  validateRoleScopedConnections(connectionUrls, remoteDevTarget);
  const encodedHmac = required(environment, "TIVDOC_DOWNLOAD_GRANT_HMAC_KEY_BASE64URL", 128);
  if (!/^[A-Za-z0-9_-]+$/u.test(encodedHmac)) throw new Error("DURABLE_LOCAL_PRODUCT_DOWNLOAD_KEY_INVALID");
  const hmac = Buffer.from(encodedHmac, "base64url");
  if (hmac.byteLength < 32 || hmac.byteLength > 64 || hmac.toString("base64url") !== encodedHmac) {
    throw new Error("DURABLE_LOCAL_PRODUCT_DOWNLOAD_KEY_INVALID");
  }
  const workerIdentity = Object.freeze({
    actor_id: opaque(environment.TIVDOC_WORKER_ACTOR_ID),
    tenant_id: opaque(environment.TIVDOC_WORKER_TENANT_ID),
    session_id: opaque(environment.TIVDOC_WORKER_SESSION_ID),
    token_id: opaque(environment.TIVDOC_WORKER_TOKEN_ID),
    rotation_counter: integer(environment.TIVDOC_WORKER_ROTATION_COUNTER, 0, 999_999_999),
  });
  return Object.freeze({
    build_identity_sha: buildIdentitySha,
    allowed_origin: allowedOrigin.origin,
    allow_loopback_http: allowedOrigin.protocol === "http:",
    identity: Object.freeze({
      issuer,
      key_id: keyId,
      algorithm,
      public_key_spki_pem: publicKey,
      key_not_before_epoch: keyNotBeforeEpoch,
      key_expires_at_epoch: keyExpiresAtEpoch,
      clock_skew_seconds: clockSkewSeconds,
      max_token_lifetime_seconds: maxTokenLifetimeSeconds,
    }),
    connection_urls: connectionUrls,
    remote_dev_target: remoteDevTarget,
    private_storage_root: required(environment, "TIVDOC_PRIVATE_STORAGE_ROOT", 4_096),
    download_grant_hmac_key: Uint8Array.from(hmac),
    worker_identity: workerIdentity,
  });
}

/** Local workflow capabilities are available while prohibited/external acts stay blocked. */
export function buildDurableLocalProductCapabilityProjection(): SystemCapabilityProjection {
  const enabledCapabilities: readonly SystemCapabilityName[] = [
    "identity", "session", "postgresql", "storage", "extraction", "legal_review",
    "parameter_approval", "rulespec_approval", "analysis", "operations", "portal",
    "export", "download",
  ];
  const blockers: Readonly<Partial<Record<SystemCapabilityName, string>>> = Object.freeze({
    parser: "PARSER_OS_SANDBOX_NOT_VERIFIED",
    controlled_import: "PARSER_OS_SANDBOX_NOT_VERIFIED",
    shadow: "CUSTOMER_SHADOW_NOT_AUTHORIZED",
  });
  const declarations = Object.fromEntries(Object.keys(SYSTEM_CAPABILITY_PREREQUISITES).map((rawName) => {
    const name = rawName as SystemCapabilityName;
    const isEnabled = enabledCapabilities.includes(name);
    const blocker = blockers[name];
    const state = isEnabled ? "enabled" : blocker ? "blocked" : "disabled";
    const declaration: CapabilityDeclaration = Object.freeze({
      state,
      provider_target: state === "disabled" ? null : "local",
      provider_id: state === "disabled" ? null : "durable_local_v0102",
      provider_schema_version: state === "disabled" ? null : "v0.10.2",
      prerequisite_capabilities: SYSTEM_CAPABILITY_PREREQUISITES[name],
      blocker_codes: blocker ? [blocker] : [],
      evidence_codes: isEnabled ? [`DURABLE_${name.toUpperCase()}_WORKFLOW_WIRED`] : [],
    });
    return [name, declaration];
  })) as Readonly<Partial<Record<SystemCapabilityName, CapabilityDeclaration>>>;
  return buildSystemCapabilityProjection({
    schema_version: SYSTEM_CAPABILITY_SCHEMA_VERSION,
    runtime_mode: "development",
    execution_scope: "local_only",
    fixture_mode: "none",
    declarations,
  });
}

/** Exact local operations profile; public fixtures, customers, Shadow and delivery stay off. */
export function buildDurableLocalInternalOpsFlags(): InternalOpsFlagSnapshot {
  return Object.freeze({
    TIVDOC_INTERNAL_OPS_UI_ENABLED: true,
    TIVDOC_INTERNAL_OPS_API_ENABLED: true,
    TIVDOC_SYNTHETIC_OPS_ENABLED: true,
    TIVDOC_PUBLIC_FIXTURE_OPS_ENABLED: false,
    TIVDOC_MANUAL_REPORT_EXPORT_ENABLED: true,
    TIVDOC_CUSTOMER_PROCESSING_ENABLED: false,
    TIVDOC_CUSTOMER_SHADOW_ENABLED: false,
    TIVDOC_PRODUCTION_DELIVERY_ENABLED: false,
  });
}

function requireFixedFlags(environment: Readonly<Record<string, string | undefined>>): void {
  const enabledFlags = [
    "TIVDOC_PORTAL_UI_ENABLED", "TIVDOC_PORTAL_API_ENABLED",
    "TIVDOC_OPERATIONS_UI_ENABLED", "TIVDOC_OPERATIONS_API_ENABLED",
  ];
  if (enabledFlags.some((name) => !enabled(environment[name]))
      || environment.TIVDOC_CUSTOMER_PROCESSING_ENABLED !== "0"
      || environment.TIVDOC_CUSTOMER_SHADOW_AUTHORIZED !== "0"
      || environment.TIVDOC_PRODUCTION_DELIVERY_ENABLED !== "0"
      || environment.TIVDOC_OPENAI_LIVE_TESTS !== "0") {
    throw new Error("DURABLE_LOCAL_PRODUCT_FLAGS_INVALID");
  }
}

const REMOTE_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/u;
const PROJECT_REF = /^[a-z]{20}$/u;

/**
 * Reads the declared remote development target. All four parts must be present
 * and well formed together; a partial declaration is refused rather than
 * completed with a default, so a half-configured environment cannot open a
 * non-loopback path by accident.
 */
function readRemoteDevTarget(
  environment: Readonly<Record<string, string | undefined>>,
): NodePostgresRemoteDevTarget | null {
  const ref = environment.TIVDOC_REMOTE_DEV_PROJECT_REF;
  const host = environment.TIVDOC_REMOTE_DEV_HOST;
  const port = environment.TIVDOC_REMOTE_DEV_PORT;
  const database = environment.TIVDOC_REMOTE_DEV_DATABASE;
  if (ref === undefined && host === undefined && port === undefined && database === undefined) return null;
  const parsedPort = Number(port);
  if (typeof ref !== "string" || !PROJECT_REF.test(ref)
      || typeof host !== "string" || !REMOTE_HOST.test(host) || host.length > 253
      || !Number.isSafeInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535
      || typeof database !== "string" || !/^tivdoc_v09_[a-z0-9_]{8,48}$/u.test(database)) {
    throw new Error("DURABLE_LOCAL_PRODUCT_REMOTE_TARGET_INVALID");
  }
  return Object.freeze({ host, port: parsedPort, database, project_ref: ref });
}

function validateRoleScopedConnections(
  urls: DurableLocalProductRuntimeConfig["connection_urls"],
  remote: NodePostgresRemoteDevTarget | null,
): void {
  const targets = Object.entries(urls).map(([role, raw]) => {
    const url = new URL(raw);
    const expected = EXPECTED_DATABASE_USERS[role as keyof typeof EXPECTED_DATABASE_USERS];
    // A managed connection pooler routes on `<role>.<project ref>`. The role
    // identity that matters is the part before the dot, and the suffix must be
    // the declared project ref, so role separation is unchanged.
    const [name, ...suffix] = decodeURIComponent(url.username).split(".");
    const suffixValid = suffix.length === 0
      || (suffix.length === 1 && remote !== null && suffix[0] === remote.project_ref);
    if (name !== expected || !suffixValid) {
      throw new Error("DURABLE_LOCAL_PRODUCT_DATABASE_ROLE_INVALID");
    }
    return deriveNodePostgresTargetDescriptor(raw, remote);
  });
  const first = targets[0];
  if (!first || targets.some((target) => target.target_id !== first.target_id
      || target.host !== first.host || target.port !== first.port || target.database !== first.database)) {
    throw new Error("DURABLE_LOCAL_PRODUCT_DATABASE_TARGET_MISMATCH");
  }
}

function strictLocalOrigin(raw: string): URL {
  const url = new URL(raw);
  // The exact loopback set, not one spelling of it. Identity still requires the
  // request origin to equal this value exactly; what this allows is configuring
  // the label the server itself uses, which is the only way the two can agree.
  const localTransport = (url.protocol === "http:" || url.protocol === "https:")
    && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (!localTransport || url.username || url.password
      || url.pathname !== "/" || url.search || url.hash || !url.port) {
    throw new Error("DURABLE_LOCAL_PRODUCT_ORIGIN_INVALID");
  }
  return url;
}

function strictHttpsOrigin(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("DURABLE_LOCAL_PRODUCT_IDENTITY_CONFIG_INVALID");
  }
  return url.origin;
}

function required(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  maxBytes: number,
  allowNewlines = false,
): string {
  const value = environment[name];
  if (!value || value.includes("\0") || (!allowNewlines && /[\r\n]/u.test(value))
      || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error("DURABLE_LOCAL_PRODUCT_CONFIGURATION_INCOMPLETE");
  }
  return value;
}

function opaque(value: string | undefined): string {
  if (!value || !OPAQUE.test(value)) throw new Error("DURABLE_LOCAL_PRODUCT_WORKER_IDENTITY_INVALID");
  return value;
}

function integer(value: string | undefined, minimum: number, maximum: number): number {
  if (!value || !/^(?:0|[1-9][0-9]{0,12})$/u.test(value)) {
    throw new Error("DURABLE_LOCAL_PRODUCT_CONFIGURATION_INCOMPLETE");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error("DURABLE_LOCAL_PRODUCT_CONFIGURATION_INCOMPLETE");
  }
  return parsed;
}

function enabled(value: string | undefined): boolean {
  return value === "1" || value === "true";
}
