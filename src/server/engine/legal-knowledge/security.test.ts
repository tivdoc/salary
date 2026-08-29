import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { syntheticSource } from "../../../engine/legal-knowledge/synthetic-fixtures.ts";
import { storeImmutableLegalArtifact } from "./artifacts.ts";
import {
  fetchLegalSourceBytes,
  safeLegalLogEvent,
  SafeLegalFetchError,
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

  it("fetches bounded bytes with no credentials and a descriptive user agent", async () => {
    const calls: RequestInit[] = [];
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response("synthetic official text", {
        status: 200,
        headers: { "content-type": "text/plain", "set-cookie": "must-not-be-stored=1", etag: "synthetic" },
      });
    };
    const result = await fetchLegalSourceBytes(syntheticSource(), { fetchImpl });
    expect(new TextDecoder().decode(result.bytes)).toBe("synthetic official text");
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
        : new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    };
    const result = await fetchLegalSourceBytes(syntheticSource(), { fetchImpl });
    expect(result.redirectCount).toBe(1);
    expect(result.finalUrl).toBe("https://www.gov.il/final");
  });

  it("rejects a redirect to an unapproved domain", async () => {
    const fetchImpl = async () => new Response(null, { status: 302, headers: { location: "https://example.test/final" } });
    await expect(fetchLegalSourceBytes(syntheticSource(), { fetchImpl })).rejects.toMatchObject({ code: "redirect_domain_rejected" });
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
});

describe("immutable artifacts and safe logging", () => {
  it("stores an immutable content-addressed artifact idempotently", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tivdoc-legal-test-"));
    temporaryDirectories.push(directory);
    const input = {
      root: directory,
      sourceId: "IL_SYNTHETIC_LAW",
      sourceVersion: "v1",
      artifactSha256: "a".repeat(64),
      extension: "txt",
      bytes: new TextEncoder().encode("synthetic"),
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
    const input = {
      root: directory,
      sourceId: "IL_SYNTHETIC_LAW",
      sourceVersion: "v1",
      artifactSha256: "a".repeat(64),
      extension: "txt",
      bytes: new TextEncoder().encode("first"),
    };
    await storeImmutableLegalArtifact(input);
    await expect(storeImmutableLegalArtifact({ ...input, bytes: new TextEncoder().encode("second") }))
      .rejects.toThrow("immutable_artifact_mismatch");
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
