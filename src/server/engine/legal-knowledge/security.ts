import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import type { LegalSource } from "../../../engine/legal-knowledge/contracts.ts";

export const LEGAL_SOURCE_ALLOWED_HOSTS = new Set([
  "www.gov.il",
  "gov.il",
  "main.knesset.gov.il",
  "fs.knesset.gov.il",
  "www.btl.gov.il",
  "btl.gov.il",
  // Addendum 7 A7-5: a .gov.il subdomain is an official host by the same
  // rule as every other entry above — the allowlist's purpose is
  // officiality, not a fixed list. Ministry of Labor's collective
  // agreement registry, needed for D-5's second half (the 1998 general
  // collective agreement on convalescence pay).
  "workagreements.labor.gov.il",
]);

export const LEGAL_FETCH_MAX_BYTES = 20 * 1024 * 1024;
export const LEGAL_FETCH_TIMEOUT_MS = 15_000;
export const LEGAL_FETCH_USER_AGENT = "Tivdoc-LegalKnowledge/0.1 (public-official-sources-only)";

// A6-4: one bounded extension to the "table" artifact_format's media
// allowlist, scoped to the BTL host only. The Excel is historical
// corroboration and never outranks the HTML page (D-1) or the law itself —
// this narrows *what content-type is accepted*, it does not add a host to
// LEGAL_SOURCE_ALLOWED_HOSTS above (btl.gov.il/www.btl.gov.il are already
// there).
export const LEGAL_SOURCE_SPREADSHEET_CONTENT_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
]);
export const LEGAL_SOURCE_SPREADSHEET_ALLOWED_HOSTS = new Set(["www.btl.gov.il", "btl.gov.il"]);

export function validateLegalSourceUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { passed: false as const, code: "invalid_url" };
  }
  if (url.protocol !== "https:") return { passed: false as const, code: "https_required" };
  if (url.username || url.password) return { passed: false as const, code: "url_credentials_forbidden" };
  if (url.hash) return { passed: false as const, code: "url_fragment_forbidden" };
  const hostname = url.hostname.toLowerCase().replace(/^\[(.*)\]$/u, "$1");
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return { passed: false as const, code: "localhost_forbidden" };
  if (isIP(hostname) !== 0) return { passed: false as const, code: "ip_literal_forbidden" };
  if (!LEGAL_SOURCE_ALLOWED_HOSTS.has(hostname)) return { passed: false as const, code: "domain_not_allowlisted" };
  return { passed: true as const, url };
}

export function sanitizeLegalUrlForLog(value: string) {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "invalid-url";
  }
}

export function isPrivateOrLocalAddress(address: string) {
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized === "::" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
  const ipv4 = mapped ?? (isIP(normalized) === 4 ? normalized : null);
  if (!ipv4) return false;
  const [a, b] = ipv4.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

export type SafeLegalFetchResult = Readonly<{
  bytes: Uint8Array;
  finalUrl: string;
  contentType: string;
  safeHeaders: Readonly<Record<string, string>>;
  redirectCount: number;
  redirectChain: readonly string[];
}>;

export class SafeLegalFetchError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "SafeLegalFetchError";
  }
}

type FetchableLegalDocument = Pick<LegalSource, "canonical_url" | "artifact_format">;

