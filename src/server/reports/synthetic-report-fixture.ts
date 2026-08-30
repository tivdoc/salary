import type { AnalysisResultBundle, TopicAnalysisResult } from "../../engine/wave3/contracts";
import { WAVE3_TOPICS } from "../../engine/wave3/contracts.ts";
import type { CanonicalHashPort } from "../../engine/wave3/contracts";

function topicResult(hash: CanonicalHashPort, topic: typeof WAVE3_TOPICS[number], calculated: boolean): TopicAnalysisResult {
  return {
    topic,
    status: calculated ? "calculated" : "blocked_missing_facts",
    blockers: calculated ? [] : [`SYNTHETIC_${topic.toUpperCase()}_FACT_MISSING`],
    rule_input_sha256: calculated ? hash.hashCanonical({ topic, input: "synthetic" }) : null,
    amount: calculated ? { currency: "XTS", minor_units: 1_000 } : null,
    trace: calculated ? {
      calculation_id: "00000000-0000-4000-8000-000000000001",
      formula_id: `synthetic.${topic}`,
      formula_version: "1.0.0",
      rule: { rule_id: `synthetic.${topic}.rule`, rule_version: "1.0.0" },
      engine_version: "1.0.0",
      inputs: [{
        input_id: "synthetic.input",
        fact_id: "00000000-0000-4000-8000-000000000002",
        fact_path: "compensation.gross_salary",
        value: { kind: "money", value: { currency: "XTS", minor_units: 1_000 } },
      }],
      steps: [{
        step_id: "synthetic.output",
        operation: "identity",
        input_refs: ["synthetic.input"],
        result: { kind: "money", value: { currency: "XTS", minor_units: 1_000 } },
        explanation: "Neutral synthetic identity step.",
      }],
      output: { kind: "money", value: { currency: "XTS", minor_units: 1_000 } },
      calculated_at: "2026-08-30T12:00:00.000Z",
    } : null,
    legal_readiness: calculated ? {
      schema_version: "synthetic-ready-v1",
      decision_source: "evaluateLegalReadiness",
      status: "READY",
      reason_codes: [],
      decision_sha256: hash.hashCanonical({ topic, readiness: "synthetic_test_only" }),
      usable_for_rules: true,
      operative_candidate_source_version_ids: [`synthetic-source:${topic}:1`],
      normalized_input_sha256: hash.hashCanonical({ topic }),
    } : null,
  };
}

export function syntheticReportBundle(hash: CanonicalHashPort): AnalysisResultBundle {
  const topicResults = WAVE3_TOPICS.map((topic, index) => topicResult(hash, topic, index < 3));
  const unsigned = {
    schema_version: "tivdoc-analysis-result-bundle-v0.6.0" as const,
    analysis_run_id: "analysis:synthetic:001",
    case_id: "case:synthetic:report:001",
    case_revision: 7,
    period: { start_date: "2026-01-01", end_date: "2026-03-31" },
    as_of: "2026-08-30",
    document_snapshot_sha256: "1".repeat(64),
    extraction_snapshot_sha256: "2".repeat(64),
    declared_fact_snapshot_sha256: "3".repeat(64),
    facts_snapshot_sha256: "4".repeat(64),
    facts: [],
    rule_inputs: [],
    catalog_sha256: "5".repeat(64),
    topic_results: topicResults,
    known_subtotal: { currency: "XTS", minor_units: 3_000 },
    coverage_complete: false,
  };
  return { ...unsigned, result_sha256: hash.hashCanonical(unsigned) };
}
