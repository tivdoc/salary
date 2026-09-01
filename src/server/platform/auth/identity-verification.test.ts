import {
  constants,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import { describe, expect, it } from "vitest";

import { authorize } from "./authorization.ts";
import {
  CryptographicJwtIdentityVerifier,
  type IdentitySessionState,
  type IdentityVerificationKey,
  type JwtIdentityVerificationConfig,
} from "./identity-verification.ts";

const NOW = 1_900_000_000;
const ISSUER = "https://identity.test.invalid";
const AUDIENCE = "operations";
const KEY_ID = "key-00000001";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2_048 });

const CONFIG: JwtIdentityVerificationConfig = Object.freeze({
  issuer: ISSUER,
  audiences: ["operations", "portal"] as const,
  algorithms: ["RS256"] as const,
  clock_skew_seconds: 0,
  max_token_lifetime_seconds: 15 * 60,
});

function claims(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return Object.freeze({
    iss: ISSUER,
    aud: AUDIENCE,
    sub: "actor_00000001",
    iat: NOW - 30,
    nbf: NOW - 30,
    exp: NOW + 300,
    jti: "token_00000001",
    sid: "session_00000001",
    rotation: 0,
    role: "legal_reviewer",
    tenant_id: "tenant_0000001",
    assigned_case_ids: ["case_000000001"],
    reviewer_organization_id: "review_org_00001",
    break_glass_reason: null,
    break_glass_expires_at: null,
    ...overrides,
  });
}

function session(overrides: Partial<IdentitySessionState> = {}): IdentitySessionState {
  return Object.freeze({
    session_id: "session_00000001",
    subject: "actor_00000001",
    status: "active",
    current_token_id: "token_00000001",
    rotation_counter: 0,
    valid_after_epoch: NOW - 60,
    expires_at_epoch: NOW + 600,
    reviewer_organization_id: "review_org_00001",
    ...overrides,
  });
}

function key(overrides: Partial<IdentityVerificationKey> = {}): IdentityVerificationKey {
  return Object.freeze({
    key_id: KEY_ID,
    algorithm: "RS256",
    public_key: publicKey,
    status: "active",
    not_before_epoch: NOW - 3_600,
    expires_at_epoch: NOW + 3_600,
    ...overrides,
  });
}

function compactJwt(payload: Readonly<Record<string, unknown>>, header: Readonly<Record<string, unknown>> = { alg: "RS256", kid: KEY_ID, typ: "JWT" }): string {
  return compactJwtFromJson(JSON.stringify(header), JSON.stringify(payload), privateKey);
}

function compactJwtFromJson(header: string, payload: string, signingKey: KeyObject): string {
  const encodedHeader = Buffer.from(header, "utf8").toString("base64url");
  const encodedPayload = Buffer.from(payload, "utf8").toString("base64url");
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = sign("RSA-SHA256", Buffer.from(signingInput, "ascii"), {
    key: signingKey,
    padding: constants.RSA_PKCS1_PADDING,
  }).toString("base64url");
  return `${signingInput}.${signature}`;
}

function fixture() {
  let currentKey: IdentityVerificationKey | null = key();
  let currentSession: IdentitySessionState | null = session();
  const verifier = new CryptographicJwtIdentityVerifier({
    config: CONFIG,
    keys: { async resolve() { return currentKey; } },
    sessions: { async read() { return currentSession; } },
    now_epoch_seconds: () => NOW,
  });
  return Object.freeze({
    verifier,
    setKey(value: IdentityVerificationKey | null) { currentKey = value; },
    setSession(value: IdentitySessionState | null) { currentSession = value; },
  });
}

