import type { VerifiedActor } from "../../../engine/wave4/contracts";

export const AUTHORIZATION_ACTIONS = [
  "activate_legal_artifact",
  "approve_report",
  "attest_parameter",
  "mutate_case",
  "mutate_identity",
  "read_approved_report",
  "read_audit_metadata",
  "read_case_metadata",
  "read_document_body",
  "read_legal_artifact",
  "review_extraction",
  "review_facts",
  "review_legal",
  "run_scoped_job",
] as const;
export type AuthorizationAction = (typeof AUTHORIZATION_ACTIONS)[number];

export type AuthorizationResource = Readonly<{
  tenant_id: string | null;
  case_id: string | null;
  owner_actor_id: string | null;
  report_released: boolean;
  last_content_actor_id: string | null;
  first_parameter_attestor_id: string | null;
  worker_scope_actor_id: string | null;
  break_glass_audit_bound: boolean;
}>;

export type AuthorizationDecision = Readonly<{
  allowed: boolean;
  code: "ALLOW" | "DENY_ASSIGNMENT" | "DENY_DISTINCT_ACTOR" | "DENY_OWNER" | "DENY_RELEASE" | "DENY_ROLE" | "DENY_SCOPE" | "DENY_TENANT";
}>;

function deny(code: Exclude<AuthorizationDecision["code"], "ALLOW">): AuthorizationDecision {
  return Object.freeze({ allowed: false, code });
}

function assigned(actor: VerifiedActor, resource: AuthorizationResource): boolean {
  return resource.case_id !== null && actor.assigned_case_ids.includes(resource.case_id);
}

export function authorize(actor: VerifiedActor, action: AuthorizationAction, resource: AuthorizationResource, nowMs = Date.now()): AuthorizationDecision {
  if (actor.verified_server_side !== true) return deny("DENY_SCOPE");
  if (actor.role === "anonymous") return deny("DENY_ROLE");
  if (action === "mutate_identity") return deny("DENY_ROLE");

  if (actor.role === "break_glass_admin") {
    const expires = actor.break_glass_expires_at === null ? Number.NaN : Date.parse(actor.break_glass_expires_at);
    return actor.break_glass_reason !== null && Number.isFinite(expires) && expires > nowMs && resource.break_glass_audit_bound
      ? Object.freeze({ allowed: true, code: "ALLOW" })
      : deny("DENY_SCOPE");
  }
  if (actor.role === "auditor") return action === "read_audit_metadata" ? Object.freeze({ allowed: true, code: "ALLOW" }) : deny("DENY_ROLE");
  if (actor.role === "scoped_background_worker") {
    return action === "run_scoped_job" && resource.worker_scope_actor_id === actor.actor_id
      ? Object.freeze({ allowed: true, code: "ALLOW" })
      : deny("DENY_SCOPE");
  }
  if (actor.role === "customer_owner") {
    if (resource.owner_actor_id !== actor.actor_id) return deny("DENY_OWNER");
    if (actor.tenant_id === null || actor.tenant_id !== resource.tenant_id) return deny("DENY_TENANT");
    if (action === "read_case_metadata") return Object.freeze({ allowed: true, code: "ALLOW" });
    if (action === "read_approved_report") return resource.report_released ? Object.freeze({ allowed: true, code: "ALLOW" }) : deny("DENY_RELEASE");
    return deny("DENY_ROLE");
  }

  if (resource.tenant_id !== null && actor.tenant_id !== resource.tenant_id) return deny("DENY_TENANT");
  if (resource.case_id !== null && !assigned(actor, resource) && !["legal_reviewer", "parameter_verifier"].includes(actor.role)) return deny("DENY_ASSIGNMENT");

  const roleActions: Readonly<Record<string, readonly AuthorizationAction[]>> = {
    intake_operator: ["read_case_metadata", "mutate_case"],
    extraction_reviewer: ["read_case_metadata", "read_document_body", "review_extraction"],
    fact_reviewer: ["read_case_metadata", "read_document_body", "review_facts"],
    legal_reviewer: ["read_legal_artifact", "review_legal"],
    parameter_verifier: ["read_legal_artifact", "attest_parameter"],
    report_approver: ["read_case_metadata", "approve_report"],
  };
  if (!(roleActions[actor.role] ?? []).includes(action)) return deny("DENY_ROLE");
  if (action === "approve_report" && resource.last_content_actor_id === actor.actor_id) return deny("DENY_DISTINCT_ACTOR");
  if (action === "attest_parameter" && resource.first_parameter_attestor_id === actor.actor_id) return deny("DENY_DISTINCT_ACTOR");
  return Object.freeze({ allowed: true, code: "ALLOW" });
}
