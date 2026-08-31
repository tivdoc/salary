import { describe, expect, it } from "vitest";
import { HermeticSessionManager, PRODUCT_CSRF_HEADER, PRODUCT_SESSION_COOKIE } from "./hermetic-session.ts";

const SECRET = "local-hermetic-session-secret-32-bytes-minimum";
const OWNER_TICKET = "ticket-owner-a-00000001";
const OPERATOR_TICKET = "ticket-operator-0000001";

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
    expect(manager.verify(request("/api/portal/cases", { headers: { cookie: `${PRODUCT_SESSION_COOKIE}=${token.slice(0, -1)}x` } }), "portal", false)).toBeNull();
  });

  it("requires same-origin CSRF for mutations and makes logout revoke the session", () => {
    const manager = new HermeticSessionManager({ environment: environment(), nodeEnv: "test", now: () => 1_900_000_000 });
    const issued = manager.issue(request(), "portal", OWNER_TICKET)!;
    const cookie = `${PRODUCT_SESSION_COOKIE}=${cookieValue(issued.cookie)}`;
    const headers = { cookie, origin: "http://127.0.0.1:43123", [PRODUCT_CSRF_HEADER]: issued.csrf_token };
    expect(manager.verify(request("/api/portal/cases/case-a/privacy", { method: "POST", headers }), "portal", true)).not.toBeNull();
    expect(manager.verify(request("/api/portal/cases/case-a/privacy", { method: "POST", headers: { ...headers, origin: "http://attacker.invalid" } }), "portal", true)).toBeNull();
    expect(manager.verify(request("/api/portal/cases/case-a/privacy", { method: "POST", headers: { ...headers, [PRODUCT_CSRF_HEADER]: "invalid" } }), "portal", true)).toBeNull();
    expect(manager.revoke(request("/api/portal/session", { method: "DELETE", headers }), "portal")).toContain("Max-Age=0");
    expect(manager.verify(request("/api/portal/cases", { headers: { cookie } }), "portal", false)).toBeNull();
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
    expect(new HermeticSessionManager({ environment: environment(), nodeEnv: "development", vercelEnv: "preview" }).issue(request(), "portal", OWNER_TICKET)).toBeNull();
  });

  it("rejects malformed ticket catalogs and role/audience mismatches", () => {
    const malformed = { ...environment(), TIVDOC_PRODUCT_HERMETIC_TICKETS_JSON: JSON.stringify({ [OWNER_TICKET]: { audience: "operations", actor: actor("customer_owner", "owner-a", "tenant-a", ["case-a"]) } }) };
    expect(new HermeticSessionManager({ environment: malformed, nodeEnv: "test" }).issue(request(), "operations", OWNER_TICKET)).toBeNull();
    expect(new HermeticSessionManager({ environment: { ...environment(), TIVDOC_PRODUCT_SESSION_SECRET: "short" }, nodeEnv: "test" }).issue(request(), "portal", OWNER_TICKET)).toBeNull();
  });
});
