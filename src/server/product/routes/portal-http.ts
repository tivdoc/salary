import "./server-boundary.ts";

import type { VerifiedProductSession } from "../auth/hermetic-session.ts";
import type { ProductSessionBoundary } from "../auth/runtime.ts";
import { PortalError, type PrivacyRequestKind, type ReportAccessGrant } from "../customer-portal/contracts.ts";
import type { CustomerPortalApplicationPort, ReportDownload } from "../customer-portal/repository.ts";
import { PRODUCT_HTTP_HEADERS, exactObjectKeys, productJson, productNotFound, safeSegments, strictJsonObject } from "./http-common.ts";

export type PortalHttpHandler = Readonly<{
  handle(request: Request, segments: readonly string[]): Promise<Response>;
}>;

export function createPortalHttpHandler(input: Readonly<{
  enabled: boolean;
  service: CustomerPortalApplicationPort | null;
  sessions: Pick<ProductSessionBoundary, "verify">;
}>): PortalHttpHandler {
  return Object.freeze({
    async handle(request, rawSegments) {
      if (!input.enabled || !input.service) return productNotFound();
      const segments = safeSegments(rawSegments);
      if (!segments) return productNotFound();
      const mutating = request.method === "POST";
      if (request.method !== "GET" && !mutating) return productNotFound();
      const session = await input.sessions.verify(request, "portal", mutating);
      if (!session) return productNotFound();
      try {
        return request.method === "GET"
          ? await handleRead(input.service, session, segments)
          : await handleMutation(input.service, session, request, segments);
      } catch (error) {
        return portalProblem(error);
      }
    },
  });
}

async function handleRead(service: CustomerPortalApplicationPort, session: VerifiedProductSession, segments: readonly string[]): Promise<Response> {
  if (segments.length === 1 && segments[0] === "cases") {
    const cases = await Promise.all(session.actor.assigned_case_ids.map((caseId) => service.getCaseProjection(session.actor, caseId)));
    return productJson({ cases });
  }
  if (segments.length === 2 && segments[0] === "cases") {
    return productJson({ case: await service.getCaseProjection(session.actor, segments[1]) });
  }
  if (segments.length === 3 && segments[0] === "cases" && segments[2] === "reports") {
    return productJson({ reports: await service.listReports(session.actor, segments[1]) });
  }
  return productNotFound();
}

async function handleMutation(
  service: CustomerPortalApplicationPort,
  session: VerifiedProductSession,
  request: Request,
  segments: readonly string[],
): Promise<Response> {
  const body = await strictJsonObject(request, 16_384);
  if (!body) throw new PortalHttpError("INVALID_REQUEST");
  if (segments.length === 5 && segments[0] === "cases" && segments[2] === "clarifications" && segments[4] === "answers") {
    if (!exactObjectKeys(body, ["expected_revision", "question_version", "value", "explicit_confirmation", "consent_version", "terms_version", "idempotency_key"])) throw new PortalHttpError("INVALID_REQUEST");
    if (body.explicit_confirmation !== true) throw new PortalHttpError("INVALID_REQUEST");
    const result = await service.answerClarification(session.actor, {
      case_id: segments[1],
      expected_revision: requiredRevision(body),
      task_id: segments[3],
      question_version: requiredPositiveInteger(body, "question_version"),
      value: body.value,
      explicit_confirmation: true,
      consent_version: requiredVersion(body, "consent_version"),
      terms_version: requiredVersion(body, "terms_version"),
      idempotency_key: requiredIdempotencyKey(body),
    });
    return productJson(result);
  }
  if (segments.length === 3 && segments[0] === "cases" && segments[2] === "privacy") {
    if (!exactObjectKeys(body, ["expected_revision", "request_kind", "idempotency_key"])) throw new PortalHttpError("INVALID_REQUEST");
    const result = await service.createPrivacyRequest(session.actor, {
      case_id: segments[1],
      expected_revision: requiredRevision(body),
      request_kind: requiredPrivacyKind(body),
      idempotency_key: requiredIdempotencyKey(body),
    });
    return productJson(result);
  }
  if (segments.length === 5 && segments[0] === "cases" && segments[2] === "reports" && segments[4] === "grants") {
    if (!exactObjectKeys(body, ["expected_revision"])) throw new PortalHttpError("INVALID_REQUEST");
    return productJson({
      grant: await service.createReportAccessGrant(session.actor, segments[1], segments[3], requiredRevision(body)),
    });
  }
  if (segments.length === 2 && segments[0] === "reports" && segments[1] === "download") {
    if (!exactObjectKeys(body, ["grant_id", "case_id", "report_id", "artifact_sha256", "object_version_id", "expires_at", "grant_sha256"])) throw new PortalHttpError("INVALID_REQUEST");
    return downloadResponse(await service.downloadReport(session.actor, requiredGrant(body)));
  }
  return productNotFound();
}

