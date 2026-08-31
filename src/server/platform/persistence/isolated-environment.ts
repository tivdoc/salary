import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

export const ISOLATED_POSTGRES_ENV_KEYS = Object.freeze({
  url: "TIVDOC_ISOLATED_POSTGRES_URL",
  target_id: "TIVDOC_ISOLATED_POSTGRES_TARGET_ID",
  ownership_token: "TIVDOC_ISOLATED_POSTGRES_OWNERSHIP_TOKEN",
});

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const TARGET_ID = /^tivdoc-isolated-[a-z0-9]{8,32}$/;
const DATABASE_NAME = /^tivdoc_isolated_[a-z0-9]{8,32}$/;
const OWNERSHIP_TOKEN = /^[a-f0-9]{64}$/;

export type LocalToolName = "psql" | "createdb" | "dropdb" | "pg_dump" | "pg_restore" | "docker" | "podman" | "supabase";
export type LocalToolReceipt = Readonly<{ installed: boolean; version: string | null }>;

export type SafeLoopbackTarget = Readonly<{
  approved: boolean;
  reason:
    | "explicit_target_not_supplied"
    | "invalid_url"
    | "non_loopback_target_rejected"
    | "target_identity_invalid"
    | "database_name_invalid"
    | "ownership_token_invalid"
    | "approved_loopback_disposable_target";
  host: string | null;
  port: number | null;
  database: string | null;
  target_id: string | null;
  ownership_token_sha256: string | null;
}>;

export type PersistenceEnvironmentReceipt = Readonly<{
  schema_version: "tivdoc-isolated-postgres-environment-v1";
  inspected_environment_keys: readonly string[];
  forbidden_generic_environment_keys_read: 0;
  tools: Readonly<Record<LocalToolName, LocalToolReceipt>>;
  cached_local_images: readonly string[];
  target: SafeLoopbackTarget;
  capability: "SAFE_LOOPBACK_POSTGRES_AVAILABLE" | "PERSISTENCE_ISOLATED_ENVIRONMENT_BLOCKED";
  external_connections: 0;
  secrets_emitted: 0;
}>;

export type ToolProbe = (tool: LocalToolName) => LocalToolReceipt;
export type ImageProbe = (engine: "docker" | "podman") => readonly string[];

export function detectPersistenceEnvironment(input: Readonly<{
  env?: Readonly<Record<string, string | undefined>>;
  tool_probe?: ToolProbe;
  image_probe?: ImageProbe;
}> = {}): PersistenceEnvironmentReceipt {
  const env = input.env ?? process.env;
  const toolProbe = input.tool_probe ?? probeLocalTool;
  const imageProbe = input.image_probe ?? probeCachedImages;
  const tools = Object.fromEntries(
    (["psql", "createdb", "dropdb", "pg_dump", "pg_restore", "docker", "podman", "supabase"] as const)
      .map((tool) => [tool, toolProbe(tool)]),
  ) as Record<LocalToolName, LocalToolReceipt>;
  const cachedImages = [
    ...(tools.docker.installed ? imageProbe("docker") : []),
    ...(tools.podman.installed ? imageProbe("podman") : []),
  ].filter((item, index, all) => all.indexOf(item) === index).sort();
  const target = validateExplicitLoopbackTarget({
    url: env[ISOLATED_POSTGRES_ENV_KEYS.url],
    target_id: env[ISOLATED_POSTGRES_ENV_KEYS.target_id],
    ownership_token: env[ISOLATED_POSTGRES_ENV_KEYS.ownership_token],
  });
  return Object.freeze({
    schema_version: "tivdoc-isolated-postgres-environment-v1",
    inspected_environment_keys: Object.values(ISOLATED_POSTGRES_ENV_KEYS),
    forbidden_generic_environment_keys_read: 0,
    tools: Object.freeze(tools),
    cached_local_images: Object.freeze(cachedImages),
    target,
    capability: target.approved && tools.psql.installed
      ? "SAFE_LOOPBACK_POSTGRES_AVAILABLE"
      : "PERSISTENCE_ISOLATED_ENVIRONMENT_BLOCKED",
    external_connections: 0,
    secrets_emitted: 0,
  });
}

