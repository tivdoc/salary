import { describe, expect, it } from "vitest";

import { V07_ROLES, type V07Role, type VerifiedActor } from "../../../engine/wave4/contracts";
import { AUTHORIZATION_ACTIONS, authorize, type AuthorizationAction, type AuthorizationResource } from "./authorization";
import { deriveVerifiedActor, type TrustedIdentityEnvelope } from "./claims";
import { buildStaticRlsContract, verifyStaticRlsContract } from "./rls-contract";

const NOW = Date.parse("2026-08-30T00:05:00.000Z");

function envelope(overrides: Partial<TrustedIdentityEnvelope> = {}): TrustedIdentityEnvelope {
  return {
    source: "verified_server_adapter",
    signature_valid: true,
    issuer: "issuer_local_01",
    audience: "audience_local_1",
    issued_at: "2026-08-30T00:00:00.000Z",
    expires_at: "2026-08-30T00:10:00.000Z",
    actor_id: "actor_00000001",
    role: "intake_operator",
    tenant_id: "tenant_0000001",
    assigned_case_ids: ["case_000000001"],
    break_glass_reason: null,
    break_glass_expires_at: null,
    test_only: true,
    ...overrides,
  };
}

function actor(role: V07Role, actorId = "actor_00000001", tenantId: string | null = "tenant_0000001"): VerifiedActor {
  return Object.freeze({ actor_id: actorId, role, tenant_id: tenantId, assigned_case_ids: ["case_000000001"], verified_server_side: true, break_glass_reason: null, break_glass_expires_at: null });
}

const resource: AuthorizationResource = {
  tenant_id: "tenant_0000001",
  case_id: "case_000000001",
  owner_actor_id: "owner_000000001",
  report_released: false,
  last_content_actor_id: null,
  first_parameter_attestor_id: null,
  worker_scope_actor_id: "worker_00000001",
  break_glass_audit_bound: false,
};

describe("V07-P2-AUTHZ verified claims", () => {
  it("derives identity only from a valid server envelope", () => {
    const verified = deriveVerifiedActor(envelope(), { issuer: "issuer_local_01", audience: "audience_local_1", runtime: "test", clock_skew_ms: 0 }, NOW);
    expect(verified.verified_server_side).toBe(true);
    expect(() => deriveVerifiedActor(envelope({ audience: "wrong_audience_1" }), { issuer: "issuer_local_01", audience: "audience_local_1", runtime: "test", clock_skew_ms: 0 }, NOW)).toThrow("IDENTITY_AUDIENCE_INVALID");
    expect(() => deriveVerifiedActor(envelope({ expires_at: "2026-08-29T00:00:00.000Z" }), { issuer: "issuer_local_01", audience: "audience_local_1", runtime: "test", clock_skew_ms: 0 }, NOW)).toThrow("IDENTITY_EXPIRED");
    expect(() => deriveVerifiedActor(envelope(), { issuer: "issuer_local_01", audience: "audience_local_1", runtime: "production", clock_skew_ms: 0 }, NOW)).toThrow("TEST_IDENTITY_PRODUCTION_FORBIDDEN");
  });

  it("requires bounded break-glass reason/expiry", () => {
    expect(() => deriveVerifiedActor(envelope({ role: "break_glass_admin", break_glass_reason: "INCIDENT_0001", break_glass_expires_at: "2026-08-30T00:15:01.000Z" }), { issuer: "issuer_local_01", audience: "audience_local_1", runtime: "test", clock_skew_ms: 0 }, NOW)).toThrow("BREAK_GLASS_EXPIRY_INVALID");
    expect(deriveVerifiedActor(envelope({ role: "break_glass_admin", break_glass_reason: "INCIDENT_0001", break_glass_expires_at: "2026-08-30T00:10:00.000Z" }), { issuer: "issuer_local_01", audience: "audience_local_1", runtime: "test", clock_skew_ms: 0 }, NOW).role).toBe("break_glass_admin");
  });
});

