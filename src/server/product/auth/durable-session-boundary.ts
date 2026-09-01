import "./server-boundary.ts";

import { timingSafeEqual } from "node:crypto";

import type { IdentityVerificationPort } from "../../platform/auth/identity-verification.ts";
import { internalOpsActorSchema } from "../internal-ops/contracts.ts";
import { authenticateProductIdentity, bindDurableProductActor } from "./identity-session.ts";
import type { ProductAudience, VerifiedProductSession } from "./hermetic-session.ts";
import type { ProductSessionBoundary } from "./runtime.ts";

export const PRODUCT_DURABLE_CSRF_COOKIE = "tivdoc_csrf" as const;
export const PRODUCT_DURABLE_CSRF_HEADER = "x-tivdoc-csrf" as const;

/**
 * Durable, cookie-only session reader. Login/key distribution stays outside this
 * boundary; every request is reverified against the cryptographic verifier and
 * its authoritative PostgreSQL session reader.
 */
export class DurableCryptographicProductSessionBoundary implements ProductSessionBoundary {
  readonly proof_class = "DURABLE_CRYPTOGRAPHIC_SESSION" as const;
  readonly #verifier: IdentityVerificationPort;
  readonly #allowedOrigin: string;

  constructor(input: Readonly<{ verifier: IdentityVerificationPort; allowed_origin: string }>) {
    const origin = exactHttpsOrigin(input.allowed_origin);
    if (!origin) throw new Error("PRODUCT_SESSION_ALLOWED_ORIGIN_INVALID");
    this.#verifier = input.verifier;
    this.#allowedOrigin = origin;
  }

  async verify(request: Request, audience: ProductAudience, requireCsrf: boolean): Promise<VerifiedProductSession | null> {
    const identity = await authenticateProductIdentity(request, audience, this.#verifier);
    if (!identity) return null;
    const actor = internalOpsActorSchema.safeParse(identity.actor);
    if (!actor.success) return null;
    const csrf = singleCookie(request.headers.get("cookie"), PRODUCT_DURABLE_CSRF_COOKIE);
    if (!csrf || !/^[A-Za-z0-9_-]{32,86}$/u.test(csrf)) return null;
    if (requireCsrf && !validMutationCsrf(request, csrf, this.#allowedOrigin)) return null;
    return Object.freeze({
      actor: bindDurableProductActor(Object.freeze({ ...identity, actor: actor.data })),
      audience,
      csrf_token: csrf,
      expires_at_epoch: identity.expires_at_epoch,
    });
  }
}

function exactHttpsOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === ""
      && url.pathname === "/" && url.search === "" && url.hash === ""
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

function singleCookie(raw: string | null, name: string): string | null {
  if (!raw || raw.length > 16_384) return null;
  const matches = raw.split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  return matches.length === 1 ? matches[0].slice(name.length + 1) : null;
}

function validMutationCsrf(request: Request, expected: string, allowedOrigin: string): boolean {
  const supplied = request.headers.get(PRODUCT_DURABLE_CSRF_HEADER);
  if (!supplied || supplied.length !== expected.length) return false;
  const left = Buffer.from(supplied, "utf8");
  const right = Buffer.from(expected, "utf8");
  if (left.byteLength !== right.byteLength || !timingSafeEqual(left, right)) return false;
  if (request.headers.get("origin") !== allowedOrigin) return false;
  const fetchSite = request.headers.get("sec-fetch-site");
  return fetchSite === null || fetchSite === "same-origin";
}
