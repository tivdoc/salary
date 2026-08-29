export const PERSISTENCE_ISOLATED_ENVIRONMENT_BLOCKED =
  "PERSISTENCE_ISOLATED_ENVIRONMENT_BLOCKED" as const;

export type PersistenceIsolationTarget = Readonly<{
  kind: "local" | "disposable";
  target_id: string;
  host: string;
  production: false;
  shared: false;
  expires_at: string | null;
}>;

export type IsolationGateDecision = Readonly<{
  authorized: boolean;
  status: "ISOLATED_TARGET_VERIFIED" | typeof PERSISTENCE_ISOLATED_ENVIRONMENT_BLOCKED;
  reason:
    | "verified_local_loopback_target"
    | "verified_expiring_disposable_target"
    | "target_identity_not_supplied"
    | "production_or_shared_target_forbidden"
    | "local_target_must_be_loopback"
    | "disposable_target_requires_future_expiry"
    | "invalid_target_identity";
}>;

const SAFE_TARGET_ID = /^[a-z][a-z0-9._:-]{2,119}$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Mandatory fail-closed gate for any future migration runner. This function does
 * not connect to a database and intentionally accepts no credentials.
 */
export function verifyIsolatedTargetIdentity(
  target: PersistenceIsolationTarget | null,
  now = new Date(),
): IsolationGateDecision {
  if (target === null) {
    return {
      authorized: false,
      status: PERSISTENCE_ISOLATED_ENVIRONMENT_BLOCKED,
      reason: "target_identity_not_supplied",
    };
  }

  if (!SAFE_TARGET_ID.test(target.target_id) || target.host.trim().length === 0) {
    return {
      authorized: false,
      status: PERSISTENCE_ISOLATED_ENVIRONMENT_BLOCKED,
      reason: "invalid_target_identity",
    };
  }

  if (target.production !== false || target.shared !== false) {
    return {
      authorized: false,
      status: PERSISTENCE_ISOLATED_ENVIRONMENT_BLOCKED,
      reason: "production_or_shared_target_forbidden",
    };
  }

  if (target.kind === "local") {
    if (!LOOPBACK_HOSTS.has(target.host.toLowerCase())) {
      return {
        authorized: false,
        status: PERSISTENCE_ISOLATED_ENVIRONMENT_BLOCKED,
        reason: "local_target_must_be_loopback",
      };
    }
    return {
      authorized: true,
      status: "ISOLATED_TARGET_VERIFIED",
      reason: "verified_local_loopback_target",
    };
  }

  const expiresAt = target.expires_at === null ? Number.NaN : Date.parse(target.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
    return {
      authorized: false,
      status: PERSISTENCE_ISOLATED_ENVIRONMENT_BLOCKED,
      reason: "disposable_target_requires_future_expiry",
    };
  }

  return {
    authorized: true,
    status: "ISOLATED_TARGET_VERIFIED",
    reason: "verified_expiring_disposable_target",
  };
}
