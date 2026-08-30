import type { LegalSource } from "../contracts.ts";
import type { LegalTopic } from "../taxonomy.ts";
import { classifyRegisteredSourceRole, type CorpusRoleAssignment } from "./source-roles.ts";

export const WAVE2_REAL_CORPUS_TOPICS = [
  "minimum_wage",
  "working_time",
  "pension",
  "travel",
  "convalescence",
  "vacation",
  "sick_leave",
] as const satisfies readonly LegalTopic[];

export const WAVE21_REQUIRED_READINESS_QUERIES = Object.freeze([
  { topic: "minimum_wage", target_date: "2026-08-29", sector: "general", population: "general_workforce" },
  { topic: "working_time", target_date: "2018-06-22", sector: "general", population: "general_workforce" },
  { topic: "pension", target_date: "2016-07-01", sector: "general", population: "general_workforce" },
  { topic: "travel", target_date: "2016-01-01", sector: "general", population: "general_workforce" },
  { topic: "convalescence", target_date: "2025-01-01", sector: "general", population: "general_workforce" },
  { topic: "vacation", target_date: "2026-08-29", sector: "general", population: "general_workforce" },
  { topic: "sick_leave", target_date: "2026-08-29", sector: "general", population: "general_workforce" },
] as const);

type BuildRecord = Readonly<{ source_version_id: string; parse_status: string }>;
type CitationRecord = Readonly<{ source_version_id: string; status: string }>;

export function evaluateStrictRealCorpusReadiness(input: Readonly<{
  sources: readonly LegalSource[];
  buildRecords: readonly BuildRecord[];
  citationRecords: readonly CitationRecord[];
  stagedArtifacts?: readonly CorpusRoleAssignment[];
}>) {
  const buildByVersion = new Map(input.buildRecords.map((record) => [record.source_version_id, record]));
  const citationByVersion = new Map(input.citationRecords.map((record) => [record.source_version_id, record]));
  const reports = WAVE21_REQUIRED_READINESS_QUERIES.map((requiredQuery) => {
    const topic = requiredQuery.topic;
    const topicSources = input.sources.filter((source) => source.topics.includes(topic));
    const assignments = topicSources.map((source) => ({ source, assignment: classifyRegisteredSourceRole(source) }));
    const operative = assignments.filter(({ assignment }) => assignment.role === "binding_operative_instrument_version");
    const secondaryExcluded = assignments
      .filter(({ assignment }) => assignment.role !== "binding_operative_instrument_version")
      .map(({ assignment }) => assignment.source_version_id)
      .sort();
    const sourceIds = operative.map(({ assignment }) => assignment.source_version_id).sort();
    const gateReasons = {
      parse: sourceIds.filter((id) => buildByVersion.get(id)?.parse_status !== "parsed").map((id) => `parse_missing:${id}`),
      citation: sourceIds.filter((id) => citationByVersion.get(id)?.status !== "round_trip_passed").map((id) => `citation_missing_or_not_round_trip_verified:${id}`),
      source_role: sourceIds.length ? [] : [`binding_operative_source_role_missing:${topic}`],
      review: sourceIds.filter((id) => {
        const source = operative.find(({ assignment }) => assignment.source_version_id === id)?.source;
        return source?.status !== "reviewed" && source?.status !== "active";
      }).map((id) => `human_legal_review_missing:${id}`),
      effective_interval: sourceIds.filter((id) => {
        const source = operative.find(({ assignment }) => assignment.source_version_id === id)?.source;
        return !source?.effective_from || (source.status !== "reviewed" && source.status !== "active");
      }).map((id) => {
        const source = operative.find(({ assignment }) => assignment.source_version_id === id)?.source;
        return source?.effective_from ? `effective_interval_human_attestation_missing:${id}` : `effective_interval_missing_or_unverified:${id}`;
      }),
      sector: sourceIds.map((id) => `sector_scope_human_attestation_missing:${id}`),
      population: sourceIds.map((id) => `population_scope_missing:${id}`),
      activation: sourceIds.filter((id) => operative.find(({ assignment }) => assignment.source_version_id === id)?.source.status !== "active").map((id) => `activation_missing:${id}`),
    };
    const missingGates = Object.entries(gateReasons)
      .filter(([, reasons]) => reasons.length > 0)
      .map(([gate]) => gate)
      .sort();
    return Object.freeze({
      topic,
      required_query: requiredQuery,
      status: "not_ready" as const,
      usable_for_rules: false as const,
      operative_candidate_source_version_ids: sourceIds,
      non_operative_source_version_ids_excluded: secondaryExcluded,
      gates: Object.fromEntries(Object.entries(gateReasons).map(([gate, reasons]) => [gate, Object.freeze({ passed: reasons.length === 0, reason_codes: Object.freeze(reasons) })])),
      missing_gates: missingGates,
    });
  });
  if (reports.some((report) => report.status !== "not_ready" || report.usable_for_rules)) throw new Error("real_corpus_readiness_must_remain_fail_closed");
  const excludedStagedArtifacts = (input.stagedArtifacts ?? []).map((assignment) => {
    if (assignment.lifecycle !== "acquisition_only_staged") throw new Error("registered_source_must_not_enter_staged_artifact_input");
    return Object.freeze({ source_version_id: assignment.source_version_id, artifact_id: assignment.artifact_id, citation_gate_satisfied: false as const, effective_interval_gate_satisfied: false as const, parameter_gate_satisfied: false as const, activation_gate_satisfied: false as const, reason_codes: assignment.reason_codes });
  });
  return Object.freeze({
    schema_version: "wave2-real-corpus-topic-readiness-v0.4" as const,
    status: "LEGAL_SOURCE_CORPUS_INCOMPLETE" as const,
    strict_gate_passed: false as const,
    strict_exit_code: 2 as const,
    topic_count: reports.length,
    ready_topic_count: 0,
    excluded_staged_artifacts: Object.freeze(excludedStagedArtifacts),
    reports,
  });
}
