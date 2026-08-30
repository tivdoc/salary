import { describe, expect, it } from "vitest";

import { assertParserMayRun, parserSandboxCapability, parserSandboxSpecification } from "./parser-sandbox";
import { assertSafeOperationalRecord, assertServerSecretConfiguration, scanPrivacyCanaries } from "./privacy";
import { assertBoundedJsonInput, assertCsrfProtectedMutation, InMemoryAdmissionLimiter, isForbiddenNetworkAddress, parameterizedSql, renderUntrustedTextInert, validateOutboundHttpsTarget, validateRedirectChain } from "./request-guards";

describe("V07-P2-PRIVACY", () => {
  it.each([
    "person@example.test",
    "+972-50-1234567",
    "123456789",
    "eyJabc.def.ghi",
    "https://example.test/file?signature=secret",
    "C:\\private\\object.bin",
    "salary value",
    "raw OCR text",
  ])("detects privacy canary %s", (canary) => {
    expect(scanPrivacyCanaries({ event: "failure", detail: canary }).safe).toBe(false);
  });

  it("allows only coarse operational records and rejects client-exposed secrets", () => {
    expect(() => assertSafeOperationalRecord({ event: "authorization", status: "blocked", opaque_id: "actor_00000001", sha256: "a".repeat(64) })).not.toThrow();
    expect(() => assertSafeOperationalRecord({ event: "failure", message: "free text" })).toThrow("OPERATIONAL_FIELD_FORBIDDEN");
    expect(() => assertServerSecretConfiguration({ NEXT_PUBLIC_SERVICE_KEY: "not-public" }, "production")).toThrow("CLIENT_SECRET_CONFIGURATION_FORBIDDEN");
    expect(scanPrivacyCanaries("synthetic full name canary", ["synthetic full name canary"]).violation_codes).toContain("EXPLICIT_CANARY");
  });
});

describe("V07-P2 security request guards", () => {
  it.each(["127.0.0.1", "10.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1"])("rejects private address %s", (address) => {
    expect(isForbiddenNetworkAddress(address)).toBe(true);
  });

  it("pins only public DNS answers and revalidates redirects", async () => {
    const resolver = async () => ["93.184.216.34"];
    expect((await validateOutboundHttpsTarget("https://example.com/resource", resolver)).pinned_addresses).toEqual(["93.184.216.34"]);
    await expect(validateOutboundHttpsTarget("http://example.com", resolver)).rejects.toThrow("SSRF_URL_FORBIDDEN");
    await expect(validateOutboundHttpsTarget("https://metadata.google.internal/", resolver)).rejects.toThrow("SSRF_HOST_FORBIDDEN");
    await expect(validateOutboundHttpsTarget("https://example.com", async () => ["127.0.0.1"])).rejects.toThrow("SSRF_DNS_FORBIDDEN");
    await expect(validateRedirectChain(["https://example.com", "https://redirect.example.com"], async (host) => host.startsWith("redirect") ? ["10.0.0.1"] : ["93.184.216.34"])).rejects.toThrow("SSRF_DNS_FORBIDDEN");
  });

  it("requires same-origin JSON mutation and bound CSRF tokens", () => {
    const token = "csrf_token_000000000000000000000001";
    expect(() => assertCsrfProtectedMutation({ method: "POST", origin: "https://app.example.test", allowed_origin: "https://app.example.test", cookie_token: token, header_token: token, content_type: "application/json" })).not.toThrow();
    expect(() => assertCsrfProtectedMutation({ method: "POST", origin: "https://evil.example.test", allowed_origin: "https://app.example.test", cookie_token: token, header_token: token, content_type: "application/json" })).toThrow("CSRF_ORIGIN_INVALID");
    expect(() => assertCsrfProtectedMutation({ method: "POST", origin: "https://app.example.test", allowed_origin: "https://app.example.test", cookie_token: token, header_token: `${token}x`, content_type: "application/json" })).toThrow("CSRF_TOKEN_INVALID");
  });

  it("bounds JSON and renders untrusted content inertly", () => {
    expect(() => assertBoundedJsonInput({ value: "ok" }, 100)).not.toThrow();
    expect(() => assertBoundedJsonInput({ value: "x".repeat(101) }, 100)).toThrow("INPUT_REJECTED");
    expect(renderUntrustedTextInert('<script>alert("x")</script>')).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  });

  it("keeps hostile SQL values parameterized and enforces rate/concurrency bounds", () => {
    const hostile = "' OR 1=1 --";
    const query = parameterizedSql`SELECT * FROM cases WHERE case_id = ${hostile}`;
    expect(query.text).toBe("SELECT * FROM cases WHERE case_id = $1");
    expect(query.text).not.toContain(hostile);
    expect(query.values).toEqual([hostile]);

    const limiter = new InMemoryAdmissionLimiter({ max_requests: 2, max_in_flight: 1, window_ms: 1_000 });
    const first = limiter.admit("subject_0000001", 0);
    expect(() => limiter.admit("subject_0000001", 1)).toThrow("ADMISSION_CONCURRENCY_LIMITED");
    first.release();
    const second = limiter.admit("subject_0000001", 2);
    second.release();
    expect(() => limiter.admit("subject_0000001", 3)).toThrow("ADMISSION_RATE_LIMITED");
    expect(() => limiter.admit("subject_0000001", 1_001)).not.toThrow();
  });
});

describe("V07-P2-PARSER", () => {
  it("retains a fail-closed sandbox spec and exact unavailable-capability blocker", () => {
    expect(parserSandboxSpecification()).toMatchObject({ network: "none", base_filesystem: "read_only", untrusted_input_visibility: "quarantine_only" });
    const capability = parserSandboxCapability({ docker: "unavailable", supported_microvm: false });
    expect(capability).toMatchObject({ runnable: false, status: "SKIPPED_BLOCKED", blocker_code: "PARSER_OS_SANDBOX_NOT_VERIFIED" });
    expect(() => assertParserMayRun(capability)).toThrow("PARSER_OS_SANDBOX_REQUIRED");
  });
});
