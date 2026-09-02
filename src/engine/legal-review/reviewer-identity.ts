// V0.10.6 reviewer identity and key readiness (L4).
//
// This evaluates whether a reviewer reference is usable for an internal review
// action. It provisions nothing, holds no private key and proves no signature:
// it checks the reference material the durable governance contracts already
// record, and reports exactly why a reviewer is or is not eligible.
//
// Synthetic identities are marked synthetic and are refused for anything that
// could ever become a real approval, so a fixture can never be mistaken for a
// human decision.

import { frozen } from "../legal-operations/canonical.ts";
import type { LegalReviewerRole } from "./contracts.ts";

export const REVIEWER_IDENTITY_SCHEMA = "tivdoc-reviewer-identity-readiness-v0.10.6" as const;

const SYNTHETIC_MARKERS = frozen(["synthetic", "fixture", "sample", "test"]);
const KEY_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export type ReviewerKeyState = "active" | "suspended" | "revoked" | "rotated";

export type ReviewerIdentityReference = Readonly<{
  reviewer_id: string;
  reviewer_role: LegalReviewerRole;
  key_reference: string;
  public_key_sha256: string;
  key_state: ReviewerKeyState;
  valid_from: string;
  expires_at: string;
  rotated_to_key_reference: string | null;
  organization_id: string;
  registered_by_actor_id: string;
  registered_at: string;
}>;

export type ReviewerIneligibilityCode =
  | "KEY_REFERENCE_MALFORMED"
  | "PUBLIC_KEY_DIGEST_MALFORMED"
  | "KEY_REVOKED"
  | "KEY_SUSPENDED"
  | "KEY_ROTATED_TO_SUCCESSOR"
  | "OUTSIDE_VALIDITY_WINDOW"
  | "ROLE_NOT_ELIGIBLE"
  | "SYNTHETIC_IDENTITY_NOT_HUMAN"
  | "AUDIT_PROVENANCE_INCOMPLETE";

export type ReviewerIdentityReadiness = Readonly<{
  schema_version: typeof REVIEWER_IDENTITY_SCHEMA;
  reviewer_id: string;
  reviewer_role: LegalReviewerRole;
  synthetic: boolean;
  eligible_for_internal_review: boolean;
  eligible_for_real_approval: false;
  ineligibility_codes: readonly ReviewerIneligibilityCode[];
  cryptographic_verification_performed: false;
}>;

/**
 * A reference is synthetic when its own identifiers say so. This is a labelling
 * check, not a security control: it exists so a fixture is never displayed or
 * counted as a human reviewer.
 */
export function isSyntheticReviewerReference(reference: ReviewerIdentityReference): boolean {
  const haystack = `${reference.reviewer_id} ${reference.key_reference} ${reference.organization_id}`.toLowerCase();
  return SYNTHETIC_MARKERS.some((marker) => haystack.includes(marker));
}

/**
 * Evaluates one reviewer reference at a point in time. Every failure reason is
 * returned rather than short-circuited, so the workbench can show a reviewer
 * everything that stands between them and eligibility.
 */
export function evaluateReviewerIdentityReadiness(
  reference: ReviewerIdentityReference,
  now: string,
  eligibleRoles: readonly LegalReviewerRole[] = ["legal_reviewer", "senior_legal_reviewer"],
): ReviewerIdentityReadiness {
  const codes: ReviewerIneligibilityCode[] = [];
  if (!KEY_REFERENCE.test(reference.key_reference)) codes.push("KEY_REFERENCE_MALFORMED");
  if (!SHA256.test(reference.public_key_sha256)) codes.push("PUBLIC_KEY_DIGEST_MALFORMED");
  if (reference.key_state === "revoked") codes.push("KEY_REVOKED");
  if (reference.key_state === "suspended") codes.push("KEY_SUSPENDED");
  if (reference.key_state === "rotated") codes.push("KEY_ROTATED_TO_SUCCESSOR");

  const at = Date.parse(now);
  const from = Date.parse(reference.valid_from);
  const until = Date.parse(reference.expires_at);
  if (!Number.isFinite(at) || !Number.isFinite(from) || !Number.isFinite(until)
    || at < from || at >= until) {
    codes.push("OUTSIDE_VALIDITY_WINDOW");
  }
  if (!eligibleRoles.includes(reference.reviewer_role)) codes.push("ROLE_NOT_ELIGIBLE");
  if (reference.registered_by_actor_id.trim() === "" || Number.isNaN(Date.parse(reference.registered_at))) {
    codes.push("AUDIT_PROVENANCE_INCOMPLETE");
  }

  const synthetic = isSyntheticReviewerReference(reference);
  if (synthetic) codes.push("SYNTHETIC_IDENTITY_NOT_HUMAN");

  const sorted = frozen([...new Set(codes)].sort());
  return frozen({
    schema_version: REVIEWER_IDENTITY_SCHEMA,
    reviewer_id: reference.reviewer_id,
    reviewer_role: reference.reviewer_role,
    synthetic,
    // Synthetic references may still drive the internal workflow; they simply
    // carry their marker everywhere they go.
    eligible_for_internal_review: sorted.filter((code) => code !== "SYNTHETIC_IDENTITY_NOT_HUMAN").length === 0,
    // No reference evaluated here is ever eligible for a real approval: this
    // repository holds no human key and performs no signature verification.
    eligible_for_real_approval: false as const,
    ineligibility_codes: sorted,
    cryptographic_verification_performed: false as const,
  });
}

/** Successor reference for a rotated key, when one was recorded. */
export function reviewerRotationSuccessor(reference: ReviewerIdentityReference): string | null {
  return reference.key_state === "rotated" ? reference.rotated_to_key_reference : null;
}

/** Deterministic roster ordering, ineligible reviewers first so they are seen. */
export function buildReviewerIdentityRoster(
  references: readonly ReviewerIdentityReference[],
  now: string,
): readonly ReviewerIdentityReadiness[] {
  return frozen(references
    .map((reference) => evaluateReviewerIdentityReadiness(reference, now))
    .sort((left, right) => Number(left.eligible_for_internal_review) - Number(right.eligible_for_internal_review)
      || left.reviewer_id.localeCompare(right.reviewer_id)));
}
