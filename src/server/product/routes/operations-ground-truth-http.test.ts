import { beforeEach, describe, expect, it } from "vitest";

import type { InternalOpsApplicationPort } from "../internal-ops/application-port.ts";
import { clearProductNotFoundLog, readProductNotFoundLog } from "./http-common.ts";
import { createOperationsHttpHandler, GROUND_TRUTH_ROUTES, STABLE_OPERATIONS_COMMAND_SCHEMA } from "./operations-http.ts";

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

// E2-3: the capability is now all three methods, not just the read. A service
// with only the read would serve a queue whose claim button 500s, so the whole
// panel stays at 404 until the write path exists too.
function groundTruthService(calls: unknown[], failure?: { code: string }): InternalOpsApplicationPort {
  const fail = () => { if (failure) throw Object.assign(new Error(failure.code), { code: failure.code }); };
  return Object.freeze({
    ...baseService(),
    readGroundTruthQueue: async (input: unknown) => {
      calls.push({ kind: "queue", input });
      fail();
      return Object.freeze({ entries: Object.freeze([]), content_included: false, activation_allowed: false });
    },
    claimGroundTruthItem: async (input: unknown) => {
      calls.push({ kind: "claim", input });
      fail();
      return Object.freeze({ claimed: true, content_included: false, human_ground_truth_locked: 0 });
    },
    submitGroundTruthAnnotation: async (input: unknown) => {
      calls.push({ kind: "annotation", input });
      fail();
      return Object.freeze({ accepted: true, content_included: false, human_ground_truth_locked: 0 });
    },
  }) as unknown as InternalOpsApplicationPort;
}

/** A service that reads but cannot write — the half-built case. */
function readOnlyGroundTruthService(): InternalOpsApplicationPort {
  return Object.freeze({
    ...baseService(),
    readGroundTruthQueue: async () => Object.freeze({ entries: Object.freeze([]) }),
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

  it("declares exactly one read and two writes, and nothing else", () => {
    expect(GROUND_TRUTH_ROUTES.map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET ground-truth/queue",
      "POST ground-truth/claims",
      "POST ground-truth/annotations",
    ]);
  });
});

// E2-3. The annotator write path: claim an item, submit an annotation envelope.
// Same negative matrix as legal-review, and no annotation content anywhere —
// the fixtures carry envelopes, not annotations, and every response asserts
// content_included false and HUMAN_GROUND_TRUTH_LOCKED still 0.

const CLAIM_SEGMENTS = ["ground-truth", "claims"];
const ANNOTATION_SEGMENTS = ["ground-truth", "annotations"];

