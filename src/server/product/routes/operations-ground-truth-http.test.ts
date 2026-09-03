import { beforeEach, describe, expect, it } from "vitest";

import type { InternalOpsApplicationPort } from "../internal-ops/application-port.ts";
import { clearProductNotFoundLog, readProductNotFoundLog } from "./http-common.ts";
import { createOperationsHttpHandler, GROUND_TRUTH_ROUTES } from "./operations-http.ts";

// Wave 5 (G-12). The nested Ground Truth queue endpoint, at the HTTP layer:
// the same negative matrix the legal-review endpoints carry, on a route that
// is read-only by declaration.

const ACTOR = Object.freeze({ actor_id: "actor.extraction_reviewer.001", role: "extraction_reviewer" });

function baseService(): InternalOpsApplicationPort {
  return Object.freeze({
    read: async () => Object.freeze({}) as never,
    mutate: async () => Object.freeze({}) as never,
  });
}

function groundTruthService(calls: unknown[], failure?: { code: string }): InternalOpsApplicationPort {
  return Object.freeze({
    ...baseService(),
    readGroundTruthQueue: async (input: unknown) => {
      calls.push({ kind: "queue", input });
      if (failure) throw Object.assign(new Error(failure.code), { code: failure.code });
      return Object.freeze({ entries: Object.freeze([]), content_included: false, activation_allowed: false });
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
    service: groundTruthService([]),
    sessions: sessions(true),
    ...input,
  });
}

const GET_QUEUE = (query = "") => new Request(`https://internal.invalid/api/operations/ground-truth/queue${query}`);
const SEGMENTS = ["ground-truth", "queue"];

async function bodyAndHeaders(response: Response) {
  return {
    status: response.status,
    body: await response.text(),
    headers: [...response.headers.entries()].sort(),
  };
}

describe("Wave 5 nested ground truth queue endpoint", () => {
  beforeEach(() => { clearProductNotFoundLog(); });

  it("serves the durable queue to a verified session without content", async () => {
    const calls: unknown[] = [];
    const response = await handler({ service: groundTruthService(calls) }).handle(GET_QUEUE(), SEGMENTS);
    expect(response.status).toBe(200);
    const body = await response.json() as { data?: { activation_allowed?: boolean; content_included?: boolean } };
    expect(body.data?.activation_allowed).toBe(false);
    expect(body.data?.content_included).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("verifies the operations session without CSRF: the route is read-only", async () => {
    const seen: unknown[] = [];
    await handler({ sessions: sessions(true, seen) }).handle(GET_QUEUE(), SEGMENTS);
    expect(seen).toEqual([{ audience: "operations", csrf: false }]);
  });

  it("passes the verified actor, correlation id and bounded limit to the durable service", async () => {
    const calls: unknown[] = [];
    const request = new Request("https://internal.invalid/api/operations/ground-truth/queue?limit=7", {
      headers: { "x-correlation-id": "correlation.gt.0001" },
    });
    const response = await handler({ service: groundTruthService(calls) }).handle(request, SEGMENTS);
    expect(response.status).toBe(200);
    expect(calls).toEqual([{ kind: "queue", input: { actor: ACTOR, correlation_id: "correlation.gt.0001", limit: 7 } }]);
  });

  it("rejects an out-of-range or malformed limit before reaching the service", async () => {
    for (const query of ["?limit=0", "?limit=501", "?limit=abc"]) {
      const calls: unknown[] = [];
      const response = await handler({ service: groundTruthService(calls) }).handle(GET_QUEUE(query), SEGMENTS);
      expect(response.status, query).toBe(400);
      const body = await response.json() as { code?: string; retryable?: boolean };
      expect(body.code).toBe("OPS_INVALID_REQUEST");
      expect(body.retryable).toBe(false);
      expect(calls).toHaveLength(0);
    }
  });

  it("surfaces a forbidden read as 403 without retrying it", async () => {
    const response = await handler({ service: groundTruthService([], { code: "OPS_FORBIDDEN" }) }).handle(GET_QUEUE(), SEGMENTS);
    expect(response.status).toBe(403);
    const body = await response.json() as { code?: string; retryable?: boolean };
    expect(body).toMatchObject({ code: "OPS_FORBIDDEN", retryable: false });
  });

  it("records a distinct internal reason for each refusal and one identical external response", async () => {
    const cases: readonly (readonly [string, Promise<Response>])[] = [
      ["SURFACE_DISABLED", handler({ enabled: false }).handle(GET_QUEUE(), SEGMENTS)],
      ["SERVICE_ABSENT", handler({ service: null }).handle(GET_QUEUE(), SEGMENTS)],
      ["CAPABILITY_ABSENT", handler({ service: baseService() }).handle(GET_QUEUE(), SEGMENTS)],
      ["PATH_NOT_ROUTED", handler().handle(GET_QUEUE(), ["ground-truth", "unrouted"])],
      ["SESSION_UNVERIFIED", handler({ sessions: sessions(false) }).handle(GET_QUEUE(), SEGMENTS)],
    ];
    const shapes: unknown[] = [];
    for (const [, pending] of cases) shapes.push(await bodyAndHeaders(await pending));
    expect(readProductNotFoundLog().map((entry) => entry.reason)).toEqual(cases.map(([reason]) => reason));
    expect(new Set(shapes.map((shape) => JSON.stringify(shape))).size).toBe(1);
    expect((shapes[0] as { status: number }).status).toBe(404);
    expect((shapes[0] as { body: string }).body).toBe("");
  });

  it("refuses the wrong method and never reaches the service", async () => {
    const calls: unknown[] = [];
    const post = new Request("https://internal.invalid/api/operations/ground-truth/queue", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    expect((await handler({ service: groundTruthService(calls) }).handle(post, SEGMENTS)).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("declares exactly one read-only endpoint", () => {
    expect(GROUND_TRUTH_ROUTES.map((route) => `${route.method} ${route.path}`)).toEqual(["GET ground-truth/queue"]);
  });
});
