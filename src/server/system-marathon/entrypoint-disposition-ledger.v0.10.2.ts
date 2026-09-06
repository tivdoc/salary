import inventoryJson from "./canonical-entrypoints.v0.10.0.json" with { type: "json" };

import { deepFreeze } from "../../engine/rule-runtime/canonical.ts";
import {
  STABLE_ENTRYPOINT_CAPABILITY_REQUIREMENTS,
  type EntrypointExecutionClass,
  type StableEntrypointCapabilityRequirement,
} from "../platform/capabilities/stable-entrypoint-runtime.ts";
import type { CanonicalEntrypoint, CanonicalEntrypointInventory } from "./closure-contracts.ts";

const inventory = inventoryJson as CanonicalEntrypointInventory;
const capabilityRequirementById = new Map(
  STABLE_ENTRYPOINT_CAPABILITY_REQUIREMENTS.map((requirement) => [requirement.entrypoint_id, requirement]),
);

export const ENTRYPOINT_DISPOSITION_LEDGER_SCHEMA_VERSION = "tivdoc-entrypoint-disposition-ledger-v0.10.2" as const;

export type EntrypointCurrentStatus =
  | "CANONICALLY_WIRED"
  | "CAPABILITY_GATED_CANONICAL_SOURCE"
  | "EXTERNAL_OR_HUMAN_BLOCKED_LOCAL_FAIL_CLOSED"
  | "EVIDENCE_OR_MAINTENANCE_CLI"
  | "NON_PRODUCT_CONTRACT";

export type EntrypointDispositionRow = Readonly<{
  entrypoint_id: string;
  before_status: CanonicalEntrypoint["classification"];
  entrypoint: string;
  kind: CanonicalEntrypoint["kind"];
  stable_product_evidence_external_classification: EntrypointExecutionClass;
  identity_boundary: string;
  capability_gate: string;
  application_service: string;
  transaction_context: string;
  repository: string;
  storage: string;
  current_status: EntrypointCurrentStatus;
  source_path: string;
  canonical_contract_id: string;
  canonical_target: string;
  product_stable: boolean;
  reason_codes: readonly string[];
  local_fail_closed_evidence: readonly string[];
  replacement_proof: null;
}>;

export type EntrypointDispositionLedger = Readonly<{
  schema_version: typeof ENTRYPOINT_DISPOSITION_LEDGER_SCHEMA_VERSION;
  baseline_schema_version: CanonicalEntrypointInventory["schema_version"];
  denominator: 106;
  product_stable_denominator: 95;
  before_counts: Readonly<{ partial: 31; implemented_not_wired: 21; partial_or_unwired: 52 }>;
  source_disposition_counts: Readonly<{
    product_stable_partial_or_unwired: number;
    app_routes: number;
    api_routes: number;
    durable_workers: number;
    application_services: number;
    clis: number;
  }>;
  runtime_integration_non_claim: string;
  rows: readonly EntrypointDispositionRow[];
}>;

const rows = inventory.entries.map((entry) => dispositionFor(entry));

export const ENTRYPOINT_DISPOSITION_LEDGER: EntrypointDispositionLedger = deepFreeze({
  schema_version: ENTRYPOINT_DISPOSITION_LEDGER_SCHEMA_VERSION,
  baseline_schema_version: inventory.schema_version,
  // UX Run 1 / U0: CEP-096..CEP-101 joined the denominator (three pages PARTIAL, three API routes IMPLEMENTED_NOT_WIRED).
  denominator: 106,
  product_stable_denominator: 95,
  before_counts: { partial: 31, implemented_not_wired: 21, partial_or_unwired: 52 },
  source_disposition_counts: {
    product_stable_partial_or_unwired: rows.filter((row) => row.product_stable
      && (row.current_status === ("PARTIAL" as EntrypointCurrentStatus)
        || row.current_status === ("IMPLEMENTED_NOT_WIRED" as EntrypointCurrentStatus))).length,
    app_routes: rows.filter((row) => row.kind === "app_route").length,
    api_routes: rows.filter((row) => row.kind === "api_route").length,
    durable_workers: rows.filter((row) => row.kind === "durable_worker").length,
    application_services: rows.filter((row) => row.kind === "application_service").length,
    clis: rows.filter((row) => row.kind === "cli").length,
  },
  runtime_integration_non_claim: "This tracked source disposition does not itself prove that the canonical startup root and every dispatcher invoke the one-shot server capability runtime; final MC-29/MC-39 proof must verify that integration on the exact final tree.",
  rows,
});

