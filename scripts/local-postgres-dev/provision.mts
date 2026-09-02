// V0.10.10 local disposable PostgreSQL provisioning.
//
// The canonical driver refuses any target that is not loopback and not a
// disposable database (`POSTGRES_TARGET_NOT_LOOPBACK`,
// `POSTGRES_TARGET_NOT_DISPOSABLE`), so the product runtime is designed to run
// against a throwaway local cluster. This script provisions exactly that from
// the pinned binaries already vendored under `.tools/postgresql`.
//
// Passwords are generated here, written only into the ignored env file, and
// never printed, never passed as a command-line argument, and never placed in a
// receipt. The initdb password file is written to the data directory and
// removed as soon as initdb returns.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import path from "node:path";

import { readDevEnvFile, writeDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";

export const LOCAL_POSTGRES_SCHEMA = "tivdoc-local-postgres-v0.10.10" as const;

/** The one vendored build this machine is allowed to execute. */
export const LOCAL_POSTGRES_BIN = path.join(".tools", "postgresql", "17.11-1-signed", "bin");

export const LOCAL_RUNTIME_ROLES = Object.freeze([
  "tivdoc_identity_runtime",
  "tivdoc_web_runtime",
  "tivdoc_operations_runtime",
  "tivdoc_worker_runtime",
] as const);

/** Disposable database name; the driver requires a disposable-looking name. */
export const LOCAL_DATABASE = "tivdoc_disposable_v01010";
const SUPERUSER = "tivdoc_local_superuser";

function tool(name: string): string {
  return path.resolve(LOCAL_POSTGRES_BIN, `${name}.exe`);
}

function run(name: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): { code: number; out: string } {
  const result = spawnSync(tool(name), [...args], {
    encoding: "utf8", windowsHide: true, timeout: 180_000,
    env: { ...process.env, ...env },
  });
  return { code: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

export async function pickLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port >= 1024 ? resolve(port) : reject(new Error("LOCAL_POSTGRES_PORT_UNAVAILABLE"))));
    });
  });
}

export function renderPgHba(): string {
  // Loopback only, password-authenticated. No trust, no host-wide listener.
  return [
    "local all all scram-sha-256",
    "host all all 127.0.0.1/32 scram-sha-256",
    "host all all ::1/128 scram-sha-256",
    "",
  ].join("\n");
}

export function renderPostgresqlConf(port: number): string {
  return [
    "listen_addresses = '127.0.0.1'",
    `port = ${port}`,
    "max_connections = 60",
    "fsync = off",
    "synchronous_commit = off",
    "full_page_writes = off",
    "logging_collector = off",
    "log_min_messages = warning",
    "password_encryption = 'scram-sha-256'",
    "",
  ].join("\n");
}

function localUrl(role: string, password: string, port: number, database: string): string {
  return `postgresql://${encodeURIComponent(role)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`;
}

