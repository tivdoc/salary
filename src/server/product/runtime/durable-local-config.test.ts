import { generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createStableEntrypointRuntime, STABLE_PRODUCT_DISPATCHER_ROOTS } from "../../platform/capabilities/stable-entrypoint-runtime.ts";
import {
  DURABLE_LOCAL_PRODUCT_RUNTIME_SENTINEL,
  buildDurableLocalInternalOpsFlags,
  buildDurableLocalProductCapabilityProjection,
  durableLocalProductRuntimeEnabled,
  readDurableLocalProductRuntimeConfig,
} from "./durable-local-config.ts";
import path from "node:path";

const publicKey = generateKeyPairSync("rsa", { modulusLength: 2_048 }).publicKey
  .export({ format: "pem", type: "spki" }).toString();

function environment(): Record<string, string> {
  const database = "tivdoc_v09_runtime01";
  return {
    NODE_ENV: "production",
    TIVDOC_DURABLE_PRODUCT_RUNTIME_ENABLED: "1",
    TIVDOC_DURABLE_PRODUCT_RUNTIME_SENTINEL: DURABLE_LOCAL_PRODUCT_RUNTIME_SENTINEL,
    TIVDOC_RUNTIME_TARGET: "local_only",
    TIVDOC_PRODUCT_PERSISTENCE_MODE: "isolated_postgres",
    TIVDOC_DURABLE_IDENTITY_ENABLED: "1",
    TIVDOC_PRIVATE_STORAGE_ENABLED: "1",
    TIVDOC_PORTAL_UI_ENABLED: "1",
    TIVDOC_PORTAL_API_ENABLED: "1",
    TIVDOC_OPERATIONS_UI_ENABLED: "1",
    TIVDOC_OPERATIONS_API_ENABLED: "1",
    TIVDOC_CUSTOMER_PROCESSING_ENABLED: "0",
    TIVDOC_CUSTOMER_SHADOW_AUTHORIZED: "0",
    TIVDOC_PRODUCTION_DELIVERY_ENABLED: "0",
    TIVDOC_OPENAI_LIVE_TESTS: "0",
    TIVDOC_RUNTIME_BUILD_IDENTITY_SHA: "a".repeat(40),
    TIVDOC_LOCAL_PRODUCT_ALLOWED_ORIGIN: "http://127.0.0.1:45124",
    TIVDOC_IDENTITY_ISSUER: "https://identity.test.invalid",
    TIVDOC_IDENTITY_KEY_ID: "key-00000001",
    TIVDOC_IDENTITY_ALGORITHM: "RS256",
    TIVDOC_IDENTITY_PUBLIC_KEY_SPKI_PEM: publicKey,
    TIVDOC_IDENTITY_KEY_NOT_BEFORE_EPOCH: "1800000000",
    TIVDOC_IDENTITY_KEY_EXPIRES_AT_EPOCH: "2000000000",
    TIVDOC_IDENTITY_CLOCK_SKEW_SECONDS: "5",
    TIVDOC_IDENTITY_MAX_TOKEN_LIFETIME_SECONDS: "900",
    TIVDOC_IDENTITY_POSTGRES_URL: postgresTestUrl("tivdoc_identity_runtime", "secret", "127.0.0.1", database),
    TIVDOC_WEB_POSTGRES_URL: postgresTestUrl("tivdoc_web_runtime", "secret", "127.0.0.1", database),
    TIVDOC_OPERATIONS_POSTGRES_URL: postgresTestUrl("tivdoc_operations_runtime", "secret", "127.0.0.1", database),
    TIVDOC_WORKER_POSTGRES_URL: postgresTestUrl("tivdoc_worker_runtime", "secret", "127.0.0.1", database),
    TIVDOC_PRIVATE_STORAGE_ROOT: "C:\\ignored\\tivdoc-private-runtime-v0102",
    TIVDOC_DOWNLOAD_GRANT_HMAC_KEY_BASE64URL: randomBytes(32).toString("base64url"),
    TIVDOC_WORKER_ACTOR_ID: "worker-runtime-001",
    TIVDOC_WORKER_TENANT_ID: "tenant-runtime-001",
    TIVDOC_WORKER_SESSION_ID: "session-runtime-001",
    TIVDOC_WORKER_TOKEN_ID: "token-runtime-001",
    TIVDOC_WORKER_ROTATION_COUNTER: "1",
  };
}

function postgresTestUrl(role: string, password: string, host: string, database: string): string {
  const value = new URL("postgresql://127.0.0.1");
  value.username = role;
  value.password = password;
  value.hostname = host;
  value.port = "5432";
  value.pathname = `/${database}`;
  return value.toString();
}

