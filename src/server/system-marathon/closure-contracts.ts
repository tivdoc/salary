import {
  MARATHON_CLASSIFICATIONS,
  MARATHON_TRUTH_BASELINE,
  type MarathonClassification,
} from "./contracts.ts";

export const CANONICAL_ENTRYPOINT_SCHEMA_VERSION =
  "tivdoc-canonical-entrypoint-inventory-v0.10.0" as const;
export const OWNER_ACTION_INDEX_SCHEMA_VERSION =
  "tivdoc-owner-action-index-v0.10.0" as const;

export const CANONICAL_ENTRYPOINT_KINDS = [
  "app_route",
  "api_route",
  "durable_worker",
  "cli",
  "application_service",
] as const;
export type CanonicalEntrypointKind = (typeof CANONICAL_ENTRYPOINT_KINDS)[number];

export const OWNER_ACTION_GROUPS = Object.freeze([
  { group_id: "OA-01", slug: "official-source-handoff" },
  { group_id: "OA-02", slug: "legal-source-review" },
  { group_id: "OA-03", slug: "effective-period-sector-population-review" },
  { group_id: "OA-04", slug: "parameter-attestations" },
  { group_id: "OA-05", slug: "rulespec-approval-golden-cases" },
  { group_id: "OA-06", slug: "payslip-visual-review-dual-annotation-adjudication" },
  { group_id: "OA-07", slug: "external-audit-delivery" },
  { group_id: "OA-08", slug: "isolated-supabase-managed-identity-storage" },
  { group_id: "OA-09", slug: "parser-sandbox-platform-proof" },
  { group_id: "OA-10", slug: "off-host-custody" },
  { group_id: "OA-11", slug: "customer-shadow-authorization" },
] as const);

export const EXTERNAL_ACTION_OWNER_TYPES = [
  "official_source_custodian",
  "trusted_legal_reviewer",
  "trusted_parameter_attestors",
  "trusted_rulespec_reviewers",
  "trusted_visual_reviewers",
  "independent_external_auditor",
  "managed_platform_owner",
  "sandbox_security_operator",
  "off_host_custody_operator",
  "customer_data_controller",
] as const;
export type ExternalActionOwnerType = (typeof EXTERNAL_ACTION_OWNER_TYPES)[number];

export const REQUIRED_CANONICAL_CLI_ENTRIES = Object.freeze([
  "npm run canonical:reachability:verify",
  "npm run platform:persistence:wiring:verify",
  "npm run platform:persistence:env:detect",
  "npm run platform:persistence:static:verify",
  "npm run platform:persistence:isolated:bootstrap",
  "npm run platform:persistence:isolated:verify",
  "npm run platform:persistence:isolated:teardown",
  "npm run product:routes:verify",
  "npm run product:auth-boundary:verify",
  "npm run product:pdf:hebrew:verify",
  "npm run product:e2e:synthetic",
  "npm run product:e2e:negative",
  "npm run verify:postgres:dynamic",
  "node --experimental-strip-types scripts/product-integration/durable-postgres/run.mts",
  "node --experimental-strip-types scripts/controlled-import/verify.mts",
  "node --experimental-strip-types scripts/human-trust/verify.mts",
  "npm run legal:ops:packets",
  "npm run legal:ops:verify",
  "npm run legal:ops:status",
  "npm run legal:ops:strict-readiness",
  "npm run legal:ops:import",
  "npm run legal:ops:propose-activation",
  "npm run legal:ops:activate",
  "npm run legal:ops:revoke",
  "npm run legal:ops:supersede",
  "npm run legal:review-workspace:build",
  "npm run legal:rulespec-skeletons:verify",
  "npm run legal:golden-workflow:verify",
  "npm run extraction:gt:workspace:verify",
  "npm run shadow:offline:verify",
  "npm run shadow:offline:synthetic",
  "npm run shadow:offline:real-blocked",
  "npm run tivdoc:ops:contract",
  "npm run tivdoc:ops:api:verify",
  "npm run tivdoc:ops:ui:verify",
  "npm run tivdoc:ops:e2e:synthetic",
  "npm run tivdoc:ops:e2e:blocked",
  "npm run tivdoc:portal:verify",
  "npm run platform:security:verify",
  "npm run platform:backup-restore:verify",
  "npm run marathon:v010:focused",
  "npm run marathon:v010:finalize",
  "npm run marathon:v010:security",
  "npm run marathon:v010:evidence:build",
  "npm run marathon:v010:evidence:verify",
] as const);

