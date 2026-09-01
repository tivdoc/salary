import { createHash, randomBytes } from "node:crypto";

export const DYNAMIC_POSTGRES_ENV_KEY = "TIVDOC_DYNAMIC_POSTGRES_URL" as const;
export const OWNED_TARGET_SCHEMA_VERSION = "tivdoc-dynamic-postgres-owner-v0.9.1" as const;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const SAFE_DATABASE = /^tivdoc_v09_[a-z0-9_]{8,48}$/;
const SAFE_TARGET_ID = /^tivdoc-v09-[a-z0-9-]{8,48}$/;
const FORBIDDEN_DATABASE_MARKER = /prod|production|live|customer|shared/i;
const INSPECTED_ENVIRONMENT_KEYS: readonly [typeof DYNAMIC_POSTGRES_ENV_KEY] = Object.freeze([
  DYNAMIC_POSTGRES_ENV_KEY,
]);

export class SecretValue {
  readonly #value: string;

  constructor(value: string) {
    if (value.length === 0 || value.includes("\0")) throw new TypeError("SECRET_VALUE_INVALID");
    this.#value = value;
    Object.freeze(this);
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return "[REDACTED]";
  }

  toJSON(): string {
    return "[REDACTED]";
  }
}

export type SafeTargetDescriptor = Readonly<{
  kind: "explicit_loopback" | "owned_local_loopback";
  host: "127.0.0.1" | "localhost" | "::1";
  port: number;
  database: string;
  target_id: string;
  destructive_control_authorized: boolean;
}>;

export type OwnedTargetMarker = Readonly<{
  schema_version: typeof OWNED_TARGET_SCHEMA_VERSION;
  target_id: string;
  database: string;
  host: "127.0.0.1";
  port: number;
  ownership_token_sha256: string;
}>;

export type ApprovedPostgresTarget = Readonly<{
  descriptor: SafeTargetDescriptor;
  username: SecretValue;
  password: SecretValue;
  ownership_token: SecretValue | null;
  marker: OwnedTargetMarker | null;
}>;

export type TargetSafetyReceipt = Readonly<{
  schema_version: "tivdoc-dynamic-postgres-target-safety-v0.9.1";
  inspected_environment_keys: readonly [typeof DYNAMIC_POSTGRES_ENV_KEY];
  approved: boolean;
  reason:
    | "explicit_target_not_supplied"
    | "invalid_url"
    | "non_postgresql_protocol"
    | "non_loopback_target_rejected"
    | "port_invalid"
    | "database_name_invalid"
    | "production_like_database_rejected"
    | "credentials_missing"
    | "unsupported_connection_option"
    | "approved_explicit_loopback_target";
  target: SafeTargetDescriptor | null;
  credentials_emitted: 0;
  generic_database_environment_keys_read: 0;
}>;

export function inspectExplicitDynamicTarget(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<{ receipt: TargetSafetyReceipt; target: ApprovedPostgresTarget | null }> {
  const raw = env[DYNAMIC_POSTGRES_ENV_KEY];
  if (!raw) return denied("explicit_target_not_supplied");

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return denied("invalid_url");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    return denied("non_postgresql_protocol");
  }
  const host = normalizeHost(parsed.hostname);
  if (!host) return denied("non_loopback_target_rejected");
  const port = parsed.port === "" ? 5432 : Number.parseInt(parsed.port, 10);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) return denied("port_invalid");
  let database: string;
  let username: string;
  let password: string;
  try {
    database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
    username = decodeURIComponent(parsed.username);
    password = decodeURIComponent(parsed.password);
  } catch {
    return denied("invalid_url");
  }
  if (FORBIDDEN_DATABASE_MARKER.test(database)) return denied("production_like_database_rejected");
  if (!SAFE_DATABASE.test(database)) return denied("database_name_invalid");
  if (!parsed.username || !parsed.password) return denied("credentials_missing");
  if (parsed.hash || !hasOnlySafeConnectionOptions(parsed.searchParams)) {
    return denied("unsupported_connection_option");
  }

  const targetId = database.replaceAll("_", "-");
  const descriptor: SafeTargetDescriptor = Object.freeze({
    kind: "explicit_loopback",
    host,
    port,
    database,
    target_id: targetId,
    destructive_control_authorized: false,
  });
  const target: ApprovedPostgresTarget = Object.freeze({
    descriptor,
    username: new SecretValue(username),
    password: new SecretValue(password),
    ownership_token: null,
    marker: null,
  });
  return Object.freeze({
    receipt: Object.freeze({
      schema_version: "tivdoc-dynamic-postgres-target-safety-v0.9.1",
      inspected_environment_keys: INSPECTED_ENVIRONMENT_KEYS,
      approved: true,
      reason: "approved_explicit_loopback_target",
      target: descriptor,
      credentials_emitted: 0,
      generic_database_environment_keys_read: 0,
    }),
    target,
  });
}

