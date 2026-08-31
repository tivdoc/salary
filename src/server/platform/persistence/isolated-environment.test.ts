import { describe, expect, it } from "vitest";

import {
  authorizeIsolatedTeardown,
  createOwnershipMarker,
  detectPersistenceEnvironment,
  validateExplicitLoopbackTarget,
} from "./isolated-environment";
import { verifyIsolatedPostgresAvailability } from "./isolated-verifier";

const token = "a".repeat(64);

describe("isolated PostgreSQL safety boundary", () => {
  it("reads no generic database or application secrets", () => {
    let probes = 0;
    const receipt = detectPersistenceEnvironment({
      env: {
        DATABASE_URL: "postgresql://remote.example/live",
        SUPABASE_SERVICE_ROLE_KEY: "must-not-be-read",
      },
      tool_probe: () => { probes += 1; return { installed: false, version: null }; },
      image_probe: () => { throw new Error("uninstalled engine must not be invoked"); },
    });
    expect(probes).toBe(8);
    expect(receipt.inspected_environment_keys).toEqual([
      "TIVDOC_ISOLATED_POSTGRES_URL",
      "TIVDOC_ISOLATED_POSTGRES_TARGET_ID",
      "TIVDOC_ISOLATED_POSTGRES_OWNERSHIP_TOKEN",
    ]);
    expect(receipt.forbidden_generic_environment_keys_read).toBe(0);
    expect(receipt.target.reason).toBe("explicit_target_not_supplied");
    expect(receipt.capability).toBe("PERSISTENCE_ISOLATED_ENVIRONMENT_BLOCKED");
  });

  it("rejects non-loopback and non-randomized targets before connection", () => {
    expect(validateExplicitLoopbackTarget({
      url: "postgresql://example.com/tivdoc_isolated_12345678",
      target_id: "tivdoc-isolated-12345678",
      ownership_token: token,
    }).reason).toBe("non_loopback_target_rejected");
    expect(validateExplicitLoopbackTarget({
      url: "postgresql://127.0.0.1/postgres",
      target_id: "tivdoc-isolated-12345678",
      ownership_token: token,
    }).reason).toBe("database_name_invalid");
  });

  it("approves only a matching loopback disposable identity and never exposes the token", () => {
    const receipt = validateExplicitLoopbackTarget({
      url: "postgresql://local:secret@127.0.0.1:55432/tivdoc_isolated_12345678",
      target_id: "tivdoc-isolated-12345678",
      ownership_token: token,
    });
    expect(receipt).toMatchObject({
      approved: true,
      host: "127.0.0.1",
      port: 55432,
      database: "tivdoc_isolated_12345678",
      target_id: "tivdoc-isolated-12345678",
    });
    expect(JSON.stringify(receipt)).not.toContain("secret");
    expect(JSON.stringify(receipt)).not.toContain(token);
  });

  it("authorizes teardown only for the exact marker, target and token", () => {
    const marker = createOwnershipMarker({ target_id: "tivdoc-isolated-12345678", ownership_token: token });
    expect(authorizeIsolatedTeardown({ marker, target_id: "tivdoc-isolated-12345678", ownership_token: token })).toBe(true);
    expect(authorizeIsolatedTeardown({ marker, target_id: "tivdoc-isolated-87654321", ownership_token: token })).toBe(false);
    expect(authorizeIsolatedTeardown({ marker, target_id: "tivdoc-isolated-12345678", ownership_token: "b".repeat(64) })).toBe(false);
  });

  it("keeps static, driver and PostgreSQL evidence distinct", () => {
    const environment = detectPersistenceEnvironment({
      env: {},
      tool_probe: () => ({ installed: false, version: null }),
      image_probe: () => [],
    });
    const receipt = verifyIsolatedPostgresAvailability(environment);
    expect(receipt).toMatchObject({
      status: "SKIPPED_BLOCKED",
      blocker_code: "SKIPPED_ENVIRONMENT_DEPENDENCY",
      database_connection_attempts: 0,
      database_semantics_verified: false,
      static_wiring_verified_separately: true,
      driver_harness_verified: false,
    });
  });
});
