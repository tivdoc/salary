import {
  independentVerificationRefSchema,
  numericParameterDraftSchema,
  type IndependentVerificationRef,
  type NumericParameterDraft,
} from "../wave2/contracts.ts";
import { canonicalStringify } from "../rule-runtime/canonical.ts";

export const parameterInvalidationReasons = [
  "source_byte_changed",
  "parsed_content_changed",
  "parser_changed",
  "citation_changed",
  "value_changed",
  "unit_changed",
  "effective_interval_changed",
  "scope_changed",
  "population_changed",
  "dossier_changed",
  "source_set_changed",
] as const;

export type ParameterInvalidationReason = typeof parameterInvalidationReasons[number];

export type VerificationEvidenceBinding = Readonly<Pick<IndependentVerificationRef,
  | "source_id"
  | "source_version_id"
  | "artifact_sha256"
  | "parsed_version_id"
  | "parsed_sha256"
  | "parser_sha256"
  | "citation_id"
>>;

export type CurrentParameterBinding = Readonly<Pick<NumericParameterDraft,
  | "value_representation"
  | "unit"
  | "effective_from"
  | "effective_to"
  | "sector"
  | "population"
  | "dossier_sha256"
  | "source_set_sha256"
> & {
  evidence: readonly VerificationEvidenceBinding[];
}>;

function isHumanReviewerRole(role: string) {
  return /^human(?:[._:-][a-z0-9]+)+$/u.test(role);
}
function sameValue(left: unknown, right: unknown) {
  return canonicalStringify(left) === canonicalStringify(right);
}

function matchingEvidence(
  verification: IndependentVerificationRef,
  context: CurrentParameterBinding,
) {
  return context.evidence.find((candidate) => candidate.source_id === verification.source_id
    && candidate.source_version_id === verification.source_version_id);
}

export function createNumericParameterDraft(
  input: Omit<NumericParameterDraft, "state" | "verifications" | "activation_state">,
): NumericParameterDraft {
  return numericParameterDraftSchema.parse({
    ...input,
    state: "draft",
    verifications: [],
    activation_state: "inactive",
  });
}

function assertVerificationBinding(
  draft: NumericParameterDraft,
  verification: IndependentVerificationRef,
  context: CurrentParameterBinding,
) {
  if (!isHumanReviewerRole(verification.reviewer_role)) throw new Error("human_reviewer_role_required");
  if (!sameValue(verification.value_representation, draft.value_representation)) throw new Error("verification_value_mismatch");
  if (verification.unit !== draft.unit) throw new Error("verification_unit_mismatch");
  if (verification.effective_from !== draft.effective_from || verification.effective_to !== draft.effective_to) throw new Error("verification_interval_mismatch");
  if (verification.sector !== draft.sector) throw new Error("verification_scope_mismatch");
  if (verification.population !== draft.population) throw new Error("verification_population_mismatch");
  if (verification.dossier_sha256 !== draft.dossier_sha256 || verification.dossier_sha256 !== context.dossier_sha256) throw new Error("verification_dossier_mismatch");
  if (verification.source_set_sha256 !== draft.source_set_sha256 || verification.source_set_sha256 !== context.source_set_sha256) throw new Error("verification_source_set_mismatch");
  const evidence = matchingEvidence(verification, context);
  if (!evidence) throw new Error("verification_source_evidence_missing");
  for (const field of [
    "artifact_sha256",
    "parsed_version_id",
    "parsed_sha256",
    "parser_sha256",
    "citation_id",
  ] as const) {
    if (verification[field] !== evidence[field]) throw new Error(`verification_${field}_mismatch`);
  }
}

export function appendIndependentHumanVerification(
  draft: NumericParameterDraft,
  verificationInput: IndependentVerificationRef,
  context: CurrentParameterBinding,
): NumericParameterDraft {
  if (draft.state !== "draft") throw new Error("verification_only_allowed_from_draft");
  if (draft.verifications.length >= 2) throw new Error("exactly_two_verifications_allowed");
  const verification = independentVerificationRefSchema.parse(verificationInput);
  assertVerificationBinding(draft, verification, context);
  if (draft.verifications.some((existing) => existing.reviewer_id === verification.reviewer_id)) {
    throw new Error("independent_verification_requires_distinct_human_reviewers");
  }
  if (draft.verifications.some((existing) => existing.verification_id === verification.verification_id)) {
    throw new Error("duplicate_verification_id");
  }
  const verifications = [...draft.verifications, verification];
  return numericParameterDraftSchema.parse({
    ...draft,
    state: verifications.length === 2 ? "independently_verified_twice" : "draft",
    verifications,
    activation_state: "inactive",
  });
}

export function assessParameterInvalidation(
  draft: NumericParameterDraft,
  current: CurrentParameterBinding,
): ParameterInvalidationReason[] {
  const reasons = new Set<ParameterInvalidationReason>();
  if (!sameValue(draft.value_representation, current.value_representation)) reasons.add("value_changed");
  if (draft.unit !== current.unit) reasons.add("unit_changed");
  if (draft.effective_from !== current.effective_from || draft.effective_to !== current.effective_to) reasons.add("effective_interval_changed");
  if (draft.sector !== current.sector) reasons.add("scope_changed");
  if (draft.population !== current.population) reasons.add("population_changed");
  if (draft.dossier_sha256 !== current.dossier_sha256) reasons.add("dossier_changed");
  if (draft.source_set_sha256 !== current.source_set_sha256) reasons.add("source_set_changed");
  for (const verification of draft.verifications) {
    const evidence = matchingEvidence(verification, current);
    if (!evidence) {
      reasons.add("source_set_changed");
      continue;
    }
    if (verification.artifact_sha256 !== evidence.artifact_sha256) reasons.add("source_byte_changed");
    if (verification.parsed_version_id !== evidence.parsed_version_id || verification.parsed_sha256 !== evidence.parsed_sha256) reasons.add("parsed_content_changed");
    if (verification.parser_sha256 !== evidence.parser_sha256) reasons.add("parser_changed");
    if (verification.citation_id !== evidence.citation_id) reasons.add("citation_changed");
  }
  return parameterInvalidationReasons.filter((reason) => reasons.has(reason));
}

export function makeActivationEligible(
  draft: NumericParameterDraft,
  current: CurrentParameterBinding,
): NumericParameterDraft {
  if (draft.state !== "independently_verified_twice" || draft.verifications.length !== 2) {
    throw new Error("two_independent_human_verifications_required");
  }
  if (new Set(draft.verifications.map((entry) => entry.reviewer_id)).size !== 2) {
    throw new Error("distinct_human_reviewers_required");
  }
  const invalidations = assessParameterInvalidation(draft, current);
  if (invalidations.length > 0) throw new Error(`parameter_binding_invalidated:${invalidations.join(",")}`);
  return numericParameterDraftSchema.parse({ ...draft, state: "activation_eligible", activation_state: "inactive" });
}

export function invalidateNumericParameterDraft(
  draft: NumericParameterDraft,
  current: CurrentParameterBinding,
) {
  const reasons = assessParameterInvalidation(draft, current);
  if (reasons.length === 0) return { status: "unchanged" as const, reasons, parameter: draft };
  return {
    status: "invalidated" as const,
    reasons,
    parameter: numericParameterDraftSchema.parse({
      ...draft,
      state: "draft",
      verifications: [],
      activation_state: "inactive",
    }),
  };
}
