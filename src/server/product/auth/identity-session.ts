import "./server-boundary.ts";

import type {
  IdentityVerificationPort,
  VerifiedIdentity,
} from "../../platform/auth/identity-verification.ts";
import type { ProductAudience } from "./hermetic-session.ts";
import type { VerifiedActor } from "../../../engine/wave4/contracts.ts";

export const PRODUCT_IDENTITY_COOKIE = "__Host-tivdoc_identity" as const;

const IDENTITY_SPOOF_HEADERS = Object.freeze([
  "authorization",
  "forwarded-user",
  "remote-user",
  "x-auth-request-email",
  "x-auth-request-user",
  "x-forwarded-email",
  "x-forwarded-user",
  "x-owner-id",
  "x-role",
  "x-tivdoc-actor-id",
  "x-tivdoc-owner-id",
  "x-tivdoc-role",
  "x-user-id",
]);
const IDENTITY_QUERY_KEYS = Object.freeze([
  "actor",
  "actor_id",
  "authorization",
  "jwt",
  "owner",
  "owner_id",
  "role",
  "session",
  "tenant",
  "tenant_id",
  "token",
]);

export type VerifiedProductIdentity = Readonly<VerifiedIdentity & {
  product_audience: ProductAudience;
}>;

export type ProductIdentityTransportPolicy = Readonly<{
  /** HTTPS remains mandatory unless this explicit local-development exception is enabled. */
  allow_local_loopback_http?: boolean;
  /** Exact origin that issued the host-only cookie. Required for the HTTP exception. */
  allowed_origin?: string;
  /** Additional deployment evidence; it can only make the policy more restrictive. */
  environment?: Readonly<Record<string, string | undefined>>;
}>;

export const DURABLE_PRODUCT_ACTOR_SESSION = Symbol("tivdoc.durable-product-actor-session.v0.10.2");

export type DurableProductActorSessionBinding = Readonly<{
  session_id: string;
  token_id: string;
  rotation_counter: number;
  reviewer_organization_id: string | null;
  issuer: string;
  audience: string;
  issued_at_epoch: number;
  expires_at_epoch: number;
}>;

export type DurableSessionBoundActor<TActor extends VerifiedActor = VerifiedActor> = TActor & Readonly<{
  [DURABLE_PRODUCT_ACTOR_SESSION]: DurableProductActorSessionBinding;
}>;

/** Binds verified session coordinates without making them JSON-visible. */
export function bindDurableProductActor<TActor extends VerifiedActor>(
  identity: Omit<VerifiedProductIdentity, "actor"> & Readonly<{ actor: TActor }>,
): DurableSessionBoundActor<TActor> {
  const actor = { ...identity.actor } as TActor & {
    [DURABLE_PRODUCT_ACTOR_SESSION]?: DurableProductActorSessionBinding;
  };
  Object.defineProperty(actor, DURABLE_PRODUCT_ACTOR_SESSION, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({
      session_id: identity.session_id,
      token_id: identity.token_id,
      rotation_counter: identity.rotation_counter,
      reviewer_organization_id: identity.reviewer_organization_id,
      issuer: identity.issuer,
      audience: identity.audience,
      issued_at_epoch: identity.issued_at_epoch,
      expires_at_epoch: identity.expires_at_epoch,
    }),
  });
  return Object.freeze(actor) as DurableSessionBoundActor<TActor>;
}

export function durableProductActorSession(actor: VerifiedActor): DurableProductActorSessionBinding | null {
  const value = (actor as Partial<DurableSessionBoundActor>)[DURABLE_PRODUCT_ACTOR_SESSION];
  return value && typeof value === "object" ? value : null;
}

