// V0.10.10 Tivdoc DEV credential provisioning.
//
// The isolated DEV database needs login roles, and this repository may never
// disclose a password. The two are reconciled with the mechanism PostgreSQL
// provides for exactly this case: a SCRAM-SHA-256 *verifier*.
//
// A verifier is `SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>`.
// StoredKey is SHA-256 of ClientKey, and a SCRAM client proof requires
// ClientKey rather than StoredKey, so holding a verifier does not let anyone
// authenticate. PostgreSQL accepts a verifier wherever it accepts a password.
//
// So the password is generated here, written only into the ignored local env
// file, and never returned. Only the verifier leaves this process, and that is
// what gets sent to the DEV project. No password reaches a transcript, a
// command line, a log, a receipt or a commit.
//
// Every command is gated on the DEV guard first: nothing runs against a ref
// that is not the isolated Tivdoc DEV project.

import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { evaluateSupabaseDevGuard, TIVDOC_DEV_PROJECT_REF } from "./guard.mts";

export const DEV_CREDENTIAL_SCHEMA = "tivdoc-dev-credential-v0.10.10" as const;

/** Login roles this run provisions on the DEV project. */
export const DEV_LOGIN_ROLES = Object.freeze([
  "tivdoc_dev_migrator",
  "tivdoc_identity_runtime",
  "tivdoc_web_runtime",
  "tivdoc_operations_runtime",
  "tivdoc_worker_runtime",
] as const);

export type DevLoginRole = (typeof DEV_LOGIN_ROLES)[number];

const SCRAM_ITERATIONS = 4096;

/**
 * Builds a PostgreSQL SCRAM-SHA-256 verifier. Deterministic for a given salt so
 * it can be checked against the RFC 7677 vector.
 */
