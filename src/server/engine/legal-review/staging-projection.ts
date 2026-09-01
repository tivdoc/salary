// V0.10.3 staged-observation to review-backlog projection.
//
// Historical acquisition produced observations, not conclusions. This maps
// them into an explicit review backlog and nothing more: no source is promoted,
// no parameter is extracted, no legal effect is inferred, and an observation
// whose official artifact bytes are absent becomes a visible blocked entry
// rather than a substituted one.

import { frozen, legalOperationsSha256 } from "../../../engine/legal-operations/canonical.ts";
import {
  legalObservationCandidateSchema,
  type LegalObservationCandidate,
} from "../../platform/persistence/postgres/governance/contracts.ts";

export const LEGAL_REVIEW_BACKLOG_SCHEMA = "tivdoc-legal-review-backlog-v0.10.3" as const;

export type LegalReviewBacklogBlockedReason =
  | "OFFICIAL_ARTIFACT_BYTES_MISSING"
  | "ARTIFACT_VERSION_MISSING"
  | "TOPIC_UNRESOLVED"
  | "EFFECTIVE_PERIOD_UNRESOLVED";

export type LegalReviewBacklogEntry = Readonly<{
  schema_version: typeof LEGAL_REVIEW_BACKLOG_SCHEMA;
  observation_id: string;
  observation_version: string;
  observation_kind: LegalObservationCandidate["observation_kind"];
  candidate_sha256: string;
  bytes_sha256: string | null;
  byte_object_id: string | null;
  artifact_version_id: string | null;
  topic: string | null;
  sectors: readonly string[];
  populations: readonly string[];
  candidate_valid_from: string | null;
  candidate_valid_to: string | null;
  provenance: Readonly<Record<string, unknown>>;
  provenance_sha256: string;
  disposition: "reviewable" | "blocked";
  blocked_reason_codes: readonly LegalReviewBacklogBlockedReason[];
}>;

export type LegalReviewBacklog = Readonly<{
  schema_version: typeof LEGAL_REVIEW_BACKLOG_SCHEMA;
  entries: readonly LegalReviewBacklogEntry[];
  counts: Readonly<{ total: number; reviewable: number; blocked: number }>;
  activation_allowed: false;
}>;

export class LegalReviewBacklogError extends Error {
  readonly code: "LEGAL_REVIEW_BACKLOG_CANDIDATE_INVALID" | "LEGAL_REVIEW_BACKLOG_CONFLICT"
    | "LEGAL_REVIEW_BACKLOG_ACTIVATION_FORBIDDEN";

  constructor(code: LegalReviewBacklogError["code"], detail?: string) {
    super(detail ? `${code}:${detail}` : code);
    this.name = "LegalReviewBacklogError";
    this.code = code;
  }
}

/**
 * Reasons this observation cannot yet be reviewed. An empty list means the
 * evidence needed to open a review packet is present; it never means the
 * observation has been accepted.
 */
function blockedReasons(candidate: LegalObservationCandidate): readonly LegalReviewBacklogBlockedReason[] {
  const reasons: LegalReviewBacklogBlockedReason[] = [];
  if (candidate.bytes_sha256 === null || candidate.byte_object_id === null) {
    reasons.push("OFFICIAL_ARTIFACT_BYTES_MISSING");
  }
  if (candidate.artifact_version_id === null) reasons.push("ARTIFACT_VERSION_MISSING");
  if (candidate.topic === null) reasons.push("TOPIC_UNRESOLVED");
  if (candidate.candidate_valid_from === null && candidate.candidate_valid_to === null) {
    reasons.push("EFFECTIVE_PERIOD_UNRESOLVED");
  }
  return frozen(reasons);
}

export function projectObservationToBacklogEntry(candidateInput: unknown): LegalReviewBacklogEntry {
  let candidate: LegalObservationCandidate;
  try {
    candidate = legalObservationCandidateSchema.parse(candidateInput);
  } catch (error) {
    throw new LegalReviewBacklogError("LEGAL_REVIEW_BACKLOG_CANDIDATE_INVALID",
      error instanceof Error ? error.message.slice(0, 200) : undefined);
  }
  // Defence in depth: the schema pins these literals, so a candidate reaching
  // here with anything else means the contract was bypassed upstream.
  if (candidate.activation_allowed !== false || candidate.legal_effect !== "unreviewed") {
    throw new LegalReviewBacklogError("LEGAL_REVIEW_BACKLOG_ACTIVATION_FORBIDDEN", candidate.observation_id);
  }
  const reasons = blockedReasons(candidate);
  return frozen({
    schema_version: LEGAL_REVIEW_BACKLOG_SCHEMA,
    observation_id: candidate.observation_id,
    observation_version: candidate.observation_version,
    observation_kind: candidate.observation_kind,
    candidate_sha256: candidate.candidate_sha256,
    bytes_sha256: candidate.bytes_sha256,
    byte_object_id: candidate.byte_object_id,
    artifact_version_id: candidate.artifact_version_id,
    topic: candidate.topic,
    sectors: frozen([...candidate.sectors]),
    populations: frozen([...candidate.populations]),
    candidate_valid_from: candidate.candidate_valid_from,
    candidate_valid_to: candidate.candidate_valid_to,
    provenance: frozen({ ...candidate.provenance }),
    provenance_sha256: legalOperationsSha256(candidate.provenance),
    disposition: reasons.length === 0 ? "reviewable" as const : "blocked" as const,
    blocked_reason_codes: reasons,
  });
}

function compareEntries(left: LegalReviewBacklogEntry, right: LegalReviewBacklogEntry): number {
  if (left.observation_id !== right.observation_id) return left.observation_id < right.observation_id ? -1 : 1;
  if (left.observation_version !== right.observation_version) {
    return left.observation_version < right.observation_version ? -1 : 1;
  }
  return left.candidate_sha256 < right.candidate_sha256 ? -1 : left.candidate_sha256 > right.candidate_sha256 ? 1 : 0;
}

/**
 * Deterministic and idempotent: the same staged set always projects to the same
 * backlog, replaying an identical observation collapses, and the same
 * observation version arriving with different bytes is a conflict rather than
 * a silent overwrite.
 */
export function projectStagedObservationsToReviewBacklog(
  candidates: readonly unknown[],
): LegalReviewBacklog {
  const byIdentity = new Map<string, LegalReviewBacklogEntry>();
  for (const candidate of candidates) {
    const entry = projectObservationToBacklogEntry(candidate);
    const identity = `${entry.observation_id}@${entry.observation_version}`;
    const existing = byIdentity.get(identity);
    if (existing) {
      if (legalOperationsSha256(existing) !== legalOperationsSha256(entry)) {
        throw new LegalReviewBacklogError("LEGAL_REVIEW_BACKLOG_CONFLICT", identity);
      }
      continue;
    }
    byIdentity.set(identity, entry);
  }
  const entries = frozen([...byIdentity.values()].sort(compareEntries));
  return frozen({
    schema_version: LEGAL_REVIEW_BACKLOG_SCHEMA,
    entries,
    counts: frozen({
      total: entries.length,
      reviewable: entries.filter((entry) => entry.disposition === "reviewable").length,
      blocked: entries.filter((entry) => entry.disposition === "blocked").length,
    }),
    activation_allowed: false as const,
  });
}
