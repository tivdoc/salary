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

export const DURABLE_PRODUCT_ACTOR_SESSION = Symbol("tivdoc.durable-product-actor-session.v0.10.2");

export type DurableProductActorSessionBinding = Readonly<{
  session_id: string;
  token_id: string;
  rotation_counter: number;
  reviewer_organization_id: string | null;
  issuer: string;
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
    }),
  });
  return Object.freeze(actor) as DurableSessionBoundActor<TActor>;
}

export function durableProductActorSession(actor: VerifiedActor): DurableProductActorSessionBinding | null {
  const value = (actor as Partial<DurableSessionBoundActor>)[DURABLE_PRODUCT_ACTOR_SESSION];
  return value && typeof value === "object" ? value : null;
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
): Promise<VerifiedProductIdentity | null> {
  if (IDENTITY_SPOOF_HEADERS.some((header) => request.headers.has(header))) return null;
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
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
  return role !== "anonymous" && role !== "customer_owner";
}