export type CanonicalEntrypoint = Readonly<{
  entrypoint_id: string;
  kind: CanonicalEntrypointKind;
  stable_entry: string;
  source_path: string;
  canonical_contract_id: string;
  canonical_target: string;
  classification: MarathonClassification;
  product_stable: boolean;
  dependencies: readonly string[];
  blockers: readonly string[];
  non_claim: string;
}>;

export type CanonicalEntrypointInventory = Readonly<{
  schema_version: typeof CANONICAL_ENTRYPOINT_SCHEMA_VERSION;
  generated_from_head: string;
  authority: Readonly<{
    reachability_command: "npm run canonical:reachability:verify";
    reachability_verifier: "scripts/product-integration/reachability/verify.mts";
    wiring_map: "src/server/platform/persistence/wiring-map.ts";
    composition_root: "src/server/platform/composition/canonical-postgres-application.ts";
    asserted_invariants: Readonly<{
      unknown_production_reachable_symbols: 0;
      duplicate_canonical_contracts: 0;
      wave_or_version_specific_stable_product_paths: 0;
      direct_repository_construction_outside_composition: 0;
      product_reachable_memory_fallbacks: 0;
    }>;
  }>;
  baseline_truth: typeof MARATHON_TRUTH_BASELINE;
  entries: readonly CanonicalEntrypoint[];
}>;

export type OwnerAction = Readonly<{
  action_id: string;
  owner_type: ExternalActionOwnerType;
  status: "BLOCKED_EXTERNAL";
  summary: string;
  external_prerequisites: readonly string[];
  evidence_required: readonly string[];
  blocked_truths: readonly (keyof typeof MARATHON_TRUTH_BASELINE)[];
  locally_solvable_engineering: false;
  completion_effect: string;
}>;

export type OwnerActionGroup = Readonly<{
  group_id: string;
  slug: string;
  title: string;
  actions: readonly OwnerAction[];
}>;

export type OwnerActionIndex = Readonly<{
  schema_version: typeof OWNER_ACTION_INDEX_SCHEMA_VERSION;
  generated_from_head: string;
  baseline_truth: typeof MARATHON_TRUTH_BASELINE;
  groups: readonly OwnerActionGroup[];
  non_claims: readonly string[];
}>;

const STABLE_PRODUCT_VERSION_PATTERN = /(?:^|[/:._-])(?:v0?\d+|wave\d*|overnight)(?:$|[/:._-])/iu;
const ROUTINE_ENGINEERING_PATTERN = /\b(?:write code|implement code|fix (?:a )?test|run lint|edit (?:a )?file|refactor|unit test|update documentation)\b/iu;

export function validateCanonicalEntrypointInventory(candidate: CanonicalEntrypointInventory): readonly string[] {
  const issues: string[] = [];
  if (candidate.schema_version !== CANONICAL_ENTRYPOINT_SCHEMA_VERSION) issues.push("ENTRYPOINT_SCHEMA_VERSION_INVALID");
  if (!/^[a-f0-9]{40}$/u.test(candidate.generated_from_head)) issues.push("ENTRYPOINT_HEAD_INVALID");
  if (!sameTruth(candidate.baseline_truth)) issues.push("ENTRYPOINT_BASELINE_TRUTH_CHANGED");
  if (candidate.authority.reachability_command !== "npm run canonical:reachability:verify"
      || candidate.authority.reachability_verifier !== "scripts/product-integration/reachability/verify.mts"
      || candidate.authority.wiring_map !== "src/server/platform/persistence/wiring-map.ts"
      || candidate.authority.composition_root !== "src/server/platform/composition/canonical-postgres-application.ts") {
    issues.push("ENTRYPOINT_CANONICAL_AUTHORITY_INVALID");
  }
  if (Object.values(candidate.authority.asserted_invariants).some((value) => value !== 0)) {
    issues.push("ENTRYPOINT_ZERO_INVARIANT_CHANGED");
  }

  const ids = new Set<string>();
  const stableEntries = new Set<string>();
  const contracts = new Set<string>();
  for (const entry of candidate.entries) {
    if (!/^CEP-\d{3}$/u.test(entry.entrypoint_id) || ids.has(entry.entrypoint_id)) issues.push(`ENTRYPOINT_ID_INVALID_OR_DUPLICATE:${entry.entrypoint_id}`);
    ids.add(entry.entrypoint_id);
    const entryKey = `${entry.kind}:${entry.stable_entry}`;
    if (stableEntries.has(entryKey)) issues.push(`ENTRYPOINT_STABLE_ENTRY_DUPLICATE:${entryKey}`);
    stableEntries.add(entryKey);
    if (!entry.canonical_contract_id || contracts.has(entry.canonical_contract_id)) issues.push(`ENTRYPOINT_CANONICAL_CONTRACT_DUPLICATE:${entry.canonical_contract_id}`);
    contracts.add(entry.canonical_contract_id);
    if (!(CANONICAL_ENTRYPOINT_KINDS as readonly string[]).includes(entry.kind)) issues.push(`ENTRYPOINT_KIND_INVALID:${entry.entrypoint_id}`);
    if (!(MARATHON_CLASSIFICATIONS as readonly string[]).includes(entry.classification)) issues.push(`ENTRYPOINT_CLASSIFICATION_UNKNOWN:${entry.entrypoint_id}`);
    if (!entry.source_path || entry.source_path.includes("\\") || !entry.canonical_target) issues.push(`ENTRYPOINT_TARGET_INVALID:${entry.entrypoint_id}`);
    if (entry.product_stable && STABLE_PRODUCT_VERSION_PATTERN.test(entry.stable_entry)) issues.push(`ENTRYPOINT_STABLE_VERSION_LEAK:${entry.entrypoint_id}`);
    if (!entry.non_claim.trim()) issues.push(`ENTRYPOINT_NON_CLAIM_MISSING:${entry.entrypoint_id}`);
  }

  const cliEntries = new Set(candidate.entries.filter((entry) => entry.kind === "cli").map((entry) => entry.stable_entry));
  for (const command of REQUIRED_CANONICAL_CLI_ENTRIES) {
    if (!cliEntries.has(command)) issues.push(`ENTRYPOINT_REQUIRED_CLI_MISSING:${command}`);
  }
  return Object.freeze(issues);
}