function sourceHostname(source: FetchableLegalDocument): string | null {
  try {
    return new URL(source.canonical_url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isBtlSpreadsheetEnvelope(source: FetchableLegalDocument, contentType: string, hostname: string | null) {
  return source.artifact_format === "table"
    && hostname !== null
    && LEGAL_SOURCE_SPREADSHEET_ALLOWED_HOSTS.has(hostname)
    && LEGAL_SOURCE_SPREADSHEET_CONTENT_TYPES.has(contentType);
}

function contentTypeMatches(source: FetchableLegalDocument, contentType: string, hostname: string | null) {
  if (source.artifact_format === "pdf") return contentType === "application/pdf" || contentType === "application/octet-stream";
  if (source.artifact_format === "html") return contentType === "text/html" || contentType === "application/xhtml+xml";
  if (isBtlSpreadsheetEnvelope(source, contentType, hostname)) return true;
  return contentType.startsWith("text/") || contentType === "application/json" || contentType === "text/html";
}

export function validateLegalContentEnvelope(
  source: FetchableLegalDocument,
  bytes: Uint8Array,
  contentType: string,
) {
  const hostname = sourceHostname(source);
  if (!contentTypeMatches(source, contentType, hostname)) return { passed: false as const, code: "declared_mime_mismatch" };
  if (source.artifact_format === "pdf") {
    const signature = new TextDecoder("ascii").decode(bytes.slice(0, 5));
    if (signature !== "%PDF-") return { passed: false as const, code: "pdf_magic_mismatch" };
    if (bytes.byteLength < 512) return { passed: false as const, code: "document_truncated" };
    return { passed: true as const };
  }
  if (isBtlSpreadsheetEnvelope(source, contentType, hostname)) {
    if (bytes.byteLength < 512) return { passed: false as const, code: "document_truncated" };
    if (contentType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
      // .xlsx is a ZIP container; a real one always opens with a local file
      // header ("PK\x03\x04"), same rigor tier as the PDF magic-byte check.
      if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return { passed: false as const, code: "xlsx_magic_mismatch" };
      return { passed: true as const };
    }
    // application/vnd.ms-excel: legacy binary .xls, an OLE compound file.
    const oleSignature = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
    if (!oleSignature.every((byte, index) => bytes[index] === byte)) return { passed: false as const, code: "xls_magic_mismatch" };
    return { passed: true as const };
  }
  const prefix = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, Math.min(bytes.byteLength, 32_768)));
  if (source.artifact_format === "html") {
    if (!/<(?:!doctype\s+html|html|body)\b/iu.test(prefix)) return { passed: false as const, code: "html_signature_mismatch" };
    if (/(?:kramericaindustries|cf-chl-|cloudflare|captcha|access\s+denied|enable\s+javascript\s+and\s+cookies)/iu.test(prefix)) {
      return { passed: false as const, code: "html_challenge_or_error_page" };
    }
    const visible = prefix.replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, "").replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, "").replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim();
    if (visible.length < 20) return { passed: false as const, code: "html_wrapper_empty" };
  } else if (bytes.byteLength === 0) return { passed: false as const, code: "document_empty" };
  return { passed: true as const };
}

export async function fetchLegalSourceBytes(
  source: FetchableLegalDocument,
  options: Readonly<{
    fetchImpl?: typeof fetch;
    maxBytes?: number;
    timeoutMs?: number;
    maxRedirects?: number;
    resolveHostname?: (hostname: string) => Promise<readonly string[]>;
  }> = {},
): Promise<SafeLegalFetchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? LEGAL_FETCH_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? 4;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? LEGAL_FETCH_TIMEOUT_MS);
  let current = source.canonical_url;
  let redirectCount = 0;
  const redirectChain: string[] = [];
  try {
    while (true) {
      const validation = validateLegalSourceUrl(current);
      if (!validation.passed) throw new SafeLegalFetchError(validation.code);
      redirectChain.push(sanitizeLegalUrlForLog(validation.url.toString()));
      const resolveHostname = options.resolveHostname ?? (options.fetchImpl ? null : async (hostname: string) => (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address));
      if (resolveHostname) {
        let addresses: readonly string[];
        try {
          addresses = await resolveHostname(validation.url.hostname);
        } catch {
          throw new SafeLegalFetchError("dns_lookup_failed");
        }
        if (addresses.length === 0) throw new SafeLegalFetchError("dns_lookup_empty");
        if (addresses.some(isPrivateOrLocalAddress)) throw new SafeLegalFetchError("resolved_private_address_forbidden");
      }
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
      const envelope = validateLegalContentEnvelope(source, bytes, contentType);
      if (!envelope.passed) throw new SafeLegalFetchError(envelope.code);
      const safeHeaders = Object.fromEntries(
        ["content-type", "content-length", "etag", "last-modified"]
          .map((name) => [name, response.headers.get(name)] as const)
          .filter((entry): entry is readonly [string, string] => entry[1] !== null),
      );
      return { bytes, finalUrl: validation.url.toString(), contentType, safeHeaders, redirectCount, redirectChain };
    }
  } finally {
    clearTimeout(timeout);
  }
}

export function safeLegalLogEvent(event: Readonly<Record<string, unknown>>) {
  const allowed = new Set(["source_id", "source_version", "domain", "stage", "status", "duration_ms", "byte_count", "hash_prefix", "safe_error_code"]);
  return Object.fromEntries(Object.entries(event).filter(([key, value]) => allowed.has(key) && ["string", "number", "boolean"].includes(typeof value)));
}
