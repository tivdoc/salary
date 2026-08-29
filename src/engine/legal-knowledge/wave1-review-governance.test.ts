import { describe, expect, it } from "vitest";
import {
  appendWave1ReviewEvent,
  detectWave1AttestationInvalidations,
  evaluateWave1Attestation,
  evaluateWave1FutureActivationGate,
  type Wave1ActivationApproval,
  type Wave1ReviewAttestation,
  type Wave1ReviewBinding,
  type Wave1ReviewEvent,
} from "./wave1-review-governance.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const D = "d".repeat(64);
const E = "e".repeat(64);

const binding: Wave1ReviewBinding = {
  artifact_sha256: A,
  parsed_sha256: B,
  parser_version: "synthetic-parser-v1",
  source_set_version: "synthetic-set-v1",
  interval_claim_id: "SYNTHETIC_INTERVAL_001",
  interval_claim_sha256: C,
  scope_claim_id: "SYNTHETIC_SCOPE_001",
  scope_claim_sha256: D,
};

const attestation: Wave1ReviewAttestation = {
  ref: {
    attestation_id: "SYNTHETIC_ATTESTATION_001",
    artifact_sha256: A,
    parsed_sha256: B,
    source_set_version: "synthetic-set-v1",
    interval_claim_id: "SYNTHETIC_INTERVAL_001",
    scope_claim_id: "SYNTHETIC_SCOPE_001",
    reviewer_id: "synthetic-reviewer-1",
    reviewer_role: "synthetic-legal-review",
    reviewed_at: "2024-03-01T00:00:00Z",
    status: "valid",
  },
  parser_version: "synthetic-parser-v1",
  interval_claim_sha256: C,
  scope_claim_sha256: D,
};

const issued: Wave1ReviewEvent = {
  event_kind: "issued",
  event_id: "SYNTHETIC_EVENT_001",
  sequence: 1,
  recorded_at: "2024-03-01T00:00:00Z",
  attestation,
};

describe("Wave 1 append-only review governance", () => {
  it("appends an attestation without mutating the prior log", () => {
    const empty: readonly Wave1ReviewEvent[] = Object.freeze([]);
    const next = appendWave1ReviewEvent(empty, issued);
    expect(empty).toHaveLength(0);
    expect(next).toEqual([issued]);
    expect(Object.isFrozen(next)).toBe(true);
  });

  it("rejects sequence rewrites and duplicate attestations", () => {
    const log = appendWave1ReviewEvent([], issued);
    expect(() => appendWave1ReviewEvent(log, { ...issued, event_id: "SYNTHETIC_EVENT_002", sequence: 3 })).toThrow("append_only");
    expect(() => appendWave1ReviewEvent(log, { ...issued, event_id: "SYNTHETIC_EVENT_002", sequence: 2 })).toThrow("attestation_id_reused");
    expect(() => appendWave1ReviewEvent(log, {
      event_kind: "invalidated",
      event_id: "SYNTHETIC_EVENT_003",
      sequence: 2,
      recorded_at: "2024-02-29T23:59:59Z",
      attestation_id: attestation.ref.attestation_id,
      reasons: ["source_set_changed"],
    })).toThrow("time_must_be_monotonic");
  });

  it.each([
    ["artifact bytes", { artifact_sha256: E }, "artifact_bytes_changed"],
    ["parsed output", { parsed_sha256: E }, "parsed_output_changed"],
    ["parser version", { parser_version: "synthetic-parser-v2" }, "parser_version_changed"],
    ["source set", { source_set_version: "synthetic-set-v2" }, "source_set_changed"],
    ["interval claim", { interval_claim_sha256: E }, "interval_claim_changed"],
    ["scope claim", { scope_claim_sha256: E }, "scope_claim_changed"],
  ])("invalidates on changed %s", (_label, override, reason) => {
    expect(detectWave1AttestationInvalidations(attestation, { ...binding, ...override })).toContain(reason);
  });

  it("applies an appended invalidation only at and after its recorded knowledge time", () => {
    const invalidation: Wave1ReviewEvent = {
      event_kind: "invalidated",
      event_id: "SYNTHETIC_EVENT_002",
      sequence: 2,
      recorded_at: "2024-04-01T00:00:00Z",
      attestation_id: attestation.ref.attestation_id,
      reasons: ["source_set_changed"],
    };
    const log = appendWave1ReviewEvent(appendWave1ReviewEvent([], issued), invalidation);
    expect(evaluateWave1Attestation({ log, attestation_id: attestation.ref.attestation_id, as_of: "2024-03-31T23:59:59Z", current_binding: binding }).status)
      .toBe("valid");
    expect(evaluateWave1Attestation({ log, attestation_id: attestation.ref.attestation_id, as_of: "2024-04-01T00:00:00Z", current_binding: binding }))
      .toMatchObject({ status: "invalidated", reasons: ["source_set_changed"] });
  });

  it("requires non-substitutable approvals and never activates a record", () => {
    const approval = (kind: Wave1ActivationApproval["approval_kind"], id: string, approver: string): Wave1ActivationApproval => ({
      approval_id: id,
      attestation_id: attestation.ref.attestation_id,
      approval_kind: kind,
      approver_id: approver,
      approver_role: `synthetic-${kind}`,
      approved_at: "2024-04-01T00:00:00Z",
      binding_sha256: E,
    });
    const legal = approval("legal_content_approval", "SYNTHETIC_APPROVAL_001", "synthetic-approver-1");
    const control = approval("activation_control_approval", "SYNTHETIC_APPROVAL_002", "synthetic-approver-2");
    expect(evaluateWave1FutureActivationGate({
      attestation_status: "valid",
      attestation_id: attestation.ref.attestation_id,
      binding_sha256: E,
      approvals: [legal],
    })).toMatchObject({ eligible: false, activates_source: false });
    expect(evaluateWave1FutureActivationGate({
      attestation_status: "valid",
      attestation_id: attestation.ref.attestation_id,
      binding_sha256: E,
      approvals: [legal, control],
    })).toEqual({ eligible: true, reasons: [], activates_source: false });
    expect(evaluateWave1FutureActivationGate({
      attestation_status: "valid",
      attestation_id: attestation.ref.attestation_id,
      binding_sha256: E,
      approvals: [legal, { ...control, approver_id: legal.approver_id }],
    }).reasons).toContain("separate_approvers_required");
  });
});
