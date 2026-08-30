import { createHash } from "node:crypto";

export const EVIDENCE_DISPOSITION_SCHEMA = "tivdoc-evidence-root-disposition-v1" as const;

export const EVIDENCE_DISPOSITION_STATES = [
  "trusted_current",
  "quarantined_failed",
  "forensic_only",
  "superseded_for_use",
  "not_available_for_revalidation",
] as const;

export type EvidenceDispositionState = typeof EVIDENCE_DISPOSITION_STATES[number];

export interface HistoricalPackageIdentity {
  package_id: string;
  zip_sha256: string;
  manifest_sha256: string;
  erratum_sha256?: string;
}

export interface EvidenceAdmissionCapabilities {
  current_audit_admission: boolean;
  legal_source_activation: boolean;
  shadow_evidence_admission: boolean;
}

export interface EvidenceDispositionRecord {
  schema_version: typeof EVIDENCE_DISPOSITION_SCHEMA;
  root_id: string;
  sequence: number;
  state: EvidenceDispositionState;
  reason_code: string;
  package_identity: HistoricalPackageIdentity;
  parent_record_hash: string | null;
  failure_latched: boolean;
  component_only: boolean;
  capabilities: EvidenceAdmissionCapabilities;
  record_hash: string;
}

export type NewDispositionRecord = Omit<EvidenceDispositionRecord, "schema_version" | "sequence" | "parent_record_hash" | "record_hash">;

export class EvidenceDispositionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "EvidenceDispositionError";
  }
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
  }
  throw new EvidenceDispositionError("unsupported_hash_value");
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

function withoutHash(record: EvidenceDispositionRecord): Omit<EvidenceDispositionRecord, "record_hash"> {
  const payload: Partial<EvidenceDispositionRecord> = { ...record };
  delete payload.record_hash;
  return payload as Omit<EvidenceDispositionRecord, "record_hash">;
}

function sameIdentity(left: HistoricalPackageIdentity, right: HistoricalPackageIdentity): boolean {
  return canonicalize(left) === canonicalize(right);
}

function transitionAllowed(previous: EvidenceDispositionState, next: EvidenceDispositionState): boolean {
  if (previous === "trusted_current") return next === "superseded_for_use";
  if (previous === "quarantined_failed") return next === "forensic_only";
  if (previous === "not_available_for_revalidation") return next === "forensic_only";
  if (previous === "forensic_only") return next === "superseded_for_use";
  return false;
}

function validateCapabilities(record: EvidenceDispositionRecord): void {
  const denied = !record.capabilities.current_audit_admission
    && !record.capabilities.legal_source_activation
    && !record.capabilities.shadow_evidence_admission;
  if ((record.state !== "trusted_current" || record.failure_latched || record.component_only) && !denied) {
    throw new EvidenceDispositionError("non_trusted_root_has_admission_capability");
  }
  if (record.state === "quarantined_failed" && !record.failure_latched) {
    throw new EvidenceDispositionError("quarantine_must_latch_failure");
  }
  if (record.failure_latched && record.state === "trusted_current") {
    throw new EvidenceDispositionError("failed_root_cannot_become_trusted");
  }
}

export function appendDisposition(
  history: readonly EvidenceDispositionRecord[],
  input: NewDispositionRecord,
): EvidenceDispositionRecord {
  const previous = history.at(-1);
  if (previous) {
    validateDispositionChain(history);
    if (previous.root_id !== input.root_id) throw new EvidenceDispositionError("root_id_changed");
    if (!sameIdentity(previous.package_identity, input.package_identity)) {
      throw new EvidenceDispositionError("package_identity_changed");
    }
    if (!transitionAllowed(previous.state, input.state)) {
      throw new EvidenceDispositionError("invalid_disposition_transition");
    }
    if (previous.failure_latched && !input.failure_latched) {
      throw new EvidenceDispositionError("failure_latch_cleared");
    }
  }
  const unsigned: Omit<EvidenceDispositionRecord, "record_hash"> = {
    schema_version: EVIDENCE_DISPOSITION_SCHEMA,
    root_id: input.root_id,
    sequence: history.length,
    state: input.state,
    reason_code: input.reason_code,
    package_identity: input.package_identity,
    parent_record_hash: previous?.record_hash ?? null,
    failure_latched: input.failure_latched,
    component_only: input.component_only,
    capabilities: input.capabilities,
  };
  const record = { ...unsigned, record_hash: sha256(unsigned) };
  validateCapabilities(record);
  return record;
}

export function validateDispositionChain(history: readonly EvidenceDispositionRecord[]): void {
  if (history.length === 0) throw new EvidenceDispositionError("empty_disposition_chain");
  history.forEach((record, index) => {
    if (record.schema_version !== EVIDENCE_DISPOSITION_SCHEMA) {
      throw new EvidenceDispositionError("disposition_schema_mismatch");
    }
    if (record.sequence !== index) throw new EvidenceDispositionError("disposition_sequence_mismatch");
    const previous = history[index - 1];
    if (record.parent_record_hash !== (previous?.record_hash ?? null)) {
      throw new EvidenceDispositionError("disposition_parent_hash_mismatch");
    }
    if (record.record_hash !== sha256(withoutHash(record))) {
      throw new EvidenceDispositionError("disposition_record_hash_mismatch");
    }
    if (previous) {
      if (previous.root_id !== record.root_id) throw new EvidenceDispositionError("root_id_changed");
      if (!sameIdentity(previous.package_identity, record.package_identity)) {
        throw new EvidenceDispositionError("package_identity_changed");
      }
      if (!transitionAllowed(previous.state, record.state)) {
        throw new EvidenceDispositionError("invalid_disposition_transition");
      }
      if (previous.failure_latched && !record.failure_latched) {
        throw new EvidenceDispositionError("failure_latch_cleared");
      }
    }
    validateCapabilities(record);
  });
}

export function canSatisfyCurrentAuditAdmission(history: readonly EvidenceDispositionRecord[]): boolean {
  validateDispositionChain(history);
  const current = history.at(-1)!;
  return current.state === "trusted_current"
    && !current.failure_latched
    && !current.component_only
    && current.capabilities.current_audit_admission;
}
