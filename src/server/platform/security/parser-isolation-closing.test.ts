import { describe, expect, it } from "vitest";

import {
  detectLocalParserSandboxPlatform,
  localParserSandboxCapability,
  parserIsolationClosingEnvironment,
  type ParserIsolationPinnedTool,
} from "./parser-sandbox.ts";

// Wave 6 (K-4). The contract that would close PARSER_OS_SANDBOX_NOT_VERIFIED
// names four proofs and stays NOT_VERIFIED on every one of them until a launch
// adapter presents them; the detector on this host keeps refusing meanwhile.

const PINS: readonly ParserIsolationPinnedTool[] = Object.freeze([
  Object.freeze({ tool: "python", version: "3.13.5", sha256: "a".repeat(64), byte_count: 1, locator_class: "interpreter" as const, observed_on_host: true }),
  Object.freeze({ tool: "pypdf", version: "6.16.2", sha256: null, byte_count: null, locator_class: "python_package" as const, observed_on_host: true }),
]);

describe("parser isolation closing environment", () => {
  it("names exactly the four proofs, each NOT_VERIFIED with an artefact and a runtime check", () => {
    const closing = parserIsolationClosingEnvironment(PINS);
    expect(closing.blocker_code).toBe("PARSER_OS_SANDBOX_NOT_VERIFIED");
    expect(closing.proofs.map((proof) => proof.proof)).toEqual(["pinned_image", "kernel_isolation", "no_network", "pinned_toolchain"]);
    for (const proof of closing.proofs) {
      expect(proof.status).toBe("NOT_VERIFIED");
      expect(proof.artefact.length).toBeGreaterThan(20);
      expect(proof.runtime_check).toMatch(/refuse|abort/u);
      expect(proof.acceptable_implementations.length).toBeGreaterThan(0);
    }
    expect(closing.toolchain_pins).toEqual(PINS);
    expect(Object.isFrozen(closing)).toBe(true);
    expect(Object.isFrozen(closing.proofs[0])).toBe(true);
  });

  it("does not claim an OS sandbox primitive on this host, and the parser stays not runnable", () => {
    const detection = detectLocalParserSandboxPlatform();
    const capability = localParserSandboxCapability(detection);
    expect(detection.os_kernel_boundary_verified).toBe(false);
    expect(detection.node_permission_model.network_kernel_denial).toBe(false);
    expect(capability.runnable).toBe(false);
    expect(capability.blocker_code).toBe("PARSER_OS_SANDBOX_NOT_VERIFIED");
    expect(capability.persistent_owner_import_enabled).toBe(false);
  });

  it("keeps the resource limits hard, not cooperative", () => {
    const closing = parserIsolationClosingEnvironment([]);
    expect(closing.resource_limits.cpu).toMatch(/hard/u);
    expect(closing.resource_limits.memory).toMatch(/killed/u);
    expect(closing.resource_limits.user).toMatch(/non-root/u);
    expect(closing.receipt_binding).toMatch(/hashed into the parse receipt/u);
  });
});
