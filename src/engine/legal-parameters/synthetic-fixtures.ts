import type { IndependentVerificationRef, NumericParameterDraft } from "../wave2/contracts.ts";
import type { CurrentParameterBinding } from "./state-machine.ts";

const hash = (character: string) => character.repeat(64);

export const syntheticNeutralDraftInput: Omit<NumericParameterDraft, "state" | "verifications" | "activation_state"> = {
  parameter_id: "synthetic:neutral:quantity",
  parameter_version: "1",
  parameter_key: "synthetic.neutral.quantity",
  value_representation: { kind: "decimal", value: "7", unit: "synthetic.unit" },
  unit: "synthetic.unit",
  effective_from: "2040-01-01",
  effective_to: "2040-12-31",
  sector: "synthetic.sector",
  population: "synthetic.population",
  dossier_sha256: hash("a"),
  source_set_sha256: hash("b"),
};

export const syntheticNeutralContext: CurrentParameterBinding = {
  value_representation: syntheticNeutralDraftInput.value_representation,
  unit: syntheticNeutralDraftInput.unit,
  effective_from: syntheticNeutralDraftInput.effective_from,
  effective_to: syntheticNeutralDraftInput.effective_to,
  sector: syntheticNeutralDraftInput.sector,
  population: syntheticNeutralDraftInput.population,
  dossier_sha256: syntheticNeutralDraftInput.dossier_sha256,
  source_set_sha256: syntheticNeutralDraftInput.source_set_sha256,
  evidence: [{
    source_id: "SYNTHETIC_NEUTRAL_SOURCE",
    source_version_id: "synthetic-neutral-v1",
    artifact_sha256: hash("c"),
    parsed_version_id: "synthetic:parsed:v1",
    parsed_sha256: hash("d"),
    parser_sha256: hash("e"),
    citation_id: "synthetic:citation:one",
  }],
};

export function syntheticNeutralVerification(
  reviewerId: string,
  ordinal: 1 | 2,
): IndependentVerificationRef {
  const evidence = syntheticNeutralContext.evidence[0];
  return {
    verification_id: `synthetic:verification:${ordinal}`,
    reviewer_id: reviewerId,
    reviewer_role: "human.parameter_reviewer",
    verified_at: `2041-01-0${ordinal}T00:00:00.000Z`,
    ...evidence,
    value_representation: syntheticNeutralDraftInput.value_representation,
    unit: syntheticNeutralDraftInput.unit,
    effective_from: syntheticNeutralDraftInput.effective_from,
    effective_to: syntheticNeutralDraftInput.effective_to,
    sector: syntheticNeutralDraftInput.sector,
    population: syntheticNeutralDraftInput.population,
    dossier_sha256: syntheticNeutralDraftInput.dossier_sha256,
    source_set_sha256: syntheticNeutralDraftInput.source_set_sha256,
  };
}