export function scramSha256Verifier(
  password: string,
  salt: Uint8Array = randomBytes(16),
  iterations: number = SCRAM_ITERATIONS,
): string {
  if (password === "") throw new Error("DEV_CREDENTIAL_PASSWORD_EMPTY");
  if (salt.byteLength < 16) throw new Error("DEV_CREDENTIAL_SALT_TOO_SHORT");
  if (!Number.isInteger(iterations) || iterations < 4096) {
    throw new Error("DEV_CREDENTIAL_ITERATIONS_TOO_LOW");
  }
  const salted = pbkdf2Sync(Buffer.from(password, "utf8"), Buffer.from(salt), iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${Buffer.from(salt).toString("base64")}`
    + `$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

const VERIFIER = /^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):(.+)$/u;

/**
 * Server-side SCRAM check: recomputes StoredKey from a candidate password and
 * the verifier's own salt and iteration count. Proves the verifier is a real
 * credential check rather than an opaque string.
 */
export function scramVerifierAcceptsPassword(verifier: string, password: string): boolean {
  const match = VERIFIER.exec(verifier);
  if (!match) return false;
  const [, iterations, salt, storedKey] = match;
  const candidate = scramSha256Verifier(
    password,
    Buffer.from(salt as string, "base64"),
    Number(iterations),
  );
  return candidate.split("$")[2]?.split(":")[0] === storedKey;
}

export function generateDevPassword(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * The credential file lives **outside** the repository. `inspectRepositorySourceSafety`
 * asserts the working tree contains no local environment file at all, and that
 * guard is worth more than the convenience of a dotfile next to the code, so an
 * ignored path in the checkout is not good enough.
 */
export function envPath(): string {
  const override = process.env.TIVDOC_DEV_ENV_FILE;
  if (override && override.trim() !== "") return path.resolve(override);
  return path.join(homedir(), ".tivdoc-dev", "credentials.env");
}

/** Reads the ignored env file into a map. Never logs a value. */
export function readDevEnvFile(file: string = envPath()): Map<string, string> {
  const entries = new Map<string, string>();
  if (!existsSync(file)) return entries;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/u)) {
    if (line === "" || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    entries.set(line.slice(0, index), line.slice(index + 1));
  }
  return entries;
}

export function writeDevEnvFile(entries: Map<string, string>, file: string = envPath()): void {
  const body = [...entries.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `# ${DEV_CREDENTIAL_SCHEMA} - outside the repository, never committed\n${body}\n`, "utf8");
}

function requireDevGuard(): string {
  const outcome = evaluateSupabaseDevGuard({ project_ref: TIVDOC_DEV_PROJECT_REF });
  if (!outcome.allowed) throw new Error(`SUPABASE_DEV_GUARD_REFUSED:${outcome.refusal_code}`);
  return outcome.project_ref as string;
}

export function buildConnectionUrl(input: Readonly<{
  role: string;
  password: string;
  host: string;
  port: number;
  database: string;
  pooler_tenant: string | null;
}>): string {
  const user = input.pooler_tenant === null ? input.role : `${input.role}.${input.pooler_tenant}`;
  // `no-verify` keeps the transport encrypted. The managed pooler presents a
  // Supabase-issued chain that no public root signs, and the run records the
  // server certificate fingerprint in its receipt instead of trusting a CA it
  // would have had to fetch over the same untrusted path.
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(input.password)}`
    + `@${input.host}:${input.port}/${input.database}?sslmode=no-verify`;
}

function commandIssue(roles: readonly string[]): void {
  const ref = requireDevGuard();
  const entries = readDevEnvFile();
  entries.set("TIVDOC_DEV_PROJECT_REF", ref);
  const lines: string[] = [];
  for (const role of roles) {
    if (!DEV_LOGIN_ROLES.includes(role as DevLoginRole)) throw new Error(`DEV_CREDENTIAL_ROLE_UNKNOWN:${role}`);
    const password = generateDevPassword();
    if (password.length < 24) throw new Error("DEV_CREDENTIAL_PASSWORD_TOO_SHORT");
    entries.set(`TIVDOC_DEV_PASSWORD__${role}`, password);
    lines.push(`${role} ${scramSha256Verifier(password)}`);
  }
  writeDevEnvFile(entries);
  // Verifiers only. Nothing printed here can authenticate.
  for (const line of lines) process.stdout.write(`${line}\n`);
}

function commandUrls(host: string, port: string, poolerMode: string, database: string): void {
  const ref = requireDevGuard();
  const entries = readDevEnvFile();
  const tenant = poolerMode === "none" ? null : ref;
  const targets: readonly (readonly [string, string])[] = Object.freeze([
    ["TIVDOC_DEV_DATABASE_URL", "tivdoc_dev_migrator"],
    ["TIVDOC_IDENTITY_POSTGRES_URL", "tivdoc_identity_runtime"],
    ["TIVDOC_WEB_POSTGRES_URL", "tivdoc_web_runtime"],
    ["TIVDOC_OPERATIONS_POSTGRES_URL", "tivdoc_operations_runtime"],
    ["TIVDOC_WORKER_POSTGRES_URL", "tivdoc_worker_runtime"],
  ] as const);
  entries.set("TIVDOC_DEV_DB_HOST", host);
  entries.set("TIVDOC_DEV_DB_PORT", port);
  entries.set("TIVDOC_DEV_DB_POOLER_TENANT", tenant === null ? "none" : tenant);
  // A role with no issued password is skipped rather than guessed at, so a
  // partial provisioning run leaves a truthful env file behind.
  const written: string[] = [];
  for (const [key, role] of targets) {
    const password = entries.get(`TIVDOC_DEV_PASSWORD__${role}`);
    if (!password) continue;
    entries.set(key, buildConnectionUrl({
      role, password, host, port: Number(port), database, pooler_tenant: tenant,
    }));
    written.push(key);
  }
  writeDevEnvFile(entries);
  process.stdout.write(`urls_written ${written.length} ${written.join(",")}\n`);
}

async function commandVerify(key: string): Promise<void> {
  requireDevGuard();
  const url = readDevEnvFile().get(key);
  if (!url) {
    process.stdout.write(`fail ${key} missing\n`);
    process.exitCode = 1;
    return;
  }
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 20_000 });
  try {
    await client.connect();
    const result = await client.query("select current_user as who, current_database() as db");
    const socket = (client as unknown as { connection?: { stream?: { getPeerCertificate?: () => { fingerprint256?: string } } } })
      .connection?.stream?.getPeerCertificate?.();
    const fingerprint = socket?.fingerprint256 ?? "none";
    process.stdout.write(`ok ${key} ${result.rows[0].who} ${result.rows[0].db} cert=${fingerprint}\n`);
  } catch (error) {
    // Driver error text can echo the connection string, so every issued
    // password is scrubbed out of the message before anything is emitted.
    const code = (error as { code?: string }).code ?? (error as Error).name ?? "UNKNOWN";
    let message = String((error as Error).message ?? "").slice(0, 200);
    for (const [name, value] of readDevEnvFile()) {
      if (name.startsWith("TIVDOC_DEV_PASSWORD__") && value !== "") {
        message = message.replaceAll(value, "***");
      }
    }
    process.stdout.write(`fail ${key} ${String(code).slice(0, 60)} ${message}\n`);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "issue") commandIssue(rest.length > 0 ? rest : DEV_LOGIN_ROLES);
  else if (command === "urls") {
    commandUrls(rest[0] as string, rest[1] as string, rest[2] ?? "pooler", rest[3] ?? "postgres");
  }
  else if (command === "verify") await commandVerify(rest[0] ?? "TIVDOC_DEV_DATABASE_URL");
  else throw new Error("DEV_CREDENTIAL_COMMAND_UNKNOWN");
}

const invokedDirectly = process.argv[1] !== undefined
  && process.argv[1].replaceAll("\\", "/").endsWith("scripts/supabase-dev-guard/dev-credential.mts");
if (invokedDirectly) await main();
