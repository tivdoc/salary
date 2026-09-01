import { describe, expect, it } from "vitest";

import type {
  IdentityVerificationInput,
  IdentityVerificationPort,
  VerifiedIdentity,
} from "../../platform/auth/identity-verification.ts";
import {
  authenticateProductIdentity,
  bindDurableProductActor,
  durableProductActorSession,
  durableProductIdentityFromActor,
  PRODUCT_IDENTITY_COOKIE,
  type VerifiedProductIdentity,
} from "./identity-session.ts";

const COMPACT_JWT = [
  "eyJhbGciOiJSUzI1NiJ9",
  "eyJzdWIiOiJhY3RvciJ9",
  "c2lnbmF0dXJl",
].join(".");

function identity(role: VerifiedIdentity["actor"]["role"] = "legal_reviewer"): VerifiedIdentity {
  return Object.freeze({
    actor: Object.freeze({
      actor_id: "actor_00000001",
      role,
      tenant_id: "tenant_0000001",
      assigned_case_ids: Object.freeze(["case_000000001"]),
      verified_server_side: true,
      break_glass_reason: null,
      break_glass_expires_at: null,
    }),
    issuer: "issuer_00000001",
    audience: "operations",
    session_id: "session_00000001",
    token_id: "token_00000001",
    rotation_counter: 0,
    reviewer_organization_id: role === "legal_reviewer" ? "review_org_00001" : null,
    issued_at_epoch: 1_900_000_000,
    expires_at_epoch: 1_900_000_300,
  });
}

function request(path = "/operations", headers: HeadersInit = {}): Request {
  return new Request(`https://tivdoc.test${path}`, { headers });
}

function verifier(result: VerifiedIdentity | null = identity()) {
  const calls: IdentityVerificationInput[] = [];
  const port: IdentityVerificationPort = {
    async verify(input) {
      calls.push(input);
      return result;
    },
  };
  return Object.freeze({ port, calls });
}

function productIdentity(): VerifiedProductIdentity {
  const verified = identity("customer_owner");
  return Object.freeze({ ...verified, audience: "portal", product_audience: "portal" });
}

