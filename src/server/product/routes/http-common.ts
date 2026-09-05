import { isCapabilityBlockedError } from "../../platform/capabilities/stable-entrypoint-runtime.ts";
import "./server-boundary.ts";

export const PRODUCT_HTTP_HEADERS = Object.freeze({
  "cache-control": "private, no-store, max-age=0",
  "content-security-policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow, noarchive",
});

/**
 * Why a bare 404 was returned.
 *
 * The response body stays empty and identical for every cause: a refusal must
 * not disclose whether a path, a capability or a session was the problem. But
 * three unrelated conditions producing one indistinguishable 404 cost a whole
 * run to localise, so the cause is recorded internally. Codes only — never a
 * path, an identifier, an actor or any part of a request.
 */
export const PRODUCT_NOT_FOUND_REASONS = Object.freeze([
  "CAPABILITY_BLOCKED",
  "SURFACE_DISABLED",
  "SERVICE_ABSENT",
  "SESSION_BOUNDARY_ABSENT",
  "SESSION_UNVERIFIED",
  "PATH_NOT_ROUTED",
  "SEGMENTS_UNSAFE",
  "CAPABILITY_ABSENT",
  "RESOURCE_ABSENT",
  "UNSPECIFIED",
] as const);

export type ProductNotFoundReason = (typeof PRODUCT_NOT_FOUND_REASONS)[number];

const NOT_FOUND_LOG_LIMIT = 64;
const notFoundLog: { reason: ProductNotFoundReason; at: string }[] = [];

/** The recent refusal reasons, newest last. Codes and timestamps only. */
export function readProductNotFoundLog(): readonly Readonly<{ reason: ProductNotFoundReason; at: string }>[] {
  return Object.freeze(notFoundLog.map((entry) => Object.freeze({ ...entry })));
}

export function clearProductNotFoundLog(): void {
  notFoundLog.length = 0;
}

/**
 * L8-1 / D2. The one answer a blocked dispatcher gives: the product 404, the
 * same shape as every other refusal, with the cause logged server-side only.
 * Any other error is not the guard's business and is rethrown.
 */
export function refusedEntrypoint(error: unknown): Response {
  if (isCapabilityBlockedError(error)) return productNotFound("CAPABILITY_BLOCKED");
  throw error;
}

export function productNotFound(reason: ProductNotFoundReason = "UNSPECIFIED"): Response {
  notFoundLog.push({ reason, at: new Date().toISOString() });
  if (notFoundLog.length > NOT_FOUND_LOG_LIMIT) notFoundLog.shift();
  // Server-side only, and only the code. There is no diagnostic endpoint: the
  // cause must never become observable to the caller being refused.
  if (process.env.NODE_ENV !== "test") process.stderr.write(`product_not_found ${reason}\n`);
  return new Response(null, { status: 404, headers: PRODUCT_HTTP_HEADERS });
}

export function productJson(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: PRODUCT_HTTP_HEADERS });
}

export async function strictJsonObject(request: Request, maximumBytes = 65_536): Promise<Record<string, unknown> | null> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return null;
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maximumBytes) return null;
  const text = await request.text();
  if (text.length < 1 || Buffer.byteLength(text, "utf8") > maximumBytes) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function exactObjectKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

export function safeSegments(raw: readonly string[]): readonly string[] | null {
  if (raw.length < 1 || raw.length > 7) return null;
  const decoded: string[] = [];
  for (const segment of raw) {
    let value: string;
    try {
      value = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/.test(value) || value === "." || value === "..") return null;
    decoded.push(value);
  }
  return Object.freeze(decoded);
}
