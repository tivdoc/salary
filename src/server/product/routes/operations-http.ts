import "./server-boundary.ts";

import { randomUUID } from "node:crypto";
import type { ProductSessionBoundary } from "../auth/runtime.ts";
import type { InternalOpsApplicationPort } from "../internal-ops/application-port.ts";
import { INTERNAL_OPS_SCHEMA_VERSION, type InternalOpsAction, type OpsProblemCode } from "../internal-ops/contracts.ts";
import { InternalOpsError, type InternalOpsReadKind } from "../internal-ops/service.ts";
import { PRODUCT_HTTP_HEADERS, productJson, productNotFound, safeSegments, strictJsonObject } from "./http-common.ts";

export const STABLE_OPERATIONS_COMMAND_SCHEMA = "tivdoc-operations-command" as const;

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
      if (!input.enabled || !input.service) return productNotFound();
      const segments = safeSegments(rawSegments);
      if (!segments) return productNotFound();
      const route = matchOperationsRoute(request.method, segments);
      if (!route) return productNotFound();
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
  }
  return "OPS_COMMAND_REJECTED";
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
