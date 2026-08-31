import { createHash, randomInt } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, appendFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";

import type { PinnedPostgresBinaries } from "./pinned-binaries.mts";
import type { DynamicPostgresPaths } from "./paths.mts";
import {
  buildPostgresChildEnvironment,
  type CommandRunner,
  runSafeCommand,
  SafeCommandFailure,
} from "./process.mts";
import {
  assertSafeTargetIdentity,
  authorizeOwnedControl,
  type ApprovedPostgresTarget,
  type OwnedTargetMarker,
} from "./safety.mts";

export const OWNED_CLUSTER_MARKER_SCHEMA = "tivdoc-owned-postgres-cluster-v0.9.1" as const;

export type OwnedClusterMarker = Readonly<{
  schema_version: typeof OWNED_CLUSTER_MARKER_SCHEMA;
  ownership: OwnedTargetMarker;
  postgres_version: "17.11";
  configuration_sha256: string;
  initialized: true;
}>;

export type ClusterControlReceipt = Readonly<{
  schema_version: "tivdoc-postgres-cluster-control-v0.9.1";
  operation: "initialize" | "start" | "stop" | "verify_stopped" | "restart" | "create_database";
  target_id: string;
  host: "127.0.0.1";
  port: number;
  database: string;
  status: "COMPLETE";
  credentials_emitted: 0;
  external_connections: 0;
}>;

export async function selectRandomHighLoopbackPort(input: Readonly<{
  random_integer?: (minimum: number, maximum: number) => number;
  available?: (port: number) => Promise<boolean>;
  attempts?: number;
}> = {}): Promise<number> {
  const choose = input.random_integer ?? randomInt;
  const available = input.available ?? isLoopbackPortAvailable;
  for (let attempt = 0; attempt < (input.attempts ?? 32); attempt += 1) {
    const candidate = choose(40_000, 49_152);
    if (await available(candidate)) return candidate;
  }
  throw new Error("NO_HIGH_LOOPBACK_PORT_AVAILABLE");
}

export function renderPostgresqlConfig(target: ApprovedPostgresTarget): string {
  assertOwnedTarget(target);
  return [
    "# Tivdoc V0.9.1 isolated dynamic-verification cluster.",
    "listen_addresses = '127.0.0.1'",
    `port = ${target.descriptor.port}`,
    "timezone = 'UTC'",
    "log_timezone = 'UTC'",
    "password_encryption = 'scram-sha-256'",
    "ssl = off",
    "fsync = on",
    "synchronous_commit = on",
    "full_page_writes = on",
    "log_statement = 'none'",
    "log_min_error_statement = error",
    "",
  ].join("\n");
}

export function renderPgHba(): string {
  return [
    "# Tivdoc V0.9.1: fail closed; TCP loopback only; no passwordless authentication.",
    "host all all 127.0.0.1/32 scram-sha-256",
    "host all all ::1/128 reject",
    "host all all 0.0.0.0/0 reject",
    "host all all ::0/0 reject",
    "",
  ].join("\n");
}

