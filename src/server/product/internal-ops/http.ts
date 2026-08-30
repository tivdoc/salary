import "./server-boundary.ts";

import { randomUUID } from "node:crypto";
import type { InternalOpsFlagSnapshot } from "./flags.ts";
import { INTERNAL_OPS_SCHEMA_VERSION, type InternalOpsAction, type OpsProblem, type OpsProblemCode } from "./contracts.ts";
import { InternalOpsError, type InternalOpsReadKind, type InternalOpsService } from "./service.ts";

const SAFE_HEADERS = Object.freeze({
  "Cache-Control": "no-store, max-age=0",
  "Content-Type": "application/json; charset=utf-8",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
});

type RouteMatch =
  | Readonly<{ method: "GET"; kind: InternalOpsReadKind; caseId: string | null }>
  | Readonly<{ method: "POST"; action: InternalOpsAction; caseId: string | null }>;

export type InternalOpsHttpAdapter = Readonly<{
  handle(request: Request, segments: readonly string[]): Promise<Response>;
}>;

export function createInternalOpsHttpAdapter(input: Readonly<{
  service: InternalOpsService | null;
  flags: InternalOpsFlagSnapshot;
}>): InternalOpsHttpAdapter {
  return Object.freeze({
    async handle(request: Request, rawSegments: readonly string[]): Promise<Response> {
      if (!input.flags.TIVDOC_INTERNAL_OPS_API_ENABLED) return new Response(null, { status: 404, headers: SAFE_HEADERS });
      const correlationId = correlationIdFor(request);
      if (!input.service) return problem("OPS_BACKEND_UNAVAILABLE", correlationId, 503, true);
      const segments = normalizeSegments(rawSegments);
      if (!segments) return problem("OPS_NOT_FOUND", correlationId, 404, false);
      const route = matchRoute(request.method, segments);
      if (!route) return problem("OPS_NOT_FOUND", correlationId, 404, false);
      try {
        const actor = await input.service.authenticate(request);
        if (route.method === "GET") {
          const projection = await input.service.read(actor, route.kind, route.caseId);
          return json({ schema_version: INTERNAL_OPS_SCHEMA_VERSION, correlation_id: correlationId, data: projection }, 200);
        }
        const body = await strictJsonBody(request);
        if (!payloadMatchesRoute(body, route.action, route.caseId)) throw new InternalOpsError("OPS_INVALID_REQUEST");
        const result = await input.service.mutate(actor, body, correlationId);
        if ("mutation" in result) {
          const bytes = result.bytes.buffer.slice(result.bytes.byteOffset, result.bytes.byteOffset + result.bytes.byteLength) as ArrayBuffer;
          return new Response(bytes, {
            status: 200,
            headers: {
              ...SAFE_HEADERS,
              "Content-Type": result.media_type,
              "X-Tivdoc-Artifact-Sha256": result.artifact_sha256,
              "X-Tivdoc-Correlation-Id": correlationId,
              "X-Tivdoc-Export-Format": result.format,
            },
          });
        }
        return json({ schema_version: INTERNAL_OPS_SCHEMA_VERSION, correlation_id: correlationId, data: result }, 200);
      } catch (error) {
        const code = safeProblemCode(error);
        return problem(code, correlationId, statusFor(code), retryable(code));
      }
    },
  });
}

function normalizeSegments(segments: readonly string[]): readonly string[] | null {
  if (segments.length < 1 || segments.length > 5) return null;
  if (segments.some((segment) => !/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,159}$/.test(segment) || segment === "." || segment === "..")) return null;
  return segments;
}

function matchRoute(method: string, segments: readonly string[]): RouteMatch | null {
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
  const tail = segments.slice(2).join("/");
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
  const action = actions[tail];
  return action ? { method, action, caseId: segments[1] } : null;
}

async function strictJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new InternalOpsError("OPS_INVALID_REQUEST");
  const announced = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(announced) && announced > 65_536) throw new InternalOpsError("OPS_INVALID_REQUEST");
  const text = await request.text();
  if (text.length === 0 || Buffer.byteLength(text, "utf8") > 65_536) throw new InternalOpsError("OPS_INVALID_REQUEST");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new InternalOpsError("OPS_INVALID_REQUEST");
  }
}

function payloadMatchesRoute(body: unknown, action: InternalOpsAction, caseId: string | null): boolean {
  if (!body || typeof body !== "object" || !("payload" in body)) return false;
  const payload = (body as { payload?: unknown }).payload;
  if (!payload || typeof payload !== "object") return false;
  const candidate = payload as { action?: unknown; case_id?: unknown };
  return candidate.action === action && (caseId === null || candidate.case_id === caseId);
}

function correlationIdFor(request: Request): string {
  const supplied = request.headers.get("x-correlation-id");
  return supplied && /^[a-zA-Z0-9][a-zA-Z0-9:._-]{7,127}$/.test(supplied) ? supplied : `ops:${randomUUID()}`;
}

function safeProblemCode(error: unknown): OpsProblemCode {
  if (error instanceof InternalOpsError) return error.code;
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code: unknown }).code;
    const mapped: Readonly<Record<string, OpsProblemCode>> = {
      case_revision_conflict: "OPS_REVISION_CONFLICT",
      revision_conflict: "OPS_REVISION_CONFLICT",
      idempotency_key_reused_with_different_command: "OPS_IDEMPOTENCY_CONFLICT",
      idempotency_conflict: "OPS_IDEMPOTENCY_CONFLICT",
      exact_report_approval_required: "OPS_EXACT_REPORT_APPROVAL_REQUIRED",
      upstream_invalidated: "OPS_UPSTREAM_INVALIDATED",
      legal_readiness_blocked: "OPS_LEGAL_READINESS_BLOCKED",
    };
    if (typeof code === "string" && mapped[code]) return mapped[code];
  }
  return "OPS_COMMAND_REJECTED";
}

function statusFor(code: OpsProblemCode): number {
  if (code === "OPS_AUTH_REQUIRED") return 401;
  if (code === "OPS_FORBIDDEN") return 403;
  if (code === "OPS_NOT_FOUND" || code === "OPS_DISABLED") return 404;
  if (code === "OPS_INVALID_REQUEST") return 400;
  if (code === "OPS_REVISION_CONFLICT" || code === "OPS_IDEMPOTENCY_CONFLICT" || code === "OPS_UPSTREAM_INVALIDATED") return 409;
  if (code === "OPS_BACKEND_UNAVAILABLE") return 503;
  return 422;
}

function retryable(code: OpsProblemCode): boolean {
  return code === "OPS_BACKEND_UNAVAILABLE" || code === "OPS_REVISION_CONFLICT";
}

function problem(code: OpsProblemCode, correlationId: string, status: number, canRetry: boolean): Response {
  const body: OpsProblem = Object.freeze({ schema_version: INTERNAL_OPS_SCHEMA_VERSION, code, correlation_id: correlationId, retryable: canRetry });
  return json(body, status);
}

function json(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), { status, headers: SAFE_HEADERS });
}
