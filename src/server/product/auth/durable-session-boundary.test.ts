import { describe, expect, it } from "vitest";

import type { IdentityVerificationPort, VerifiedIdentity } from "../../platform/auth/identity-verification.ts";
import { durableProductActorSession, PRODUCT_IDENTITY_COOKIE } from "./identity-session.ts";
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

function request(input: Readonly<{ csrf?: string; origin?: string; spoof?: boolean; url?: string }> = {}): Request {
  const csrf = input.csrf ?? CSRF;
  return new Request(input.url ?? "https://local.tivdoc.invalid/api/portal/cases", {
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
    const session = await boundary.verify(request(), "portal", true);
    expect(session).toEqual({
      actor: IDENTITY.actor,
      audience: "portal",
      csrf_token: CSRF,
      expires_at_epoch: IDENTITY.expires_at_epoch,
    });
    expect(durableProductActorSession(session!.actor)).toEqual({
      session_id: IDENTITY.session_id,
      token_id: IDENTITY.token_id,
      rotation_counter: IDENTITY.rotation_counter,
      reviewer_organization_id: null,
      issuer: IDENTITY.issuer,
      audience: IDENTITY.audience,
      issued_at_epoch: IDENTITY.issued_at_epoch,
      expires_at_epoch: IDENTITY.expires_at_epoch,
    });
    expect(JSON.stringify(session!.actor)).not.toContain(IDENTITY.session_id);
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
    expect(() => new DurableCryptographicProductSessionBoundary({ verifier: verifier(), allowed_origin: "http://127.0.0.1:43191" }))
      .toThrow("PRODUCT_SESSION_ALLOWED_ORIGIN_INVALID");
    expect(() => new DurableCryptographicProductSessionBoundary({ verifier: verifier(), allowed_origin: "https://local.tivdoc.invalid/path" }))
      .toThrow("PRODUCT_SESSION_ALLOWED_ORIGIN_INVALID");
  });

  it("permits only an explicitly enabled exact local loopback HTTP origin", async () => {
    const boundary = new DurableCryptographicProductSessionBoundary({
      verifier: verifier(),
      allowed_origin: "http://127.0.0.1:43191",
      allow_local_loopback_http: true,
      environment: {},
    });
    const session = await boundary.verify(request({
      url: "http://127.0.0.1:43191/api/portal/cases",
      origin: "http://127.0.0.1:43191",
    }), "portal", true);
    expect(boundary.request_origin).toBe("http://127.0.0.1:43191");
    expect(session?.actor.actor_id).toBe(IDENTITY.actor.actor_id);

    await expect(boundary.verify(request({
      url: "http://localhost:43191/api/portal/cases",
      origin: "http://localhost:43191",
    }), "portal", true)).resolves.toBeNull();

    const localhostBoundary = new DurableCryptographicProductSessionBoundary({
      verifier: verifier(),
      allowed_origin: "http://localhost:43191",
      allow_local_loopback_http: true,
      environment: {},
    });
    await expect(localhostBoundary.verify(request({
      url: "http://localhost:43191/api/portal/cases",
      origin: "http://localhost:43191",
    }), "portal", true)).resolves.toMatchObject({ audience: "portal" });
  });

  it("never enables remote, lookalike or Vercel HTTP origins", () => {
    for (const allowedOrigin of [
      "http://192.168.1.8:43191",
      "http://localhost.example.invalid:43191",
      "http://[::1]:43191",
    ]) {
      expect(() => new DurableCryptographicProductSessionBoundary({
        verifier: verifier(),
        allowed_origin: allowedOrigin,
        allow_local_loopback_http: true,
        environment: {},
      })).toThrow("PRODUCT_SESSION_ALLOWED_ORIGIN_INVALID");
    }
    expect(() => new DurableCryptographicProductSessionBoundary({
      verifier: verifier(),
      allowed_origin: "http://localhost:43191",
      allow_local_loopback_http: true,
      environment: { VERCEL_ENV: "preview" },
    })).toThrow("PRODUCT_SESSION_ALLOWED_ORIGIN_INVALID");
  });
});
