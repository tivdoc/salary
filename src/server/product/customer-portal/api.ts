import type { VerifiedActor } from "../../../engine/wave4/contracts";
import type {
  PortalRequestIdentityPort,
  PrivacyRequestKind,
  ReportAccessGrant,
} from "./contracts";
import { PortalError } from "./contracts";
import type { CustomerPortalService } from "./service";

type RouteContext = Readonly<{ params: Promise<Readonly<{ resource?: readonly string[] }>> }>;
type VerifiedRequest = Readonly<{ actor: VerifiedActor; csrf_valid: boolean }>;
type Handler = (request: Request, context: RouteContext) => Promise<Response>;

const MAX_JSON_BYTES = 16_384;

export function createPortalApi(service: CustomerPortalService, identity: PortalRequestIdentityPort): Readonly<{ GET: Handler; POST: Handler }> {
  return Object.freeze({
    GET: async (request, context) => handle(async () => {
      const segments = await segmentsFrom(context);
      const verified = await requireIdentity(identity, request, false);
      if (segments.length === 2 && segments[0] === "case") {
        return json(service.getCaseProjection(verified.actor, segments[1]));
      }
      if (segments.length === 3 && segments[0] === "case" && segments[2] === "reports") {
        return json(service.listReports(verified.actor, segments[1]));
      }
      return notFound();
    }),
    POST: async (request, context) => handle(async () => {
      const segments = await segmentsFrom(context);
      if (segments.length === 2 && segments[0] === "invite" && segments[1] === "accept") {
        const body = await strictJson(request);
        exactKeys(body, ["token", "audience"]);
        return json(service.acceptSyntheticInvite(requiredString(body, "token"), requiredString(body, "audience")));
      }
      const verified = await requireIdentity(identity, request, true);
      const body = await strictJson(request);
      if (segments.length === 3 && segments[0] === "case" && segments[2] === "consent") {
        exactKeys(body, ["consent_version", "terms_version", "granted", "idempotency_key"]);
        return json(service.recordConsent(verified.actor, {
          case_id: segments[1],
          consent_version: requiredVersion(body, "consent_version"),
          terms_version: requiredVersion(body, "terms_version"),
          granted: requiredBoolean(body, "granted"),
          idempotency_key: requiredIdempotencyKey(body),
        }));
      }
      if (segments.length === 3 && segments[0] === "case" && segments[2] === "privacy") {
        exactKeys(body, ["request_kind", "idempotency_key"]);
        return json(service.createPrivacyRequest(verified.actor, {
          case_id: segments[1],
          request_kind: requiredPrivacyKind(body),
          idempotency_key: requiredIdempotencyKey(body),
        }));
      }
      if (segments.length === 5 && segments[0] === "case" && segments[2] === "clarifications" && segments[4] === "answer") {
        exactKeys(body, ["question_version", "value", "explicit_confirmation", "consent_version", "terms_version", "idempotency_key"]);
        if (body.explicit_confirmation !== true) throw new PortalError("INVALID_REQUEST");
        return json(service.answerClarification(verified.actor, {
          case_id: segments[1],
          task_id: segments[3],
          question_version: requiredPositiveInteger(body, "question_version"),
          value: body.value,
          explicit_confirmation: true,
          consent_version: requiredVersion(body, "consent_version"),
          terms_version: requiredVersion(body, "terms_version"),
          idempotency_key: requiredIdempotencyKey(body),
        }));
      }
      if (segments.length === 4 && segments[0] === "case" && segments[2] === "uploads" && segments[3] === "reserve") {
        exactKeys(body, ["document_id", "expected_sha256", "expected_length", "detected_mime", "expires_at", "idempotency_key"]);
        return json(service.reserveUpload(verified.actor, {
          case_id: segments[1],
          document_id: requiredString(body, "document_id"),
          expected_sha256: requiredSha256(body, "expected_sha256"),
          expected_length: requiredPositiveInteger(body, "expected_length"),
          detected_mime: requiredString(body, "detected_mime"),
          expires_at: requiredIsoDate(body, "expires_at"),
          idempotency_key: requiredIdempotencyKey(body),
        }));
      }
      if (segments.length === 5 && segments[0] === "case" && segments[2] === "reports" && segments[4] === "grant") {
        exactKeys(body, []);
        return json(service.createReportAccessGrant(verified.actor, segments[1], segments[3]));
      }
      if (segments.length === 2 && segments[0] === "reports" && segments[1] === "download") {
        exactKeys(body, ["grant_id", "case_id", "report_id", "artifact_sha256", "object_version_id", "expires_at", "grant_sha256"]);
        const download = service.downloadReport(verified.actor, requiredGrant(body));
        return new Response(Uint8Array.from(download.bytes).buffer, {
          status: 200,
          headers: {
            "cache-control": "private, no-store",
            "content-disposition": `attachment; filename="${download.filename}"`,
            "content-type": download.content_type,
            "x-content-type-options": "nosniff",
          },
        });
      }
      return notFound();
    }),
  });
}

