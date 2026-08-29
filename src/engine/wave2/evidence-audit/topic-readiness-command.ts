import { evaluateWave1TopicReadiness } from "../../legal-knowledge/wave1-topic-readiness.ts";
import {
  wave1SyntheticInactiveEvidence,
  wave1SyntheticReadinessQuery,
} from "../../legal-knowledge/wave1-synthetic-fixtures.ts";

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
  const exitCode = input.command === "gate" && result.status !== "ready" ? 2 : 0;
  return {
    schema_version: "tivdoc-wave2-topic-readiness-command-v0.4",
    command: input.command,
    fixture: "synthetic_inactive_only",
    semantics: input.command === "status"
      ? "diagnostic_status_may_exit_zero_while_not_ready"
      : "strict_gate_exits_nonzero_while_any_required_gate_is_missing",
    result,
    exit_code: exitCode,
  } as const;
}