describe("canonical product identity boundary", () => {
  it("passes only the exact host cookie to the cryptographic port", async () => {
    const fixture = verifier();
    const verified = await authenticateProductIdentity(request("/operations", {
      cookie: `preference=compact; ${PRODUCT_IDENTITY_COOKIE}=${COMPACT_JWT}`,
    }), "operations", fixture.port);
    expect(verified?.actor.role).toBe("legal_reviewer");
    expect(verified?.product_audience).toBe("operations");
    expect(fixture.calls).toEqual([{ compact_jwt: COMPACT_JWT, expected_audience: "operations" }]);
  });

  it("rejects header, query, loose, unsigned and duplicate-cookie identities before verification", async () => {
    const fixture = verifier();
    expect(await authenticateProductIdentity(request("/operations", { authorization: `Bearer ${COMPACT_JWT}`, cookie: `${PRODUCT_IDENTITY_COOKIE}=${COMPACT_JWT}` }), "operations", fixture.port)).toBeNull();
    expect(await authenticateProductIdentity(request(`/operations?token=${COMPACT_JWT}`, { cookie: `${PRODUCT_IDENTITY_COOKIE}=${COMPACT_JWT}` }), "operations", fixture.port)).toBeNull();
    expect(await authenticateProductIdentity(request("/operations", { cookie: "actor=actor_00000001; role=legal_reviewer" }), "operations", fixture.port)).toBeNull();
    expect(await authenticateProductIdentity(request("/operations", { cookie: `${PRODUCT_IDENTITY_COOKIE}=actor_00000001` }), "operations", fixture.port)).toBeNull();
    expect(await authenticateProductIdentity(request("/operations", { cookie: `${PRODUCT_IDENTITY_COOKIE}=${COMPACT_JWT}; ${PRODUCT_IDENTITY_COOKIE}=${COMPACT_JWT}` }), "operations", fixture.port)).toBeNull();
    expect(await authenticateProductIdentity(new Request("http://tivdoc.test/operations", { headers: { cookie: `${PRODUCT_IDENTITY_COOKIE}=${COMPACT_JWT}` } }), "operations", fixture.port)).toBeNull();
    expect(fixture.calls).toHaveLength(0);
  });

  it("fails closed on verifier errors and audience/role confusion", async () => {
    const owner = verifier(identity("customer_owner"));
    expect(await authenticateProductIdentity(request("/operations", { cookie: `${PRODUCT_IDENTITY_COOKIE}=${COMPACT_JWT}` }), "operations", owner.port)).toBeNull();
    const worker = verifier(identity("scoped_background_worker"));
    expect(await authenticateProductIdentity(request("/operations", { cookie: `${PRODUCT_IDENTITY_COOKIE}=${COMPACT_JWT}` }), "operations", worker.port)).toBeNull();
    const wrongAudience = verifier(Object.freeze({ ...identity(), audience: "portal" }));
    expect(await authenticateProductIdentity(request("/operations", { cookie: `${PRODUCT_IDENTITY_COOKIE}=${COMPACT_JWT}` }), "operations", wrongAudience.port)).toBeNull();
    const throwing: IdentityVerificationPort = { async verify() { throw new Error("provider unavailable"); } };
    expect(await authenticateProductIdentity(request("/operations", { cookie: `${PRODUCT_IDENTITY_COOKIE}=${COMPACT_JWT}` }), "operations", throwing)).toBeNull();
  });

  it("keeps HTTP disabled by default and binds the exception to one exact local origin", async () => {
    const headers = { cookie: `${PRODUCT_IDENTITY_COOKIE}=${COMPACT_JWT}` };
    const disabled = verifier();
    expect(await authenticateProductIdentity(
      new Request("http://127.0.0.1:43191/operations", { headers }),
      "operations",
      disabled.port,
      { allowed_origin: "http://127.0.0.1:43191", environment: {} },
    )).toBeNull();
    expect(disabled.calls).toHaveLength(0);

    const enabled = verifier();
    expect(await authenticateProductIdentity(
      new Request("http://127.0.0.1:43191/operations", { headers }),
      "operations",
      enabled.port,
      {
        allowed_origin: "http://127.0.0.1:43191",
        allow_local_loopback_http: true,
        environment: {},
      },
    )).toMatchObject({ product_audience: "operations" });
    expect(enabled.calls).toHaveLength(1);

    for (const url of [
      "http://localhost:43191/operations",
      "http://127.0.0.1:43192/operations",
      "http://192.168.1.8:43191/operations",
    ]) {
      expect(await authenticateProductIdentity(new Request(url, { headers }), "operations", enabled.port, {
        allowed_origin: "http://127.0.0.1:43191",
        allow_local_loopback_http: true,
        environment: {},
      })).toBeNull();
    }
    expect(enabled.calls).toHaveLength(1);
  });

  it("rejects local HTTP in a Vercel environment before verification", async () => {
    const fixture = verifier();
    expect(await authenticateProductIdentity(
      new Request("http://localhost:43191/operations", {
        headers: { cookie: `${PRODUCT_IDENTITY_COOKIE}=${COMPACT_JWT}` },
      }),
      "operations",
      fixture.port,
      {
        allowed_origin: "http://localhost:43191",
        allow_local_loopback_http: true,
        environment: { VERCEL: "1" },
      },
    )).toBeNull();
    expect(fixture.calls).toHaveLength(0);
  });

  it("reconstitutes only the exact verified audience and keeps session coordinates non-enumerable", () => {
    const expected = productIdentity();
    const actor = bindDurableProductActor(expected);
    const restored = durableProductIdentityFromActor(actor, "portal");
    expect(restored).toMatchObject({
      issuer: expected.issuer,
      audience: "portal",
      product_audience: "portal",
      session_id: expected.session_id,
      token_id: expected.token_id,
      rotation_counter: expected.rotation_counter,
      issued_at_epoch: expected.issued_at_epoch,
      expires_at_epoch: expected.expires_at_epoch,
    });
    expect(durableProductActorSession(actor)).toMatchObject({ audience: "portal" });
    expect(JSON.stringify(actor)).not.toContain(expected.session_id);
    expect(() => durableProductIdentityFromActor(actor, "operations"))
      .toThrow("DURABLE_PRODUCT_SESSION_AUDIENCE_MISMATCH");
    expect(() => durableProductIdentityFromActor(expected.actor, "portal"))
      .toThrow("DURABLE_PRODUCT_SESSION_BINDING_REQUIRED");
  });
});
