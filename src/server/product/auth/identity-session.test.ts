import { describe, expect, it } from "vitest";

import type {
  IdentityVerificationInput,
  IdentityVerificationPort,
  VerifiedIdentity,
} from "../../platform/auth/identity-verification.ts";
import {
  authenticateProductIdentity,
  PRODUCT_IDENTITY_COOKIE,
} from "./identity-session.ts";

const COMPACT_JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhY3RvciJ9.c2lnbmF0dXJl";

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
    const wrongAudience = verifier(Object.freeze({ ...identity(), audience: "portal" }));
    expect(await authenticateProductIdentity(request("/operations", { cookie: `${PRODUCT_IDENTITY_COOKIE}=${COMPACT_JWT}` }), "operations", wrongAudience.port)).toBeNull();
    const throwing: IdentityVerificationPort = { async verify() { throw new Error("provider unavailable"); } };
    expect(await authenticateProductIdentity(request("/operations", { cookie: `${PRODUCT_IDENTITY_COOKIE}=${COMPACT_JWT}` }), "operations", throwing)).toBeNull();
  });
});
