import { evaluateWave1TopicReadiness } from "../../legal-knowledge/wave1-topic-readiness.ts";
import {
  wave1SyntheticInactiveEvidence,
  wave1SyntheticReadinessQuery,
} from "../../legal-knowledge/wave1-synthetic-fixtures.ts";
import { legalReadinessDiagnostic, legalReadinessStrict } from "../../legal-knowledge/canonical-readiness/delegates.ts";

export type TopicReadinessCommand = "status" | "gate";

export function runTopicReadinessCommand(input: Readonly<{
  command: TopicReadinessCommand;
  from?: string;
  as_of?: string;
  topic?: string;
  sector?: string;
  population?: string;
}>) {
  const result = evaluateWave1TopicReadiness({
    query: {
      ...wave1SyntheticReadinessQuery,
      from: input.from ?? wave1SyntheticReadinessQuery.from,
      as_of: input.as_of ?? wave1SyntheticReadinessQuery.as_of,
      topic: input.topic ?? wave1SyntheticReadinessQuery.topic,
      sector: input.sector ?? wave1SyntheticReadinessQuery.sector,
      population: input.population ?? wave1SyntheticReadinessQuery.population,
    },
    evidence: [wave1SyntheticInactiveEvidence],
  });
  const readinessCase = { case_id: "READINESS_WAVE2_TOPIC_COMMAND", topic: result.topic, kind: "adapter" as const, target_date: result.valid_on, as_of: result.known_at.slice(0, 10), sector: result.sector, population: result.population };
  const candidates = [{ source_version_id: wave1SyntheticInactiveEvidence.evidence_ref.source_version_id, topics: [result.topic], parse_succeeded: wave1SyntheticInactiveEvidence.evidence_ref.parsed_version_id !== null, citation_verified: wave1SyntheticInactiveEvidence.evidence_ref.citation_id !== null, operative_role_eligible: wave1SyntheticInactiveEvidence.source_role === "operative_instrument", human_reviewed: false, effective_interval_verified: false, verified_sectors: [] as string[], verified_populations: [] as string[], active: false }];
  const canonical = input.command === "gate" ? legalReadinessStrict(readinessCase, candidates) : legalReadinessDiagnostic(readinessCase, candidates);
  const exitCode = canonical.exit_code;
  return {
    schema_version: "tivdoc-wave2-topic-readiness-command-v0.4",
    command: input.command,
    fixture: "synthetic_inactive_only",
    semantics: input.command === "status"
      ? "diagnostic_status_may_exit_zero_while_not_ready"
      : "strict_gate_exits_nonzero_while_any_required_gate_is_missing",
    result,
    canonical_decision: canonical.decision,
    exit_code: exitCode,
  } as const;
}
