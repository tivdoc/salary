import "./server-boundary.ts";

import { randomUUID } from "node:crypto";
import type { ProductSessionBoundary } from "../auth/runtime.ts";
import type { InternalOpsApplicationPort } from "../internal-ops/application-port.ts";
import { INTERNAL_OPS_SCHEMA_VERSION, type InternalOpsAction, type OpsProblemCode } from "../internal-ops/contracts.ts";
import { InternalOpsError, type InternalOpsReadKind } from "../internal-ops/service.ts";
import { PRODUCT_HTTP_HEADERS, productJson, productNotFound, safeSegments, strictJsonObject } from "./http-common.ts";

export const STABLE_OPERATIONS_COMMAND_SCHEMA = "tivdoc-operations-command" as const;

/**
 * Every nested Legal Review endpoint this handler routes. The handler matches
 * against this list and the route matrix test asserts against it, so the two
 * can never drift.
 */
export const LEGAL_REVIEW_ROUTES = Object.freeze([
  Object.freeze({ path: "legal-review/queue", method: "GET" as const }),
  Object.freeze({ path: "legal-review/topics", method: "GET" as const }),
  Object.freeze({ path: "legal-review/actions", method: "POST" as const }),
]);

/**
 * The nested Ground Truth queue panel. Read-only by construction: one GET, no
 * action route, so there is nothing here that a CSRF token would protect.
 */
/**
 * E2-3. The annotator write path beside G-12's read-only queue. Two POSTs and
 * nothing else: claim one item, submit one annotation envelope.
 *
 * What is deliberately NOT here is any enforcement. G-4 independence (an
 * annotator may not verify their own work) and G-7 lock semantics (a committed
 * item opens a new revision rather than being mutated) are enforced by the
 * definers, in the database, where they hold for every caller. A route that
 * re-checked them would be a second copy of the rule that can drift from the
 * first, and the one that drifts is always the one someone trusts.
 */
export const GROUND_TRUTH_ROUTES = Object.freeze([
  Object.freeze({ path: "ground-truth/queue", method: "GET" as const }),
  Object.freeze({ path: "ground-truth/claims", method: "POST" as const }),
  Object.freeze({ path: "ground-truth/annotations", method: "POST" as const }),
]);

/**
 * Wave 8 (S-8). The nested offline-shadow control-plane panel — same
 * precedent as Ground Truth: read-only by construction, one GET, served
 * only once the canonical service actually provides the capability
 * (shadowCapability below), same as every other panel here.
 */
export const SHADOW_ROUTES = Object.freeze([
  Object.freeze({ path: "shadow/summary", method: "GET" as const }),
]);

type OperationsRoute =
  | Readonly<{ method: "GET"; kind: InternalOpsReadKind; caseId: string | null }>
  | Readonly<{ method: "POST"; action: InternalOpsAction; caseId: string | null }>;

export type OperationsHttpHandler = Readonly<{
  handle(request: Request, segments: readonly string[]): Promise<Response>;
}>;

