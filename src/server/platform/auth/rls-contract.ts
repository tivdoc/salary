export const CUSTOMER_SCOPED_TABLES = [
  "analysis_runs",
  "audit_case_projection",
  "canonical_facts",
  "case_documents",
  "cases",
  "extractions",
  "jobs",
  "object_metadata",
  "payment_evidence",
  "reports",
  "reviews",
  "rule_inputs",
] as const;

export type StaticRlsPolicy = Readonly<{
  table: (typeof CUSTOMER_SCOPED_TABLES)[number];
  force_rls: true;
  select_owner_predicate: "tenant_and_case_assignment";
  mutation_owner_predicate: "server_claim_tenant_and_case_assignment";
  join_guarded: true;
  rpc_guarded: true;
  owner_columns_immutable: true;
}>;

export function buildStaticRlsContract(): readonly StaticRlsPolicy[] {
  return Object.freeze(CUSTOMER_SCOPED_TABLES.map((table) => Object.freeze({
    table,
    force_rls: true as const,
    select_owner_predicate: "tenant_and_case_assignment" as const,
    mutation_owner_predicate: "server_claim_tenant_and_case_assignment" as const,
    join_guarded: true as const,
    rpc_guarded: true as const,
    owner_columns_immutable: true as const,
  })));
}

export function verifyStaticRlsContract(policies: readonly StaticRlsPolicy[]): Readonly<{
  valid: boolean;
  missing_tables: readonly string[];
  invalid_tables: readonly string[];
  capability: "STATIC_CONTRACT_ONLY";
  blocker_code: "ISOLATED_SUPABASE_MIGRATION_RLS_VERIFICATION_REQUIRED";
}> {
  const byTable = new Map(policies.map((policy) => [policy.table, policy]));
  const missing = CUSTOMER_SCOPED_TABLES.filter((table) => !byTable.has(table));
  const invalid = policies.filter((policy) => !policy.force_rls || !policy.join_guarded || !policy.rpc_guarded || !policy.owner_columns_immutable || policy.select_owner_predicate !== "tenant_and_case_assignment" || policy.mutation_owner_predicate !== "server_claim_tenant_and_case_assignment").map((policy) => policy.table);
  return Object.freeze({
    valid: missing.length === 0 && invalid.length === 0 && policies.length === CUSTOMER_SCOPED_TABLES.length,
    missing_tables: Object.freeze(missing),
    invalid_tables: Object.freeze([...new Set(invalid)].sort()),
    capability: "STATIC_CONTRACT_ONLY",
    blocker_code: "ISOLATED_SUPABASE_MIGRATION_RLS_VERIFICATION_REQUIRED",
  });
}
