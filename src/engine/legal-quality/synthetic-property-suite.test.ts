import { describe, expect, it } from "vitest";

import { WAVE3_TOPICS } from "../wave3/contracts.ts";
import {
  assessSyntheticFactReadiness,
  resolveSyntheticApplicability,
  runSyntheticSevenTopicPropertySuite,
} from "./synthetic-property-suite.ts";

describe("seven-topic synthetic golden/mutation/property tooling", () => {
  it("covers every required property for all seven topics without a legal or human act", () => {
    const report = runSyntheticSevenTopicPropertySuite();
    expect(report.topic_count).toBe(7);
    expect(report.topics).toEqual(WAVE3_TOPICS);
    expect(report.property_result_count).toBe(266);
    expect(report.all_mechanical_properties_passed).toBe(true);
    expect(report.partial_output_count).toBe(0);
    expect(report.real_legal_values_created).toBe(0);
    expect(report.genuine_human_approvals_created).toBe(0);
    expect(report.activation_allowed).toBe(false);
    expect(report.customer_shadow_allowed).toBe(false);
    expect(report.human_golden_templates_remain_authoring_only).toBe(true);
    expect(report.report_sha256).toMatch(/^[a-f0-9]{64}$/u);
    for (const topic of WAVE3_TOPICS) {
      const topicResults = report.results.filter((entry) => entry.topic === topic);
      expect(topicResults).toHaveLength(38);
      expect(topicResults.every((entry) => entry.passed && !entry.partial_output_visible)).toBe(true);
      expect(new Set(topicResults.filter((entry) => entry.category === "negative_scope")
        .map((entry) => entry.dimension))).toEqual(new Set(["sector", "population", "geography"]));
      expect(topicResults.filter((entry) => entry.category === "dependency_binding_mutation")).toHaveLength(8);
      expect(topicResults.filter((entry) => entry.category === "dependency_manifest_mutation")).toHaveLength(8);
    }
  });

  it("fails closed on conflicted scope and preserves unknown missing fact material", () => {
    expect(() => resolveSyntheticApplicability({ candidates: [], context: {
      topic: "minimum_wage",
      target_date: "2040-01-01",
      sector: "synthetic.sector",
      population: "synthetic.population",
      geography: "synthetic.geography",
    } })).toThrow("SYNTHETIC_APPLICABILITY_CANDIDATE_SET_INVALID");
    const missing = assessSyntheticFactReadiness({
      facts: [{
        fact_id: "syn.fact.missing",
        state: "missing",
        confidence_basis_points: null,
        observed_at: null,
        content_sha256: null,
        synthetic_test_only: true,
      }],
      as_of: "2040-01-01T00:00:00.000Z",
      maximum_age_days: 30,
      minimum_confidence_basis_points: 9_000,
    });
    expect(missing).toMatchObject({
      status: "blocked",
      blocker_codes: ["FACT_MISSING"],
      legal_conclusion: null,
      monetary_result: null,
      activation_allowed: false,
    });
  });
});