export function createOperationsHttpHandler(input: Readonly<{
  enabled: boolean;
  service: InternalOpsApplicationPort | null;
  sessions: Pick<ProductSessionBoundary, "verify">;
}>): OperationsHttpHandler {
  return Object.freeze({
    async handle(request, rawSegments) {
      if (!input.enabled) return productNotFound("SURFACE_DISABLED");
      if (!input.service) return productNotFound("SERVICE_ABSENT");
      const segments = safeSegments(rawSegments);
      if (!segments) return productNotFound("SEGMENTS_UNSAFE");
      // Nested Ground Truth queue panel. Same session and correlation handling
      // as every other operations route; only the capability differs.
      if (segments[0] === "ground-truth") {
        const groundTruth = groundTruthCapability(input.service);
        if (!groundTruth) return productNotFound("CAPABILITY_ABSENT");
        const isPost = request.method === "POST";
        const joined = segments.join("/");
        if (!GROUND_TRUTH_ROUTES.some((route) => route.path === joined && route.method === request.method)) {
          return productNotFound("PATH_NOT_ROUTED");
        }
        // CSRF is required for the writes and not for the read, the same way
        // Legal Review does it — one rule, applied from the method rather than
        // from a per-path exception someone can forget to add.
        const session = await input.sessions.verify(request, "operations", isPost);
        if (!session) return productNotFound("SESSION_UNVERIFIED");
        const correlationId = correlationIdFor(request);
        try {
          if (!isPost) {
            const limit = queueLimit(request);
            const data = await groundTruth.readGroundTruthQueue({
              actor: session.actor, correlation_id: correlationId, limit,
            });
            return productJson({ correlation_id: correlationId, data });
          }
          const body = await strictJsonObject(request);
          if (!body || body.schema_version !== STABLE_OPERATIONS_COMMAND_SCHEMA
            || typeof body.work_item_id !== "string"
            || typeof body.idempotency_key !== "string" || typeof body.occurred_at !== "string") {
            throw new InternalOpsError("OPS_INVALID_REQUEST");
          }
          if (joined === "ground-truth/claims") {
            const data = await groundTruth.claimGroundTruthItem({
              actor: session.actor, correlation_id: correlationId,
              work_item_id: body.work_item_id,
              idempotency_key: body.idempotency_key, occurred_at: body.occurred_at,
            });
            return productJson({ correlation_id: correlationId, data });
          }
          // The envelope is passed through whole. This route does not read
          // inside it, does not validate its contents against the item, and
          // does not decide whether the annotator is allowed to submit it —
          // the definer does all three, for every caller, not just this one.
          if (!isRecord(body.envelope)) throw new InternalOpsError("OPS_INVALID_REQUEST");
          const data = await groundTruth.submitGroundTruthAnnotation({
            actor: session.actor, correlation_id: correlationId,
            work_item_id: body.work_item_id, envelope: body.envelope as never,
            idempotency_key: body.idempotency_key, occurred_at: body.occurred_at,
          });
          return productJson({ correlation_id: correlationId, data });
        } catch (error) {
          const code = problemCode(error);
          return productJson({ code, correlation_id: correlationId, retryable: false }, statusFor(code));
        }
      }
      // Wave 8 (S-8). Nested offline-shadow control-plane panel. Same
      // session and correlation handling as Ground Truth; read-only, no
      // action route, no CSRF check — there is nothing here to mutate.
      if (segments[0] === "shadow") {
        const shadow = shadowCapability(input.service);
        if (!shadow) return productNotFound("CAPABILITY_ABSENT");
        const joined = segments.join("/");
        if (!SHADOW_ROUTES.some((route) => route.path === joined && route.method === request.method)) {
          return productNotFound("PATH_NOT_ROUTED");
        }
        const session = await input.sessions.verify(request, "operations", false);
        if (!session) return productNotFound("SESSION_UNVERIFIED");
        const correlationId = correlationIdFor(request);
        try {
          const data = await shadow.readShadowSummary({ actor: session.actor, correlation_id: correlationId });
          return productJson({ correlation_id: correlationId, data });
        } catch (error) {
          const code = problemCode(error);
          return productJson({ code, correlation_id: correlationId, retryable: false }, statusFor(code));
        }
      }
      // Nested Legal Review workspace. It shares this route's session, CSRF and
      // correlation handling exactly; only the service capability differs.
      if (segments[0] === "legal-review") {
        const legalReview = legalReviewCapability(input.service);
        if (!legalReview) return productNotFound("CAPABILITY_ABSENT");
        const isPost = request.method === "POST";
        const joined = segments.join("/");
        // Routed from the declaration, never from a second copy of it: the
        // route matrix test asserts against this same list, so an endpoint that
        // stops being routed fails at commit time rather than in a journey.
        if (!LEGAL_REVIEW_ROUTES.some((route) => route.path === joined && route.method === request.method)) {
          return productNotFound("PATH_NOT_ROUTED");
        }
        const session = await input.sessions.verify(request, "operations", isPost);
        if (!session) return productNotFound("SESSION_UNVERIFIED");
        const correlationId = correlationIdFor(request);
        try {
          if (joined === "legal-review/topics") {
            const data = await legalReview.readLegalReviewTopics({
              actor: session.actor, correlation_id: correlationId,
            });
            return productJson({ correlation_id: correlationId, data });
          }
          if (!isPost) {
            const limit = queueLimit(request);
            const data = await legalReview.readLegalReviewQueue({
              actor: session.actor, correlation_id: correlationId, limit,
            });
            return productJson({ correlation_id: correlationId, data });
          }
          const body = await strictJsonObject(request);
          if (!body || body.schema_version !== STABLE_OPERATIONS_COMMAND_SCHEMA
            || !isRecord(body.packet) || !isRecord(body.action)
            || typeof body.idempotency_key !== "string" || typeof body.occurred_at !== "string") {
            throw new InternalOpsError("OPS_INVALID_REQUEST");
          }
          const data = await legalReview.submitLegalReviewAction({
            actor: session.actor,
            correlation_id: correlationId,
            packet: body.packet as never,
            action: body.action as never,
            applied_actions: Array.isArray(body.applied_actions) ? body.applied_actions as never : [],
            superseded_by_packet_id: typeof body.superseded_by_packet_id === "string"
              ? body.superseded_by_packet_id : null,
            idempotency_key: body.idempotency_key,
            occurred_at: body.occurred_at,
          });
          return productJson({ correlation_id: correlationId, data });
        } catch (error) {
          const code = problemCode(error);
          return productJson({ code, correlation_id: correlationId, retryable: false }, statusFor(code));
        }
      }
      const route = matchOperationsRoute(request.method, segments);
      if (!route) return productNotFound("PATH_NOT_ROUTED");
      const session = await input.sessions.verify(request, "operations", route.method === "POST");
      if (!session) return productNotFound();
      const correlationId = correlationIdFor(request);
      try {
        if (route.method === "GET") {
          const projection = await input.service.read(session.actor, route.kind, route.caseId);
          return productJson({ correlation_id: correlationId, data: projection });
        }
        const body = await strictJsonObject(request);
        if (!body || body.schema_version !== STABLE_OPERATIONS_COMMAND_SCHEMA || !payloadMatchesRoute(body, route.action, route.caseId)) {
          throw new InternalOpsError("OPS_INVALID_REQUEST");
        }
        const result = await input.service.mutate(session.actor, { ...body, schema_version: INTERNAL_OPS_SCHEMA_VERSION }, correlationId);
        if ("mutation" in result) {
          const bytes = result.bytes.buffer.slice(result.bytes.byteOffset, result.bytes.byteOffset + result.bytes.byteLength) as ArrayBuffer;
          return new Response(bytes, {
            status: 200,
            headers: {
              ...PRODUCT_HTTP_HEADERS,
              "content-type": result.media_type,
              "content-disposition": `attachment; filename="tivdoc-internal-report.${result.format}"`,
              "x-tivdoc-artifact-sha256": result.artifact_sha256,
              "x-tivdoc-correlation-id": correlationId,
            },
          });
        }
        return productJson({ correlation_id: correlationId, data: result });
      } catch (error) {
        const code = problemCode(error);
        return productJson({ code, correlation_id: correlationId, retryable: code === "OPS_BACKEND_UNAVAILABLE" || code === "OPS_REVISION_CONFLICT" }, statusFor(code));
      }
    },
  });
}