async function provision(dataRoot: string): Promise<void> {
  const version = run("postgres", ["--version"]);
  if (version.code !== 0) throw new Error(`LOCAL_POSTGRES_BINARY_UNUSABLE:${version.out.slice(0, 80)}`);

  const entries = readDevEnvFile();
  const port = await pickLoopbackPort();
  const superuserPassword = randomBytes(24).toString("base64url");

  if (existsSync(dataRoot)) rmSync(dataRoot, { recursive: true, force: true });
  mkdirSync(dataRoot, { recursive: true });
  const passwordFile = path.join(dataRoot, "initdb.pwfile");
  writeFileSync(passwordFile, superuserPassword, "utf8");
  const init = run("initdb", [
    "-D", dataRoot, "-U", SUPERUSER, "--auth=scram-sha-256",
    `--pwfile=${passwordFile}`, "-E", "UTF8", "--no-sync",
  ]);
  rmSync(passwordFile, { force: true });
  if (init.code !== 0) throw new Error(`LOCAL_POSTGRES_INITDB_FAILED:${init.out.slice(-200)}`);

  appendFileSync(path.join(dataRoot, "postgresql.conf"), `\n${renderPostgresqlConf(port)}`, "utf8");
  writeFileSync(path.join(dataRoot, "pg_hba.conf"), renderPgHba(), "utf8");

  const logFile = path.join(dataRoot, "server.log");
  const start = run("pg_ctl", ["-D", dataRoot, "-l", logFile, "-w", "-t", "60", "start"]);
  if (start.code !== 0) {
    const log = existsSync(logFile) ? readFileSync(logFile, "utf8").slice(-400) : "";
    throw new Error(`LOCAL_POSTGRES_START_FAILED:${start.out.slice(-160)}|${log}`);
  }

  const { default: pg } = await import("pg");
  const admin = new pg.Client({
    connectionString: localUrl(SUPERUSER, superuserPassword, port, "postgres"),
    connectionTimeoutMillis: 15_000,
  });
  await admin.connect();
  try {
    await admin.query(`create database ${LOCAL_DATABASE}`);
    for (const role of LOCAL_RUNTIME_ROLES) {
      const password = randomBytes(24).toString("base64url");
      entries.set(`TIVDOC_LOCAL_PASSWORD__${role}`, password);
      // Interpolated inside this process only; the value never leaves it.
      await admin.query(`do $do$ begin
        if not exists (select 1 from pg_roles where rolname = '${role}') then
          execute format('create role %I login', '${role}');
        end if;
        execute format('alter role %I with login password %L', '${role}', ${quote(password)});
      end $do$;`);
    }
    const migratorPassword = randomBytes(24).toString("base64url");
    entries.set("TIVDOC_LOCAL_PASSWORD__tivdoc_local_migrator", migratorPassword);
    await admin.query(`do $do$ begin
      if not exists (select 1 from pg_roles where rolname = 'tivdoc_local_migrator') then
        execute 'create role tivdoc_local_migrator login superuser';
      end if;
      execute format('alter role tivdoc_local_migrator with login superuser password %L', ${quote(migratorPassword)});
    end $do$;`);
    entries.set("TIVDOC_LOCAL_MIGRATOR_URL", localUrl("tivdoc_local_migrator", migratorPassword, port, LOCAL_DATABASE));
    for (const role of LOCAL_RUNTIME_ROLES) {
      const password = entries.get(`TIVDOC_LOCAL_PASSWORD__${role}`) as string;
      const key = `TIVDOC_LOCAL_${role.replace("tivdoc_", "").replace("_runtime", "").toUpperCase()}_POSTGRES_URL`;
      entries.set(key, localUrl(role, password, port, LOCAL_DATABASE));
    }
  } finally {
    await admin.end().catch(() => undefined);
  }

  entries.set("TIVDOC_LOCAL_PG_DATA", dataRoot);
  entries.set("TIVDOC_LOCAL_PG_PORT", String(port));
  entries.set("TIVDOC_LOCAL_PG_DATABASE", LOCAL_DATABASE);
  entries.set("TIVDOC_LOCAL_PASSWORD__" + SUPERUSER, superuserPassword);
  writeDevEnvFile(entries);
  process.stdout.write(`provisioned port=${port} database=${LOCAL_DATABASE} roles=${LOCAL_RUNTIME_ROLES.length + 1}\n`);
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function stop(dataRoot: string): void {
  const result = run("pg_ctl", ["-D", dataRoot, "-m", "fast", "-w", "-t", "60", "stop"]);
  process.stdout.write(`${result.code === 0 ? "stopped" : "stop_failed"} ${result.out.slice(-120)}\n`);
}

function status(dataRoot: string): void {
  const result = run("pg_ctl", ["-D", dataRoot, "status"]);
  process.stdout.write(`status_code=${result.code}\n`);
}

const [command, ...rest] = process.argv.slice(2);
const dataRoot = path.resolve(rest[0] ?? path.join(process.env.TEMP ?? ".", "tivdoc-local-pg-v01010"));
if (command === "provision") await provision(dataRoot);
else if (command === "stop") stop(dataRoot);
else if (command === "status") status(dataRoot);
else throw new Error("LOCAL_POSTGRES_COMMAND_UNKNOWN");