export function validateEntrypointDispositionLedger(
  ledger: EntrypointDispositionLedger = ENTRYPOINT_DISPOSITION_LEDGER,
): readonly string[] {
  const issues: string[] = [];
  if (ledger.schema_version !== ENTRYPOINT_DISPOSITION_LEDGER_SCHEMA_VERSION) issues.push("DISPOSITION_SCHEMA_VERSION_INVALID");
  if (ledger.denominator !== 106 || ledger.rows.length !== 106) issues.push("DISPOSITION_DENOMINATOR_CHANGED");
  if (ledger.product_stable_denominator !== 95 || ledger.rows.filter((row) => row.product_stable).length !== 95) {
    issues.push("DISPOSITION_PRODUCT_STABLE_DENOMINATOR_CHANGED");
  }
  if (ledger.before_counts.partial !== 31 || ledger.before_counts.implemented_not_wired !== 21
      || ledger.before_counts.partial_or_unwired !== 52) issues.push("DISPOSITION_BEFORE_COUNTS_CHANGED");

  const ids = new Set<string>();
  for (const entry of inventory.entries) {
    const row = ledger.rows.find((candidate) => candidate.entrypoint_id === entry.entrypoint_id);
    if (!row || ids.has(entry.entrypoint_id)) {
      issues.push(`DISPOSITION_ROW_MISSING_OR_DUPLICATE:${entry.entrypoint_id}`);
      continue;
    }
    ids.add(entry.entrypoint_id);
    if (row.before_status !== entry.classification || row.entrypoint !== entry.stable_entry || row.kind !== entry.kind
        || row.source_path !== entry.source_path || row.canonical_contract_id !== entry.canonical_contract_id
        || row.canonical_target !== entry.canonical_target || row.product_stable !== entry.product_stable) {
      issues.push(`DISPOSITION_BASELINE_IDENTITY_CHANGED:${entry.entrypoint_id}`);
    }
    for (const field of [
      "entrypoint", "kind", "stable_product_evidence_external_classification", "identity_boundary",
      "capability_gate", "application_service", "transaction_context", "repository", "storage", "current_status",
    ] as const) {
      if (!String(row[field]).trim()) issues.push(`DISPOSITION_MAPPING_FIELD_EMPTY:${entry.entrypoint_id}:${field}`);
    }
    if (row.current_status === "EXTERNAL_OR_HUMAN_BLOCKED_LOCAL_FAIL_CLOSED"
        && (row.reason_codes.length === 0 || row.local_fail_closed_evidence.length < 2)) {
      issues.push(`DISPOSITION_EXTERNAL_WITHOUT_LOCAL_COMPLETION:${entry.entrypoint_id}`);
    }
    if (row.current_status === "EVIDENCE_OR_MAINTENANCE_CLI" && row.kind !== "cli") {
      issues.push(`DISPOSITION_NON_CLI_MISCLASSIFIED:${entry.entrypoint_id}`);
    }
    if (row.replacement_proof !== null) issues.push(`DISPOSITION_UNDECLARED_RETIREMENT:${entry.entrypoint_id}`);
  }
  if (ledger.source_disposition_counts.product_stable_partial_or_unwired !== 0) {
    issues.push("DISPOSITION_PRODUCT_STABLE_PARTIAL_OR_UNWIRED_NONZERO");
  }
  return deepFreeze(issues);
}

function dispositionFor(entry: CanonicalEntrypoint): EntrypointDispositionRow {
  const requirement = requiredCapabilityEntry(entry.entrypoint_id);
  const currentStatus = currentStatusFor(entry, requirement);
  const hasIdentity = requirement.required_capabilities.includes("identity") || requirement.required_capabilities.includes("session");
  const hasPostgresql = requirement.required_capabilities.includes("postgresql");
  const hasStorage = requirement.required_capabilities.includes("storage");
  return deepFreeze({
    entrypoint_id: entry.entrypoint_id,
    before_status: entry.classification,
    entrypoint: entry.stable_entry,
    kind: entry.kind,
    stable_product_evidence_external_classification: requirement.execution_class,
    identity_boundary: hasIdentity ? "server_verified_identity_and_session" : "public_or_non_identity_entrypoint",
    capability_gate: `src/server/platform/capabilities/stable-entrypoint-runtime.ts:assertStableEntrypointCapability("${entry.entrypoint_id}")`,
    application_service: entry.canonical_target,
    transaction_context: hasPostgresql ? "canonical_postgresql_transaction_or_read_context" : "no_postgresql_context_required",
    repository: hasPostgresql ? "canonical_composition_repository_only" : "no_product_repository_required",
    storage: hasStorage ? "private_content_addressed_storage_only" : "no_private_storage_required",
    current_status: currentStatus,
    source_path: entry.source_path,
    canonical_contract_id: entry.canonical_contract_id,
    canonical_target: entry.canonical_target,
    product_stable: entry.product_stable,
    reason_codes: [...entry.blockers].sort(compareStrings),
    local_fail_closed_evidence: currentStatus === "EXTERNAL_OR_HUMAN_BLOCKED_LOCAL_FAIL_CLOSED"
      ? [entry.source_path, "src/server/platform/capabilities/stable-entrypoint-runtime.ts"]
      : [],
    replacement_proof: null,
  });
}

function currentStatusFor(
  entry: CanonicalEntrypoint,
  requirement: StableEntrypointCapabilityRequirement,
): EntrypointCurrentStatus {
  if (entry.kind === "cli") return "EVIDENCE_OR_MAINTENANCE_CLI";
  if (!entry.product_stable) return entry.classification === "EXTERNAL_OR_HUMAN_BLOCKED"
    ? "EXTERNAL_OR_HUMAN_BLOCKED_LOCAL_FAIL_CLOSED"
    : "NON_PRODUCT_CONTRACT";
  if (entry.classification === "EXTERNAL_OR_HUMAN_BLOCKED") return "EXTERNAL_OR_HUMAN_BLOCKED_LOCAL_FAIL_CLOSED";
  if (entry.classification === "ALREADY_CANONICAL_AND_PROVEN") return "CANONICALLY_WIRED";
  if (requiresExternalOrDisabledCapability(requirement)) return "EXTERNAL_OR_HUMAN_BLOCKED_LOCAL_FAIL_CLOSED";
  return "CAPABILITY_GATED_CANONICAL_SOURCE";
}

function requiresExternalOrDisabledCapability(requirement: StableEntrypointCapabilityRequirement): boolean {
  if (requirement.required_capabilities.some((capability) => ["parser", "controlled_import", "shadow", "customer_processing", "delivery"].includes(capability))) {
    return true;
  }
  return false;
}

function requiredCapabilityEntry(entrypointId: string): StableEntrypointCapabilityRequirement {
  const requirement = capabilityRequirementById.get(entrypointId);
  if (!requirement) throw new Error(`DISPOSITION_CAPABILITY_REQUIREMENT_MISSING:${entrypointId}`);
  return requirement;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
