import { describe, expect, it } from "vitest";
import {
  assessParameterInvalidation,
  appendIndependentHumanVerification,
  createNumericParameterDraft,
  invalidateNumericParameterDraft,
  makeActivationEligible,
  parameterInvalidationReasons,
  type CurrentParameterBinding,
} from "./state-machine.ts";
import {
  syntheticNeutralContext,
  syntheticNeutralDraftInput,
  syntheticNeutralVerification,
} from "./synthetic-fixtures.ts";

function twiceVerified() {
  const draft = createNumericParameterDraft(syntheticNeutralDraftInput);
  const once = appendIndependentHumanVerification(draft, syntheticNeutralVerification("human:reviewer:alpha", 1), syntheticNeutralContext);
  return appendIndependentHumanVerification(once, syntheticNeutralVerification("human:reviewer:beta", 2), syntheticNeutralContext);
}

describe("numeric parameter state machine with wholly synthetic neutral fixtures", () => {
  it("follows draft to independently verified twice to activation eligible while remaining inactive", () => {
    const draft = createNumericParameterDraft(syntheticNeutralDraftInput);
    expect(draft).toMatchObject({ state: "draft", verifications: [], activation_state: "inactive" });
    const once = appendIndependentHumanVerification(draft, syntheticNeutralVerification("human:reviewer:alpha", 1), syntheticNeutralContext);
    expect(once).toMatchObject({ state: "draft", activation_state: "inactive" });
    expect(once.verifications).toHaveLength(1);
    const twice = appendIndependentHumanVerification(once, syntheticNeutralVerification("human:reviewer:beta", 2), syntheticNeutralContext);
    expect(twice).toMatchObject({ state: "independently_verified_twice", activation_state: "inactive" });
    const eligible = makeActivationEligible(twice, syntheticNeutralContext);
    expect(eligible).toMatchObject({ state: "activation_eligible", activation_state: "inactive" });
  });

  it("requires exactly two distinct human reviewers and complete evidence bindings", () => {
    const draft = createNumericParameterDraft(syntheticNeutralDraftInput);
    const once = appendIndependentHumanVerification(draft, syntheticNeutralVerification("human:reviewer:alpha", 1), syntheticNeutralContext);
    expect(() => makeActivationEligible(once, syntheticNeutralContext)).toThrow(/two_independent_human_verifications_required/u);
    expect(() => appendIndependentHumanVerification(once, syntheticNeutralVerification("human:reviewer:alpha", 2), syntheticNeutralContext)).toThrow(/distinct_human_reviewers/u);
    expect(() => appendIndependentHumanVerification(draft, {
      ...syntheticNeutralVerification("automation:reviewer", 1),
      reviewer_role: "system",
    }, syntheticNeutralContext)).toThrow(/human_reviewer_role_required/u);
  });

  it.each([
    ["source", { source_id: "SYNTHETIC_OTHER_SOURCE" }, /verification_source_evidence_missing/u],
    ["source version", { source_version_id: "synthetic-neutral-v2" }, /verification_source_evidence_missing/u],
    ["artifact bytes", { artifact_sha256: "f".repeat(64) }, /verification_artifact_sha256_mismatch/u],
    ["parsed version", { parsed_version_id: "synthetic:parsed:v2" }, /verification_parsed_version_id_mismatch/u],
    ["parsed bytes", { parsed_sha256: "f".repeat(64) }, /verification_parsed_sha256_mismatch/u],
    ["parser", { parser_sha256: "f".repeat(64) }, /verification_parser_sha256_mismatch/u],
    ["citation", { citation_id: "synthetic:citation:changed" }, /verification_citation_id_mismatch/u],
    ["value", { value_representation: { kind: "integer" as const, value: 8 } }, /verification_value_mismatch/u],
    ["unit", { unit: "synthetic.changed_unit" }, /verification_unit_mismatch/u],
    ["interval", { effective_to: "2041-01-01" }, /verification_interval_mismatch/u],
    ["sector scope", { sector: "synthetic.changed_sector" }, /verification_scope_mismatch/u],
    ["population", { population: "synthetic.changed_population" }, /verification_population_mismatch/u],
    ["dossier", { dossier_sha256: "f".repeat(64) }, /verification_dossier_mismatch/u],
    ["source set", { source_set_sha256: "f".repeat(64) }, /verification_source_set_mismatch/u],
  ] as const)("rejects an attestation whose %s binding differs", (_label, mutation, expected) => {
    const draft = createNumericParameterDraft(syntheticNeutralDraftInput);
    const verification = { ...syntheticNeutralVerification("human:reviewer:alpha", 1), ...mutation };
    expect(() => appendIndependentHumanVerification(draft, verification, syntheticNeutralContext)).toThrow(expected);
  });

  it.each([
    ["source_byte_changed", { evidence: [{ ...syntheticNeutralContext.evidence[0], artifact_sha256: "f".repeat(64) }] }],
    ["parsed_content_changed", { evidence: [{ ...syntheticNeutralContext.evidence[0], parsed_sha256: "f".repeat(64) }] }],
    ["parser_changed", { evidence: [{ ...syntheticNeutralContext.evidence[0], parser_sha256: "f".repeat(64) }] }],
    ["citation_changed", { evidence: [{ ...syntheticNeutralContext.evidence[0], citation_id: "synthetic:citation:changed" }] }],
    ["value_changed", { value_representation: { kind: "integer" as const, value: 8 } }],
    ["unit_changed", { unit: "synthetic.changed_unit" }],
    ["effective_interval_changed", { effective_to: "2041-01-01" }],
    ["scope_changed", { sector: "synthetic.changed_sector" }],
    ["population_changed", { population: "synthetic.changed_population" }],
    ["dossier_changed", { dossier_sha256: "f".repeat(64) }],
    ["source_set_changed", { source_set_sha256: "f".repeat(64) }],
  ] as const)("invalidates eligibility when %s", (expected, mutation) => {
    const verified = twiceVerified();
    const current = { ...syntheticNeutralContext, ...mutation } as CurrentParameterBinding;
    expect(assessParameterInvalidation(verified, current)).toContain(expected);
    expect(() => makeActivationEligible(verified, current)).toThrow(/parameter_binding_invalidated/u);
    const invalidated = invalidateNumericParameterDraft(verified, current);
    expect(invalidated.status).toBe("invalidated");
    expect(invalidated.reasons).toContain(expected);
    expect(invalidated.parameter).toMatchObject({ state: "draft", verifications: [], activation_state: "inactive" });
  });

  it("covers every mandatory invalidation dimension", () => {
    expect(parameterInvalidationReasons).toEqual([
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
    ]);
  });
});
