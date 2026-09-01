import { describe, expect, it, vi } from "vitest";
import { HermeticSessionManager, PRODUCT_CSRF_HEADER } from "../auth/hermetic-session.ts";
import type { CustomerPortalApplicationPort } from "../customer-portal/repository.ts";
import { createHarness, seedEvidenceAndReport } from "../customer-portal/test-fixtures.ts";
import { createPortalHttpHandler } from "./portal-http.ts";

const SECRET = "local-portal-session-secret-32-bytes-minimum";
const OWNER_A_TICKET = "portal-owner-a-00000001";
const OWNER_B_TICKET = "portal-owner-b-00000001";

function portalHarness() {
  const canonical = createHarness();
  const environment = {
    TIVDOC_HERMETIC_MODE: "true",
    TIVDOC_PRODUCT_SESSION_SECRET: SECRET,
    TIVDOC_PRODUCT_HERMETIC_TICKETS_JSON: JSON.stringify({
      [OWNER_A_TICKET]: { audience: "portal", actor: canonical.ownerA },
      [OWNER_B_TICKET]: { audience: "portal", actor: canonical.ownerB },
    }),
  };
  const sessions = new HermeticSessionManager({ environment, nodeEnv: "test", now: () => 1_893_456_000 });
  const issue = (ticket: string) => sessions.issue(new Request("http://127.0.0.1:42001/api/portal/session"), "portal", ticket)!;
  const ownerA = issue(OWNER_A_TICKET);
  const ownerB = issue(OWNER_B_TICKET);
  return {
    ...canonical,
    sessions,
    handler: createPortalHttpHandler({ enabled: true, service: canonical.service, sessions }),
    ownerA: { cookie: ownerA.cookie.split(";", 1)[0], csrf: ownerA.csrf_token },
    ownerB: { cookie: ownerB.cookie.split(";", 1)[0], csrf: ownerB.csrf_token },
  };
}

