import type { V07Role, VerifiedActor } from "../../../engine/wave4/contracts";
import { V07_ROLES } from "../../../engine/wave4/contracts";

const OPAQUE = /^[a-z][a-z0-9_-]{7,63}$/;

export type TrustedIdentityEnvelope = Readonly<{
  source: "verified_server_adapter";
  signature_valid: true;
  issuer: string;
  audience: string;
  issued_at: string;
  expires_at: string;
  actor_id: string;
  role: V07Role;
  tenant_id: string | null;
  assigned_case_ids: readonly string[];
  break_glass_reason: string | null;
  break_glass_expires_at: string | null;
  test_only: boolean;
}>;

export type IdentityVerificationConfig = Readonly<{
  issuer: string;
  audience: string;
  runtime: "development" | "production" | "test";
  clock_skew_ms: number;
}>;

function parseTime(value: string, code: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(code);
  return parsed;
}

export function deriveVerifiedActor(
  envelope: TrustedIdentityEnvelope,
  config: IdentityVerificationConfig,
  nowMs: number,
): VerifiedActor {
  // This legacy envelope exists only for hermetic integration fixtures. Runtime
  // identities must enter through CryptographicJwtIdentityVerifier.
  const nodeEnvironment = runtimeEnvironmentValue("NODE_ENV");
  const vercelEnvironment = runtimeEnvironmentValue("VERCEL_ENV");
  if (nodeEnvironment !== "test" || vercelEnvironment === "production" || vercelEnvironment === "preview" || config.runtime !== "test" || envelope.test_only !== true) {
    throw new Error("TEST_IDENTITY_PRODUCTION_FORBIDDEN");
  }
  if (envelope.source !== "verified_server_adapter" || envelope.signature_valid !== true) throw new Error("IDENTITY_UNVERIFIED");
  if (envelope.issuer !== config.issuer) throw new Error("IDENTITY_ISSUER_INVALID");
  if (envelope.audience !== config.audience) throw new Error("IDENTITY_AUDIENCE_INVALID");
  if (!OPAQUE.test(envelope.actor_id) || (envelope.tenant_id !== null && !OPAQUE.test(envelope.tenant_id))) throw new Error("IDENTITY_REFERENCE_INVALID");
  if (!(V07_ROLES as readonly string[]).includes(envelope.role)) throw new Error("IDENTITY_ROLE_INVALID");
  if (new Set(envelope.assigned_case_ids).size !== envelope.assigned_case_ids.length || envelope.assigned_case_ids.some((id) => !OPAQUE.test(id))) {
    throw new Error("IDENTITY_ASSIGNMENTS_INVALID");
  }
  if (!Number.isSafeInteger(config.clock_skew_ms) || config.clock_skew_ms < 0 || config.clock_skew_ms > 60_000) throw new Error("IDENTITY_CLOCK_SKEW_INVALID");
  const issued = parseTime(envelope.issued_at, "IDENTITY_ISSUED_AT_INVALID");
  const expires = parseTime(envelope.expires_at, "IDENTITY_EXPIRES_AT_INVALID");
  if (issued > nowMs + config.clock_skew_ms) throw new Error("IDENTITY_NOT_YET_VALID");
  if (expires <= nowMs - config.clock_skew_ms || expires <= issued) throw new Error("IDENTITY_EXPIRED");

  if (envelope.role === "break_glass_admin") {
    if (!envelope.break_glass_reason || !/^[A-Z][A-Z0-9_]{7,63}$/.test(envelope.break_glass_reason)) throw new Error("BREAK_GLASS_REASON_REQUIRED");
    if (envelope.break_glass_expires_at === null) throw new Error("BREAK_GLASS_EXPIRY_REQUIRED");
    const breakGlassExpiry = parseTime(envelope.break_glass_expires_at, "BREAK_GLASS_EXPIRY_INVALID");
    if (breakGlassExpiry <= nowMs || breakGlassExpiry > nowMs + 15 * 60_000 || breakGlassExpiry > expires) throw new Error("BREAK_GLASS_EXPIRY_INVALID");
  } else if (envelope.break_glass_reason !== null || envelope.break_glass_expires_at !== null) {
    throw new Error("BREAK_GLASS_FIELDS_FORBIDDEN");
  }

  return Object.freeze({
    actor_id: envelope.actor_id,
    role: envelope.role,
    tenant_id: envelope.tenant_id,
    assigned_case_ids: Object.freeze([...envelope.assigned_case_ids]),
    verified_server_side: true,
    break_glass_reason: envelope.break_glass_reason,
    break_glass_expires_at: envelope.break_glass_expires_at,
  });
}

function runtimeEnvironmentValue(key: string): string | undefined {
  const value = Reflect.get(process.env, key);
  return typeof value === "string" ? value : undefined;
}
