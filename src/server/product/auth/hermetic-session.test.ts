import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HermeticSessionManager, PRODUCT_CSRF_HEADER, PRODUCT_SESSION_COOKIE } from "./hermetic-session.ts";

const SECRET = "local-hermetic-session-secret-32-bytes-minimum";
const OWNER_TICKET = "ticket-owner-a-00000001";
const OPERATOR_TICKET = "ticket-operator-0000001";

// H-1. This was reported as an order-dependent failure under full-suite load.
// It is not order-dependent, and there is no shared state: it was a ~1-in-16
// random flake, present in complete isolation, reproducible without touching
// any other file. See the comment at the tamper site below for the actual
// mechanism. `#configurationFor` also re-reads the real `process.env.NODE_ENV`
// / `VERCEL_ENV` as a second, non-injectable check on top of the constructor's
// `environment` seam; no leak into those two was found (every `vi.stubEnv`
// call in the codebase runs under an `afterEach` that always fires), but they
// are pinned here anyway so this file's outcome can never depend on ambient
// process state, checked or not.
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("VERCEL_ENV", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function environment() {
  return Object.freeze({
    TIVDOC_HERMETIC_MODE: "true",
    TIVDOC_PRODUCT_SESSION_SECRET: SECRET,
    TIVDOC_PRODUCT_HERMETIC_TICKETS_JSON: JSON.stringify({
      [OWNER_TICKET]: { audience: "portal", actor: actor("customer_owner", "owner-a", "tenant-a", ["case-a"]) },
      [OPERATOR_TICKET]: { audience: "operations", actor: actor("legal_reviewer", "operator-a", "tenant-a", ["case-a"]) },
    }),
  });
}

function actor(role: string, actorId: string, tenantId: string, cases: readonly string[]) {
  return { actor_id: actorId, role, tenant_id: tenantId, assigned_case_ids: cases, verified_server_side: true, break_glass_reason: null, break_glass_expires_at: null };
}

function request(path = "/api/portal/session", input: RequestInit = {}) {
  return new Request(`http://127.0.0.1:43123${path}`, input);
}

function cookieValue(serialized: string): string {
  return serialized.split(";", 1)[0].slice(PRODUCT_SESSION_COOKIE.length + 1);
}

describe("hermetic product sessions", () => {
  it("issues a short-lived signed HttpOnly SameSite session from a fixed server ticket", () => {
    const manager = new HermeticSessionManager({ environment: environment(), nodeEnv: "test", now: () => 1_900_000_000 });
    const issued = manager.issue(request(), "portal", OWNER_TICKET);
    expect(issued).not.toBeNull();
    expect(issued?.cookie).toContain("HttpOnly");
    expect(issued?.cookie).toContain("SameSite=Strict");
    expect(issued?.cookie).toContain("Path=/");
    expect(issued?.cookie).toContain("Max-Age=900");
    expect(issued?.csrf_token).toMatch(/^[A-Za-z0-9_-]{32,64}$/);
  });

  it("authenticates only the signed cookie and rejects header, query and unsigned-cookie identity", () => {
    const manager = new HermeticSessionManager({ environment: environment(), nodeEnv: "test", now: () => 1_900_000_000 });
    const issued = manager.issue(request(), "portal", OWNER_TICKET)!;
    const token = cookieValue(issued.cookie);
    const verified = manager.verify(request("/api/portal/cases", { headers: { cookie: `${PRODUCT_SESSION_COOKIE}=${token}` } }), "portal", false);
    expect(verified?.actor).toMatchObject({ actor_id: "owner-a", role: "customer_owner", tenant_id: "tenant-a" });

    expect(manager.verify(request("/api/portal/cases?role=customer_owner", { headers: { cookie: `${PRODUCT_SESSION_COOKIE}=${token}` } }), "portal", false)).toBeNull();
    expect(manager.verify(request("/api/portal/cases", { headers: { "x-tivdoc-role": "customer_owner", cookie: `${PRODUCT_SESSION_COOKIE}=${token}` } }), "portal", false)).toBeNull();
    expect(manager.verify(request("/api/portal/cases", { headers: { cookie: "actor=owner-a; role=customer_owner" } }), "portal", false)).toBeNull();
    // Tamper a character strictly before the token's last one. The signature
    // is a 32-byte HMAC, and 32 mod 3 is 2, so the final base64url character
    // of any such digest carries two bits nothing decodes: `Buffer.from`
    // reconstructs only the meaningful 16 bits of that trailing group and
    // discards the low two bits of the character actually written. Four
    // characters — "w", "x", "y", "z" — share the same meaningful bits at
    // that position, so if the digest's real last character happened to be
    // one of the four and this test swapped it for another one of the four,
    // the decoded signature bytes were identical to the original and
    // verification passed the "tampered" cookie. That is a real signature
    // every run in 16 produces (four picks out of the 64-character alphabet),
    // which read as exactly the "order-dependent under load" symptom this
    // file was flagged for: no shared state, a coin landing wrong often
    // enough to look systemic. Every other position of the token is fully
    // significant — mutating it always changes the decoded bytes — so this
    // tampers the middle character instead, which for tokens of any realistic
    // length lands inside the base64url payload segment, itself hashed as an
    // opaque UTF-8 string rather than decoded, so no such ambiguity exists.
    const tamperIndex = Math.floor(token.length / 2);
    const replacement = token[tamperIndex] === "x" ? "y" : "x";
    const tampered = `${token.slice(0, tamperIndex)}${replacement}${token.slice(tamperIndex + 1)}`;
    expect(manager.verify(request("/api/portal/cases", { headers: { cookie: `${PRODUCT_SESSION_COOKIE}=${tampered}` } }), "portal", false)).toBeNull();
  });

  it("requires same-origin CSRF for mutations and makes logout revoke the session", () => {
    const manager = new HermeticSessionManager({ environment: environment(), nodeEnv: "test", now: () => 1_900_000_000 });
    const issued = manager.issue(request(), "portal", OWNER_TICKET)!;
    const cookie = `${PRODUCT_SESSION_COOKIE}=${cookieValue(issued.cookie)}`;
    const headers = { cookie, origin: "http://127.0.0.1:43123", [PRODUCT_CSRF_HEADER]: issued.csrf_token };
    expect(manager.verify(request("/api/portal/cases/case-a/privacy", { method: "POST", headers }), "portal", true)).not.toBeNull();
    const nextNormalizedRequest = new Request("http://localhost:43123/api/portal/cases/case-a/privacy", {
      method: "POST",
      headers: { ...headers, host: "127.0.0.1:43123" },
    });
    expect(manager.verify(nextNormalizedRequest, "portal", true)).not.toBeNull();
    expect(manager.verify(request("/api/portal/cases/case-a/privacy", { method: "POST", headers: { ...headers, origin: "http://attacker.invalid" } }), "portal", true)).toBeNull();
    expect(manager.verify(new Request("http://localhost:43123/api/portal/cases/case-a/privacy", { method: "POST", headers: { ...headers, host: "attacker.invalid" } }), "portal", true)).toBeNull();
    expect(manager.verify(new Request("http://localhost:43123/api/portal/cases/case-a/privacy", { method: "POST", headers: { ...headers, host: "127.0.0.1:43123/path" } }), "portal", true)).toBeNull();
    expect(manager.verify(request("/api/portal/cases/case-a/privacy", { method: "POST", headers: { ...headers, [PRODUCT_CSRF_HEADER]: "invalid" } }), "portal", true)).toBeNull();
    expect(manager.revoke(request("/api/portal/session", { method: "DELETE", headers }), "portal")).toContain("Max-Age=0");
    expect(manager.verify(request("/api/portal/cases", { headers: { cookie } }), "portal", false)).toBeNull();
  });

  it("rotates a principal to one current session and invalidates the previous cookie", () => {
    const manager = new HermeticSessionManager({ environment: environment(), nodeEnv: "test", now: () => 1_900_000_000 });
    const first = manager.issue(request(), "portal", OWNER_TICKET)!;
    const second = manager.issue(request(), "portal", OWNER_TICKET)!;
    const firstCookie = `${PRODUCT_SESSION_COOKIE}=${cookieValue(first.cookie)}`;
    const secondCookie = `${PRODUCT_SESSION_COOKIE}=${cookieValue(second.cookie)}`;
    expect(manager.verify(request("/api/portal/cases", { headers: { cookie: firstCookie } }), "portal", false)).toBeNull();
    expect(manager.verify(request("/api/portal/cases", { headers: { cookie: secondCookie } }), "portal", false)).not.toBeNull();
  });

  it("rejects expiry, non-loopback hosts, audience confusion, production and preview", () => {
    let now = 1_900_000_000;
    const manager = new HermeticSessionManager({ environment: environment(), nodeEnv: "test", now: () => now });
    const issued = manager.issue(request(), "operations", OPERATOR_TICKET)!;
    const cookie = `${PRODUCT_SESSION_COOKIE}=${cookieValue(issued.cookie)}`;
    expect(manager.verify(request("/api/operations/queue", { headers: { cookie } }), "portal", false)).toBeNull();
    now += 901;
    expect(manager.verify(request("/api/operations/queue", { headers: { cookie } }), "operations", false)).toBeNull();
    expect(manager.issue(new Request("http://example.test/api/portal/session"), "portal", OWNER_TICKET)).toBeNull();
    expect(new HermeticSessionManager({ environment: environment(), nodeEnv: "production" }).issue(request(), "portal", OWNER_TICKET)).toBeNull();
    expect(new HermeticSessionManager({ environment: environment(), nodeEnv: "development" }).issue(request(), "portal", OWNER_TICKET)).toBeNull();
    expect(new HermeticSessionManager({ environment: environment(), nodeEnv: "development", vercelEnv: "preview" }).issue(request(), "portal", OWNER_TICKET)).toBeNull();
  });

  it("cannot use an injectable test seam to override the actual process environment", () => {
    const manager = new HermeticSessionManager({ environment: environment(), nodeEnv: "test" });
    vi.stubEnv("NODE_ENV", "development");
    expect(manager.issue(request(), "portal", OWNER_TICKET)).toBeNull();
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(manager.issue(request(), "portal", OWNER_TICKET)).toBeNull();
    vi.stubEnv("VERCEL_ENV", "");
    expect(manager.issue(request(), "portal", OWNER_TICKET)).not.toBeNull();
  });

  it("rejects malformed ticket catalogs and role/audience mismatches", () => {
    const malformed = { ...environment(), TIVDOC_PRODUCT_HERMETIC_TICKETS_JSON: JSON.stringify({ [OWNER_TICKET]: { audience: "operations", actor: actor("customer_owner", "owner-a", "tenant-a", ["case-a"]) } }) };
    expect(new HermeticSessionManager({ environment: malformed, nodeEnv: "test" }).issue(request(), "operations", OWNER_TICKET)).toBeNull();
    expect(new HermeticSessionManager({ environment: { ...environment(), TIVDOC_PRODUCT_SESSION_SECRET: "short" }, nodeEnv: "test" }).issue(request(), "portal", OWNER_TICKET)).toBeNull();
  });
});