type LegalReviewCapability = Readonly<{
  readLegalReviewQueue(input: Readonly<{ actor: unknown; correlation_id: string; limit: number }>): Promise<unknown>;
  readLegalReviewTopics(input: Readonly<{ actor: unknown; correlation_id: string }>): Promise<unknown>;
  submitLegalReviewAction(input: Readonly<Record<string, unknown>>): Promise<unknown>;
}>;

type GroundTruthCapability = Readonly<{
  readGroundTruthQueue(input: Readonly<{ actor: unknown; correlation_id: string; limit: number }>): Promise<unknown>;
  claimGroundTruthItem(input: Readonly<Record<string, unknown>>): Promise<unknown>;
  submitGroundTruthAnnotation(input: Readonly<Record<string, unknown>>): Promise<unknown>;
}>;

/**
 * The panel is served only when the canonical durable service provides ALL
 * THREE. A service with only the read would otherwise serve a queue whose
 * claim button 500s; the whole panel staying at 404 until the write path exists
 * is the honest state, and it is the same rule Legal Review already follows.
 */
function groundTruthCapability(service: InternalOpsApplicationPort | null): GroundTruthCapability | null {
  const candidate = service as unknown as Partial<GroundTruthCapability> | null;
  return candidate && typeof candidate.readGroundTruthQueue === "function"
    && typeof candidate.claimGroundTruthItem === "function"
    && typeof candidate.submitGroundTruthAnnotation === "function"
    ? candidate as GroundTruthCapability : null;
}