export function validateOwnerActionIndex(candidate: OwnerActionIndex): readonly string[] {
  const issues: string[] = [];
  if (candidate.schema_version !== OWNER_ACTION_INDEX_SCHEMA_VERSION) issues.push("OWNER_ACTION_SCHEMA_VERSION_INVALID");
  if (!/^[a-f0-9]{40}$/u.test(candidate.generated_from_head)) issues.push("OWNER_ACTION_HEAD_INVALID");
  if (!sameTruth(candidate.baseline_truth)) issues.push("OWNER_ACTION_BASELINE_TRUTH_CHANGED");
  if (candidate.groups.length !== OWNER_ACTION_GROUPS.length) issues.push("OWNER_ACTION_GROUP_COUNT_INVALID");

  const actionIds = new Set<string>();
  candidate.groups.forEach((group, index) => {
    const expected = OWNER_ACTION_GROUPS[index];
    if (!expected || group.group_id !== expected.group_id || group.slug !== expected.slug) issues.push(`OWNER_ACTION_GROUP_ORDER_INVALID:${group.group_id}`);
    if (group.actions.length < 1) issues.push(`OWNER_ACTION_GROUP_EMPTY:${group.group_id}`);
    for (const action of group.actions) {
      if (!/^OA-\d{2}-A\d{2}$/u.test(action.action_id) || actionIds.has(action.action_id)) issues.push(`OWNER_ACTION_ID_INVALID_OR_DUPLICATE:${action.action_id}`);
      actionIds.add(action.action_id);
      if (!(EXTERNAL_ACTION_OWNER_TYPES as readonly string[]).includes(action.owner_type)) issues.push(`OWNER_ACTION_OWNER_INVALID:${action.action_id}`);
      if (action.status !== "BLOCKED_EXTERNAL" || action.locally_solvable_engineering !== false) issues.push(`OWNER_ACTION_NOT_EXTERNAL_ONLY:${action.action_id}`);
      if (action.external_prerequisites.length < 1 || action.evidence_required.length < 1 || action.blocked_truths.length < 1) issues.push(`OWNER_ACTION_EVIDENCE_OR_PREREQUISITE_MISSING:${action.action_id}`);
      if (action.blocked_truths.some((truth) => !(truth in MARATHON_TRUTH_BASELINE))) issues.push(`OWNER_ACTION_TRUTH_UNKNOWN:${action.action_id}`);
      if (ROUTINE_ENGINEERING_PATTERN.test(action.summary)) issues.push(`OWNER_ACTION_ROUTINE_ENGINEERING_MISLABEL:${action.action_id}`);
      if (!/does not (?:activate|authorize|enable|prove)/iu.test(action.completion_effect)) issues.push(`OWNER_ACTION_NON_CLAIM_MISSING:${action.action_id}`);
    }
  });
  if (candidate.non_claims.length < 1) issues.push("OWNER_ACTION_GLOBAL_NON_CLAIMS_MISSING");
  return Object.freeze(issues);
}

function sameTruth(candidate: typeof MARATHON_TRUTH_BASELINE): boolean {
  return JSON.stringify(candidate) === JSON.stringify(MARATHON_TRUTH_BASELINE);
}
