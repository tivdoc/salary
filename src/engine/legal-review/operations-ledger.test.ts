import { describe, expect, it } from "vitest";

import { legalCitationSchema } from "../legal-knowledge/contracts.ts";
import { syntheticChunk, syntheticSource } from "../legal-knowledge/synthetic-fixtures.ts";
import {
  applyLegalReviewAssignmentCommand,
  buildLegalReviewWorkload,
  createLegalReviewAssignment,
  expireLegalReviewLease,
  requeueableLegalReviewAssignments,
} from "./assignment.ts";
import { LEGAL_REVIEW_SCHEMA_VERSION } from "./contracts.ts";
import {
  buildCaseLawRegister,
  caseLawConflicts,
  createHandoffPackage,
  exportHandoffPackage,
  invalidateHandoffPackageOnRevisionChange,
} from "./handoff-registry.ts";
import {
  buildReviewerIdentityRoster,
  evaluateReviewerIdentityReadiness,
  reviewerRotationSuccessor,
} from "./reviewer-identity.ts";
import { buildLegalHandoffManifest } from "./topic-readiness.ts";
import {
  buildAttestationPreconditionView,
  buildReviewerWorkbench,
  exportReviewerWorkbench,
} from "./workbench.ts";
import { createLegalReviewPacket } from "./workflow.ts";

const T0 = "2026-01-02T00:00:00.000Z";
const T1 = "2026-01-02T00:10:00.000Z";
const T2 = "2026-01-02T09:00:00.000Z";

function citation(authority?: Record<string, unknown>) {
  const source = syntheticSource();
  const chunk = syntheticChunk(source);
  return legalCitationSchema.parse({
    source_id: source.source_id, source_version: source.source_version,
    source_version_id: `${source.source_id}@${source.source_version}`,
    parsed_version_id: chunk.parsed_version_id, raw_artifact_sha256: chunk.artifact_sha256,
    normalized_text_sha256: chunk.normalized_text_sha256, parser_version: chunk.parser_version,
    chunk_id: chunk.chunk_id, title: source.title, authority: authority ?? source.authority,
    canonical_url: source.canonical_url, section_or_clause: chunk.section_identifier,
    page: chunk.page_from, effective_period: source.effective_period,
    effective_date_evidence_locator: "synthetic clause 1", review_status: source.status,
    retrieved_at: "2026-08-29T00:00:00Z",
    locator: {
      format: "pdf", page: chunk.page_from, section: chunk.section_identifier, paragraph: null,
      character_from: chunk.character_from, character_to: chunk.character_to,
    },
    supporting_chunk_ids: [chunk.chunk_id], excerpt: null,
  });
}

const ARTIFACT = "a".repeat(64);

function packet(overrides: Record<string, unknown> = {}) {
  return createLegalReviewPacket({
    binding: {
      schema_version: LEGAL_REVIEW_SCHEMA_VERSION,
      source_id: "IL_SYNTHETIC_LAW", source_version_id: "IL_SYNTHETIC_LAW@v1",
      manifest_sha256: "c".repeat(64), raw_artifact_sha256: ARTIFACT,
      normalized_text_sha256: "d".repeat(64),
      parser_version: "synthetic-parser-v1", normalizer_version: "synthetic-normalizer-v1",
    },
    scope: {
      topic: "minimum_wage", sectors: ["general"], applicability: "general",
      population_constraints: [],
      effective_period: {
        effective_from: "2020-01-01", effective_to: null,
        retroactive: false, retroactive_basis: null, applicability_basis: "salary_month",
      },
      period_certainty: "known",
    },
    citations: [citation()],
    created_at: T0,
    ...overrides,
  });
}

function assignment() {
  return createLegalReviewAssignment({
    packet_id: "LRP:a", packet_sha256: "a".repeat(64), packet_revision: 1, enqueued_at: T0,
  });
}

function command(overrides: Record<string, unknown> = {}) {
  return {
    command_id: "cmd.001", kind: "assign", actor_id: "reviewer:1",
    actor_role: "legal_reviewer", expected_packet_revision: 1, expected_fencing_token: 0,
    now: T0, lease_seconds: 900, ...overrides,
  } as never;
}