type ShadowCapability = Readonly<{
  readShadowSummary(input: Readonly<{ actor: unknown; correlation_id: string }>): Promise<unknown>;
}>;

/** The shadow control-plane panel is served only when the canonical durable service provides it. */
function shadowCapability(service: InternalOpsApplicationPort | null): ShadowCapability | null {
  const candidate = service as unknown as Partial<ShadowCapability> | null;
  return candidate && typeof candidate.readShadowSummary === "function"
    ? candidate as ShadowCapability : null;
}

/** The panel is served only when the canonical durable service provides it. */
function legalReviewCapability(service: InternalOpsApplicationPort | null): LegalReviewCapability | null {
  const candidate = service as unknown as Partial<LegalReviewCapability> | null;
  return candidate && typeof candidate.readLegalReviewQueue === "function"
    && typeof candidate.readLegalReviewTopics === "function"
    && typeof candidate.submitLegalReviewAction === "function"
    ? candidate as LegalReviewCapability : null;
}

function queueLimit(request: Request): number {
  const raw = new URL(request.url).searchParams.get("limit");
  if (raw === null) return 50;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 500) {
    throw new InternalOpsError("OPS_INVALID_REQUEST");
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchOperationsRoute(method: string, segments: readonly string[]): OperationsRoute | null {
  const joined = segments.join("/");
  if (method === "GET") {
    if (joined === "capabilities") return { method, kind: "capabilities", caseId: null };
    if (joined === "queue") return { method, kind: "queue", caseId: null };
    if (segments[0] === "cases" && segments.length === 2) return { method, kind: "case", caseId: segments[1] };
    if (segments[0] === "cases" && segments.length === 3) {
      const kinds = ["timeline", "payment", "documents", "extraction", "facts", "readiness", "analysis", "report", "audit"] as const;
      if (kinds.includes(segments[2] as typeof kinds[number])) return { method, kind: segments[2] as typeof kinds[number], caseId: segments[1] };
    }
    return null;
  }
  if (method !== "POST") return null;
  if (joined === "cases") return { method, action: "case_create", caseId: null };
  if (segments[0] !== "cases" || segments.length < 3) return null;
  const actions: Readonly<Record<string, InternalOpsAction>> = Object.freeze({
    "payment/reconcile": "payment_reconcile",
    documents: "document_reference_add",
    "extraction/review": "extraction_review",
    "facts/resolve": "fact_resolution",
    "analysis/request": "analysis_request",
    "analysis/resume": "analysis_resume",
    "analysis/replay": "analysis_replay",
    "report/submit": "report_submit",
    "report/approve": "report_approve",
    "report/reject": "report_reject",
    "report/export": "report_manual_export",
  });
  const action = actions[segments.slice(2).join("/")];
  return action ? { method, action, caseId: segments[1] } : null;
}

function payloadMatchesRoute(body: Record<string, unknown>, action: InternalOpsAction, caseId: string | null): boolean {
  if (!body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)) return false;
  const payload = body.payload as Record<string, unknown>;
  return payload.action === action && (caseId === null || payload.case_id === caseId);
}

function correlationIdFor(request: Request): string {
  const supplied = request.headers.get("x-correlation-id");
  return supplied && /^[A-Za-z0-9][A-Za-z0-9:._-]{7,127}$/.test(supplied) ? supplied : `ops:${randomUUID()}`;
}