export async function initializeOwnedCluster(input: Readonly<{
  target: ApprovedPostgresTarget;
  paths: DynamicPostgresPaths;
  binaries: PinnedPostgresBinaries;
  runner?: CommandRunner;
}>): Promise<ClusterControlReceipt> {
  assertOwnedTarget(input.target);
  if (input.binaries.postgres_version !== "17.11") throw new Error("POSTGRES_PIN_MISMATCH");
  const runner = input.runner ?? runSafeCommand;
  await mkdir(input.paths.runtime_root, { recursive: true });
  await mkdir(input.paths.cluster_root, { recursive: false });
  await mkdir(input.paths.log_root, { recursive: false });
  await mkdir(input.paths.backup_root, { recursive: false });

  const passwordFile = `${input.paths.cluster_root}\\initdb-password.txt`;
  await writeFile(passwordFile, `${input.target.password.reveal()}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    await runner({
      executable: input.binaries.executable_paths.initdb,
      args: Object.freeze([
        "--pgdata", input.paths.data_root,
        "--username", "tivdoc_dynamic_admin",
        "--pwfile", passwordFile,
        "--auth-host=scram-sha-256",
        "--auth-local=scram-sha-256",
        "--encoding=UTF8",
        "--locale=C",
        "--data-checksums",
        "--no-instructions",
      ]),
      cwd: input.paths.repository_root,
      redactions: Object.freeze([
        input.target.password,
        ...(input.target.ownership_token ? [input.target.ownership_token] : []),
      ]),
      timeout_ms: 60_000,
    });
  } finally {
    await unlink(passwordFile).catch(() => undefined);
  }

  const configuration = renderPostgresqlConfig(input.target);
  const hba = renderPgHba();
  await appendFile(`${input.paths.data_root}\\postgresql.conf`, `\n${configuration}`, { encoding: "utf8" });
  await writeFile(`${input.paths.data_root}\\pg_hba.conf`, hba, { encoding: "utf8", mode: 0o600 });
  const marker: OwnedClusterMarker = Object.freeze({
    schema_version: OWNED_CLUSTER_MARKER_SCHEMA,
    ownership: input.target.marker!,
    postgres_version: "17.11",
    configuration_sha256: sha256(`${configuration}\u0000${hba}`),
    initialized: true,
  });
  await writeFile(input.paths.owner_marker, `${JSON.stringify(marker, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return receipt("initialize", input.target);
}

export async function startOwnedCluster(input: Readonly<{
  target: ApprovedPostgresTarget;
  paths: DynamicPostgresPaths;
  binaries: PinnedPostgresBinaries;
  runner?: CommandRunner;
}>): Promise<ClusterControlReceipt> {
  await assertOwnedCluster(input.target, input.paths);
  const runner = input.runner ?? runSafeCommand;
  await runner({
    executable: input.binaries.executable_paths.pg_ctl,
    args: Object.freeze(["start", "--pgdata", input.paths.data_root, "--log", input.paths.server_log, "--wait", "--timeout", "30"]),
    cwd: input.paths.repository_root,
    redactions: secretRedactions(input.target),
    timeout_ms: 45_000,
  });
  return receipt("start", input.target);
}

export async function stopOwnedCluster(input: Readonly<{
  target: ApprovedPostgresTarget;
  paths: DynamicPostgresPaths;
  binaries: PinnedPostgresBinaries;
  runner?: CommandRunner;
}>): Promise<ClusterControlReceipt> {
  await assertOwnedCluster(input.target, input.paths);
  const runner = input.runner ?? runSafeCommand;
  await runner({
    executable: input.binaries.executable_paths.pg_ctl,
    args: Object.freeze(["stop", "--pgdata", input.paths.data_root, "--mode", "fast", "--wait", "--timeout", "30"]),
    cwd: input.paths.repository_root,
    redactions: secretRedactions(input.target),
    timeout_ms: 45_000,
  });
  return receipt("stop", input.target);
}

export async function assertOwnedClusterStopped(input: Readonly<{
  target: ApprovedPostgresTarget;
  paths: DynamicPostgresPaths;
  binaries: PinnedPostgresBinaries;
  runner?: CommandRunner;
}>): Promise<ClusterControlReceipt> {
  await assertOwnedCluster(input.target, input.paths);
  const runner = input.runner ?? runSafeCommand;
  let stopped = false;
  try {
    await runner({
      executable: input.binaries.executable_paths.pg_ctl,
      args: Object.freeze(["status", "--pgdata", input.paths.data_root]),
      cwd: input.paths.repository_root,
      redactions: secretRedactions(input.target),
      timeout_ms: 10_000,
    });
  } catch (error) {
    stopped = error instanceof SafeCommandFailure && error.result.exit_code === 3;
  }
  if (!stopped || !await isLoopbackPortAvailable(input.target.descriptor.port)) {
    throw new Error("OWNED_POSTGRES_SHUTDOWN_NOT_VERIFIED");
  }
  return receipt("verify_stopped", input.target);
}

export async function restartOwnedCluster(input: Readonly<{
  target: ApprovedPostgresTarget;
  paths: DynamicPostgresPaths;
  binaries: PinnedPostgresBinaries;
  runner?: CommandRunner;
}>): Promise<ClusterControlReceipt> {
  const runner = input.runner ?? runSafeCommand;
  await stopOwnedCluster({ ...input, runner });
  await startOwnedCluster({ ...input, runner });
  return receipt("restart", input.target);
}

export async function createOwnedDatabase(input: Readonly<{
  target: ApprovedPostgresTarget;
  paths: DynamicPostgresPaths;
  binaries: PinnedPostgresBinaries;
  runner?: CommandRunner;
}>): Promise<ClusterControlReceipt> {
  await assertOwnedCluster(input.target, input.paths);
  const runner = input.runner ?? runSafeCommand;
  await runner({
    executable: input.binaries.executable_paths.createdb,
    args: Object.freeze([
      "--maintenance-db=postgres",
      "--encoding=UTF8",
      "--template=template0",
      input.target.descriptor.database,
    ]),
    cwd: input.paths.repository_root,
    env: buildPostgresChildEnvironment(input.target, "postgres"),
    redactions: secretRedactions(input.target),
    timeout_ms: 30_000,
  });
  return receipt("create_database", input.target);
}

export async function assertOwnedCluster(
  target: ApprovedPostgresTarget,
  paths: DynamicPostgresPaths,
): Promise<OwnedClusterMarker> {
  assertOwnedTarget(target);
  const raw = await readFile(paths.owner_marker, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("OWNED_CLUSTER_MARKER_INVALID");
  }
  if (!isOwnedClusterMarker(parsed) || !authorizeOwnedControl(target, parsed.ownership)) {
    throw new Error("OWNED_CLUSTER_AUTHORIZATION_FAILED");
  }
  await access(`${paths.data_root}\\PG_VERSION`, fsConstants.R_OK);
  const configuration = await readFile(`${paths.data_root}\\postgresql.conf`, "utf8");
  const hba = await readFile(`${paths.data_root}\\pg_hba.conf`, "utf8");
  const controlledConfiguration = renderPostgresqlConfig(target);
  if (!configuration.endsWith(`\n${controlledConfiguration}`)
    || parsed.configuration_sha256 !== sha256(`${controlledConfiguration}\u0000${hba}`)) {
    throw new Error("OWNED_CLUSTER_CONFIGURATION_DRIFT");
  }
  return parsed;
}

function assertOwnedTarget(target: ApprovedPostgresTarget): void {
  assertSafeTargetIdentity(target.descriptor);
  if (target.descriptor.kind !== "owned_local_loopback"
    || target.descriptor.host !== "127.0.0.1"
    || !target.descriptor.destructive_control_authorized
    || !target.marker
    || !target.ownership_token
    || target.username.reveal() !== "tivdoc_dynamic_admin") {
    throw new Error("OWNED_POSTGRES_CONTROL_NOT_AUTHORIZED");
  }
}

function receipt(operation: ClusterControlReceipt["operation"], target: ApprovedPostgresTarget): ClusterControlReceipt {
  return Object.freeze({
    schema_version: "tivdoc-postgres-cluster-control-v0.9.1",
    operation,
    target_id: target.descriptor.target_id,
    host: "127.0.0.1",
    port: target.descriptor.port,
    database: target.descriptor.database,
    status: "COMPLETE",
    credentials_emitted: 0,
    external_connections: 0,
  });
}

function secretRedactions(target: ApprovedPostgresTarget) {
  return Object.freeze([
    target.username,
    target.password,
    ...(target.ownership_token ? [target.ownership_token] : []),
  ]);
}

function isOwnedClusterMarker(value: unknown): value is OwnedClusterMarker {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const marker = value as Record<string, unknown>;
  return marker.schema_version === OWNED_CLUSTER_MARKER_SCHEMA
    && marker.postgres_version === "17.11"
    && marker.initialized === true
    && typeof marker.configuration_sha256 === "string"
    && /^[0-9a-f]{64}$/.test(marker.configuration_sha256)
    && typeof marker.ownership === "object"
    && marker.ownership !== null;
}

async function isLoopbackPortAvailable(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolvePromise) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolvePromise(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(() => resolvePromise(true));
    });
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
