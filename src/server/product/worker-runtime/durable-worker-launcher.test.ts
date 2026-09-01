import { generateKeyPairSync, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { readDurableLocalProductRuntimeConfig } from "../runtime/durable-local-config.ts";
import { createDurableFreshWorkerLauncher } from "./durable-worker-launcher.ts";

describe("durable fresh worker launcher composition", () => {
  it("loads the exact raw-Node child graph without an ESM resolution failure", async () => {
    const entrypoint = resolve(process.cwd(),
      "src/server/product/worker-runtime/durable-worker-child-entrypoint.mts");
    const result = await new Promise<Readonly<{ code: number | null; stdout: string; stderr: string }>>((done, reject) => {
      const child = spawn(process.execPath, [
        "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
        "--experimental-strip-types",
        entrypoint,
      ], {
        cwd: process.cwd(),
        env: {
          NODE_ENV: "test",
          PATH: process.env.PATH,
          SYSTEMROOT: process.env.SYSTEMROOT,
          WINDIR: process.env.WINDIR,
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", reject);
      child.once("exit", (code) => done(Object.freeze({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      })));
      child.stdin.end();
    });
    expect(result).toEqual({ code: 1, stdout: "", stderr: "" });
  });

  it("keeps worker configuration out of protocol/proof and excludes web-only secrets", () => {
    const publicKey = generateKeyPairSync("rsa", { modulusLength: 2_048 }).publicKey
      .export({ format: "pem", type: "spki" }).toString();
    const database = "tivdoc_v09_launcher01";
    const secret = "web-only-secret-marker";
    const config = readDurableLocalProductRuntimeConfig({
      NODE_ENV: "production",
      TIVDOC_DURABLE_PRODUCT_RUNTIME_ENABLED: "1",
      TIVDOC_DURABLE_PRODUCT_RUNTIME_SENTINEL: "TIVDOC_DURABLE_LOCAL_PRODUCT_V0102",
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
      TIVDOC_IDENTITY_POSTGRES_URL: postgresTestUrl("tivdoc_identity_runtime", "identity", "127.0.0.1", database),
      TIVDOC_WEB_POSTGRES_URL: postgresTestUrl("tivdoc_web_runtime", "web", "127.0.0.1", database),
      TIVDOC_OPERATIONS_POSTGRES_URL: postgresTestUrl("tivdoc_operations_runtime", "operations", "127.0.0.1", database),
      TIVDOC_WORKER_POSTGRES_URL: postgresTestUrl("tivdoc_worker_runtime", "worker", "127.0.0.1", database),
      TIVDOC_PRIVATE_STORAGE_ROOT: "C:\\ignored\\tivdoc-private-runtime-launcher",
      TIVDOC_DOWNLOAD_GRANT_HMAC_KEY_BASE64URL: randomBytes(32).toString("base64url"),
      TIVDOC_WORKER_ACTOR_ID: "worker-runtime-001",
      TIVDOC_WORKER_TENANT_ID: "tenant-runtime-001",
      TIVDOC_WORKER_SESSION_ID: "session-runtime-001",
      TIVDOC_WORKER_TOKEN_ID: "token-runtime-001",
      TIVDOC_WORKER_ROTATION_COUNTER: "1",
    });
    const launcher = createDurableFreshWorkerLauncher(config, {
      TIVDOC_DURABLE_DOWNLOAD_HMAC_KEY: secret,
      TIVDOC_IDENTITY_PUBLIC_KEY_SPKI_PEM: secret,
      SYSTEMROOT: "C:\\Windows",
    });
    const serialized = JSON.stringify(launcher.proof());
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("postgresql:");
    expect(serialized).not.toContain(config.private_storage_root);
    expect(launcher.proof()).toMatchObject({
      inherited_runtime_configuration: false,
      inherited_parent_environment_keys: 0,
      protocol_credentials_allowed: false,
    });
  });
});

function postgresTestUrl(role: string, password: string, host: string, database: string): string {
  const value = new URL("postgresql://127.0.0.1");
  value.username = role;
  value.password = password;
  value.hostname = host;
  value.port = "5432";
  value.pathname = `/${database}`;
  return value.toString();
}