function request(path: string, identity?: Readonly<{ cookie: string; csrf: string }>, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://127.0.0.1:42001/api/portal/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(identity ? { cookie: identity.cookie } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json", origin: "http://127.0.0.1:42001", [PRODUCT_CSRF_HEADER]: identity?.csrf ?? "" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("stable portal HTTP boundary", () => {
  it("is hard 404 while disabled, unwired or unauthenticated", async () => {
    const active = portalHarness();
    const disabled = createPortalHttpHandler({ enabled: false, service: null, sessions: new HermeticSessionManager({ environment: {}, nodeEnv: "test" }) });
    expect((await disabled.handle(request("cases"), ["cases"])).status).toBe(404);
    expect((await active.handler.handle(request("cases"), ["cases"])).status).toBe(404);
  });

  it("lists and reads only the signed session owner's case with indistinguishable cross-owner 404", async () => {
    const { handler, ownerA, ownerB } = portalHarness();
    const list = await handler.handle(request("cases", ownerA), ["cases"]);
    expect(list.status).toBe(200);
    expect((await list.json()).cases.map((item: { case_id: string }) => item.case_id)).toEqual(["synthetic-case-a"]);
    expect((await handler.handle(request("cases/synthetic-case-a", ownerB), ["cases", "synthetic-case-a"])).status).toBe(404);
    expect((await handler.handle(request("cases/synthetic-case-a", ownerA, undefined, { "x-tivdoc-owner-id": "synthetic-owner-b" }), ["cases", "synthetic-case-a"])).status).toBe(404);
  });

  it("awaits a durable-style asynchronous application port without weakening concealment", async () => {
    const active = portalHarness();
    const service = new Proxy(active.service, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function"
          ? async (...args: unknown[]) => Reflect.apply(value, target, args)
          : value;
      },
    }) as CustomerPortalApplicationPort;
    const handler = createPortalHttpHandler({ enabled: true, service, sessions: active.sessions });
    const list = await handler.handle(request("cases", active.ownerA), ["cases"]);
    expect(list.status).toBe(200);
    expect((await list.json()).cases).toHaveLength(1);
    expect((await handler.handle(
      request("cases/synthetic-case-a", active.ownerB),
      ["cases", "synthetic-case-a"],
    )).status).toBe(404);
  });

  it("requires revision, idempotency and CSRF for clarification mutation", async () => {
    const { handler, ownerA, service, operator } = portalHarness();
    service.recordConsent({ actor_id: "synthetic-owner-a", role: "customer_owner", tenant_id: "synthetic-tenant-a", assigned_case_ids: ["synthetic-case-a"], verified_server_side: true, break_glass_reason: null, break_glass_expires_at: null }, { case_id: "synthetic-case-a", consent_version: "consent-1", terms_version: "terms-1", granted: true, idempotency_key: "consent-seed-0001" });
    const [task] = service.requestHumanClarification(operator, "synthetic-case-a", [{ fact_path: "work.regular_hours", status: "conflicted", fact_ids: ["fact-1"], state_sha256: "f".repeat(64) }]);
    const path = `cases/synthetic-case-a/clarifications/${task.task_id}/answers`;
    const encodedTaskId = encodeURIComponent(task.task_id);
    const body = { expected_revision: 2, question_version: task.question_version, value: "synthetic answer", explicit_confirmation: true, consent_version: "consent-1", terms_version: "terms-1", idempotency_key: "answer-http-0001" };
    expect((await handler.handle(request(path, { ...ownerA, csrf: "wrong" }, body), ["cases", "synthetic-case-a", "clarifications", task.task_id, "answers"])).status).toBe(404);
    expect((await handler.handle(request(path, ownerA, { ...body, expected_revision: 1 }), ["cases", "synthetic-case-a", "clarifications", task.task_id, "answers"])).status).toBe(409);
    const first = await handler.handle(request(path, ownerA, body), ["cases", "synthetic-case-a", "clarifications", encodedTaskId, "answers"]);
    const replay = await handler.handle(request(path, ownerA, body), ["cases", "synthetic-case-a", "clarifications", task.task_id, "answers"]);
    expect(first.status).toBe(200);
    expect((await replay.json()).idempotent_replay).toBe(true);
    expect((await handler.handle(request(path, ownerA, { ...body, value: "changed" }), ["cases", "synthetic-case-a", "clarifications", task.task_id, "answers"])).status).toBe(409);
  });

  it("returns the exact stored report bytes by digest and denies another owner", async () => {
    const { handler, ownerA, ownerB, repository } = portalHarness();
    const report = seedEvidenceAndReport(repository, { edition: "full_reviewed_report" });
    const grantResponse = await handler.handle(request(`cases/synthetic-case-a/reports/${report.report_id}/grants`, ownerA, { expected_revision: 2 }), ["cases", "synthetic-case-a", "reports", report.report_id, "grants"]);
    expect(grantResponse.status).toBe(200);
    const { grant } = await grantResponse.json();
    const downloaded = await handler.handle(request("reports/download", ownerA, grant), ["reports", "download"]);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("x-tivdoc-artifact-sha256")).toBe(report.artifact_sha256);
    expect(Buffer.from(await downloaded.arrayBuffer()).toString("utf8")).toContain("synthetic-pdf-artifact");
    expect((await handler.handle(request("reports/download", ownerB, grant), ["reports", "download"])).status).toBe(404);
  });

  it("records privacy requests idempotently and rejects stale revisions", async () => {
    const { handler, ownerA } = portalHarness();
    const path = "cases/synthetic-case-a/privacy";
    const body = { expected_revision: 2, request_kind: "data_export", idempotency_key: "privacy-http-0001" };
    const first = await handler.handle(request(path, ownerA, body), ["cases", "synthetic-case-a", "privacy"]);
    const replay = await handler.handle(request(path, ownerA, body), ["cases", "synthetic-case-a", "privacy"]);
    expect(first.status).toBe(200);
    expect((await replay.json()).idempotent_replay).toBe(true);
    expect((await handler.handle(request(path, ownerA, { ...body, expected_revision: 1 }), ["cases", "synthetic-case-a", "privacy"])).status).toBe(409);
  });

  it("passes the expected revision into the mutation port instead of a separate projection read", async () => {
    const active = portalHarness();
    const projection = vi.spyOn(active.service, "getCaseProjection");
    let receivedRevision: number | undefined;
    const service = new Proxy(active.service, {
      get(target, property, receiver) {
        if (property === "createPrivacyRequest") {
          return async (...args: Parameters<typeof target.createPrivacyRequest>) => {
            receivedRevision = args[1].expected_revision;
            return target.createPrivacyRequest(...args);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as CustomerPortalApplicationPort;
    const handler = createPortalHttpHandler({ enabled: true, service, sessions: active.sessions });
    const response = await handler.handle(request("cases/synthetic-case-a/privacy", active.ownerA, {
      expected_revision: 2,
      request_kind: "correction",
      idempotency_key: "privacy-atomic-0001",
    }), ["cases", "synthetic-case-a", "privacy"]);
    expect(response.status).toBe(200);
    expect(receivedRevision).toBe(2);
    expect(projection).not.toHaveBeenCalled();
  });

  it("maps a narrow structural portal error across a bundled runtime boundary", async () => {
    const active = portalHarness();
    const service = new Proxy(active.service, {
      get(target, property, receiver) {
        if (property === "createPrivacyRequest") return () => { throw Object.freeze({ code: "IDEMPOTENCY_KEY_COMMAND_MISMATCH" }); };
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const handler = createPortalHttpHandler({ enabled: true, service, sessions: active.sessions });
    const response = await handler.handle(request("cases/synthetic-case-a/privacy", active.ownerA, {
      expected_revision: 1,
      request_kind: "data_export",
      idempotency_key: "privacy-cross-boundary-0001",
    }), ["cases", "synthetic-case-a", "privacy"]);
    expect(response.status).toBe(409);
  });
});
