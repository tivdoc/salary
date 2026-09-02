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
/**
 * Why an identity was refused. Codes only, never a header, cookie, origin or
 * any part of a request. The caller still receives an identical bare refusal;
 * this exists so an operator can tell three unrelated causes apart from the
 * inside, which is what a bare 404 costs when it hides its own reason.
 */
export const PRODUCT_IDENTITY_REFUSALS = Object.freeze([
  "SPOOF_HEADER_PRESENT",
  "REQUEST_URL_INVALID",
  "TRANSPORT_ORIGIN_INVALID",
  "URL_CREDENTIALS_PRESENT",
  "HTTPS_ORIGIN_MISMATCH",
  "LOOPBACK_HTTP_NOT_ALLOWED",
  "LOOPBACK_ORIGIN_MISMATCH",
  "LOOPBACK_ORIGIN_PROTOCOL_MISMATCH",
  "LOOPBACK_ORIGIN_PORT_MISMATCH",
  "LOOPBACK_ORIGIN_REQUEST_NOT_LOOPBACK",
  "LOOPBACK_ORIGIN_CONFIG_NOT_LOOPBACK",
  "LOOPBACK_ORIGIN_LABEL_DIFFERS",
  "LOOPBACK_HOSTNAME_INVALID",
  "PROTOCOL_UNSUPPORTED",
  "QUERY_KEY_FORBIDDEN",
  "IDENTITY_COOKIE_ABSENT",
  "VERIFIER_THREW",
  "VERIFIER_REJECTED",
] as const);

export type ProductIdentityRefusal = (typeof PRODUCT_IDENTITY_REFUSALS)[number];

const identityRefusalLog: { reason: ProductIdentityRefusal; at: string }[] = [];

export function readProductIdentityRefusalLog(): readonly Readonly<{
  reason: ProductIdentityRefusal; at: string;
}>[] {
  return Object.freeze(identityRefusalLog.map((entry) => Object.freeze({ ...entry })));
}

export function clearProductIdentityRefusalLog(): void {
  identityRefusalLog.length = 0;
}

function refuseIdentity(reason: ProductIdentityRefusal): null {
  identityRefusalLog.push({ reason, at: new Date().toISOString() });
  if (identityRefusalLog.length > 64) identityRefusalLog.shift();
  if (process.env.NODE_ENV !== "test") process.stderr.write(`product_identity_refused ${reason}
`);
  return null;
}

export async function authenticateProductIdentity(
  request: Request,
  audience: ProductAudience,
  verifier: IdentityVerificationPort,
  transport: ProductIdentityTransportPolicy = Object.freeze({}),
): Promise<VerifiedProductIdentity | null> {
  if (IDENTITY_SPOOF_HEADERS.some((header) => request.headers.has(header))) return refuseIdentity("SPOOF_HEADER_PRESENT");
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return refuseIdentity("REQUEST_URL_INVALID");
  }
  const allowedOrigin = transport.allowed_origin === undefined
    ? null
    : canonicalProductIdentityOrigin(transport.allowed_origin, transport);
  if (transport.allowed_origin !== undefined && !allowedOrigin) return refuseIdentity("TRANSPORT_ORIGIN_INVALID");
  if (url.username !== "" || url.password !== "") return refuseIdentity("URL_CREDENTIALS_PRESENT");
  if (url.protocol === "https:") {
    if (allowedOrigin !== null && url.origin !== allowedOrigin) return refuseIdentity("HTTPS_ORIGIN_MISMATCH");
  } else if (url.protocol === "http:") {
    if (!transport.allow_local_loopback_http || !allowedOrigin) return refuseIdentity("LOOPBACK_HTTP_NOT_ALLOWED");
    if (url.origin !== allowedOrigin) {
      // Origin equality stays exact — two spellings of loopback are still two
      // different origins here, and that assertion is deliberate. The codes
      // only say which field diverged, and for a hostname divergence, which
      // side was loopback: that is the difference between a misconfiguration
      // and an attempt, and it is not derivable from outside.
      const expected = new URL(allowedOrigin);
      if (url.protocol !== expected.protocol) return refuseIdentity("LOOPBACK_ORIGIN_PROTOCOL_MISMATCH");
      if (url.port !== expected.port) return refuseIdentity("LOOPBACK_ORIGIN_PORT_MISMATCH");
      if (url.hostname !== expected.hostname) {
        if (!isExactLoopbackHostname(url.hostname)) return refuseIdentity("LOOPBACK_ORIGIN_REQUEST_NOT_LOOPBACK");
        if (!isExactLoopbackHostname(expected.hostname)) return refuseIdentity("LOOPBACK_ORIGIN_CONFIG_NOT_LOOPBACK");
        return refuseIdentity("LOOPBACK_ORIGIN_LABEL_DIFFERS");
      }
      return refuseIdentity("LOOPBACK_ORIGIN_MISMATCH");
    }
    if (!isExactLoopbackHostname(url.hostname) || vercelEnvironmentPresent(transport.environment)) {
      return refuseIdentity("LOOPBACK_HOSTNAME_INVALID");
    }
  } else {
    return refuseIdentity("PROTOCOL_UNSUPPORTED");
  }
  if (IDENTITY_QUERY_KEYS.some((key) => url.searchParams.has(key))) return refuseIdentity("QUERY_KEY_FORBIDDEN");
  const compactJwt = singleCookie(request.headers.get("cookie"), PRODUCT_IDENTITY_COOKIE);
  if (!compactJwt) return refuseIdentity("IDENTITY_COOKIE_ABSENT");

  let verified: VerifiedIdentity | null;
  try {
    verified = await verifier.verify({ compact_jwt: compactJwt, expected_audience: audience });
  } catch {
    return refuseIdentity("VERIFIER_THREW");
  }
  if (!verified || verified.audience !== audience || verified.actor.verified_server_side !== true
      || !roleAllowedForAudience(verified.actor.role, audience)) {
    return refuseIdentity("VERIFIER_REJECTED");
  }
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