describe("canonical cryptographic identity verification", () => {
  it("maps only a valid public-key JWT into the existing VerifiedActor contract", async () => {
    const { verifier } = fixture();
    const verified = await verifier.verify({ compact_jwt: compactJwt(claims()), expected_audience: AUDIENCE });
    expect(verified).toMatchObject({
      issuer: ISSUER,
      audience: AUDIENCE,
      session_id: "session_00000001",
      token_id: "token_00000001",
      rotation_counter: 0,
      reviewer_organization_id: "review_org_00001",
      actor: {
        actor_id: "actor_00000001",
        role: "legal_reviewer",
        tenant_id: "tenant_0000001",
        assigned_case_ids: ["case_000000001"],
        verified_server_side: true,
      },
    });
    expect(authorize(verified!.actor, "review_legal", {
      tenant_id: "tenant_0000001",
      case_id: "case_000000001",
      owner_actor_id: null,
      report_released: false,
      last_content_actor_id: null,
      first_parameter_attestor_id: null,
      worker_scope_actor_id: null,
      break_glass_audit_bound: false,
    }, NOW * 1_000).allowed).toBe(true);
  });

  it("rejects tampering, algorithm confusion, extra or duplicate claims, and revoked keys", async () => {
    const fixtureState = fixture();
    const token = compactJwt(claims());
    const replacement = token.at(-1) === "a" ? "b" : "a";
    expect(await fixtureState.verifier.verify({ compact_jwt: `${token.slice(0, -1)}${replacement}`, expected_audience: AUDIENCE })).toBeNull();
    expect(await fixtureState.verifier.verify({ compact_jwt: compactJwt(claims(), { alg: "none", kid: KEY_ID, typ: "JWT" }), expected_audience: AUDIENCE })).toBeNull();
    expect(await fixtureState.verifier.verify({ compact_jwt: compactJwt({ ...claims(), unexpected: true }), expected_audience: AUDIENCE })).toBeNull();

    const duplicatePayload = JSON.stringify(claims()).replace(`"iss":"${ISSUER}"`, `"iss":"${ISSUER}","iss":"${ISSUER}"`);
    expect(await fixtureState.verifier.verify({ compact_jwt: compactJwtFromJson(JSON.stringify({ alg: "RS256", kid: KEY_ID, typ: "JWT" }), duplicatePayload, privateKey), expected_audience: AUDIENCE })).toBeNull();

    fixtureState.setKey(key({ status: "revoked" }));
    expect(await fixtureState.verifier.verify({ compact_jwt: token, expected_audience: AUDIENCE })).toBeNull();
  });

  it("enforces issuer, exact audience, bounded lifetime, not-before and expiry", async () => {
    const { verifier } = fixture();
    const verify = (payload: Readonly<Record<string, unknown>>, audience = AUDIENCE) => verifier.verify({ compact_jwt: compactJwt(payload), expected_audience: audience });
    expect(await verify(claims({ iss: "https://wrong.test.invalid" }))).toBeNull();
    expect(await verify(claims({ aud: "portal" }))).toBeNull();
    expect(await verify(claims({ exp: NOW }))).toBeNull();
    expect(await verify(claims({ nbf: NOW + 1 }))).toBeNull();
    expect(await verify(claims({ iat: NOW + 1 }))).toBeNull();
    expect(await verify(claims({ iat: NOW - 1_000, nbf: NOW - 1_000 }))).toBeNull();
    expect(await verify(claims(), "unknown-audience")).toBeNull();
  });

  it("invalidates the previous JWT on rotation and denies revoked or expired sessions", async () => {
    const fixtureState = fixture();
    const first = compactJwt(claims());
    expect(await fixtureState.verifier.verify({ compact_jwt: first, expected_audience: AUDIENCE })).not.toBeNull();

    fixtureState.setSession(session({
      current_token_id: "token_00000002",
      rotation_counter: 1,
      valid_after_epoch: NOW,
    }));
    const rotated = compactJwt(claims({
      iat: NOW,
      nbf: NOW,
      jti: "token_00000002",
      rotation: 1,
    }));
    expect(await fixtureState.verifier.verify({ compact_jwt: first, expected_audience: AUDIENCE })).toBeNull();
    expect(await fixtureState.verifier.verify({ compact_jwt: rotated, expected_audience: AUDIENCE })).not.toBeNull();

    fixtureState.setSession(session({ status: "revoked", current_token_id: "token_00000002", rotation_counter: 1, valid_after_epoch: NOW }));
    expect(await fixtureState.verifier.verify({ compact_jwt: rotated, expected_audience: AUDIENCE })).toBeNull();
    fixtureState.setSession(session({ current_token_id: "token_00000002", rotation_counter: 1, valid_after_epoch: NOW, expires_at_epoch: NOW }));
    expect(await fixtureState.verifier.verify({ compact_jwt: rotated, expected_audience: AUDIENCE })).toBeNull();
    fixtureState.setSession(null);
    expect(await fixtureState.verifier.verify({ compact_jwt: rotated, expected_audience: AUDIENCE })).toBeNull();
  });

  it("binds reviewer roles to the authoritative organization and forbids organization claims on other roles", async () => {
    const fixtureState = fixture();
    expect(await fixtureState.verifier.verify({ compact_jwt: compactJwt(claims({ reviewer_organization_id: null })), expected_audience: AUDIENCE })).toBeNull();
    fixtureState.setSession(session({ reviewer_organization_id: "review_org_00002" }));
    expect(await fixtureState.verifier.verify({ compact_jwt: compactJwt(claims()), expected_audience: AUDIENCE })).toBeNull();

    fixtureState.setSession(session({ reviewer_organization_id: null }));
    const owner = claims({ role: "customer_owner", reviewer_organization_id: null });
    expect(await fixtureState.verifier.verify({ compact_jwt: compactJwt(owner), expected_audience: AUDIENCE })).not.toBeNull();
    fixtureState.setSession(session({ reviewer_organization_id: "review_org_00001" }));
    expect(await fixtureState.verifier.verify({ compact_jwt: compactJwt({ ...owner, reviewer_organization_id: "review_org_00001" }), expected_audience: AUDIENCE })).toBeNull();
  });
});
