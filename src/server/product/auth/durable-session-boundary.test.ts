import { describe, expect, it } from "vitest";

import type { IdentityVerificationPort, VerifiedIdentity } from "../../platform/auth/identity-verification.ts";
import { PRODUCT_IDENTITY_COOKIE } from "./identity-session.ts";
import { DurableCryptographicProductSessionBoundary } from "./durable-session-boundary.ts";

const CSRF = "csrf_token_0000000000000000000000000001";
const IDENTITY: VerifiedIdentity = Object.freeze({
  actor: Object.freeze({
    actor_id: "owner.actor.001",
    role: "customer_owner",
    tenant_id: "tenant.001",
    assigned_case_ids: Object.freeze(["case.001"]),
    verified_server_side: true,
    break_glass_reason: null,
    break_glass_expires_at: null,
  }),
  issuer: "https://issuer.test.invalid",
  audience: "portal",
  session_id: "session.001",
  token_id: "token.001",
  rotation_counter: 4,
  reviewer_organization_id: null,
  issued_at_epoch: 2_000_000_000,
  expires_at_epoch: 2_000_000_600,
});

function verifier(identity: VerifiedIdentity | null = IDENTITY): IdentityVerificationPort {
  return Object.freeze({ async verify() { return identity; } });
}

function request(input: Readonly<{ csrf?: string; origin?: string; spoof?: boolean }> = {}): Request {
  const csrf = input.csrf ?? CSRF;
  return new Request("https://local.tivdoc.invalid/api/portal/cases", {
    method: "POST",
    headers: {
      cookie: `${PRODUCT_IDENTITY_COOKIE}=header.claims.signature; tivdoc_csrf=${CSRF}`,
      "content-type": "application/json",
      origin: input.origin ?? "https://local.tivdoc.invalid",
      "sec-fetch-site": "same-origin",
      "x-tivdoc-csrf": csrf,
      ...(input.spoof ? { "x-user-id": "spoofed.actor" } : {}),
    },
    body: "{}",
  });
}

describe("durable cryptographic product session boundary", () => {
  it("uses the verified durable identity and double-submit CSRF token", async () => {
    const boundary = new DurableCryptographicProductSessionBoundary({
      verifier: verifier(),
      allowed_origin: "https://local.tivdoc.invalid",
    });
    await expect(boundary.verify(request(), "portal", true)).resolves.toEqual({
      actor: IDENTITY.actor,
      audience: "portal",
      csrf_token: CSRF,
      expires_at_epoch: IDENTITY.expires_at_epoch,
    });
  });

  it("fails closed for spoof identity, CSRF mismatch, origin mismatch or absent durable identity", async () => {
    const boundary = new DurableCryptographicProductSessionBoundary({ verifier: verifier(), allowed_origin: "https://local.tivdoc.invalid" });
    await expect(boundary.verify(request({ spoof: true }), "portal", true)).resolves.toBeNull();
    await expect(boundary.verify(request({ csrf: `${CSRF}x` }), "portal", true)).resolves.toBeNull();
    await expect(boundary.verify(request({ origin: "https://other.invalid" }), "portal", true)).resolves.toBeNull();
    const absent = new DurableCryptographicProductSessionBoundary({ verifier: verifier(null), allowed_origin: "https://local.tivdoc.invalid" });
    await expect(absent.verify(request(), "portal", true)).resolves.toBeNull();
  });

  it("rejects non-HTTPS or path-bearing allowed origins", () => {
    expect(() => new DurableCryptographicProductSessionBoundary({ verifier: verifier(), allowed_origin: "http://local.tivdoc.invalid" }))
      .toThrow("PRODUCT_SESSION_ALLOWED_ORIGIN_INVALID");
    expect(() => new DurableCryptographicProductSessionBoundary({ verifier: verifier(), allowed_origin: "https://local.tivdoc.invalid/path" }))
      .toThrow("PRODUCT_SESSION_ALLOWED_ORIGIN_INVALID");
  });
});
