import { describe, expect, it } from "vitest";

import {
  buildConnectionUrl,
  DEV_LOGIN_ROLES,
  generateDevPassword,
  readDevEnvFile,
  scramSha256Verifier,
  scramVerifierAcceptsPassword,
} from "./dev-credential.mts";

describe("V0.10.10 DEV credential provisioning", () => {
  it("matches the RFC 7677 SCRAM-SHA-256 vector", () => {
    const verifier = scramSha256Verifier("pencil", Buffer.from("W22ZaJ0SNY7soEsUEjb6gQ==", "base64"), 4096);
    expect(verifier).toBe(
      "SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==$"
      + "WG5d8oPm3OtcPnkdi4Uo7BkeZkBFzpcXkuLmtbsT4qY=:wfPLwcE6nTWhTAmQ7tl2KeoiWGPlZqQxSrmfPwDl2dU=",
    );
  });

  it("accepts only the password it was built from", () => {
    const password = generateDevPassword();
    const verifier = scramSha256Verifier(password);
    expect(scramVerifierAcceptsPassword(verifier, password)).toBe(true);
    expect(scramVerifierAcceptsPassword(verifier, `${password}x`)).toBe(false);
    expect(scramVerifierAcceptsPassword("not-a-verifier", password)).toBe(false);
  });

  it("never carries the password inside the verifier", () => {
    const password = generateDevPassword();
    expect(scramSha256Verifier(password)).not.toContain(password);
  });

  it("refuses a weak salt, a weak iteration count and an empty password", () => {
    expect(() => scramSha256Verifier("x".repeat(24), Buffer.alloc(8))).toThrow("DEV_CREDENTIAL_SALT_TOO_SHORT");
    expect(() => scramSha256Verifier("x".repeat(24), Buffer.alloc(16), 1024))
      .toThrow("DEV_CREDENTIAL_ITERATIONS_TOO_LOW");
    expect(() => scramSha256Verifier("")).toThrow("DEV_CREDENTIAL_PASSWORD_EMPTY");
  });

  it("generates a distinct high-entropy password every time", () => {
    const values = new Set(Array.from({ length: 64 }, () => generateDevPassword()));
    expect(values.size).toBe(64);
    for (const value of values) expect(value).toMatch(/^[A-Za-z0-9_-]{32}$/u);
  });

  it("escapes the credential into the URL and keeps the pooler tenant suffix explicit", () => {
    const url = buildConnectionUrl({
      role: "tivdoc_web_runtime", password: "a/b:c@d?e", host: "pooler.invalid",
      port: 5432, database: "postgres", pooler_tenant: "abcdefghijklmnopqrst",
    });
    const parsed = new URL(url);
    expect(parsed.username).toBe("tivdoc_web_runtime.abcdefghijklmnopqrst");
    expect(decodeURIComponent(parsed.password)).toBe("a/b:c@d?e");
    expect(parsed.searchParams.get("sslmode")).toBe("no-verify");
    expect(new URL(buildConnectionUrl({
      role: "tivdoc_web_runtime", password: "p".repeat(24), host: "127.0.0.1",
      port: 5432, database: "postgres", pooler_tenant: null,
    })).username).toBe("tivdoc_web_runtime");
  });

  it("reads a missing env file as empty rather than failing open", () => {
    expect(readDevEnvFile("does-not-exist.env").size).toBe(0);
  });

  it("names every runtime role the durable local config expects", () => {
    expect([...DEV_LOGIN_ROLES]).toEqual([
      "tivdoc_dev_migrator",
      "tivdoc_identity_runtime",
      "tivdoc_web_runtime",
      "tivdoc_operations_runtime",
      "tivdoc_worker_runtime",
    ]);
  });
});