function problemCode(error: unknown): OpsProblemCode {
  if (error instanceof InternalOpsError) return error.code;
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string" && OPS_PROBLEM_CODES.has(code as OpsProblemCode)) return code as OpsProblemCode;
    const mapped: Readonly<Record<string, OpsProblemCode>> = Object.freeze({
      case_revision_conflict: "OPS_REVISION_CONFLICT",
      revision_conflict: "OPS_REVISION_CONFLICT",
      idempotency_key_reused_with_different_command: "OPS_IDEMPOTENCY_CONFLICT",
      idempotency_conflict: "OPS_IDEMPOTENCY_CONFLICT",
      exact_report_approval_required: "OPS_EXACT_REPORT_APPROVAL_REQUIRED",
      upstream_invalidated: "OPS_UPSTREAM_INVALIDATED",
      legal_readiness_blocked: "OPS_LEGAL_READINESS_BLOCKED",
    });
    if (typeof code === "string" && mapped[code]) return mapped[code];
    // A wrapper that substituted its own code may still carry the origin's
    // SQLSTATE. A missing GRANT is a refusal, not an unclassified rejection.
    const origin = (error as { origin_sqlstate?: unknown; sqlstate?: unknown });
    for (const candidate of [origin.origin_sqlstate, origin.sqlstate]) {
      if (candidate === "42501") return "OPS_FORBIDDEN";
    }
  }
  // `OPS_COMMAND_REJECTED` is the catch-all, and an unrecognised failure that
  // says nothing about itself is the same defect as a bare 404. The class of
  // the error is recorded server-side — a SQLSTATE or a constructor name, never
  // a message, parameter or identifier.
  recordOpsRejection(error);
  return "OPS_COMMAND_REJECTED";
}

const OPS_REJECTION_LIMIT = 64;
const opsRejectionLog: { kind: string; at: string }[] = [];

/** Recent unrecognised failure classes. Codes only. */
export function readOpsRejectionLog(): readonly Readonly<{ kind: string; at: string }>[] {
  return Object.freeze(opsRejectionLog.map((entry) => Object.freeze({ ...entry })));
}

export function clearOpsRejectionLog(): void {
  opsRejectionLog.length = 0;
}

function recordOpsRejection(error: unknown): void {
  const raw = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : error instanceof Error ? error.constructor.name : typeof error;
  const base = /^[A-Za-z0-9_]{1,64}$/u.test(raw) ? raw : "UNCLASSIFIED";
  // A canonical persistence failure carries its SQLSTATE and domain code; both
  // are classifications, not content, and both are what makes the failure
  // actionable without opening the database.
  const detail = ["sqlstate", "origin_sqlstate", "domain_code"]
    .map((field) => (error as Record<string, unknown> | null)?.[field])
    .filter((value): value is string => typeof value === "string" && /^[A-Za-z0-9_]{1,32}$/u.test(value));
  const kind = detail.length > 0 ? `${base}:${detail.join(":")}` : base;
  opsRejectionLog.push({ kind, at: new Date().toISOString() });
  if (opsRejectionLog.length > OPS_REJECTION_LIMIT) opsRejectionLog.shift();
  if (process.env.NODE_ENV !== "test") process.stderr.write(`ops_command_rejected ${kind}\n`);
}

const OPS_PROBLEM_CODES = new Set<OpsProblemCode>([
  "OPS_DISABLED",
  "OPS_BACKEND_UNAVAILABLE",
  "OPS_AUTH_REQUIRED",
  "OPS_FORBIDDEN",
  "OPS_INVALID_REQUEST",
  "OPS_NOT_FOUND",
  "OPS_REVISION_CONFLICT",
  "OPS_IDEMPOTENCY_CONFLICT",
  "OPS_LEGAL_READINESS_BLOCKED",
  "OPS_EXACT_REPORT_APPROVAL_REQUIRED",
  "OPS_MANUAL_EXPORT_DISABLED",
  "OPS_SYNTHETIC_DISABLED",
  "OPS_PRODUCTION_FIXTURE_FORBIDDEN",
  "OPS_UPSTREAM_INVALIDATED",
  "OPS_COMMAND_REJECTED",
]);

function statusFor(code: OpsProblemCode): number {
  if (code === "OPS_AUTH_REQUIRED") return 401;
  if (code === "OPS_FORBIDDEN") return 403;
  if (code === "OPS_NOT_FOUND" || code === "OPS_DISABLED") return 404;
  if (code === "OPS_INVALID_REQUEST") return 400;
  if (code === "OPS_REVISION_CONFLICT" || code === "OPS_IDEMPOTENCY_CONFLICT" || code === "OPS_UPSTREAM_INVALIDATED") return 409;
  if (code === "OPS_BACKEND_UNAVAILABLE") return 503;
  return 422;
}
