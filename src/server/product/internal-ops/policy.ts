import "./server-boundary.ts";

import type { V07Role, VerifiedActor } from "../../../engine/wave4/contracts.ts";
import type { InternalOpsAction, OpsCapability } from "./contracts.ts";

const OPS_STAFF = [
  "intake_operator",
  "extraction_reviewer",
  "fact_reviewer",
  "legal_reviewer",
  "parameter_verifier",
  "report_approver",
  "auditor",
  "scoped_background_worker",
  "break_glass_admin",
] as const satisfies readonly V07Role[];

const ACTION_ROLES: Readonly<Record<InternalOpsAction, readonly V07Role[]>> = Object.freeze({
  case_create: ["intake_operator", "break_glass_admin"],
  payment_reconcile: ["intake_operator", "break_glass_admin"],
  document_reference_add: ["intake_operator", "break_glass_admin"],
  extraction_review: ["extraction_reviewer", "break_glass_admin"],
  fact_resolution: ["fact_reviewer", "break_glass_admin"],
  analysis_request: ["legal_reviewer", "scoped_background_worker", "break_glass_admin"],
  analysis_resume: ["legal_reviewer", "scoped_background_worker", "break_glass_admin"],
  analysis_replay: ["legal_reviewer", "auditor", "scoped_background_worker", "break_glass_admin"],
  report_submit: ["legal_reviewer", "break_glass_admin"],
  report_approve: ["report_approver", "break_glass_admin"],
  report_reject: ["report_approver", "break_glass_admin"],
  report_manual_export: ["report_approver", "break_glass_admin"],
});

const READ_ROLES: Readonly<Record<Exclude<OpsCapability, `command.${string}`>, readonly V07Role[]>> = Object.freeze({
  "ops.read": OPS_STAFF,
  "queue.read": OPS_STAFF,
  "case.read": OPS_STAFF,
  "payment.read": ["intake_operator", "report_approver", "auditor", "break_glass_admin"],
  "document.read": ["intake_operator", "extraction_reviewer", "fact_reviewer", "legal_reviewer", "report_approver", "auditor", "break_glass_admin"],
  "extraction.read": ["extraction_reviewer", "fact_reviewer", "legal_reviewer", "report_approver", "auditor", "break_glass_admin"],
  "fact.read": ["fact_reviewer", "legal_reviewer", "report_approver", "auditor", "break_glass_admin"],
  "readiness.read": ["legal_reviewer", "parameter_verifier", "report_approver", "auditor", "break_glass_admin"],
  "analysis.read": ["legal_reviewer", "report_approver", "auditor", "scoped_background_worker", "break_glass_admin"],
  "report.read": ["legal_reviewer", "report_approver", "auditor", "break_glass_admin"],
  "audit.read": ["auditor", "break_glass_admin"],
});

export function rolePermits(role: V07Role, capability: OpsCapability): boolean {
  if (capability.startsWith("command.")) {
    const action = capability.slice("command.".length) as InternalOpsAction;
    return ACTION_ROLES[action]?.includes(role) ?? false;
  }
  return READ_ROLES[capability as keyof typeof READ_ROLES]?.includes(role) ?? false;
}

export function actorScopePermits(actor: VerifiedActor, caseId: string | null, now: string): boolean {
  if (actor.verified_server_side !== true) return false;
  if (actor.role === "break_glass_admin") {
    return actor.break_glass_reason !== null
      && actor.break_glass_reason.trim().length >= 8
      && actor.break_glass_expires_at !== null
      && Date.parse(actor.break_glass_expires_at) > Date.parse(now);
  }
  if (caseId === null) return true;
  return actor.assigned_case_ids.includes(caseId);
}

export function capabilitiesForRole(role: V07Role): readonly OpsCapability[] {
  const reads = (Object.keys(READ_ROLES) as OpsCapability[]).filter((capability) => rolePermits(role, capability));
  const writes = (Object.keys(ACTION_ROLES) as InternalOpsAction[])
    .map((action) => `command.${action}` as const)
    .filter((capability) => rolePermits(role, capability));
  return Object.freeze([...reads, ...writes].sort((a, b) => a.localeCompare(b, "en")));
}

export function internalOpsRoleMatrix(): Readonly<Record<V07Role, readonly OpsCapability[]>> {
  const roles: readonly V07Role[] = [
    "anonymous", "customer_owner", "intake_operator", "extraction_reviewer", "fact_reviewer",
    "legal_reviewer", "parameter_verifier", "report_approver", "auditor",
    "scoped_background_worker", "break_glass_admin",
  ];
  return Object.freeze(Object.fromEntries(roles.map((role) => [role, capabilitiesForRole(role)])) as Record<V07Role, readonly OpsCapability[]>);
}