function post(path: string, body: unknown) {
  return new Request(`https://internal.invalid/api/operations/ground-truth/${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

const VALID_CLAIM = Object.freeze({
  schema_version: STABLE_OPERATIONS_COMMAND_SCHEMA,
  work_item_id: "work.ground-truth.synthetic.001",
  idempotency_key: "ground-truth.claim.synthetic.0001",
  occurred_at: "2030-01-01T00:00:00.000Z",
});
const VALID_ANNOTATION = Object.freeze({
  ...VALID_CLAIM,
  idempotency_key: "ground-truth.annotation.synthetic.0001",
  // Structure only. There is no annotation content in this repository and this
  // fixture does not introduce any: it is an envelope shape, and the definer is
  // what decides whether it may be accepted.
  envelope: Object.freeze({ envelope_id: "env.ground-truth.synthetic.001", content_included: false }),
});

describe("E2-3 ground truth annotator write path", () => {
  beforeEach(() => { clearProductNotFoundLog(); });

  it("claims an item and submits an annotation, passing both straight through to the definer", async () => {
    const calls: unknown[] = [];
    const handle = handler({ service: groundTruthService(calls) });
    const claimed = await handle.handle(post("claims", VALID_CLAIM), CLAIM_SEGMENTS);
    expect(claimed.status).toBe(200);
    const submitted = await handle.handle(post("annotations", VALID_ANNOTATION), ANNOTATION_SEGMENTS);
    expect(submitted.status).toBe(200);
    expect((calls as Array<{ kind: string }>).map((entry) => entry.kind)).toEqual(["claim", "annotation"]);
    // The envelope reaches the service whole. This route does not look inside
    // it, and the test asserts that by comparing the object it sent.
    const annotationCall = calls[1] as { input: { envelope: unknown; work_item_id: string } };
    expect(annotationCall.input.envelope).toEqual(VALID_ANNOTATION.envelope);
    expect(annotationCall.input.work_item_id).toBe(VALID_ANNOTATION.work_item_id);
  });

  it("requires CSRF on both writes and not on the read — from the method, not a per-path exception", async () => {
    const seen: unknown[] = [];
    const handle = handler({ sessions: sessions(true, seen) });
    await handle.handle(GET_QUEUE(), SEGMENTS);
    await handle.handle(post("claims", VALID_CLAIM), CLAIM_SEGMENTS);
    await handle.handle(post("annotations", VALID_ANNOTATION), ANNOTATION_SEGMENTS);
    expect(seen).toEqual([
      { audience: "operations", csrf: false },
      { audience: "operations", csrf: true },
      { audience: "operations", csrf: true },
    ]);
  });

  it("no annotation content leaves the route, and the ground-truth counter stays zero", async () => {
    const handle = handler({ service: groundTruthService([]) });
    for (const [segments, body] of [[CLAIM_SEGMENTS, VALID_CLAIM], [ANNOTATION_SEGMENTS, VALID_ANNOTATION]] as const) {
      const response = await handle.handle(post(segments[1], body), segments);
      const payload = await response.json() as { data?: { content_included?: boolean; human_ground_truth_locked?: number } };
      expect(payload.data?.content_included).toBe(false);
      expect(payload.data?.human_ground_truth_locked).toBe(0);
    }
  });

  it("refuses a malformed command before it reaches the definer", async () => {
    const calls: unknown[] = [];
    const handle = handler({ service: groundTruthService(calls) });
    const malformed: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ["wrong schema", { ...VALID_CLAIM, schema_version: "something-else" }],
      ["no work item", { ...VALID_CLAIM, work_item_id: undefined as never }],
      ["no idempotency key", { ...VALID_CLAIM, idempotency_key: 7 as never }],
      ["no occurred_at", { ...VALID_CLAIM, occurred_at: null as never }],
    ];
    for (const [name, body] of malformed) {
      const response = await handle.handle(post("claims", body), CLAIM_SEGMENTS);
      expect(response.status, name).toBe(400);
    }
    // An annotation without an envelope is refused too, and for its own reason.
    const noEnvelope = await handle.handle(post("annotations", VALID_CLAIM), ANNOTATION_SEGMENTS);
    expect(noEnvelope.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("gives one identical 404 for five distinct internal reasons, writes included", async () => {
    const cases: readonly (readonly [string, Promise<Response>])[] = [
      ["SURFACE_DISABLED", handler({ enabled: false }).handle(post("claims", VALID_CLAIM), CLAIM_SEGMENTS)],
      ["SERVICE_ABSENT", handler({ service: null }).handle(post("claims", VALID_CLAIM), CLAIM_SEGMENTS)],
      ["CAPABILITY_ABSENT", handler({ service: readOnlyGroundTruthService() }).handle(post("claims", VALID_CLAIM), CLAIM_SEGMENTS)],
      ["PATH_NOT_ROUTED", handler().handle(post("unrouted", VALID_CLAIM), ["ground-truth", "unrouted"])],
      ["SESSION_UNVERIFIED", handler({ sessions: sessions(false) }).handle(post("claims", VALID_CLAIM), CLAIM_SEGMENTS)],
    ];
    const shapes: unknown[] = [];
    for (const [, pending] of cases) shapes.push(await bodyAndHeaders(await pending));
    expect(readProductNotFoundLog().map((entry) => entry.reason)).toEqual(cases.map(([reason]) => reason));
    expect(new Set(shapes.map((shape) => JSON.stringify(shape))).size).toBe(1);
    expect((shapes[0] as { status: number }).status).toBe(404);
  });

  it("a read-only service serves nothing at all, not a queue with a broken button", async () => {
    // The half-built case: if the capability were still just the read, the
    // queue would render and its claim action would 500 on the first click.
    const handle = handler({ service: readOnlyGroundTruthService() });
    expect((await handle.handle(GET_QUEUE(), SEGMENTS)).status).toBe(404);
    expect((await handle.handle(post("claims", VALID_CLAIM), CLAIM_SEGMENTS)).status).toBe(404);
  });

  it("refuses the wrong method on every route and never reaches the service", async () => {
    const calls: unknown[] = [];
    const handle = handler({ service: groundTruthService(calls) });
    // GET on a write route, and POST on the read route.
    expect((await handle.handle(new Request("https://internal.invalid/api/operations/ground-truth/claims"), CLAIM_SEGMENTS)).status).toBe(404);
    expect((await handle.handle(post("queue", VALID_CLAIM), SEGMENTS)).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("today: the canonical service implements none of the three, so the panel is unreachable", async () => {
    // Same steady state G-12 recorded, now covering the write path too.
    const service = baseService();
    expect(service).not.toHaveProperty("readGroundTruthQueue");
    expect(service).not.toHaveProperty("claimGroundTruthItem");
    expect(service).not.toHaveProperty("submitGroundTruthAnnotation");
  });
});