function downloadResponse(download: ReportDownload): Response {
  const bytes = download.bytes.buffer.slice(download.bytes.byteOffset, download.bytes.byteOffset + download.bytes.byteLength) as ArrayBuffer;
  return new Response(bytes, {
    status: 200,
    headers: {
      ...PRODUCT_HTTP_HEADERS,
      "content-disposition": `attachment; filename="${download.filename}"`,
      "content-type": download.content_type,
      "x-tivdoc-artifact-sha256": download.artifact_sha256,
      "x-tivdoc-object-version-id": download.object_version_id,
    },
  });
}

class PortalHttpError extends Error {
  readonly code: "INVALID_REQUEST";
  constructor(code: "INVALID_REQUEST") {
    super(code);
    this.code = code;
  }
}

function portalProblem(error: unknown): Response {
  if (error instanceof PortalHttpError) return productJson({ error: "invalid_request" }, 400);
  const code = portalErrorCode(error);
  if (code === "PORTAL_NOT_FOUND") return productNotFound();
  if (code === "PORTAL_REVISION_CONFLICT") return productJson({ error: "revision_conflict" }, 409);
  if (code === "IDEMPOTENCY_KEY_COMMAND_MISMATCH") return productJson({ error: "idempotency_conflict" }, 409);
  if (code) return productJson({ error: "invalid_request" }, 400);
  return productJson({ error: "request_failed" }, 500);
}

const PORTAL_ERROR_CODES = new Set([
  "ARTIFACT_HASH_MISMATCH",
  "CONSENT_VERSION_MISMATCH",
  "EXPLICIT_CONFIRMATION_REQUIRED",
  "IDEMPOTENCY_KEY_COMMAND_MISMATCH",
  "INVALID_REQUEST",
  "PORTAL_NOT_FOUND",
  "PORTAL_REVISION_CONFLICT",
  "REPORT_GRANT_EXPIRY_INVALID",
  "SYNTHETIC_CASE_COLLISION",
  "SYNTHETIC_INVITE_COLLISION",
  "TEST_ADAPTER_FORBIDDEN_IN_PRODUCTION",
  "UPLOAD_CONTRACT_INVALID",
]);

function portalErrorCode(error: unknown): string | null {
  if (error instanceof PortalError) return error.code;
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && PORTAL_ERROR_CODES.has(code) ? code : null;
}

function requiredRevision(value: Record<string, unknown>): number {
  return requiredNonNegativeInteger(value, "expected_revision");
}

function requiredPositiveInteger(value: Record<string, unknown>, key: string): number {
  const item = requiredNonNegativeInteger(value, key);
  if (item < 1) throw new PortalHttpError("INVALID_REQUEST");
  return item;
}

function requiredNonNegativeInteger(value: Record<string, unknown>, key: string): number {
  const item = value[key];
  if (!Number.isSafeInteger(item) || (item as number) < 0) throw new PortalHttpError("INVALID_REQUEST");
  return item as number;
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const item = value[key];
  if (typeof item !== "string" || item.length < 1 || item.length > 512 || /[\u0000-\u001f]/.test(item)) throw new PortalHttpError("INVALID_REQUEST");
  return item;
}

function requiredVersion(value: Record<string, unknown>, key: string): string {
  const item = requiredString(value, key);
  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(item)) throw new PortalHttpError("INVALID_REQUEST");
  return item;
}

function requiredIdempotencyKey(value: Record<string, unknown>): string {
  const item = requiredString(value, "idempotency_key");
  if (!/^[A-Za-z0-9:_-]{8,128}$/.test(item)) throw new PortalHttpError("INVALID_REQUEST");
  return item;
}

function requiredPrivacyKind(value: Record<string, unknown>): PrivacyRequestKind {
  const item = value.request_kind;
  if (item !== "data_export" && item !== "correction" && item !== "deletion") throw new PortalHttpError("INVALID_REQUEST");
  return item;
}

function requiredSha256(value: Record<string, unknown>, key: string): string {
  const item = requiredString(value, key);
  if (!/^[a-f0-9]{64}$/.test(item)) throw new PortalHttpError("INVALID_REQUEST");
  return item;
}

function requiredIsoDate(value: Record<string, unknown>, key: string): string {
  const item = requiredString(value, key);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item) || Number.isNaN(Date.parse(item))) throw new PortalHttpError("INVALID_REQUEST");
  return item;
}

function requiredGrant(value: Record<string, unknown>): ReportAccessGrant {
  return Object.freeze({
    grant_id: requiredBoundedString(value, "grant_id", 4_096),
    case_id: requiredString(value, "case_id"),
    report_id: requiredString(value, "report_id"),
    artifact_sha256: requiredSha256(value, "artifact_sha256"),
    object_version_id: requiredString(value, "object_version_id"),
    expires_at: requiredIsoDate(value, "expires_at"),
    grant_sha256: requiredSha256(value, "grant_sha256"),
  });
}

function requiredBoundedString(value: Record<string, unknown>, key: string, maximum: number): string {
  const item = value[key];
  if (typeof item !== "string" || item.length < 1 || item.length > maximum || /[\u0000-\u001f]/u.test(item)) {
    throw new PortalHttpError("INVALID_REQUEST");
  }
  return item;
}
