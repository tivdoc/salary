import { beforeEach, describe, expect, it } from "vitest";

import type { InternalOpsApplicationPort } from "../internal-ops/application-port.ts";
import {
  clearProductNotFoundLog,
  readProductNotFoundLog,
  PRODUCT_NOT_FOUND_REASONS,
} from "./http-common.ts";
import { createOperationsHttpHandler, LEGAL_REVIEW_ROUTES } from "./operations-http.ts";

// V0.10.12. Three unrelated conditions used to produce one indistinguishable
// bare 404, which is what made the legal-review outage impossible to localise
// in flight. The external response must stay identical — a refusal may not
// disclose whether a path, a capability or a session was the problem — while
// the internal reason is distinct for each cause.

const ACTOR = Object.freeze({ actor_id: "actor.legal_reviewer.001", role: "legal_reviewer" });

function baseService(): InternalOpsApplicationPort {
  return Object.freeze({
    read: async () => Object.freeze({}) as never,
    mutate: async () => Object.freeze({}) as never,
  });
}

function legalReviewService(): InternalOpsApplicationPort {
  return Object.freeze({
    ...baseService(),
    readLegalReviewTopics: async () => Object.freeze({ readiness: Object.freeze({ topics: [] }) }),
    readLegalReviewQueue: async () => Object.freeze({ entries: Object.freeze([]) }),
    submitLegalReviewAction: async () => Object.freeze({ receipt: Object.freeze({}) }),
  }) as unknown as InternalOpsApplicationPort;
}

function sessions(verified: boolean) {
  return Object.freeze({
    verify: async () => (verified ? Object.freeze({ actor: ACTOR, csrf_token: "csrf" }) as never : null),
  });
}

const QUEUE = () => new Request("https://internal.invalid/api/operations/legal-review/queue");

async function bodyAndHeaders(response: Response) {
  return {
    status: response.status,
    body: await response.text(),
    headers: [...response.headers.entries()].sort(),
  };
}

describe("V0.10.12 distinguishable 404 causes", () => {
  beforeEach(() => { clearProductNotFoundLog(); });

  it("records a distinct internal reason for each of the four causes", async () => {
    const cases: readonly (readonly [string, Promise<Response>])[] = [
      ["SURFACE_DISABLED", createOperationsHttpHandler({
        enabled: false, service: legalReviewService(), sessions: sessions(true),
      }).handle(QUEUE(), ["legal-review", "queue"])],
      ["SERVICE_ABSENT", createOperationsHttpHandler({
        enabled: true, service: null, sessions: sessions(true),
      }).handle(QUEUE(), ["legal-review", "queue"])],
      ["CAPABILITY_ABSENT", createOperationsHttpHandler({
        enabled: true, service: baseService(), sessions: sessions(true),
      }).handle(QUEUE(), ["legal-review", "queue"])],
      ["PATH_NOT_ROUTED", createOperationsHttpHandler({
        enabled: true, service: legalReviewService(), sessions: sessions(true),
      }).handle(QUEUE(), ["legal-review", "unrouted"])],
      ["SESSION_UNVERIFIED", createOperationsHttpHandler({
        enabled: true, service: legalReviewService(), sessions: sessions(false),
      }).handle(QUEUE(), ["legal-review", "queue"])],
    ];
    const observed: string[] = [];
    const shapes: unknown[] = [];
    for (const [, pending] of cases) shapes.push(await bodyAndHeaders(await pending));
    for (const entry of readProductNotFoundLog()) observed.push(entry.reason);
    expect(observed).toEqual(cases.map(([reason]) => reason));
    expect(new Set(observed).size).toBe(cases.length);
    // One identical external response for every cause.
    expect(new Set(shapes.map((shape) => JSON.stringify(shape))).size).toBe(1);
    expect((shapes[0] as { status: number }).status).toBe(404);
    expect((shapes[0] as { body: string }).body).toBe("");
  });

  it("only records reasons it declares", () => {
    createOperationsHttpHandler({ enabled: false, service: null, sessions: sessions(true) })
      .handle(QUEUE(), ["legal-review", "queue"]);
    for (const entry of readProductNotFoundLog()) {
      expect(PRODUCT_NOT_FOUND_REASONS as readonly string[]).toContain(entry.reason);
    }
  });

  it("never records anything but a code and a timestamp", async () => {
    await createOperationsHttpHandler({ enabled: true, service: baseService(), sessions: sessions(true) })
      .handle(new Request("https://internal.invalid/api/operations/legal-review/queue?limit=7"), ["legal-review", "queue"]);
    for (const entry of readProductNotFoundLog()) {
      expect(Object.keys(entry).sort()).toEqual(["at", "reason"]);
      expect(entry.at).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    }
  });
});

describe("V0.10.12 legal review route matrix", () => {
  it("answers non-404 on every declared endpoint for an authorized reviewer", async () => {
    const handler = createOperationsHttpHandler({
      enabled: true, service: legalReviewService(), sessions: sessions(true),
    });
    for (const route of LEGAL_REVIEW_ROUTES) {
      const request = new Request(`https://internal.invalid/api/operations/${route.path}`, route.method === "POST"
        ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            schema_version: "tivdoc-operations-command",
            idempotency_key: "idem.matrix.001",
            occurred_at: "2026-01-02T03:04:05.000Z",
            packet: { packet_id: "LRP:a", packet_sha256: "a".repeat(64) },
            action: { action_id: "LRA:a", decision: "claim" },
          }),
        }
        : {});
      const response = await handler.handle(request, route.path.split("/"));
      expect(response.status, `${route.method} ${route.path}`).not.toBe(404);
    }
  });

  it("refuses every declared endpoint without a verified session", async () => {
    const handler = createOperationsHttpHandler({
      enabled: true, service: legalReviewService(), sessions: sessions(false),
    });
    for (const route of LEGAL_REVIEW_ROUTES) {
      const request = new Request(`https://internal.invalid/api/operations/${route.path}`,
        route.method === "POST" ? { method: "POST", headers: { "content-type": "application/json" }, body: "{}" } : {});
      const response = await handler.handle(request, route.path.split("/"));
      expect(response.status, `${route.method} ${route.path}`).toBe(404);
    }
  });

  it("refuses the wrong method on every declared endpoint", async () => {
    const handler = createOperationsHttpHandler({
      enabled: true, service: legalReviewService(), sessions: sessions(true),
    });
    for (const route of LEGAL_REVIEW_ROUTES) {
      const wrong = route.method === "POST" ? "GET" : "POST";
      const request = new Request(`https://internal.invalid/api/operations/${route.path}`,
        wrong === "POST" ? { method: "POST", headers: { "content-type": "application/json" }, body: "{}" } : {});
      const response = await handler.handle(request, route.path.split("/"));
      expect(response.status, `${wrong} ${route.path}`).toBe(404);
    }
  });

  it("declares exactly the endpoints the journey walks", () => {
    expect(LEGAL_REVIEW_ROUTES.map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET legal-review/queue",
      "GET legal-review/topics",
      "POST legal-review/actions",
    ]);
  });
});