describe("V07-P2-AUTHZ permission matrix", () => {
  it.each<[V07Role, AuthorizationAction, boolean]>([
    ["anonymous", "read_case_metadata", false],
    ["customer_owner", "read_case_metadata", true],
    ["intake_operator", "mutate_case", true],
    ["extraction_reviewer", "read_document_body", true],
    ["fact_reviewer", "review_facts", true],
    ["legal_reviewer", "read_legal_artifact", true],
    ["legal_reviewer", "read_document_body", false],
    ["parameter_verifier", "attest_parameter", true],
    ["report_approver", "approve_report", true],
    ["auditor", "read_audit_metadata", true],
    ["auditor", "read_document_body", false],
    ["scoped_background_worker", "run_scoped_job", false],
  ])("enforces %s / %s", (role, action, expected) => {
    const identity = role === "customer_owner" ? actor(role, "owner_000000001") : actor(role);
    expect(authorize(identity, action, resource).allowed).toBe(expected);
  });

  it("denies cross-owner, cross-tenant, unapproved report, self-approval and duplicate attestation", () => {
    expect(authorize(actor("customer_owner", "owner_000000002"), "read_case_metadata", resource).code).toBe("DENY_OWNER");
    expect(authorize(actor("customer_owner", "owner_000000001", "tenant_0000002"), "read_case_metadata", resource).code).toBe("DENY_TENANT");
    expect(authorize(actor("customer_owner", "owner_000000001"), "read_approved_report", resource).code).toBe("DENY_RELEASE");
    expect(authorize(actor("report_approver"), "approve_report", { ...resource, last_content_actor_id: "actor_00000001" }).code).toBe("DENY_DISTINCT_ACTOR");
    expect(authorize(actor("parameter_verifier"), "attest_parameter", { ...resource, first_parameter_attestor_id: "actor_00000001" }).code).toBe("DENY_DISTINCT_ACTOR");
    expect(authorize(actor("intake_operator"), "activate_legal_artifact", resource).code).toBe("DENY_ROLE");
    expect(authorize(actor("intake_operator"), "mutate_identity", resource).allowed).toBe(false);
    expect(authorize({ ...actor("scoped_background_worker", "worker_00000001"), tenant_id: null }, "run_scoped_job", { ...resource, tenant_id: null }).allowed).toBe(true);
    const breakGlass = { ...actor("break_glass_admin", "admin_000000001"), break_glass_reason: "INCIDENT_0001", break_glass_expires_at: "2026-08-30T00:10:00.000Z" } as const;
    expect(authorize(breakGlass, "read_document_body", { ...resource, break_glass_audit_bound: true }, Date.parse("2026-08-30T00:05:00.000Z")).allowed).toBe(true);
    expect(authorize(breakGlass, "read_document_body", { ...resource, break_glass_audit_bound: false }, Date.parse("2026-08-30T00:05:00.000Z")).allowed).toBe(false);
    expect(authorize(breakGlass, "read_document_body", { ...resource, break_glass_audit_bound: true }, Date.parse("2026-08-30T00:11:00.000Z")).allowed).toBe(false);
  });

  it("exhaustively evaluates every role/action pair against the frozen server policy", () => {
    const expected: Readonly<Record<V07Role, readonly AuthorizationAction[]>> = {
      anonymous: [],
      customer_owner: ["read_case_metadata"],
      intake_operator: ["read_case_metadata", "mutate_case"],
      extraction_reviewer: ["read_case_metadata", "read_document_body", "review_extraction"],
      fact_reviewer: ["read_case_metadata", "read_document_body", "review_facts"],
      legal_reviewer: ["read_legal_artifact", "review_legal"],
      parameter_verifier: ["read_legal_artifact", "attest_parameter"],
      report_approver: ["read_case_metadata", "approve_report"],
      auditor: ["read_audit_metadata"],
      scoped_background_worker: ["run_scoped_job"],
      break_glass_admin: AUTHORIZATION_ACTIONS.filter((action) => action !== "mutate_identity"),
    };
    for (const role of V07_ROLES) {
      const identity: VerifiedActor = role === "customer_owner"
        ? actor(role, "owner_000000001")
        : role === "scoped_background_worker"
          ? { ...actor(role, "worker_00000001"), tenant_id: null }
          : role === "break_glass_admin"
            ? { ...actor(role, "admin_000000001"), break_glass_reason: "INCIDENT_0001", break_glass_expires_at: "2026-08-30T00:10:00.000Z" }
            : actor(role);
      for (const action of AUTHORIZATION_ACTIONS) {
        const scopedResource = role === "scoped_background_worker"
          ? { ...resource, tenant_id: null, break_glass_audit_bound: false }
          : role === "break_glass_admin"
            ? { ...resource, break_glass_audit_bound: true }
            : resource;
        expect(authorize(identity, action, scopedResource, Date.parse("2026-08-30T00:05:00.000Z")).allowed, `${role}/${action}`).toBe(expected[role].includes(action));
      }
    }
  });
});

describe("V07-P2-RLS static contract", () => {
  it("covers every customer table, joins, RPCs and immutable ownership while retaining dynamic blocker", () => {
    const result = verifyStaticRlsContract(buildStaticRlsContract());
    expect(result).toMatchObject({ valid: true, capability: "STATIC_CONTRACT_ONLY", blocker_code: "ISOLATED_SUPABASE_MIGRATION_RLS_VERIFICATION_REQUIRED" });
    expect(verifyStaticRlsContract(buildStaticRlsContract().slice(1)).valid).toBe(false);
  });
});