/** Reconstitutes the already-verified request identity from its non-enumerable actor binding. */
export function durableProductIdentityFromActor(
  actor: VerifiedActor,
  audience: ProductAudience,
): VerifiedProductIdentity {
  const session = durableProductActorSession(actor);
  if (!session || actor.tenant_id === null) throw new Error("DURABLE_PRODUCT_SESSION_BINDING_REQUIRED");
  if (session.audience !== audience
      || (audience === "portal" && actor.role !== "customer_owner")
      || (audience === "operations"
        && (actor.role === "anonymous" || actor.role === "customer_owner" || actor.role === "scoped_background_worker"))) {
    throw new Error("DURABLE_PRODUCT_SESSION_AUDIENCE_MISMATCH");
  }
  return Object.freeze({
    actor,
    issuer: session.issuer,
    audience,
    product_audience: audience,
    session_id: session.session_id,
    token_id: session.token_id,
    rotation_counter: session.rotation_counter,
    reviewer_organization_id: session.reviewer_organization_id,
    issued_at_epoch: session.issued_at_epoch,
    expires_at_epoch: session.expires_at_epoch,
  });
}

/**
 * Canonical HTTP identity boundary. The only credential source is the exact,
 * signed host cookie; identity headers, query values, duplicates and loose actor
 * cookies fail closed before the cryptographic verifier is invoked.
 */
export async function authenticateProductIdentity(
  request: Request,
  audience: ProductAudience,
  verifier: IdentityVerificationPort,
  transport: ProductIdentityTransportPolicy = Object.freeze({}),
): Promise<VerifiedProductIdentity | null> {
  if (IDENTITY_SPOOF_HEADERS.some((header) => request.headers.has(header))) return null;
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  const allowedOrigin = transport.allowed_origin === undefined
    ? null
    : canonicalProductIdentityOrigin(transport.allowed_origin, transport);
  if (transport.allowed_origin !== undefined && !allowedOrigin) return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.protocol === "https:") {
    if (allowedOrigin !== null && url.origin !== allowedOrigin) return null;
  } else if (url.protocol === "http:") {
    if (!transport.allow_local_loopback_http || !allowedOrigin || url.origin !== allowedOrigin) return null;
    if (!isExactLoopbackHostname(url.hostname) || vercelEnvironmentPresent(transport.environment)) return null;
  } else {
    return null;
  }
  if (IDENTITY_QUERY_KEYS.some((key) => url.searchParams.has(key))) return null;
  const compactJwt = singleCookie(request.headers.get("cookie"), PRODUCT_IDENTITY_COOKIE);
  if (!compactJwt) return null;

  let verified: VerifiedIdentity | null;
  try {
    verified = await verifier.verify({ compact_jwt: compactJwt, expected_audience: audience });
  } catch {
    return null;
  }
  if (!verified || verified.audience !== audience || verified.actor.verified_server_side !== true || !roleAllowedForAudience(verified.actor.role, audience)) return null;
  return Object.freeze({ ...verified, product_audience: audience });
}

/** Canonicalizes an allowed identity origin without ever relaxing remote HTTP. */
export function canonicalProductIdentityOrigin(
  value: string,
  transport: Pick<ProductIdentityTransportPolicy, "allow_local_loopback_http" | "environment"> = Object.freeze({}),
): string | null {
  try {
    const url = new URL(value);
    if (url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
      return null;
    }
    if (url.protocol === "https:") return url.origin;
    if (url.protocol !== "http:" || transport.allow_local_loopback_http !== true) return null;
    if (!isExactLoopbackHostname(url.hostname) || vercelEnvironmentPresent(transport.environment)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function singleCookie(raw: string | null, name: string): string | null {
  if (!raw || raw.length > 16_384) return null;
  const matches = raw
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(name.length + 1);
  const pieces = value.split(".");
  return pieces.length === 3 && pieces.every((piece) => /^[A-Za-z0-9_-]+$/.test(piece)) && value.length <= 8_192
    ? value
    : null;
}

function roleAllowedForAudience(role: string, audience: ProductAudience): boolean {
  if (audience === "portal") return role === "customer_owner";
  return role !== "anonymous" && role !== "customer_owner" && role !== "scoped_background_worker";
}

function isExactLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost";
}

function vercelEnvironmentPresent(additional: Readonly<Record<string, string | undefined>> | undefined): boolean {
  return hasVercelValue(process.env) || (additional !== undefined && hasVercelValue(additional));
}

function hasVercelValue(environment: Readonly<Record<string, string | undefined>>): boolean {
  return Object.entries(environment).some(([key, value]) =>
    (key === "VERCEL" || key.startsWith("VERCEL_")) && typeof value === "string" && value.trim() !== "");
}
