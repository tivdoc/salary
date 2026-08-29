import type { LegalSource } from "../../../engine/legal-knowledge/contracts.ts";

export const LEGAL_SOURCE_ALLOWED_HOSTS = new Set([
  "www.gov.il",
  "gov.il",
  "main.knesset.gov.il",
  "fs.knesset.gov.il",
  "www.btl.gov.il",
  "btl.gov.il",
]);

export const LEGAL_FETCH_MAX_BYTES = 20 * 1024 * 1024;
export const LEGAL_FETCH_TIMEOUT_MS = 15_000;
export const LEGAL_FETCH_USER_AGENT = "Tivdoc-LegalKnowledge/0.1 (public-official-sources-only)";

export function validateLegalSourceUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { passed: false as const, code: "invalid_url" };
  }
  if (url.protocol !== "https:") return { passed: false as const, code: "https_required" };
  if (url.username || url.password) return { passed: false as const, code: "url_credentials_forbidden" };
  if (!LEGAL_SOURCE_ALLOWED_HOSTS.has(url.hostname.toLowerCase())) return { passed: false as const, code: "domain_not_allowlisted" };
  return { passed: true as const, url };
}

export type SafeLegalFetchResult = Readonly<{
  bytes: Uint8Array;
  finalUrl: string;
  contentType: string;
  safeHeaders: Readonly<Record<string, string>>;
  redirectCount: number;
}>;

export class SafeLegalFetchError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "SafeLegalFetchError";
  }
}

export async function fetchLegalSourceBytes(
  source: LegalSource,
  options: Readonly<{
    fetchImpl?: typeof fetch;
    maxBytes?: number;
    timeoutMs?: number;
    maxRedirects?: number;
  }> = {},
): Promise<SafeLegalFetchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? LEGAL_FETCH_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? 4;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? LEGAL_FETCH_TIMEOUT_MS);
  let current = source.canonical_url;
  let redirectCount = 0;
  try {
    while (true) {
      const validation = validateLegalSourceUrl(current);
      if (!validation.passed) throw new SafeLegalFetchError(validation.code);
      let response: Response;
      try {
        response = await fetchImpl(validation.url, {
          method: "GET",
          redirect: "manual",
          headers: { Accept: "text/html,application/pdf,text/plain;q=0.9,*/*;q=0.1", "User-Agent": LEGAL_FETCH_USER_AGENT },
          signal: controller.signal,
          credentials: "omit",
          referrerPolicy: "no-referrer",
        });
      } catch (error) {
        if (error instanceof SafeLegalFetchError) throw error;
        throw new SafeLegalFetchError(error instanceof DOMException && error.name === "AbortError" ? "fetch_timeout" : "fetch_failed");
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new SafeLegalFetchError("redirect_location_missing");
        if (redirectCount >= maxRedirects) throw new SafeLegalFetchError("redirect_limit_exceeded");
        const next = new URL(location, validation.url).toString();
        const redirectValidation = validateLegalSourceUrl(next);
        if (!redirectValidation.passed) throw new SafeLegalFetchError("redirect_domain_rejected");
        current = next;
        redirectCount += 1;
        continue;
      }
      if (!response.ok) throw new SafeLegalFetchError(`http_status_${response.status}`);
      const declaredLength = Number(response.headers.get("content-length") ?? "0");
      if (declaredLength > maxBytes) throw new SafeLegalFetchError("response_too_large");
      if (!response.body) throw new SafeLegalFetchError("response_body_missing");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let byteCount = 0;
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        byteCount += item.value.byteLength;
        if (byteCount > maxBytes) {
          await reader.cancel();
          throw new SafeLegalFetchError("response_too_large");
        }
        chunks.push(item.value);
      }
      const bytes = new Uint8Array(byteCount);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() || "application/octet-stream";
      const safeHeaders = Object.fromEntries(
        ["content-type", "content-length", "etag", "last-modified"]
          .map((name) => [name, response.headers.get(name)] as const)
          .filter((entry): entry is readonly [string, string] => entry[1] !== null),
      );
      return { bytes, finalUrl: validation.url.toString(), contentType, safeHeaders, redirectCount };
    }
  } finally {
    clearTimeout(timeout);
  }
}

export function safeLegalLogEvent(event: Readonly<Record<string, unknown>>) {
  const allowed = new Set(["source_id", "source_version", "domain", "stage", "status", "duration_ms", "byte_count", "hash_prefix", "safe_error_code"]);
  return Object.fromEntries(Object.entries(event).filter(([key, value]) => allowed.has(key) && ["string", "number", "boolean"].includes(typeof value)));
}
