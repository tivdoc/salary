import { generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createStableEntrypointRuntime, STABLE_PRODUCT_DISPATCHER_ROOTS } from "../../platform/capabilities/stable-entrypoint-runtime.ts";
import {
  DURABLE_LOCAL_PRODUCT_RUNTIME_SENTINEL,
  buildDurableLocalProductCapabilityProjection,
  durableLocalProductRuntimeEnabled,
  readDurableLocalProductRuntimeConfig,
} from "./durable-local-config.ts";

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
    TIVDOC_IDENTITY_POSTGRES_URL: `postgresql://tivdoc_identity_runtime:secret@127.0.0.1:5432/${database}`,
    TIVDOC_WEB_POSTGRES_URL: `postgresql://tivdoc_web_runtime:secret@127.0.0.1:5432/${database}`,
    TIVDOC_OPERATIONS_POSTGRES_URL: `postgresql://tivdoc_operations_runtime:secret@127.0.0.1:5432/${database}`,
    TIVDOC_WORKER_POSTGRES_URL: `postgresql://tivdoc_worker_runtime:secret@127.0.0.1:5432/${database}`,
    TIVDOC_PRIVATE_STORAGE_ROOT: "C:\\ignored\\tivdoc-private-runtime-v0102",
    TIVDOC_DOWNLOAD_GRANT_HMAC_KEY_BASE64URL: randomBytes(32).toString("base64url"),
    TIVDOC_WORKER_ACTOR_ID: "worker-runtime-001",
    TIVDOC_WORKER_TENANT_ID: "tenant-runtime-001",
    TIVDOC_WORKER_SESSION_ID: "session-runtime-001",
    TIVDOC_WORKER_TOKEN_ID: "token-runtime-001",
    TIVDOC_WORKER_ROTATION_COUNTER: "1",
  };
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
    expect(STABLE_PRODUCT_DISPATCHER_ROOTS).toHaveLength(27);
    const decisions = STABLE_PRODUCT_DISPATCHER_ROOTS.map((entrypoint) => runtime.evaluate(entrypoint.entrypoint_id));
    expect(decisions.every((decision) => decision.outcome === "ALLOW" || decision.reason_codes.length > 0)).toBe(true);
    expect(decisions.filter((decision) => decision.outcome === "ALLOW")).toHaveLength(14);
    expect(decisions.filter((decision) => decision.outcome === "BLOCK")).toHaveLength(13);
  });
});
