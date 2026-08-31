import "./server-boundary.ts";

import type { ProductAudience } from "./hermetic-session.ts";
import { runtimeHermeticSessionManager } from "./hermetic-session.ts";

const SAFE_HEADERS = Object.freeze({
  "cache-control": "private, no-store, max-age=0",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow, noarchive",
});

export async function issueProductSession(request: Request, audience: ProductAudience, enabled: boolean): Promise<Response> {
  if (!enabled) return notFound();
  const body = await strictTicketBody(request);
  if (!body) return notFound();
  const issued = runtimeHermeticSessionManager().issue(request, audience, body.ticket);
  if (!issued) return notFound();
  return Response.json(
    { csrf_token: issued.csrf_token, expires_at_epoch: issued.expires_at_epoch },
    { status: 201, headers: { ...SAFE_HEADERS, "set-cookie": issued.cookie } },
  );
}

export async function revokeProductSession(request: Request, audience: ProductAudience, enabled: boolean): Promise<Response> {
  if (!enabled) return notFound();
  const cookie = runtimeHermeticSessionManager().revoke(request, audience);
  if (!cookie) return notFound();
  return new Response(null, { status: 204, headers: { ...SAFE_HEADERS, "set-cookie": cookie } });
}

async function strictTicketBody(request: Request): Promise<Readonly<{ ticket: string }> | null> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return null;
  const text = await request.text();
  if (text.length < 1 || Buffer.byteLength(text, "utf8") > 512) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).join(",") !== "ticket" || typeof record.ticket !== "string" || !/^[A-Za-z0-9:_-]{16,160}$/.test(record.ticket)) return null;
  return Object.freeze({ ticket: record.ticket });
}

function notFound(): Response {
  return new Response(null, { status: 404, headers: SAFE_HEADERS });
}
