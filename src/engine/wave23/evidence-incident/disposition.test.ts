import { describe, expect, it } from "vitest";
import {
  appendDisposition,
  canSatisfyCurrentAuditAdmission,
  type EvidenceDispositionRecord,
  type HistoricalPackageIdentity,
  validateDispositionChain,
} from "./disposition.ts";

const denied = {
  current_audit_admission: false,
  legal_source_activation: false,
  shadow_evidence_admission: false,
};

const identity: HistoricalPackageIdentity = {
  package_id: "SYNTHETIC-HISTORICAL-ROOT",
  zip_sha256: "1".repeat(64),
  manifest_sha256: "2".repeat(64),
};

function failedChain() {
  const quarantined = appendDisposition([], {
    root_id: "synthetic-root",
    state: "quarantined_failed",
    reason_code: "SYNTHETIC_STRICT_FAILURE",
    package_identity: identity,
    failure_latched: true,
    component_only: false,
    capabilities: denied,
  });
  const forensic = appendDisposition([quarantined], {
    root_id: "synthetic-root",
    state: "forensic_only",
    reason_code: "SYNTHETIC_RETAIN_FOR_INSPECTION",
    package_identity: identity,
    failure_latched: true,
    component_only: false,
    capabilities: denied,
  });
  return [quarantined, forensic];
}

describe("Wave 2.3 evidence-root disposition governance", () => {
  it("retains failed roots as hash-bound forensic-only evidence with no admission", () => {
    const chain = failedChain();
    expect(() => validateDispositionChain(chain)).not.toThrow();
    expect(canSatisfyCurrentAuditAdmission(chain)).toBe(false);
    expect(chain[1].parent_record_hash).toBe(chain[0].record_hash);
  });

  it("rejects changing a quarantined root to trusted", () => {
    const [quarantined] = failedChain();
    expect(() => appendDisposition([quarantined], {
      root_id: "synthetic-root",
      state: "trusted_current",
      reason_code: "ILLEGAL_PROMOTION",
      package_identity: identity,
      failure_latched: true,
      component_only: false,
      capabilities: denied,
    })).toThrowError("invalid_disposition_transition");
  });

  it.each(["reason_code", "parent_record_hash"] as const)("rejects tampering with %s", (field) => {
    const chain = failedChain();
    const tampered = chain.map((record) => ({ ...record })) as EvidenceDispositionRecord[];
    if (field === "reason_code") tampered[1].reason_code = "TAMPERED";
    else tampered[1].parent_record_hash = "f".repeat(64);
    expect(() => validateDispositionChain(tampered)).toThrow();
  });

  it("rejects fallback to a historical failed root when a current baseline is required", () => {
    expect(canSatisfyCurrentAuditAdmission(failedChain())).toBe(false);
  });
});
