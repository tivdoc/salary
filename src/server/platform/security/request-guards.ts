import { isIP } from "node:net";
import { timingSafeEqual } from "node:crypto";

function forbiddenIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 2 || b === 168)) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0) || a >= 224;
}

function forbiddenIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0];
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd") || /^fe[89ab]/.test(normalized) || normalized.startsWith("ff") || normalized.startsWith("2001:db8") || normalized.startsWith("2001:10") || normalized.startsWith("2001:2:") || normalized.startsWith("2002:")) return true;
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  return mapped ? forbiddenIpv4(mapped) : false;
}

export function isForbiddenNetworkAddress(address: string): boolean {
  const family = isIP(address);
  return family === 0 || (family === 4 ? forbiddenIpv4(address) : forbiddenIpv6(address));
}

export async function validateOutboundHttpsTarget(
  rawUrl: string,
  resolveHost: (hostname: string) => Promise<readonly string[]>,
): Promise<Readonly<{ url: string; hostname: string; pinned_addresses: readonly string[] }>> {
  if (rawUrl.length === 0 || rawUrl.length > 2048) throw new Error("SSRF_URL_INVALID");
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("SSRF_URL_INVALID");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash || (parsed.port && parsed.port !== "443")) throw new Error("SSRF_URL_FORBIDDEN");
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "metadata.google.internal" || hostname.endsWith(".internal") || isIP(hostname)) {
    throw new Error("SSRF_HOST_FORBIDDEN");
  }
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname)) throw new Error("SSRF_HOST_FORBIDDEN");
  const addresses = [...new Set(await resolveHost(hostname))].sort();
  if (addresses.length === 0 || addresses.length > 8 || addresses.some(isForbiddenNetworkAddress)) throw new Error("SSRF_DNS_FORBIDDEN");
  parsed.hostname = hostname;
  return Object.freeze({ url: parsed.toString(), hostname, pinned_addresses: Object.freeze(addresses) });
}

export async function validateRedirectChain(
  urls: readonly string[],
  resolveHost: (hostname: string) => Promise<readonly string[]>,
): Promise<readonly Readonly<{ url: string; hostname: string; pinned_addresses: readonly string[] }>[]> {
  if (urls.length === 0 || urls.length > 4) throw new Error("SSRF_REDIRECT_LIMIT");
  const validated = [];
  for (const url of urls) validated.push(await validateOutboundHttpsTarget(url, resolveHost));
  return Object.freeze(validated);
}

function equalToken(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

export function assertCsrfProtectedMutation(input: Readonly<{
  method: string;
  origin: string | null;
  allowed_origin: string;
  cookie_token: string | null;
  header_token: string | null;
  content_type: string | null;
}>): void {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(input.method.toUpperCase())) throw new Error("CSRF_METHOD_INVALID");
  if (input.origin !== input.allowed_origin || !input.origin?.startsWith("https://")) throw new Error("CSRF_ORIGIN_INVALID");
  if (!input.content_type?.toLowerCase().startsWith("application/json")) throw new Error("CSRF_CONTENT_TYPE_INVALID");
  if (!input.cookie_token || !input.header_token || input.cookie_token.length < 32 || !equalToken(input.cookie_token, input.header_token)) throw new Error("CSRF_TOKEN_INVALID");
}

export function assertBoundedJsonInput(value: unknown, maxBytes = 64 * 1024): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 1024 * 1024) throw new Error("INPUT_LIMIT_INVALID");
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("INPUT_JSON_INVALID");
  }
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > maxBytes || /(?:__proto__|constructor|prototype)/i.test(serialized)) throw new Error("INPUT_REJECTED");
}

export function renderUntrustedTextInert(value: string): string {
  if (value.length > 100_000) throw new Error("UNTRUSTED_TEXT_LIMIT");
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export type ParameterizedQuery = Readonly<{ text: string; values: readonly unknown[] }>;

export function parameterizedSql(strings: TemplateStringsArray, ...values: readonly unknown[]): ParameterizedQuery {
  if (strings.some((segment) => segment.includes("\0")) || values.some((value) => !(value === null || ["string", "number", "boolean"].includes(typeof value) || value instanceof Uint8Array))) {
    throw new Error("SQL_PARAMETER_INVALID");
  }
  const text = strings.reduce((result, segment, index) => `${result}${segment}${index < values.length ? `$${index + 1}` : ""}`, "");
  if (!/^\s*(SELECT|INSERT|UPDATE|DELETE)\b/i.test(text) || /(?:--|\/\*|;\s*\S)/.test(text)) throw new Error("SQL_TEMPLATE_INVALID");
  return Object.freeze({ text, values: Object.freeze([...values]) });
}

export class InMemoryAdmissionLimiter {
  readonly #buckets = new Map<string, { windowStart: number; requests: number; inFlight: number }>();
  readonly #maxRequests: number;
  readonly #maxInFlight: number;
  readonly #windowMs: number;

  constructor(input: Readonly<{ max_requests: number; max_in_flight: number; window_ms: number }>) {
    if (![input.max_requests, input.max_in_flight, input.window_ms].every((value) => Number.isSafeInteger(value) && value > 0) || input.max_requests > 10_000 || input.max_in_flight > 1_000 || input.window_ms > 3_600_000) {
      throw new Error("ADMISSION_LIMIT_INVALID");
    }
    this.#maxRequests = input.max_requests;
    this.#maxInFlight = input.max_in_flight;
    this.#windowMs = input.window_ms;
  }

  admit(subject: string, nowMs: number): Readonly<{ release(): void }> {
    if (!/^[a-z][a-z0-9_-]{7,63}$/.test(subject) || !Number.isFinite(nowMs)) throw new Error("ADMISSION_SUBJECT_INVALID");
    let bucket = this.#buckets.get(subject);
    if (!bucket || nowMs - bucket.windowStart >= this.#windowMs) {
      bucket = { windowStart: nowMs, requests: 0, inFlight: 0 };
      this.#buckets.set(subject, bucket);
    }
    if (bucket.requests >= this.#maxRequests) throw new Error("ADMISSION_RATE_LIMITED");
    if (bucket.inFlight >= this.#maxInFlight) throw new Error("ADMISSION_CONCURRENCY_LIMITED");
    bucket.requests += 1;
    bucket.inFlight += 1;
    let released = false;
    return Object.freeze({ release: () => { if (!released) { released = true; bucket!.inFlight -= 1; } } });
  }
}
