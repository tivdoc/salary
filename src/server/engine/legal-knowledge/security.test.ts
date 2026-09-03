import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { syntheticSource } from "../../../engine/legal-knowledge/synthetic-fixtures.ts";
import { storeImmutableLegalArtifact } from "./artifacts.ts";
import {
  fetchLegalSourceBytes,
  safeLegalLogEvent,
  SafeLegalFetchError,
  sanitizeLegalUrlForLog,
  validateLegalSourceUrl,
} from "./security.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("official legal-source network boundary", () => {
  it.each([
    "https://www.gov.il/legal.pdf",
    "https://main.knesset.gov.il/law",
    "https://fs.knesset.gov.il/law.pdf",
    "https://www.btl.gov.il/Laws1/law.pdf",
  ])("allows official HTTPS URL %s", (url) => {
    expect(validateLegalSourceUrl(url).passed).toBe(true);
  });

  it("rejects HTTP", () => {
    expect(validateLegalSourceUrl("http://www.gov.il/legal.pdf")).toMatchObject({ passed: false, code: "https_required" });
  });

  it("rejects arbitrary third-party domains", () => {
    expect(validateLegalSourceUrl("https://example.test/legal.pdf")).toMatchObject({ passed: false, code: "domain_not_allowlisted" });
  });

  it("rejects embedded URL credentials", () => {
    expect(validateLegalSourceUrl("https://user:secret@www.gov.il/legal.pdf")).toMatchObject({ passed: false, code: "url_credentials_forbidden" });
  });

  it.each([
    ["file:///etc/passwd", "https_required"],
    ["data:text/plain,secret", "https_required"],
    ["https://localhost/source", "localhost_forbidden"],
    ["https://127.0.0.1/source", "ip_literal_forbidden"],
    ["https://169.254.169.254/source", "ip_literal_forbidden"],
    ["https://gov.il.evil.example/source", "domain_not_allowlisted"],
  ])("fails closed for unsafe URL %s", (url, code) => {
    expect(validateLegalSourceUrl(url)).toMatchObject({ passed: false, code });
  });

  it("redacts query and fragment material from URL logs", () => {
    expect(sanitizeLegalUrlForLog("https://www.gov.il/source?token=secret#fragment")).toBe("https://www.gov.il/source");
  });

  it("fetches bounded bytes with no credentials and a descriptive user agent", async () => {
    const calls: RequestInit[] = [];
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response("<html><body>synthetic official text</body></html>", {
        status: 200,
        headers: { "content-type": "text/html", "set-cookie": "must-not-be-stored=1", etag: "synthetic" },
      });
    };
    const result = await fetchLegalSourceBytes(syntheticSource(), { fetchImpl });
    expect(new TextDecoder().decode(result.bytes)).toContain("synthetic official text");
    expect(calls[0]).toMatchObject({ redirect: "manual", credentials: "omit", referrerPolicy: "no-referrer" });
    expect(new Headers(calls[0].headers).get("user-agent")).toContain("Tivdoc-LegalKnowledge");
    expect(result.safeHeaders).not.toHaveProperty("set-cookie");
  });

  it("allows a redirect between approved official domains", async () => {
    let call = 0;
    const fetchImpl = async () => {
      call += 1;
      return call === 1
        ? new Response(null, { status: 302, headers: { location: "https://www.gov.il/final" } })
        : new Response("<html><body>synthetic official redirect content</body></html>", { status: 200, headers: { "content-type": "text/html" } });
    };
    const result = await fetchLegalSourceBytes(syntheticSource(), { fetchImpl });
    expect(result.redirectCount).toBe(1);
    expect(result.finalUrl).toBe("https://www.gov.il/final");
  });

  it("rejects a redirect to an unapproved domain", async () => {
    const fetchImpl = async () => new Response(null, { status: 302, headers: { location: "https://example.test/final" } });
    await expect(fetchLegalSourceBytes(syntheticSource(), { fetchImpl })).rejects.toMatchObject({ code: "redirect_domain_rejected" });
  });

  it("rejects an allowlisted hostname when DNS resolves to a private address", async () => {
    const fetchImpl = async () => new Response("<html><body>must not be reached</body></html>", { headers: { "content-type": "text/html" } });
    await expect(fetchLegalSourceBytes(syntheticSource(), {
      fetchImpl,
      resolveHostname: async () => ["127.0.0.1", "169.254.169.254"],
    })).rejects.toMatchObject({ code: "resolved_private_address_forbidden" });
  });

  it("enforces the declared response-size limit", async () => {
    const fetchImpl = async () => new Response("small", { status: 200, headers: { "content-length": "1000" } });
    await expect(fetchLegalSourceBytes(syntheticSource(), { fetchImpl, maxBytes: 10 })).rejects.toMatchObject({ code: "response_too_large" });
  });

  it("enforces the streamed response-size limit", async () => {
    const fetchImpl = async () => new Response("synthetic response exceeding limit", { status: 200 });
    await expect(fetchLegalSourceBytes(syntheticSource(), { fetchImpl, maxBytes: 5 })).rejects.toMatchObject({ code: "response_too_large" });
  });

  it("enforces a timeout", async () => {
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    });
    await expect(fetchLegalSourceBytes(syntheticSource(), { fetchImpl, timeoutMs: 5 })).rejects.toMatchObject({ code: "fetch_timeout" });
  });

  it("maps HTTP failure to a safe code", async () => {
    const fetchImpl = async () => new Response("raw server body", { status: 503 });
    await expect(fetchLegalSourceBytes(syntheticSource(), { fetchImpl })).rejects.toEqual(new SafeLegalFetchError("http_status_503"));
  });

  it("rejects misleading MIME and PDF magic bytes", async () => {
    const pdf = syntheticSource({ artifact_format: "pdf" });
    const wrongMime = async () => new Response("<html><body>not a pdf</body></html>", { headers: { "content-type": "text/html" } });
    await expect(fetchLegalSourceBytes(pdf, { fetchImpl: wrongMime })).rejects.toMatchObject({ code: "declared_mime_mismatch" });
    const wrongMagic = async () => new Response("not a PDF despite enough bytes".repeat(30), { headers: { "content-type": "application/pdf" } });
    await expect(fetchLegalSourceBytes(pdf, { fetchImpl: wrongMagic })).rejects.toMatchObject({ code: "pdf_magic_mismatch" });
  });

  it("rejects challenge pages and empty viewer shells", async () => {
    const challenge = async () => new Response("<html><body>Cloudflare captcha - enable JavaScript and cookies</body></html>", { headers: { "content-type": "text/html" } });
    await expect(fetchLegalSourceBytes(syntheticSource(), { fetchImpl: challenge })).rejects.toMatchObject({ code: "html_challenge_or_error_page" });
    const shell = async () => new Response("<html><script>viewer()</script><body></body></html>", { headers: { "content-type": "text/html" } });
    await expect(fetchLegalSourceBytes(syntheticSource(), { fetchImpl: shell })).rejects.toMatchObject({ code: "html_wrapper_empty" });
  });

  // A6-4 / D-1b: the spreadsheet media-type exception is scoped to the BTL
  // host only, and only for a "table" source — it must not open a path for
  // any other host or artifact_format to smuggle a binary blob past the
  // otherwise-text-only "table"/"text" envelope.
  describe("BTL-only spreadsheet envelope (A6-4)", () => {
    const xlsxBytes = () => {
      const bytes = new Uint8Array(600);
      bytes[0] = 0x50;
      bytes[1] = 0x4b;
      bytes[2] = 0x03;
      bytes[3] = 0x04;
      return bytes;
    };
    const xlsBytes = () => {
      const bytes = new Uint8Array(600);
      [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].forEach((byte, index) => { bytes[index] = byte; });
      return bytes;
    };
    const btlTable = () => syntheticSource({
      canonical_url: "https://www.btl.gov.il/Mediniyut/GeneralData/Documents/synthetic.xlsx",
      artifact_format: "table",
    });

    it("accepts a real .xlsx from the BTL host", async () => {
      const fetchImpl = async () => new Response(xlsxBytes(), {
        status: 200,
        headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      });
      const result = await fetchLegalSourceBytes(btlTable(), { fetchImpl });
      expect(result.contentType).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    });

    it("accepts a real legacy .xls from the BTL host", async () => {
      const fetchImpl = async () => new Response(xlsBytes(), {
        status: 200,
        headers: { "content-type": "application/vnd.ms-excel" },
      });
      const result = await fetchLegalSourceBytes(btlTable(), { fetchImpl });
      expect(result.contentType).toBe("application/vnd.ms-excel");
    });

    it("rejects spreadsheet bytes failing the magic-byte check even with the right content-type", async () => {
      const fetchImpl = async () => new Response("not actually a zip".repeat(40), {
        status: 200,
        headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      });
      await expect(fetchLegalSourceBytes(btlTable(), { fetchImpl })).rejects.toMatchObject({ code: "xlsx_magic_mismatch" });
    });

    it("rejects a truncated spreadsheet under the byte floor", async () => {
      const fetchImpl = async () => new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
        status: 200,
        headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      });
      await expect(fetchLegalSourceBytes(btlTable(), { fetchImpl })).rejects.toMatchObject({ code: "document_truncated" });
    });

    it("rejects a spreadsheet content-type from a non-BTL official host", async () => {
      const nonBtlTable = syntheticSource({ canonical_url: "https://www.gov.il/synthetic.xlsx", artifact_format: "table" });
      const fetchImpl = async () => new Response(xlsxBytes(), {
        status: 200,
        headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      });
      await expect(fetchLegalSourceBytes(nonBtlTable, { fetchImpl })).rejects.toMatchObject({ code: "declared_mime_mismatch" });
    });

    it("rejects a spreadsheet content-type on a non-table artifact_format even from the BTL host", async () => {
      const btlHtml = syntheticSource({ canonical_url: "https://www.btl.gov.il/synthetic.xlsx", artifact_format: "html" });
      const fetchImpl = async () => new Response(xlsxBytes(), {
        status: 200,
        headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      });
      await expect(fetchLegalSourceBytes(btlHtml, { fetchImpl })).rejects.toMatchObject({ code: "declared_mime_mismatch" });
    });
  });
});

