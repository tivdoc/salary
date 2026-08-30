import { describe, expect, it } from "vitest";
import {
  assertNoInheritedTrust,
  evidenceEpoch2Contract,
  parseContentSha256,
  parseDecisionSha256,
  parseGitBlobOidSha1,
  parsePackageSha256,
} from "./epoch-contract.ts";

describe("evidence_epoch_2 typed trust contract", () => {
  it("keeps hash namespaces distinct and requires a no-parent epoch", () => {
    expect(parseGitBlobOidSha1("a".repeat(40))).toHaveLength(40);
    expect(parseContentSha256("b".repeat(64))).toHaveLength(64);
    expect(parsePackageSha256("c".repeat(64))).toHaveLength(64);
    expect(parseDecisionSha256("d".repeat(64))).toHaveLength(64);
    expect(assertNoInheritedTrust(evidenceEpoch2Contract)).toBe(true);
  });

  it("rejects inherited trust and namespace-width confusion", () => {
    expect(() => assertNoInheritedTrust({ ...evidenceEpoch2Contract, parent_trust_root: "V0.4.1" })).toThrow(
      "evidence_epoch_2_inherited_or_invalid_trust",
    );
    expect(() => parseGitBlobOidSha1("a".repeat(64))).toThrow("git_blob_oid_sha1_invalid");
    expect(() => parseContentSha256("b".repeat(40))).toThrow("content_sha256_invalid");
  });
});
