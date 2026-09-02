import { describe, expect, it } from "vitest";

import {
  authenticateProductIdentity,
  clearProductIdentityRefusalLog,
  readProductIdentityRefusalLog,
  PRODUCT_IDENTITY_COOKIE,
} from "./identity-session.ts";

// V0.10.12 W1. Origin equality stays exact — two spellings of loopback remain
// two different origins, deliberately. What changed is that the refusal now
// says which field diverged, and for a hostname, which side was loopback.
// Every API route being unreachable to a session the page route accepted was
// invisible for two runs precisely because this refusal was silent.

const COMPACT_JWT = ["a", "b", "c"].map((part) => part.repeat(12)).join(".");

const verifier = Object.freeze({
  verify: async () => Object.freeze({
    audience: "operations" as const,
    expires_at_epoch: Math.floor(Date.now() / 1_000) + 600,
    actor: Object.freeze({ role: "legal_reviewer", verified_server_side: true }),
  }) as never,
});

function requestAt(origin: string): Request {
  return new Request(`${origin}/api/operations/legal-review/queue`, {
    headers: { cookie: `${PRODUCT_IDENTITY_COOKIE}=${COMPACT_JWT}` },
  });
}

async function reasonFor(requestOrigin: string, allowedOrigin: string): Promise<string | null> {
  clearProductIdentityRefusalLog();
  const identity = await authenticateProductIdentity(
    requestAt(requestOrigin), "operations", verifier,
    Object.freeze({
      allowed_origin: allowedOrigin, allow_local_loopback_http: true, environment: Object.freeze({}),
    }) as never,
  );
  return identity === null ? (readProductIdentityRefusalLog().at(-1)?.reason ?? "UNRECORDED") : null;
}

describe("V0.10.12 loopback origin refusal codes", () => {
  it("accepts only an exactly equal origin", async () => {
    expect(await reasonFor("http://127.0.0.1:45123", "http://127.0.0.1:45123")).toBeNull();
  });

  it("names a differing label without accepting it", async () => {
    expect(await reasonFor("http://localhost:45123", "http://127.0.0.1:45123"))
      .toBe("LOOPBACK_ORIGIN_LABEL_DIFFERS");
  });

  it("separates a non-loopback request from a non-loopback configuration", async () => {
    expect(await reasonFor("http://192.168.1.10:45123", "http://127.0.0.1:45123"))
      .toBe("LOOPBACK_ORIGIN_REQUEST_NOT_LOOPBACK");
    expect(await reasonFor("http://evil.example:45123", "http://127.0.0.1:45123"))
      .toBe("LOOPBACK_ORIGIN_REQUEST_NOT_LOOPBACK");
  });

  it("still refuses a different port", async () => {
    expect(await reasonFor("http://127.0.0.1:45124", "http://127.0.0.1:45123"))
      .toBe("LOOPBACK_ORIGIN_PORT_MISMATCH");
  });

  it("records a code and a timestamp and nothing else", async () => {
    await reasonFor("http://192.168.1.10:45123", "http://127.0.0.1:45123");
    for (const entry of readProductIdentityRefusalLog()) {
      expect(Object.keys(entry).sort()).toEqual(["at", "reason"]);
    }
  });
});
