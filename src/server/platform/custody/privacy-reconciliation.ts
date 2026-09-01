import { canonicalSha256, deepFreeze } from "../../../engine/rule-runtime/canonical.ts";

export type PrivacyReconciliationInput = Readonly<{
  case_id: string;
  request_id: string;
  request_kind: "data_export" | "correction" | "deletion";
  legal_hold: boolean;
  database_object_refs: readonly Readonly<{ object_id: string; sha256: string; status: "active" | "tombstoned" }>[];
  object_inventory: readonly Readonly<{ object_id: string; sha256: string }>[];
  reports: readonly Readonly<{ report_id: string; object_id: string; status: "available" | "invalidated" | "deleted" }>[];
  grants: readonly Readonly<{ grant_id: string; object_id: string; expires_at: string; revoked: boolean }>[];
  backup_object_ids: readonly string[];
  audit_case_ids: readonly string[];
  rpo_target_seconds: number;
  rto_target_seconds: number;
  reconciled_at: string;
}>;

export type PrivacyReconciliationPlan = Readonly<{
  schema_version: "tivdoc-privacy-storage-reconciliation-v0.10.0";
  case_id: string;
  request_id: string;
  status: "ready_for_human_execution" | "restricted_by_legal_hold" | "integrity_blocked";
  stale_grant_ids: readonly string[];
  orphan_object_ids: readonly string[];
  missing_object_ids: readonly string[];
  corrupt_object_ids: readonly string[];
  orphan_report_ids: readonly string[];
  backup_residual_object_ids: readonly string[];
  audit_continuity_present: boolean;
  deletion_domains: readonly Readonly<{ domain: "database" | "object_storage" | "reports" | "grants" | "backups" | "audit"; action: string; executable: boolean }>[];
  rpo_rto_configuration: Readonly<{ rpo_target_seconds: number; rto_target_seconds: number; proven: false }>;
  blocker_codes: readonly string[];
  mutation_applied: false;
  plan_sha256: string;
}>;

export function reconcilePrivacyStorage(input: PrivacyReconciliationInput): PrivacyReconciliationPlan {
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{2,159}$/.test(input.case_id)
      || !/^[A-Za-z0-9][A-Za-z0-9:._-]{2,159}$/.test(input.request_id)
      || !Number.isFinite(Date.parse(input.reconciled_at))) throw new Error("PRIVACY_RECONCILIATION_INPUT_INVALID");
  for (const value of [input.rpo_target_seconds, input.rto_target_seconds]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 31_536_000) throw new Error("PRIVACY_RPO_RTO_CONFIGURATION_INVALID");
  }
  const database = uniqueBy(input.database_object_refs, (entry) => entry.object_id, "PRIVACY_DATABASE_OBJECT_DUPLICATE");
  const inventory = uniqueBy(input.object_inventory, (entry) => entry.object_id, "PRIVACY_INVENTORY_OBJECT_DUPLICATE");
  uniqueBy(input.reports, (entry) => entry.report_id, "PRIVACY_REPORT_DUPLICATE");
  uniqueBy(input.grants, (entry) => entry.grant_id, "PRIVACY_GRANT_DUPLICATE");
  const activeDatabase = new Map([...database].filter(([, entry]) => entry.status === "active"));
  const inventoryMap = new Map(inventory);
  const orphanObjectIds = sorted([...inventoryMap.keys()].filter((id) => !activeDatabase.has(id)));
  const missingObjectIds = sorted([...activeDatabase.keys()].filter((id) => !inventoryMap.has(id)));
  const corruptObjectIds = sorted([...activeDatabase].filter(([id, entry]) => inventoryMap.has(id) && inventoryMap.get(id)!.sha256 !== entry.sha256).map(([id]) => id));
  const staleGrantIds = sorted(input.grants.filter((grant) => {
    const object = activeDatabase.get(grant.object_id);
    return !grant.revoked && (!object || grant.expires_at <= input.reconciled_at);
  }).map((grant) => grant.grant_id));
  const orphanReportIds = sorted(input.reports.filter((report) => report.status !== "deleted" && !activeDatabase.has(report.object_id)).map((report) => report.report_id));
  const backupResidualObjectIds = sorted(input.backup_object_ids.filter((id) => !activeDatabase.has(id)));
  const auditContinuityPresent = input.audit_case_ids.includes(input.case_id);
  const integrityBlocked = missingObjectIds.length > 0 || corruptObjectIds.length > 0 || !auditContinuityPresent;
  const legalHoldBlocked = input.request_kind === "deletion" && input.legal_hold;
  const status: PrivacyReconciliationPlan["status"] = legalHoldBlocked ? "restricted_by_legal_hold" : integrityBlocked ? "integrity_blocked" : "ready_for_human_execution";
  const blockers = sorted([
    ...(legalHoldBlocked ? ["PRIVACY_LEGAL_HOLD_CONFLICT"] : []),
    ...(missingObjectIds.length > 0 ? ["PRIVACY_OBJECTS_MISSING"] : []),
    ...(corruptObjectIds.length > 0 ? ["PRIVACY_OBJECTS_CORRUPT"] : []),
    ...(!auditContinuityPresent ? ["PRIVACY_AUDIT_CONTINUITY_MISSING"] : []),
  ]);
  const executable = input.request_kind === "deletion" && !legalHoldBlocked && !integrityBlocked;
  const deletionDomains = [
    ["database", "tombstone_case_rows"],
    ["object_storage", "delete_eligible_case_objects"],
    ["reports", "invalidate_and_delete_report_objects"],
    ["grants", "revoke_all_case_grants"],
    ["backups", "expire_case_objects_per_retention_policy"],
    ["audit", "retain_minimal_non_pii_audit_tombstone"],
  ].map(([domain, action]) => ({ domain, action, executable })) as PrivacyReconciliationPlan["deletion_domains"];
  const unsigned = {
    schema_version: "tivdoc-privacy-storage-reconciliation-v0.10.0" as const,
    case_id: input.case_id,
    request_id: input.request_id,
    status,
    stale_grant_ids: staleGrantIds,
    orphan_object_ids: orphanObjectIds,
    missing_object_ids: missingObjectIds,
    corrupt_object_ids: corruptObjectIds,
    orphan_report_ids: orphanReportIds,
    backup_residual_object_ids: backupResidualObjectIds,
    audit_continuity_present: auditContinuityPresent,
    deletion_domains: deletionDomains,
    rpo_rto_configuration: { rpo_target_seconds: input.rpo_target_seconds, rto_target_seconds: input.rto_target_seconds, proven: false as const },
    blocker_codes: blockers,
    mutation_applied: false as const,
  };
  return deepFreeze({ ...unsigned, plan_sha256: canonicalSha256(unsigned) });
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string, error: string): ReadonlyMap<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const identity = key(value);
    if (result.has(identity)) throw new Error(error);
    result.set(identity, value);
  }
  return result;
}

function sorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}
