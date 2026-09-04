import { beforeEach, describe, expect, it } from "vitest";

import type { InternalOpsApplicationPort } from "../internal-ops/application-port.ts";
import { clearProductNotFoundLog, readProductNotFoundLog } from "./http-common.ts";
import { createOperationsHttpHandler, SHADOW_ROUTES } from "./operations-http.ts";

// Wave 8 (S-8). The nested offline-shadow control-plane panel, at the HTTP
// layer: the same negative matrix Ground Truth (G-12) and Legal Review
// carry, on a route that is read-only by declaration — there is no action
// endpoint here, because there is nothing a shadow-mode reviewer does that
// mutates anything real.

const ACTOR = Object.freeze({ actor_id: "actor.operations_reviewer.001", role: "operations_reviewer" });

function baseService(): InternalOpsApplicationPort {
  return Object.freeze({
    read: async () => Object.freeze({}) as never,
    mutate: async () => Object.freeze({}) as never,
  });
}

function shadowService(calls: unknown[], failure?: { code: string }): InternalOpsApplicationPort {
  return Object.freeze({
    ...baseService(),
    readShadowSummary: async (input: unknown) => {
      calls.push({ kind: "summary", input });
      if (failure) throw Object.assign(new Error(failure.code), { code: failure.code });
      return Object.freeze({ jobs: Object.freeze([]), kill_switch_engaged: false, activation_allowed: false, content_included: false });
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
    service: shadowService([]),
    sessions: sessions(true),
    ...input,
  });
}

const GET_SUMMARY = () => new Request("https://internal.invalid/api/operations/shadow/summary");
const SEGMENTS = ["shadow", "summary"];

async function bodyAndHeaders(response: Response) {
  return {
    status: response.status,
    body: await response.text(),
    headers: [...response.headers.entries()].sort(),
  };
}

describe("Wave 8 nested offline-shadow control-plane endpoint (S-8)", () => {
  beforeEach(() => { clearProductNotFoundLog(); });

  it("serves the durable summary to a verified session without content", async () => {
    const calls: unknown[] = [];
    const response = await handler({ service: shadowService(calls) }).handle(GET_SUMMARY(), SEGMENTS);
    expect(response.status).toBe(200);
    const body = await response.json() as { data?: { activation_allowed?: boolean; content_included?: boolean } };
    expect(body.data?.activation_allowed).toBe(false);
    expect(body.data?.content_included).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("verifies the operations session without CSRF: the route is read-only", async () => {
    const seen: unknown[] = [];
    await handler({ sessions: sessions(true, seen) }).handle(GET_SUMMARY(), SEGMENTS);
    expect(seen).toEqual([{ audience: "operations", csrf: false }]);
  });

  it("passes the verified actor and correlation id to the durable service", async () => {
    const calls: unknown[] = [];
    const request = new Request("https://internal.invalid/api/operations/shadow/summary", {
      headers: { "x-correlation-id": "correlation.shadow.0001" },
    });
    const response = await handler({ service: shadowService(calls) }).handle(request, SEGMENTS);
    expect(response.status).toBe(200);
    expect(calls).toEqual([{ kind: "summary", input: { actor: ACTOR, correlation_id: "correlation.shadow.0001" } }]);
  });

  it("surfaces a forbidden read as 403 without retrying it", async () => {
    const response = await handler({ service: shadowService([], { code: "OPS_FORBIDDEN" }) }).handle(GET_SUMMARY(), SEGMENTS);
    expect(response.status).toBe(403);
    const body = await response.json() as { code?: string; retryable?: boolean };
    expect(body).toMatchObject({ code: "OPS_FORBIDDEN", retryable: false });
  });

  it("records a distinct internal reason for each refusal and one identical external response", async () => {
    const cases: readonly (readonly [string, Promise<Response>])[] = [
      ["SURFACE_DISABLED", handler({ enabled: false }).handle(GET_SUMMARY(), SEGMENTS)],
      ["SERVICE_ABSENT", handler({ service: null }).handle(GET_SUMMARY(), SEGMENTS)],
      ["CAPABILITY_ABSENT", handler({ service: baseService() }).handle(GET_SUMMARY(), SEGMENTS)],
      ["PATH_NOT_ROUTED", handler().handle(GET_SUMMARY(), ["shadow", "unrouted"])],
      ["SESSION_UNVERIFIED", handler({ sessions: sessions(false) }).handle(GET_SUMMARY(), SEGMENTS)],
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
    const post = new Request("https://internal.invalid/api/operations/shadow/summary", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    expect((await handler({ service: shadowService(calls) }).handle(post, SEGMENTS)).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("declares exactly one read-only endpoint", () => {
    expect(SHADOW_ROUTES.map((route) => `${route.method} ${route.path}`)).toEqual(["GET shadow/summary"]);
  });

  it("today: the canonical service does not implement the capability, so the panel is not reachable in production yet", () => {
    // Same steady state as the Ground Truth panel (readGroundTruthQueue has
    // no implementation anywhere in the non-test tree either) — the route,
    // session and CSRF handling are wired and proven; the panel goes live
    // only once a real backing implementation exists, and nothing here
    // fakes that with a stub to make the panel look wired before it is.
    expect(baseService()).not.toHaveProperty("readShadowSummary");
  });
});