export function validateExplicitLoopbackTarget(input: Readonly<{
  url: string | undefined;
  target_id: string | undefined;
  ownership_token: string | undefined;
}>): SafeLoopbackTarget {
  if (!input.url && !input.target_id && !input.ownership_token) return denied("explicit_target_not_supplied");

  let parsed: URL;
  try {
    parsed = new URL(input.url ?? "");
  } catch {
    return denied("invalid_url");
  }
  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol)) return denied("invalid_url");
  const host = parsed.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) return denied("non_loopback_target_rejected");
  if (!input.target_id || !TARGET_ID.test(input.target_id)) return denied("target_identity_invalid", parsed);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!DATABASE_NAME.test(database) || database.replaceAll("_", "-") !== input.target_id) {
    return denied("database_name_invalid", parsed, input.target_id);
  }
  if (!input.ownership_token || !OWNERSHIP_TOKEN.test(input.ownership_token)) {
    return denied("ownership_token_invalid", parsed, input.target_id, database);
  }
  return Object.freeze({
    approved: true,
    reason: "approved_loopback_disposable_target",
    host,
    port: parsePort(parsed.port),
    database,
    target_id: input.target_id,
    ownership_token_sha256: createHash("sha256").update(input.ownership_token).digest("hex"),
  });
}

export function createOwnershipMarker(input: Readonly<{ target_id: string; ownership_token: string }>): Readonly<{
  schema_version: "tivdoc-isolated-postgres-owner-v1";
  target_id: string;
  ownership_token_sha256: string;
}> {
  if (!TARGET_ID.test(input.target_id) || !OWNERSHIP_TOKEN.test(input.ownership_token)) {
    throw new TypeError("ISOLATED_POSTGRES_OWNERSHIP_INPUT_INVALID");
  }
  return Object.freeze({
    schema_version: "tivdoc-isolated-postgres-owner-v1",
    target_id: input.target_id,
    ownership_token_sha256: createHash("sha256").update(input.ownership_token).digest("hex"),
  });
}

export function authorizeIsolatedTeardown(input: Readonly<{
  marker: ReturnType<typeof createOwnershipMarker>;
  target_id: string;
  ownership_token: string;
}>): boolean {
  if (!TARGET_ID.test(input.target_id) || !OWNERSHIP_TOKEN.test(input.ownership_token)) return false;
  const tokenHash = createHash("sha256").update(input.ownership_token).digest("hex");
  return input.marker.schema_version === "tivdoc-isolated-postgres-owner-v1"
    && input.marker.target_id === input.target_id
    && input.marker.ownership_token_sha256 === tokenHash;
}

function denied(
  reason: Exclude<SafeLoopbackTarget["reason"], "approved_loopback_disposable_target">,
  parsed?: URL,
  targetId?: string,
  database?: string,
): SafeLoopbackTarget {
  return Object.freeze({
    approved: false,
    reason,
    host: parsed?.hostname.toLowerCase() ?? null,
    port: parsed ? parsePort(parsed.port) : null,
    database: database ?? (parsed ? decodeURIComponent(parsed.pathname.replace(/^\//, "")) || null : null),
    target_id: targetId ?? null,
    ownership_token_sha256: null,
  });
}

function parsePort(value: string): number {
  return value === "" ? 5432 : Number.parseInt(value, 10);
}

function probeLocalTool(tool: LocalToolName): LocalToolReceipt {
  const result = spawnSync(tool, ["--version"], {
    encoding: "utf8",
    shell: process.platform === "win32",
    windowsHide: true,
    timeout: 5_000,
  });
  const version = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split(/\r?\n/, 1)[0] ?? "";
  return Object.freeze({ installed: result.status === 0, version: result.status === 0 && version !== "" ? version : null });
}

function probeCachedImages(engine: "docker" | "podman"): readonly string[] {
  const result = spawnSync(engine, ["image", "ls", "--format", "{{.Repository}}:{{.Tag}}"], {
    encoding: "utf8",
    shell: process.platform === "win32",
    windowsHide: true,
    timeout: 10_000,
  });
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /(?:postgres|supabase)/i.test(line))
    .sort();
}