export function createOwnedLocalTarget(input: Readonly<{
  port: number;
  suffix?: string;
  username?: string;
  password?: string;
  ownership_token?: string;
}>): ApprovedPostgresTarget {
  if (!Number.isSafeInteger(input.port) || input.port < 40_000 || input.port > 49_151) {
    throw new TypeError("OWNED_POSTGRES_HIGH_PORT_INVALID");
  }
  const suffix = input.suffix ?? randomBytes(8).toString("hex");
  if (!/^[a-z0-9_]{8,48}$/.test(suffix)) throw new TypeError("OWNED_POSTGRES_SUFFIX_INVALID");
  const targetId = `tivdoc-v09-${suffix.replaceAll("_", "-")}`;
  const database = `tivdoc_v09_${suffix}`;
  if (FORBIDDEN_DATABASE_MARKER.test(database)) throw new TypeError("OWNED_POSTGRES_DATABASE_NAME_INVALID");
  const username = input.username ?? "tivdoc_dynamic_admin";
  const password = input.password ?? randomBytes(36).toString("base64url");
  const ownershipToken = input.ownership_token ?? randomBytes(32).toString("hex");
  if (!/^[a-z][a-z0-9_]{2,62}$/.test(username)) throw new TypeError("OWNED_POSTGRES_USERNAME_INVALID");
  if (password.length < 32) throw new TypeError("OWNED_POSTGRES_PASSWORD_TOO_SHORT");
  if (!/^[a-f0-9]{64}$/.test(ownershipToken)) throw new TypeError("OWNED_POSTGRES_TOKEN_INVALID");

  const marker: OwnedTargetMarker = Object.freeze({
    schema_version: OWNED_TARGET_SCHEMA_VERSION,
    target_id: targetId,
    database,
    host: "127.0.0.1",
    port: input.port,
    ownership_token_sha256: sha256(ownershipToken),
  });
  return Object.freeze({
    descriptor: Object.freeze({
      kind: "owned_local_loopback",
      host: "127.0.0.1",
      port: input.port,
      database,
      target_id: targetId,
      destructive_control_authorized: true,
    }),
    username: new SecretValue(username),
    password: new SecretValue(password),
    ownership_token: new SecretValue(ownershipToken),
    marker,
  });
}

export function authorizeOwnedControl(
  target: ApprovedPostgresTarget,
  marker: OwnedTargetMarker,
): boolean {
  const token = target.ownership_token?.reveal();
  return target.descriptor.kind === "owned_local_loopback"
    && target.descriptor.destructive_control_authorized
    && token !== undefined
    && marker.schema_version === OWNED_TARGET_SCHEMA_VERSION
    && marker.target_id === target.descriptor.target_id
    && marker.database === target.descriptor.database
    && marker.host === target.descriptor.host
    && marker.port === target.descriptor.port
    && marker.ownership_token_sha256 === sha256(token);
}

export function assertSafeTargetIdentity(descriptor: SafeTargetDescriptor): void {
  if (!SAFE_DATABASE.test(descriptor.database)
    || FORBIDDEN_DATABASE_MARKER.test(descriptor.database)
    || !SAFE_TARGET_ID.test(descriptor.target_id)) {
    throw new Error("POSTGRES_TARGET_IDENTITY_UNSAFE");
  }
  if (descriptor.database.replaceAll("_", "-") !== descriptor.target_id) {
    throw new Error("POSTGRES_TARGET_IDENTITY_MISMATCH");
  }
  if (!LOOPBACK_HOSTS.has(descriptor.host)) throw new Error("POSTGRES_TARGET_NOT_LOOPBACK");
}

function denied(reason: TargetSafetyReceipt["reason"]): Readonly<{
  receipt: TargetSafetyReceipt;
  target: null;
}> {
  return Object.freeze({
    receipt: Object.freeze({
      schema_version: "tivdoc-dynamic-postgres-target-safety-v0.9.1",
      inspected_environment_keys: INSPECTED_ENVIRONMENT_KEYS,
      approved: false,
      reason,
      target: null,
      credentials_emitted: 0,
      generic_database_environment_keys_read: 0,
    }),
    target: null,
  });
}

function normalizeHost(hostname: string): SafeTargetDescriptor["host"] | null {
  const value = hostname.toLowerCase();
  if (value === "127.0.0.1") return "127.0.0.1";
  if (value === "localhost") return "localhost";
  if (value === "::1" || value === "[::1]") return "::1";
  return null;
}

function hasOnlySafeConnectionOptions(parameters: URLSearchParams): boolean {
  for (const [key, value] of parameters.entries()) {
    if (key !== "sslmode" && key !== "application_name") return false;
    if (key === "sslmode" && value !== "disable") return false;
    if (key === "application_name" && !/^tivdoc-dynamic-v0\.9\.1$/.test(value)) return false;
  }
  return true;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
