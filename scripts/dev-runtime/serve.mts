// V0.10.11 W3. Brings the durable product runtime up against the isolated DEV
// database and probes the three product routes.
//
// Nothing here provisions a cluster. The connection comes entirely from the
// credential file, which is why `initdb` being unavailable is no longer a
// blocker: a harness that can only run against a database it created itself was
// the defect, not the missing binary.
//
// It runs both modes because a pass in one proves nothing about the other: the
// dev server compiles per request, the production server serves a build.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";

import {
  DURABLE_LOCAL_PRODUCT_RUNTIME_SENTINEL,
} from "../../src/server/product/runtime/durable-local-config.ts";
import { readDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";

export const DEV_RUNTIME_RECEIPT_SCHEMA = "tivdoc-dev-runtime-serve-v0.10.11" as const;

const ROUTES = Object.freeze(["/", "/portal", "/operations"] as const);
const WAVE = process.env.TIVDOC_WAVE_OUTPUT ?? "v0.10.11";
const RECEIPT_ROOT = path.join("output", WAVE, "runtime");

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error("DEV_RUNTIME_PORT_UNAVAILABLE"))));
    });
  });
}

/** Every variable the durable runtime insists on, built from the DEV credentials. */
export function buildRuntimeEnvironment(input: Readonly<{
  port: number;
  node_env: "development" | "production";
  /** Supplied when a caller needs to keep the matching private key. */
  identity?: Readonly<{ key_id: string; public_key_spki_pem: string }>;
  tenant_id?: string;
  worker?: Readonly<{ actor_id: string; session_id: string; token_id: string }>;
}>): NodeJS.ProcessEnv {
  const entries = readDevEnvFile();
  const required = (key: string): string => {
    const value = entries.get(key);
    if (!value) throw new Error(`DEV_RUNTIME_ENV_MISSING:${key}`);
    return value;
  };
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2_048 });
  const spki = publicKey.export({ format: "pem", type: "spki" });
  if (typeof spki !== "string") throw new Error("DEV_RUNTIME_PUBLIC_KEY_INVALID");
  const issuedAt = Math.floor(Date.now() / 1_000);
  const system: NodeJS.ProcessEnv = {};
  for (const key of ["SYSTEMROOT", "SystemRoot", "TEMP", "TMP", "WINDIR", "PATH", "USERPROFILE"] as const) {
    const value = process.env[key];
    if (value) system[key] = value;
  }
  const databaseUrl = new URL(required("TIVDOC_WEB_POSTGRES_URL"));
  return Object.freeze({
    ...system,
    NODE_ENV: input.node_env,
    NEXT_TELEMETRY_DISABLED: "1",
    PORT: String(input.port),
    TIVDOC_PRODUCT_BROWSER_RUNTIME_ENABLED: "0",
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
    TIVDOC_RUNTIME_BUILD_IDENTITY_SHA: "0".repeat(40),
    TIVDOC_LOCAL_PRODUCT_ALLOWED_ORIGIN: `http://127.0.0.1:${input.port}`,
    TIVDOC_IDENTITY_ISSUER: "https://identity.dev.invalid",
    TIVDOC_IDENTITY_KEY_ID: input.identity?.key_id ?? "dev-runtime-key-0001",
    TIVDOC_IDENTITY_ALGORITHM: "RS256",
    TIVDOC_IDENTITY_PUBLIC_KEY_SPKI_PEM: input.identity?.public_key_spki_pem ?? spki,
    TIVDOC_IDENTITY_KEY_NOT_BEFORE_EPOCH: String(issuedAt - 60),
    TIVDOC_IDENTITY_KEY_EXPIRES_AT_EPOCH: String(issuedAt + 86_400),
    TIVDOC_IDENTITY_CLOCK_SKEW_SECONDS: "5",
    TIVDOC_IDENTITY_MAX_TOKEN_LIFETIME_SECONDS: "3600",
    TIVDOC_IDENTITY_POSTGRES_URL: required("TIVDOC_IDENTITY_POSTGRES_URL"),
    TIVDOC_WEB_POSTGRES_URL: required("TIVDOC_WEB_POSTGRES_URL"),
    TIVDOC_OPERATIONS_POSTGRES_URL: required("TIVDOC_OPERATIONS_POSTGRES_URL"),
    TIVDOC_WORKER_POSTGRES_URL: required("TIVDOC_WORKER_POSTGRES_URL"),
    // The declared non-loopback target. The driver refuses every other host.
    TIVDOC_REMOTE_DEV_PROJECT_REF: required("TIVDOC_DEV_PROJECT_REF"),
    TIVDOC_REMOTE_DEV_HOST: databaseUrl.hostname,
    TIVDOC_REMOTE_DEV_PORT: databaseUrl.port,
    TIVDOC_REMOTE_DEV_DATABASE: databaseUrl.pathname.replace(/^\//u, ""),
    // The provider refuses any root whose basename lacks this prefix.
    TIVDOC_PRIVATE_STORAGE_ROOT: path.resolve(RECEIPT_ROOT, "tivdoc-private-runtime-dev"),
    TIVDOC_DOWNLOAD_GRANT_HMAC_KEY_BASE64URL: randomBytes(32).toString("base64url"),
    TIVDOC_WORKER_ACTOR_ID: input.worker?.actor_id ?? "worker.dev.runtime.001",
    TIVDOC_WORKER_TENANT_ID: input.tenant_id ?? "tenant.dev.runtime.001",
    TIVDOC_WORKER_SESSION_ID: input.worker?.session_id ?? "session.dev.runtime.001",
    TIVDOC_WORKER_TOKEN_ID: input.worker?.token_id ?? "token.dev.runtime.001",
    TIVDOC_WORKER_ROTATION_COUNTER: "1",
  });
}