async function handle(action: () => Promise<Response>): Promise<Response> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof PortalError && error.code === "PORTAL_NOT_FOUND") return notFound();
    if (error instanceof PortalError) return json({ error: "invalid_request" }, 400);
    return json({ error: "request_failed" }, 500);
  }
}

async function segmentsFrom(context: RouteContext): Promise<readonly string[]> {
  const segments = (await context.params).resource ?? [];
  if (segments.some((segment) => !/^[a-zA-Z0-9:_-]{1,160}$/.test(segment))) throw new PortalError("PORTAL_NOT_FOUND");
  return segments;
}

async function requireIdentity(identity: PortalRequestIdentityPort, request: Request, requireCsrf: boolean): Promise<VerifiedRequest> {
  const verified = await identity.verify(request);
  if (!verified || verified.actor.verified_server_side !== true || (requireCsrf && !verified.csrf_valid)) {
    throw new PortalError("PORTAL_NOT_FOUND");
  }
  return verified;
}

async function strictJson(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new PortalError("INVALID_REQUEST");
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) throw new PortalError("INVALID_REQUEST");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) throw new PortalError("INVALID_REQUEST");
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new PortalError("INVALID_REQUEST"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new PortalError("INVALID_REQUEST");
  return parsed as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new PortalError("INVALID_REQUEST");
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const item = value[key];
  if (typeof item !== "string" || item.length < 1 || item.length > 512 || /[\u0000-\u001f]/.test(item)) throw new PortalError("INVALID_REQUEST");
  return item;
}

function requiredVersion(value: Record<string, unknown>, key: string): string {
  const item = requiredString(value, key);
  if (!/^[a-zA-Z0-9._:-]{1,80}$/.test(item)) throw new PortalError("INVALID_REQUEST");
  return item;
}

function requiredBoolean(value: Record<string, unknown>, key: string): boolean {
  if (typeof value[key] !== "boolean") throw new PortalError("INVALID_REQUEST");
  return value[key];
}

function requiredPositiveInteger(value: Record<string, unknown>, key: string): number {
  const item = value[key];
  if (!Number.isSafeInteger(item) || (item as number) < 1) throw new PortalError("INVALID_REQUEST");
  return item as number;
}

function requiredIdempotencyKey(value: Record<string, unknown>): string {
  const key = requiredString(value, "idempotency_key");
  if (!/^[a-zA-Z0-9:_-]{8,128}$/.test(key)) throw new PortalError("INVALID_REQUEST");
  return key;
}

function requiredPrivacyKind(value: Record<string, unknown>): PrivacyRequestKind {
  const kind = value.request_kind;
  if (kind !== "data_export" && kind !== "correction" && kind !== "deletion") throw new PortalError("INVALID_REQUEST");
  return kind;
}

function requiredSha256(value: Record<string, unknown>, key: string): string {
  const digest = requiredString(value, key);
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new PortalError("INVALID_REQUEST");
  return digest;
}

function requiredIsoDate(value: Record<string, unknown>, key: string): string {
  const item = requiredString(value, key);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item) || Number.isNaN(Date.parse(item))) throw new PortalError("INVALID_REQUEST");
  return item;
}

function requiredGrant(value: Record<string, unknown>): ReportAccessGrant {
  return Object.freeze({
    grant_id: requiredString(value, "grant_id"),
    case_id: requiredString(value, "case_id"),
    report_id: requiredString(value, "report_id"),
    artifact_sha256: requiredSha256(value, "artifact_sha256"),
    object_version_id: requiredString(value, "object_version_id"),
    expires_at: requiredIsoDate(value, "expires_at"),
    grant_sha256: requiredSha256(value, "grant_sha256"),
  });
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
}

function notFound(): Response {
  return new Response(null, { status: 404, headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
}