describe("L1 queue work management", () => {
  it("assigns with a fencing token, lease and audit-visible command id", () => {
    const result = applyLegalReviewAssignmentCommand(assignment(), command());
    expect(result.applied).toBe(true);
    expect(result.assignment.state).toBe("assigned");
    expect(result.assignment.assignee_id).toBe("reviewer:1");
    expect(result.assignment.fencing_token).toBe(1);
    expect(result.assignment.lease_expires_at).toBe("2026-01-02T00:15:00.000Z");
    expect(result.assignment.last_command_id).toBe("cmd.001");
  });

  it("refuses a double claim by a different reviewer", () => {
    const held = applyLegalReviewAssignmentCommand(assignment(), command()).assignment;
    expect(() => applyLegalReviewAssignmentCommand(held, command({
      command_id: "cmd.002", kind: "claim", actor_id: "reviewer:2", expected_fencing_token: 1,
    }))).toThrow(/LEGAL_REVIEW_ACTION_CONFLICT/u);
  });

  it("treats an exact replay as a no-op and a stale revision or token as a conflict", () => {
    const held = applyLegalReviewAssignmentCommand(assignment(), command()).assignment;
    expect(applyLegalReviewAssignmentCommand(held, command()).applied).toBe(false);
    expect(() => applyLegalReviewAssignmentCommand(held, command({
      command_id: "cmd.003", expected_packet_revision: 9, expected_fencing_token: 1,
    }))).toThrow(/LEGAL_REVIEW_STALE_REVISION/u);
    expect(() => applyLegalReviewAssignmentCommand(held, command({
      command_id: "cmd.004", expected_fencing_token: 0,
    }))).toThrow(/LEGAL_REVIEW_ACTION_CONFLICT/u);
  });

  it("enforces role eligibility and separation of duties", () => {
    expect(() => applyLegalReviewAssignmentCommand(assignment(), command({
      actor_role: "legal_reviewer_observer",
    }))).toThrow(/LEGAL_REVIEW_ROLE_NOT_PERMITTED/u);
    expect(() => applyLegalReviewAssignmentCommand(assignment(), command({
      packet_author_id: "reviewer:1",
    }))).toThrow(/separation_of_duties/u);
  });

  it("expires a lease and offers the packet for requeue without reassigning it", () => {
    const held = applyLegalReviewAssignmentCommand(assignment(), command()).assignment;
    expect(expireLegalReviewLease(held, T2).state).toBe("lease_expired");
    expect(expireLegalReviewLease(held, T0).state).toBe("assigned");
    expect(requeueableLegalReviewAssignments([held], T2).map((row) => row.packet_id)).toEqual(["LRP:a"]);
    expect(requeueableLegalReviewAssignments([held], T0)).toEqual([]);
  });

  it("lets only the holder or a senior reviewer unassign", () => {
    const held = applyLegalReviewAssignmentCommand(assignment(), command()).assignment;
    expect(() => applyLegalReviewAssignmentCommand(held, command({
      command_id: "cmd.005", kind: "unassign", actor_id: "reviewer:2", expected_fencing_token: 1,
    }))).toThrow(/not_assignment_holder/u);
    const released = applyLegalReviewAssignmentCommand(held, command({
      command_id: "cmd.006", kind: "unassign", actor_id: "reviewer:9",
      actor_role: "senior_legal_reviewer", expected_fencing_token: 1,
    }));
    expect(released.assignment.state).toBe("unassigned");
    expect(released.assignment.fencing_token).toBe(2);
  });

  it("builds a deterministic workload excluding expired leases", () => {
    const held = applyLegalReviewAssignmentCommand(assignment(), command()).assignment;
    expect(buildLegalReviewWorkload([held], T0)).toEqual([{
      assignee_id: "reviewer:1", open_assignments: 1, oldest_enqueued_at: T0, packet_ids: ["LRP:a"],
    }]);
    expect(buildLegalReviewWorkload([held], T2)).toEqual([]);
  });

  it("rejects an out-of-range lease", () => {
    expect(() => applyLegalReviewAssignmentCommand(assignment(), command({ lease_seconds: 5 })))
      .toThrow(/lease_seconds/u);
  });
});

