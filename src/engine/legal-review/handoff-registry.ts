// V0.10.6 human-handoff package registry (L7) and case-law register (L8).
//
// Both are local, content-addressed and empty by default. Nothing is delivered
// anywhere: `not_delivered` is the only terminal state this repository can
// honestly record, because it cannot witness an external recipient. The
// case-law register is non-operative by construction — an interpretation may be
// recorded and cited, but can never on its own authorize a monetary parameter
// or rule.

import { frozen, legalOperationsSha256 } from "../legal-operations/canonical.ts";
import { LegalReviewError } from "./contracts.ts";
import type { LegalHandoffManifest } from "./topic-readiness.ts";

export const HANDOFF_REGISTRY_SCHEMA = "tivdoc-legal-handoff-registry-v0.10.6" as const;
export const CASE_LAW_REGISTER_SCHEMA = "tivdoc-case-law-register-v0.10.6" as const;

export type HandoffPackageLifecycle =
  | "draft"
  | "sealed"
  | "not_delivered"
  | "invalidated";

export type HandoffPackage = Readonly<{
  schema_version: typeof HANDOFF_REGISTRY_SCHEMA;
  package_id: string;
  manifest_sha256: string;
  packet_ids: readonly string[];
  source_artifact_sha256s: readonly string[];
  template_ids: readonly string[];
  reviewer_requirements: readonly string[];
  bound_revisions: Readonly<Record<string, number>>;
  lifecycle: HandoffPackageLifecycle;
  acknowledgement_reference: null;
  delivered: false;
  invalidated_reason: string | null;
  created_at: string;
}>;

/**
 * Seals one package against a manifest and the exact packet revisions it was
 * built from. The revision map is what makes later invalidation deterministic.
 */
export function createHandoffPackage(input: Readonly<{
  package_id: string;
  manifest: LegalHandoffManifest;
  reviewer_requirements: readonly string[];
  bound_revisions: Readonly<Record<string, number>>;
  created_at: string;
}>): HandoffPackage {
  const packetIds = frozen([...input.manifest.packets.map((packet) => packet.packet_id)].sort());
  for (const packetId of packetIds) {
    if (!(packetId in input.bound_revisions)) {
      throw new LegalReviewError("LEGAL_REVIEW_ACTION_INVALID", `unbound_revision:${packetId}`);
    }
  }
  return frozen({
    schema_version: HANDOFF_REGISTRY_SCHEMA,
    package_id: input.package_id,
    manifest_sha256: input.manifest.manifest_sha256,
    packet_ids: packetIds,
    source_artifact_sha256s: frozen([...new Set(input.manifest.packets
      .map((packet) => packet.raw_artifact_sha256))].sort()),
    template_ids: frozen([...input.manifest.template_ids].sort()),
    reviewer_requirements: frozen([...new Set(input.reviewer_requirements)].sort()),
    bound_revisions: frozen({ ...input.bound_revisions }),
    lifecycle: "not_delivered" as const,
    acknowledgement_reference: null,
    delivered: false as const,
    invalidated_reason: null,
    created_at: input.created_at,
  });
}

/**
 * Any change to a referenced packet revision invalidates the package. A stale
 * bundle is never silently refreshed, because the reviewer may already be
 * looking at the version it described.
 */
export function invalidateHandoffPackageOnRevisionChange(
  packaged: HandoffPackage,
  currentRevisions: Readonly<Record<string, number>>,
): HandoffPackage {
  const changed = packaged.packet_ids.filter((packetId) =>
    currentRevisions[packetId] !== packaged.bound_revisions[packetId]);
  if (changed.length === 0) return packaged;
  return frozen({
    ...packaged,
    lifecycle: "invalidated" as const,
    invalidated_reason: `packet_revision_changed:${changed.sort().join(",")}`,
  });
}

/** Deterministic local export. It records that nothing was delivered. */
export function exportHandoffPackage(packaged: HandoffPackage): Readonly<{
  package_sha256: string;
  body: string;
  delivered: false;
}> {
  const body = JSON.stringify(packaged, Object.keys(packaged).sort(), 2);
  return frozen({
    package_sha256: legalOperationsSha256(packaged),
    body,
    delivered: false as const,
  });
}

export type CaseLawRegisterEntry = Readonly<{
  entry_id: string;
  document_reference: string;
  document_sha256: string;
  jurisdiction: string;
  court: string;
  decided_at: string;
  authority_tier: "binding" | "persuasive" | "limited" | "unknown";
  topics: readonly string[];
  cited_source_version_ids: readonly string[];
  review_state: "needs_review" | "reviewed_inactive" | "conflicted" | "rejected";
  conflicts_with_entry_ids: readonly string[];
  can_independently_authorize_monetary_rule: false;
}>;

export type CaseLawRegister = Readonly<{
  schema_version: typeof CASE_LAW_REGISTER_SCHEMA;
  entries: readonly CaseLawRegisterEntry[];
  entry_count: number;
  blocked_reason: string | null;
  activation_allowed: false;
}>;

/**
 * The register with whatever entries exist. Empty is the normal state: no
 * authoritative case-law content is present locally, and none is invented.
 */
export function buildCaseLawRegister(
  entries: readonly CaseLawRegisterEntry[] = [],
): CaseLawRegister {
  for (const entry of entries) {
    if (entry.can_independently_authorize_monetary_rule !== false) {
      throw new LegalReviewError("LEGAL_REVIEW_MONETARY_AUTHORITY_INSUFFICIENT", entry.entry_id);
    }
    if (!/^[a-f0-9]{64}$/u.test(entry.document_sha256)) {
      throw new LegalReviewError("LEGAL_REVIEW_ACTION_INVALID", `document_sha256:${entry.entry_id}`);
    }
  }
  const sorted = frozen([...entries].sort((left, right) => left.entry_id.localeCompare(right.entry_id)));
  return frozen({
    schema_version: CASE_LAW_REGISTER_SCHEMA,
    entries: sorted,
    entry_count: sorted.length,
    blocked_reason: sorted.length === 0
      ? "NO_AUTHORITATIVE_CASE_LAW_CONTENT_AVAILABLE_LOCALLY"
      : null,
    activation_allowed: false as const,
  });
}

/** Entries that disagree with each other, surfaced rather than resolved. */
export function caseLawConflicts(register: CaseLawRegister): readonly CaseLawRegisterEntry[] {
  return frozen(register.entries.filter((entry) =>
    entry.review_state === "conflicted" || entry.conflicts_with_entry_ids.length > 0));
}
