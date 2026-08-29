import { describe, expect, it } from "vitest";
import { reviewDossierSchema } from "../../wave2/contracts.ts";
import { minimumWageSourceEvidenceSchema } from "./contracts.ts";
import {
  buildMinimumWageReviewDossier,
  classifyTechnicalSemanticDiff,
  loadMinimumWageSourceEvidence,
  minimumWageDossierSha256,
} from "./dossier.ts";

describe("minimum wage review dossier", () => {
  it("builds a deterministic fail-closed dossier from the exact current source set", () => {
    const source = loadMinimumWageSourceEvidence();
    const first = buildMinimumWageReviewDossier(source);
    const second = buildMinimumWageReviewDossier(source);
    expect(reviewDossierSchema.parse(first)).toEqual(first);
    expect(second).toEqual(first);
    expect(minimumWageDossierSha256(second)).toBe(minimumWageDossierSha256(first));
    expect(first.status).toBe("pending_human_review");
    expect(first.usable_for_rules).toBe(false);
    expect(first.evidence).toHaveLength(2);
    expect(first.evidence.every((entry) => entry.review_state === "needs_review" && entry.activation_state === "inactive")).toBe(true);
    expect(first.citations).toHaveLength(4);
    expect(first.candidate_effective_intervals.every((interval) => interval.verification_state === "unverified")).toBe(true);
  });

  it("classifies exactly three normalized-identical raw byte changes pending human review", () => {
    const source = loadMinimumWageSourceEvidence();
    const dossier = buildMinimumWageReviewDossier(source);
    expect(dossier.technical_diffs).toHaveLength(3);
    expect(dossier.technical_diffs.map((entry) => entry.classification)).toEqual([
      "normalized_text_identical",
      "normalized_text_identical",
      "normalized_text_identical",
    ]);
    expect(dossier.technical_diffs.every((entry) => entry.status === "pending_human_review")).toBe(true);
  });

  it("covers every allowed technical classification without asserting legal equivalence", () => {
    const source = loadMinimumWageSourceEvidence();
    const base = source.byte_change_baseline;
    const candidate = source.byte_change_candidates[0];
    expect(classifyTechnicalSemanticDiff(base, { ...candidate, parse_available: false, normalized_text_sha256: null })).toBe("parse_unavailable");
    expect(classifyTechnicalSemanticDiff(base, { ...candidate, normalized_text_sha256: "a".repeat(64), structure_sha256: base.structure_sha256 })).toBe("text_changed");
    expect(classifyTechnicalSemanticDiff(base, { ...candidate, normalized_text_sha256: "a".repeat(64), structure_sha256: "b".repeat(64) })).toBe("structure_changed");
  });

  it("rejects any attempt to elevate BTL rate evidence into independent monetary authority", () => {
    const source = loadMinimumWageSourceEvidence();
    const unsafe = structuredClone(source);
    const rates = unsafe.sources.find((entry) => entry.source_id === "IL_MIN_WAGE_OFFICIAL_RATES");
    if (!rates) throw new Error("test_fixture_missing_rates");
    rates.can_independently_support_monetary_rule_after_review = true;
    expect(() => minimumWageSourceEvidenceSchema.parse(unsafe)).toThrow(/btl_rates_must_remain_corroborative_only/u);
  });
});
