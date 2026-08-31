import "./server-boundary.ts";

export const PRODUCT_HTTP_HEADERS = Object.freeze({
  "cache-control": "private, no-store, max-age=0",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow, noarchive",
});

export function productNotFound(): Response {
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
  return raw.every((segment) => /^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/.test(segment) && segment !== "." && segment !== "..")
    ? Object.freeze([...raw])
    : null;
}