describe("L2 reviewer workbench", () => {
  const workbench = buildReviewerWorkbench({
    packet: packet(),
    lineage: [{ packet_id: "LRP:old", packet_sha256: "b".repeat(64), state: "superseded", superseded_by_packet_id: "LRP:a" }],
    blocked_reason_codes: ["OFFICIAL_ARTIFACT_BYTES_MISSING"],
  });

  it("exposes evidence hashes, scope, citation spans and authority tier", () => {
    expect(workbench.evidence.raw_artifact_sha256).toBe(ARTIFACT);
    expect(workbench.evidence.parser_version).toBe("synthetic-parser-v1");
    expect(workbench.scope.effective_from).toBe("2020-01-01");
    expect(workbench.citations[0]?.character_to).toBeGreaterThan(workbench.citations[0]?.character_from ?? 0);
    expect(workbench.citations[0]?.authority_tier).toBe("primary_binding");
    expect(workbench.monetary_authority_present).toBe(true);
    expect(workbench.blocked_reason_codes).toEqual(["OFFICIAL_ARTIFACT_BYTES_MISSING"]);
  });

  it("derives the invalidation chain from lineage", () => {
    expect(workbench.invalidation_edges).toEqual([
      { from_packet_id: "LRP:old", to_packet_id: "LRP:a", reason: "superseded_by" },
    ]);
  });

  it("exports json and markdown marked as not delivered", () => {
    for (const format of ["json", "markdown"] as const) {
      const exported = exportReviewerWorkbench(workbench, format);
      expect(exported.disposition).toBe("internal_review_not_delivered");
      expect(exported.sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(exported.body).toContain("internal_review_not_delivered");
    }
    expect(exportReviewerWorkbench(workbench, "markdown").body)
      .toContain("No source, parameter or rule is activated");
  });

  it("reports no monetary authority when only secondary material is cited", () => {
    const secondary = buildReviewerWorkbench({
      packet: packet({
        citations: [citation({
          kind: "secondary_professional_source", issuing_body: "Commentary",
          binding_level: "secondary_explanatory", court_level: null, scope: "general",
          operative: false, explanatory: true, contains_numeric_rate: false,
          can_independently_support_monetary_rule: false,
        })],
      }),
    });
    expect(secondary.monetary_authority_present).toBe(false);
  });
});

describe("L3 attestation preconditions and RuleSpec handoff", () => {
  const approved = buildReviewerWorkbench({ packet: { ...packet(), state: "approved" } as never });

  function view(overrides: Record<string, unknown> = {}) {
    return buildAttestationPreconditionView({
      candidate_id: "PARAM:001", packet: approved,
      first_attestation_reviewer_id: "reviewer:1", second_attestation_reviewer_id: "reviewer:2",
      reviewer_eligible: true, candidate_version_current: true,
      bound_artifact_sha256: ARTIFACT, unit: "ILS", rounding_policy: "half_up",
      ...overrides,
    } as never);
  }

  it("reports ready for rule approval yet never active and with no activation endpoint", () => {
    const ready = view();
    expect(ready.unmet_preconditions).toEqual([]);
    expect(ready.ready_for_rule_approval).toBe(true);
    expect(ready.activation_allowed).toBe(false);
    expect(ready.activation_endpoint_present).toBe(false);
    expect(ready.rulespec_handoff_state).toBe("legal_review_required");
  });

  it("surfaces every unmet precondition at once", () => {
    const blocked = view({
      second_attestation_reviewer_id: null, reviewer_eligible: false,
      candidate_version_current: false, bound_artifact_sha256: "f".repeat(64),
      unit: null, rounding_policy: null,
    });
    expect(blocked.unmet_preconditions).toEqual([
      "CANDIDATE_VERSION_STALE",
      "EVIDENCE_ARTIFACT_CHANGED",
      "REVIEWER_NOT_ELIGIBLE",
      "SECOND_ATTESTATION_MISSING",
      "UNIT_OR_ROUNDING_MISSING",
    ]);
    expect(blocked.ready_for_second_attestation).toBe(false);
    expect(blocked.ready_for_rule_approval).toBe(false);
  });

  it("blocks the same reviewer attesting twice", () => {
    const same = view({ second_attestation_reviewer_id: "reviewer:1" });
    expect(same.unmet_preconditions).toContain("SAME_REVIEWER_AS_FIRST_ATTESTATION");
    expect(same.ready_for_rule_approval).toBe(false);
  });

  it("blocks a candidate whose packet is not approved", () => {
    const pending = buildAttestationPreconditionView({
      candidate_id: "PARAM:002", packet: buildReviewerWorkbench({ packet: packet() }),
      first_attestation_reviewer_id: null, second_attestation_reviewer_id: null,
      reviewer_eligible: true, candidate_version_current: true,
      bound_artifact_sha256: ARTIFACT, unit: "ILS", rounding_policy: "half_up",
    } as never);
    expect(pending.unmet_preconditions).toContain("PACKET_NOT_APPROVED");
  });
});

describe("L4 reviewer identity readiness", () => {
  function reference(overrides: Record<string, unknown> = {}) {
    return {
      reviewer_id: "reviewer.human.001", reviewer_role: "legal_reviewer",
      key_reference: "key.human.001", public_key_sha256: "e".repeat(64),
      key_state: "active", valid_from: T0, expires_at: "2027-01-01T00:00:00.000Z",
      rotated_to_key_reference: null, organization_id: "org.reviewers",
      registered_by_actor_id: "admin.001", registered_at: T0,
      ...overrides,
    } as never;
  }

  it("accepts a well-formed non-synthetic reference for internal review only", () => {
    const readiness = evaluateReviewerIdentityReadiness(reference(), T1);
    expect(readiness.eligible_for_internal_review).toBe(true);
    expect(readiness.eligible_for_real_approval).toBe(false);
    expect(readiness.cryptographic_verification_performed).toBe(false);
    expect(readiness.synthetic).toBe(false);
  });

  it("marks a synthetic identity and refuses it for real approval", () => {
    const readiness = evaluateReviewerIdentityReadiness(
      reference({ reviewer_id: "reviewer.synthetic.001" }), T1);
    expect(readiness.synthetic).toBe(true);
    expect(readiness.ineligibility_codes).toContain("SYNTHETIC_IDENTITY_NOT_HUMAN");
    expect(readiness.eligible_for_real_approval).toBe(false);
  });

  it("reports revocation, suspension, rotation and expiry distinctly", () => {
    expect(evaluateReviewerIdentityReadiness(reference({ key_state: "revoked" }), T1)
      .ineligibility_codes).toContain("KEY_REVOKED");
    expect(evaluateReviewerIdentityReadiness(reference({ key_state: "suspended" }), T1)
      .ineligibility_codes).toContain("KEY_SUSPENDED");
    expect(evaluateReviewerIdentityReadiness(reference({ key_state: "rotated" }), T1)
      .ineligibility_codes).toContain("KEY_ROTATED_TO_SUCCESSOR");
    expect(evaluateReviewerIdentityReadiness(reference({ expires_at: T0 }), T1)
      .ineligibility_codes).toContain("OUTSIDE_VALIDITY_WINDOW");
  });

  it("rejects malformed key material and incomplete provenance", () => {
    const codes = evaluateReviewerIdentityReadiness(reference({
      key_reference: "!", public_key_sha256: "nope", registered_by_actor_id: " ",
    }), T1).ineligibility_codes;
    expect(codes).toContain("KEY_REFERENCE_MALFORMED");
    expect(codes).toContain("PUBLIC_KEY_DIGEST_MALFORMED");
    expect(codes).toContain("AUDIT_PROVENANCE_INCOMPLETE");
  });

  it("exposes a rotation successor and orders the roster ineligible first", () => {
    expect(reviewerRotationSuccessor(reference({
      key_state: "rotated", rotated_to_key_reference: "key.human.002",
    }))).toBe("key.human.002");
    const roster = buildReviewerIdentityRoster([
      reference({ reviewer_id: "reviewer.human.002" }),
      reference({ reviewer_id: "reviewer.human.003", key_state: "revoked" }),
    ], T1);
    expect(roster[0]?.reviewer_id).toBe("reviewer.human.003");
    expect(roster[0]?.eligible_for_internal_review).toBe(false);
  });
});

describe("L7 handoff package registry", () => {
  const manifest = buildLegalHandoffManifest({
    generated_for: "internal-review",
    packets: [{
      packet_id: "LRP:a", packet_sha256: "a".repeat(64), raw_artifact_sha256: ARTIFACT,
      source_version_id: "IL_SYNTHETIC_LAW@v1", state: "pending_review",
    }],
    template_ids: ["GT:001"],
  });

  function packaged() {
    return createHandoffPackage({
      package_id: "PKG:001", manifest, reviewer_requirements: ["legal_reviewer"],
      bound_revisions: { "LRP:a": 1 }, created_at: T0,
    });
  }

  it("seals a package that is not delivered and has no acknowledgement", () => {
    const result = packaged();
    expect(result.lifecycle).toBe("not_delivered");
    expect(result.delivered).toBe(false);
    expect(result.acknowledgement_reference).toBeNull();
    expect(result.source_artifact_sha256s).toEqual([ARTIFACT]);
  });

  it("refuses to seal a package with an unbound packet revision", () => {
    expect(() => createHandoffPackage({
      package_id: "PKG:002", manifest, reviewer_requirements: [],
      bound_revisions: {}, created_at: T0,
    })).toThrow(/unbound_revision/u);
  });

  it("invalidates deterministically when a referenced revision changes", () => {
    expect(invalidateHandoffPackageOnRevisionChange(packaged(), { "LRP:a": 1 }).lifecycle)
      .toBe("not_delivered");
    const invalidated = invalidateHandoffPackageOnRevisionChange(packaged(), { "LRP:a": 2 });
    expect(invalidated.lifecycle).toBe("invalidated");
    expect(invalidated.invalidated_reason).toBe("packet_revision_changed:LRP:a");
  });

  it("exports deterministically and still reports no delivery", () => {
    const exported = exportHandoffPackage(packaged());
    expect(exported.delivered).toBe(false);
    expect(exported.package_sha256).toBe(exportHandoffPackage(packaged()).package_sha256);
    expect(exported.body).toContain("not_delivered");
  });
});

describe("L8 case-law register", () => {
  function entry(overrides: Record<string, unknown> = {}) {
    return {
      entry_id: "CL:001", document_reference: "synthetic-ruling", document_sha256: "b".repeat(64),
      jurisdiction: "IL", court: "Synthetic Labour Court", decided_at: "2021-01-01",
      authority_tier: "persuasive", topics: ["minimum_wage"], cited_source_version_ids: [],
      review_state: "needs_review", conflicts_with_entry_ids: [],
      can_independently_authorize_monetary_rule: false,
      ...overrides,
    } as never;
  }

  it("is empty and explicitly blocked by default", () => {
    const register = buildCaseLawRegister();
    expect(register.entry_count).toBe(0);
    expect(register.blocked_reason).toBe("NO_AUTHORITATIVE_CASE_LAW_CONTENT_AVAILABLE_LOCALLY");
    expect(register.activation_allowed).toBe(false);
  });

  it("accepts a synthetic entry that can never authorize a monetary rule", () => {
    const register = buildCaseLawRegister([entry()]);
    expect(register.entry_count).toBe(1);
    expect(register.blocked_reason).toBeNull();
    expect(register.entries[0]?.can_independently_authorize_monetary_rule).toBe(false);
  });

  it("refuses an entry claiming independent monetary authority or a bad digest", () => {
    expect(() => buildCaseLawRegister([entry({ can_independently_authorize_monetary_rule: true })]))
      .toThrow(/MONETARY_AUTHORITY_INSUFFICIENT/u);
    expect(() => buildCaseLawRegister([entry({ document_sha256: "short" })]))
      .toThrow(/document_sha256/u);
  });

  it("surfaces conflicts rather than resolving them", () => {
    const register = buildCaseLawRegister([
      entry(),
      entry({ entry_id: "CL:002", review_state: "conflicted" }),
      entry({ entry_id: "CL:003", conflicts_with_entry_ids: ["CL:001"] }),
    ]);
    expect(caseLawConflicts(register).map((item) => item.entry_id)).toEqual(["CL:002", "CL:003"]);
  });
});
