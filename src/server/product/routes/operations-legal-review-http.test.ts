import { describe, expect, it } from "vitest";

import type { InternalOpsApplicationPort } from "../internal-ops/application-port.ts";
import { createOperationsHttpHandler, STABLE_OPERATIONS_COMMAND_SCHEMA } from "./operations-http.ts";

const ACTOR = Object.freeze({ actor_id: "actor.legal_reviewer.001", role: "legal_reviewer" });

function baseService(): InternalOpsApplicationPort {
  return Object.freeze({
    read: async () => Object.freeze({}) as never,
    mutate: async () => Object.freeze({}) as never,
  });
}

function legalReviewService(calls: unknown[], failure?: { code: string }): InternalOpsApplicationPort {
  return Object.freeze({
    ...baseService(),
    readLegalReviewTopics: async (input: unknown) => {
      calls.push({ kind: "topics", input });
      if (failure) throw Object.assign(new Error(failure.code), { code: failure.code });
      return Object.freeze({ readiness: Object.freeze({ topics: Object.freeze([]) }), activation_allowed: false });
    },
    readLegalReviewQueue: async (input: unknown) => {
      calls.push({ kind: "queue", input });
      if (failure) throw Object.assign(new Error(failure.code), { code: failure.code });
      return Object.freeze({ entries: Object.freeze([]), activation_allowed: false });
    },
    submitLegalReviewAction: async (input: unknown) => {
      calls.push({ kind: "action", input });
      if (failure) throw Object.assign(new Error(failure.code), { code: failure.code });
      return Object.freeze({ receipt: Object.freeze({ activation_allowed: false }) });
    },
  }) as unknown as InternalOpsApplicationPort;
}

function sessions(verified: boolean, seen: unknown[] = []) {
  return Object.freeze({
    verify: async (_request: Request, audience: string, csrf: boolean) => {
      seen.push({ audience, csrf });
      return verified ? Object.freeze({ actor: ACTOR, csrf_token: "csrf" }) as never : null;
    },
  });
}

function handler(input: Partial<Parameters<typeof createOperationsHttpHandler>[0]> = {}) {
  return createOperationsHttpHandler({
    enabled: true,
    service: legalReviewService([]),
    sessions: sessions(true),
    ...input,
  });
}

function actionBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    schema_version: STABLE_OPERATIONS_COMMAND_SCHEMA,
    idempotency_key: "idem.ui.001",
    occurred_at: "2026-01-02T03:04:05.000Z",
    packet: { packet_id: "LRP:a", packet_sha256: "a".repeat(64) },
    action: { action_id: "LRA:a", decision: "claim" },
    ...overrides,
  });
}

function post(body: string, headers: Record<string, string> = {}) {
  return new Request("https://internal.invalid/api/operations/legal-review/actions", {
    method: "POST", body, headers: { "content-type": "application/json", ...headers },
  });
}

const GET_QUEUE = () => new Request("https://internal.invalid/api/operations/legal-review/queue");