describe("durable local product runtime configuration", () => {
  it("requires the exact node-local sentinel and fixed disabled customer flags", () => {
    const env = environment();
    expect(durableLocalProductRuntimeEnabled(env, "nodejs")).toBe(true);
    expect(durableLocalProductRuntimeEnabled(env, "edge")).toBe(false);
    expect(() => durableLocalProductRuntimeEnabled({ ...env, VERCEL_ENV: "preview" }, "nodejs"))
      .toThrow("DURABLE_LOCAL_PRODUCT_REMOTE_RUNTIME_FORBIDDEN");
    expect(() => durableLocalProductRuntimeEnabled({ ...env, TIVDOC_CUSTOMER_PROCESSING_ENABLED: "1" }, "nodejs"))
      .toThrow("DURABLE_LOCAL_PRODUCT_FLAGS_INVALID");
  });

  it("accepts one role-separated loopback target and does not expose secrets through capability proof", () => {
    const env = environment();
    const config = readDurableLocalProductRuntimeConfig(env);
    expect(config.allow_loopback_http).toBe(true);
    expect(config.connection_urls).toEqual({
      identity: env.TIVDOC_IDENTITY_POSTGRES_URL,
      web: env.TIVDOC_WEB_POSTGRES_URL,
      operations: env.TIVDOC_OPERATIONS_POSTGRES_URL,
      worker: env.TIVDOC_WORKER_POSTGRES_URL,
    });
    const projection = buildDurableLocalProductCapabilityProjection();
    expect(JSON.stringify(projection)).not.toContain("secret");
    expect(projection.capabilities.customer_processing.state).toBe("disabled");
    expect(projection.capabilities.delivery.state).toBe("disabled");
    expect(projection.capabilities.shadow).toMatchObject({ state: "blocked", blocker_codes: ["CUSTOMER_SHADOW_NOT_AUTHORIZED"] });
    // L7-8: the offline-shadow summary root is optional and must be absolute; the customer-shadow block above is unrelated to it.
    expect(config.offline_shadow_state_root).toBeNull();
    const absoluteRoot = path.resolve("/ignored/shadow/state");
    expect(readDurableLocalProductRuntimeConfig({ ...env, TIVDOC_OFFLINE_SHADOW_STATE_ROOT: absoluteRoot }).offline_shadow_state_root).toBe(absoluteRoot);
    expect(() => readDurableLocalProductRuntimeConfig({ ...env, TIVDOC_OFFLINE_SHADOW_STATE_ROOT: "output/next/shadow/state" })).toThrow("DURABLE_LOCAL_PRODUCT_SHADOW_STATE_ROOT_INVALID");
    expect(buildDurableLocalInternalOpsFlags()).toEqual({
      TIVDOC_INTERNAL_OPS_UI_ENABLED: true,
      TIVDOC_INTERNAL_OPS_API_ENABLED: true,
      TIVDOC_SYNTHETIC_OPS_ENABLED: true,
      TIVDOC_PUBLIC_FIXTURE_OPS_ENABLED: false,
      TIVDOC_MANUAL_REPORT_EXPORT_ENABLED: true,
      TIVDOC_CUSTOMER_PROCESSING_ENABLED: false,
      TIVDOC_CUSTOMER_SHADOW_ENABLED: false,
      TIVDOC_PRODUCTION_DELIVERY_ENABLED: false,
    });
    expect(readDurableLocalProductRuntimeConfig({
      ...env,
      TIVDOC_LOCAL_PRODUCT_ALLOWED_ORIGIN: "https://127.0.0.1:45124",
    })).toMatchObject({
      allowed_origin: "https://127.0.0.1:45124",
      allow_loopback_http: false,
    });
  });

  it("rejects service-role reuse, cross-target connections, and non-loopback HTTP", () => {
    const env = environment();
    expect(() => readDurableLocalProductRuntimeConfig({
      ...env,
      TIVDOC_WEB_POSTGRES_URL: env.TIVDOC_WEB_POSTGRES_URL.replace("tivdoc_web_runtime", "service_role"),
    })).toThrow("DURABLE_LOCAL_PRODUCT_DATABASE_ROLE_INVALID");
    expect(() => readDurableLocalProductRuntimeConfig({
      ...env,
      TIVDOC_WORKER_POSTGRES_URL: env.TIVDOC_WORKER_POSTGRES_URL.replace("runtime01", "runtime02"),
    })).toThrow("DURABLE_LOCAL_PRODUCT_DATABASE_TARGET_MISMATCH");
    expect(() => readDurableLocalProductRuntimeConfig({
      ...env,
      TIVDOC_LOCAL_PRODUCT_ALLOWED_ORIGIN: "http://192.0.2.1:45124",
    })).toThrow("DURABLE_LOCAL_PRODUCT_ORIGIN_INVALID");
  });

  it("maps every product dispatcher to an enforced allow or intentional local block", () => {
    const runtime = createStableEntrypointRuntime({ projection: buildDurableLocalProductCapabilityProjection() });
    expect(STABLE_PRODUCT_DISPATCHER_ROOTS).toHaveLength(37);
    const decisions = STABLE_PRODUCT_DISPATCHER_ROOTS.map((entrypoint) => runtime.evaluate(entrypoint.entrypoint_id));
    expect(decisions.every((decision) => decision.outcome === "ALLOW" || decision.reason_codes.length > 0)).toBe(true);
    // UX Run 1 / U0: the six customer-access dispatchers need only postgresql locally, so they are allowed here.
    // S3.4: the four case-screen dispatchers (thread, documents, reports, and the request answer) need the same and no more.
    expect(decisions.filter((decision) => decision.outcome === "ALLOW")).toHaveLength(24);
    expect(decisions.filter((decision) => decision.outcome === "BLOCK")).toHaveLength(13);
  });
});
