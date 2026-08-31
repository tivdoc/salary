import { describe, expect, it } from "vitest";
import { HermeticSessionManager, PRODUCT_CSRF_HEADER } from "../auth/hermetic-session.ts";
import { disabledInternalOpsFlags } from "../internal-ops/flags.ts";
import { InternalOpsService } from "../internal-ops/service.ts";
import { createSyntheticOpsFixture } from "../internal-ops/synthetic-test-fixture.ts";
import { createOperationsHttpHandler, STABLE_OPERATIONS_COMMAND_SCHEMA } from "./operations-http.ts";

const SECRET = "local-operations-session-secret-32-bytes-minimum";
const TICKET = "operations-reviewer-00001";
const HASH = "a".repeat(64);

function harness(role = "fact_reviewer") {
  const fixture = createSyntheticOpsFixture("test");
  const flags = Object.freeze({ ...disabledInternalOpsFlags(), TIVDOC_SYNTHETIC_OPS_ENABLED: true });
  const service = new InternalOpsService({ ports: fixture.ports, flags, now: () => "2030-02-01T10:00:00.000Z" });
  const environment = {
    TIVDOC_HERMETIC_MODE: "true",
    TIVDOC_PRODUCT_SESSION_SECRET: SECRET,
    TIVDOC_PRODUCT_HERMETIC_TICKETS_JSON: JSON.stringify({ [TICKET]: { audience: "operations", actor: { actor_id: `actor-${role}`, role, tenant_id: "syn-tenant-001", assigned_case_ids: [fixture.caseId], verified_server_side: true, break_glass_reason: null, break_glass_expires_at: null } } }),
  };
  const sessions = new HermeticSessionManager({ environment, nodeEnv: "test", now: () => 1_900_000_000 });
  const issued = sessions.issue(new Request("http://127.0.0.1:41001/api/operations/session"), "operations", TICKET)!;
  const cookie = issued.cookie.split(";", 1)[0];
  const handler = createOperationsHttpHandler({ enabled: true, service, sessions });
  return { fixture, handler, cookie, csrf: issued.csrf_token };
}

function request(path: string, input: Readonly<{ cookie?: string; csrf?: string; body?: unknown; headers?: Record<string, string> }> = {}) {
  const method = input.body === undefined ? "GET" : "POST";
  return new Request(`http://127.0.0.1:41001/api/operations/${path}`, {
    method,
    headers: {
      ...(input.cookie ? { cookie: input.cookie } : {}),
      ...(input.body === undefined ? {} : { "content-type": "application/json", origin: "http://127.0.0.1:41001" }),
      ...(input.csrf ? { [PRODUCT_CSRF_HEADER]: input.csrf } : {}),
      ...input.headers,
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
}

function command(action: string, caseId: string, expectedRevision: number, extra: Record<string, unknown>, key = `operation-${action}-0001`) {
  return { schema_version: STABLE_OPERATIONS_COMMAND_SCHEMA, command_id: `command-${action}-0001`, idempotency_key: key, expected_revision: expectedRevision, reason: "synthetic operator decision", payload: { action, case_id: caseId, ...extra } };
}

describe("stable operations HTTP boundary", () => {
  it("returns a hard non-disclosing 404 while disabled, unwired or unauthenticated", async () => {
    const { handler } = harness();
    const disabled = createOperationsHttpHandler({ enabled: false, service: null, sessions: new HermeticSessionManager({ environment: {}, nodeEnv: "test" }) });
    expect((await disabled.handle(request("queue"), ["queue"])).status).toBe(404);
    expect((await handler.handle(request("queue"), ["queue"])).status).toBe(404);
  });

  it("uses the signed session actor for canonical role and case-scope checks", async () => {
    const { fixture, handler, cookie, csrf } = harness("fact_reviewer");
    const queue = await handler.handle(request("queue", { cookie }), ["queue"]);
    expect(queue.status).toBe(200);
    expect((await queue.json()).data.items[0].case_id).toBe(fixture.caseId);
    const forbidden = await handler.handle(request(`cases/${fixture.caseId}/payment/reconcile`, { cookie, csrf, body: command("payment_reconcile", fixture.caseId, 4, { payment_reference_sha256: HASH }) }), ["cases", fixture.caseId, "payment", "reconcile"]);
    expect(forbidden.status).toBe(403);
    expect(fixture.mutationCount()).toBe(0);
  });

  it("requires CSRF and preserves canonical revision and idempotency semantics", async () => {
    const { fixture, handler, cookie, csrf } = harness("fact_reviewer");
    const path = `cases/${fixture.caseId}/facts/resolve`;
    const payload = command("fact_resolution", fixture.caseId, 4, { facts_snapshot_sha256: HASH, fact_ids: ["syn-fact-001"], decision: "confirmed" });
    expect((await handler.handle(request(path, { cookie, body: payload }), ["cases", fixture.caseId, "facts", "resolve"])).status).toBe(404);
    expect(fixture.mutationCount()).toBe(0);

    const stale = command("fact_resolution", fixture.caseId, 3, { facts_snapshot_sha256: HASH, fact_ids: ["syn-fact-001"], decision: "confirmed" });
    expect((await handler.handle(request(path, { cookie, csrf, body: stale }), ["cases", fixture.caseId, "facts", "resolve"])).status).toBe(409);
    expect(fixture.mutationCount()).toBe(0);

    const first = await handler.handle(request(path, { cookie, csrf, body: payload }), ["cases", fixture.caseId, "facts", "resolve"]);
    const replay = await handler.handle(request(path, { cookie, csrf, body: payload }), ["cases", fixture.caseId, "facts", "resolve"]);
    expect(first.status).toBe(200);
    expect((await replay.json()).data.idempotent_replay).toBe(true);
    expect(fixture.mutationCount()).toBe(1);

    const conflict = { ...payload, reason: "different synthetic operator decision" };
    expect((await handler.handle(request(path, { cookie, csrf, body: conflict }), ["cases", fixture.caseId, "facts", "resolve"])).status).toBe(409);
    expect(fixture.mutationCount()).toBe(1);
  });

  it("rejects client identity and case-path forgery before canonical service execution", async () => {
    const { fixture, handler, cookie } = harness();
    const forged = await handler.handle(request("queue", { cookie, headers: { "x-tivdoc-role": "break_glass_admin" } }), ["queue"]);
    expect(forged.status).toBe(404);
    expect((await handler.handle(request("../audit", { cookie }), ["..", "audit"])).status).toBe(404);
    expect(fixture.mutationCount()).toBe(0);
  });
});