describe("immutable artifacts and safe logging", () => {
  it("stores an immutable content-addressed artifact idempotently", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tivdoc-legal-test-"));
    temporaryDirectories.push(directory);
    const bytes = new TextEncoder().encode("synthetic");
    const input = {
      root: directory,
      sourceId: "IL_SYNTHETIC_LAW",
      sourceVersion: "v1",
      artifactSha256: createHash("sha256").update(bytes).digest("hex"),
      extension: "txt",
      bytes,
    };
    const first = await storeImmutableLegalArtifact(input);
    const second = await storeImmutableLegalArtifact(input);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(await readFile(first.path, "utf8")).toBe("synthetic");
  });

  it("refuses byte changes at an existing artifact address", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tivdoc-legal-test-"));
    temporaryDirectories.push(directory);
    const firstBytes = new TextEncoder().encode("first");
    const input = {
      root: directory,
      sourceId: "IL_SYNTHETIC_LAW",
      sourceVersion: "v1",
      artifactSha256: createHash("sha256").update(firstBytes).digest("hex"),
      extension: "txt",
      bytes: firstBytes,
    };
    await storeImmutableLegalArtifact(input);
    await expect(storeImmutableLegalArtifact({ ...input, bytes: new TextEncoder().encode("second") }))
      .rejects.toThrow("artifact_hash_mismatch");
  });

  it("rejects a symlink escape in an artifact path", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tivdoc-legal-test-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "tivdoc-legal-outside-"));
    temporaryDirectories.push(directory, outside);
    await symlink(outside, path.join(directory, "IL_SYNTHETIC_LAW"), "junction");
    const bytes = new TextEncoder().encode("synthetic");
    await expect(storeImmutableLegalArtifact({
      root: directory,
      sourceId: "IL_SYNTHETIC_LAW",
      sourceVersion: "v1",
      artifactSha256: createHash("sha256").update(bytes).digest("hex"),
      extension: "txt",
      bytes,
    })).rejects.toThrow("artifact_symlink_escape");
  });

  it("safe logs discard raw text, cookies, secrets, and stack traces", () => {
    expect(safeLegalLogEvent({
      source_id: "IL_SYNTHETIC_LAW",
      source_version: "v1",
      stage: "fetch",
      status: "ok",
      raw_text: "synthetic legal body",
      cookie: "secret",
      authorization: "secret",
      stack: "raw stack",
      api_key: "secret",
    })).toEqual({ source_id: "IL_SYNTHETIC_LAW", source_version: "v1", stage: "fetch", status: "ok" });
  });
});