describe("V0.10.5 nested legal review operations endpoints", () => {
  it("serves the durable queue to a verified session", async () => {
    const calls: unknown[] = [];
    const response = await handler({ service: legalReviewService(calls) })
      .handle(GET_QUEUE(), ["legal-review", "queue"]);
    expect(response.status).toBe(200);
    const body = await response.json() as { data?: { activation_allowed?: boolean } };
    expect(body.data?.activation_allowed).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("requires CSRF verification on the action route and not on the queue route", async () => {
    const seen: unknown[] = [];
    const instance = handler({ sessions: sessions(true, seen) });
    await instance.handle(GET_QUEUE(), ["legal-review", "queue"]);
    await instance.handle(post(actionBody()), ["legal-review", "actions"]);
    expect(seen).toEqual([
      { audience: "operations", csrf: false },
      { audience: "operations", csrf: true },
    ]);
  });

  it("returns not found when the session cannot be verified", async () => {
    const calls: unknown[] = [];
    const instance = handler({ service: legalReviewService(calls), sessions: sessions(false) });
    expect((await instance.handle(GET_QUEUE(), ["legal-review", "queue"])).status).toBe(404);
    expect((await instance.handle(post(actionBody()), ["legal-review", "actions"])).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("returns not found when the service has no durable legal review capability", async () => {
    const instance = handler({ service: baseService() });
    expect((await instance.handle(GET_QUEUE(), ["legal-review", "queue"])).status).toBe(404);
    expect((await instance.handle(post(actionBody()), ["legal-review", "actions"])).status).toBe(404);
  });

  it("returns not found when the operations surface is disabled or unavailable", async () => {
    expect((await handler({ enabled: false }).handle(GET_QUEUE(), ["legal-review", "queue"])).status).toBe(404);
    expect((await handler({ service: null }).handle(GET_QUEUE(), ["legal-review", "queue"])).status).toBe(404);
  });

  it("rejects an unknown nested path and a wrong method", async () => {
    const instance = handler();
    expect((await instance.handle(GET_QUEUE(), ["legal-review", "unknown"])).status).toBe(404);
    expect((await instance.handle(post(actionBody()), ["legal-review", "queue"])).status).toBe(404);
    const getActions = new Request("https://internal.invalid/api/operations/legal-review/actions");
    expect((await instance.handle(getActions, ["legal-review", "actions"])).status).toBe(404);
  });

  it("rejects a malformed action payload before reaching the service", async () => {
    const calls: unknown[] = [];
    const instance = handler({ service: legalReviewService(calls) });
    for (const body of [
      actionBody({ schema_version: "wrong" }),
      actionBody({ packet: "not-an-object" }),
      actionBody({ action: [] }),
      actionBody({ idempotency_key: 7 }),
      actionBody({ occurred_at: null }),
      "not json",
    ]) {
      const response = await instance.handle(post(body), ["legal-review", "actions"]);
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    expect(calls).toHaveLength(0);
  });

  it("rejects an out-of-range queue limit", async () => {
    const calls: unknown[] = [];
    const instance = handler({ service: legalReviewService(calls) });
    for (const limit of ["0", "501", "abc"]) {
      const request = new Request(`https://internal.invalid/api/operations/legal-review/queue?limit=${limit}`);
      expect((await instance.handle(request, ["legal-review", "queue"])).status).toBeGreaterThanOrEqual(400);
    }
    expect(calls).toHaveLength(0);
  });

  it("surfaces a durable conflict without retrying it", async () => {
    const calls: unknown[] = [];
    const instance = handler({ service: legalReviewService(calls, { code: "OPS_REVISION_CONFLICT" }) });
    const response = await instance.handle(post(actionBody()), ["legal-review", "actions"]);
    expect(response.status).toBeGreaterThanOrEqual(400);
    const body = await response.json() as { code?: string; retryable?: boolean };
    expect(body.code).toBe("OPS_REVISION_CONFLICT");
    expect(body.retryable).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("passes the verified actor and correlation id to the durable service", async () => {
    const calls: { kind: string; input: { actor?: unknown; correlation_id?: string } }[] = [];
    const instance = handler({ service: legalReviewService(calls as never) });
    const request = new Request("https://internal.invalid/api/operations/legal-review/queue", {
      headers: { "x-correlation-id": "ops:legal-review-001" },
    });
    await instance.handle(request, ["legal-review", "queue"]);
    expect(calls[0]?.input.actor).toEqual(ACTOR);
    expect(calls[0]?.input.correlation_id).toBe("ops:legal-review-001");
  });
  it("serves the seven-topic readiness dashboard without CSRF", async () => {
    const calls: { kind: string }[] = [];
    const seen: unknown[] = [];
    const instance = handler({ service: legalReviewService(calls as never), sessions: sessions(true, seen) });
    const request = new Request("https://internal.invalid/api/operations/legal-review/topics");
    const response = await instance.handle(request, ["legal-review", "topics"]);
    expect(response.status).toBe(200);
    const body = await response.json() as { data?: { activation_allowed?: boolean } };
    expect(body.data?.activation_allowed).toBe(false);
    expect(calls[0]?.kind).toBe("topics");
    expect(seen).toEqual([{ audience: "operations", csrf: false }]);
  });
});