export async function probe(
  port: number,
  route: string,
  init: RequestInit = {},
): Promise<Readonly<{ route: string; status: number; body: string }>> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      redirect: "manual", signal: AbortSignal.timeout(30_000), ...init,
    });
    const body = (await response.text()).slice(0, 400);
    return Object.freeze({ route, status: response.status, body });
  } catch (error) {
    return Object.freeze({ route, status: 0, body: String((error as Error).message).slice(0, 200) });
  }
}

export { freePort, waitForServer };

/** Starts a server with the given environment; the caller owns its lifetime. */
export function startServer(mode: "dev" | "production", environment: NodeJS.ProcessEnv, port: number): Readonly<{
  server: ChildProcessWithoutNullStreams; log: string[];
}> {
  const command = mode === "dev"
    ? ["node_modules/next/dist/bin/next", "dev", "--port", String(port), "--hostname", "127.0.0.1"]
    : ["node_modules/next/dist/bin/next", "start", "--port", String(port), "--hostname", "127.0.0.1"];
  const server = spawn(process.execPath, command, {
    env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const log: string[] = [];
  server.stdout.on("data", (chunk: Buffer) => log.push(chunk.toString("utf8")));
  server.stderr.on("data", (chunk: Buffer) => log.push(chunk.toString("utf8")));
  return Object.freeze({ server, log });
}

async function waitForServer(port: number, deadlineMs: number): Promise<boolean> {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    const result = await probe(port, "/");
    if (result.status !== 0) return true;
    await new Promise((resolve) => { setTimeout(resolve, 1_000); });
  }
  return false;
}

async function runMode(mode: "dev" | "production"): Promise<Readonly<Record<string, unknown>>> {
  const port = await freePort();
  const environment = buildRuntimeEnvironment({
    port, node_env: mode === "dev" ? "development" : "production",
  });
  mkdirSync(path.join(RECEIPT_ROOT, "tivdoc-private-runtime-dev"), { recursive: true });
  const command = mode === "dev"
    ? ["node_modules/next/dist/bin/next", "dev", "--port", String(port), "--hostname", "127.0.0.1"]
    : ["node_modules/next/dist/bin/next", "start", "--port", String(port), "--hostname", "127.0.0.1"];
  const server: ChildProcessWithoutNullStreams = spawn(process.execPath, command, {
    env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const log: string[] = [];
  server.stdout.on("data", (chunk: Buffer) => log.push(chunk.toString("utf8")));
  server.stderr.on("data", (chunk: Buffer) => log.push(chunk.toString("utf8")));
  try {
    const up = await waitForServer(port, 180_000);
    const routes = up ? await Promise.all(ROUTES.map((route) => probe(port, route))) : [];
    return Object.freeze({ mode, port, started: up, routes });
  } finally {
    server.kill("SIGTERM");
    writeFileSync(path.join(RECEIPT_ROOT, `server-${mode}.log`), log.join("").slice(-40_000), "utf8");
  }
}

const invokedDirectly = process.argv[1] !== undefined
  && process.argv[1].replaceAll("\\", "/").endsWith("scripts/dev-runtime/serve.mts");
const [command] = invokedDirectly ? process.argv.slice(2) : ["skip"];
mkdirSync(RECEIPT_ROOT, { recursive: true });
if (command === "skip") {
  // Imported as a module; the caller drives the server itself.
} else if (command === "dev" || command === "production") {
  const result = await runMode(command);
  writeFileSync(path.join(RECEIPT_ROOT, `serve-${command}.json`),
    `${JSON.stringify({ schema_version: DEV_RUNTIME_RECEIPT_SCHEMA, ...result }, null, 2)}\n`, "utf8");
  const routes = (result.routes as Readonly<{ route: string; status: number }>[]);
  process.stdout.write(`${command} started=${result.started} `
    + `${routes.map((row) => `${row.route}=${row.status}`).join(" ")}\n`);
} else throw new Error("DEV_RUNTIME_COMMAND_UNKNOWN");
