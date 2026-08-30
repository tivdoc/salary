import type { LegalSource } from "../contracts.ts";
import type { LegalTopic } from "../taxonomy.ts";
import { isEffectiveOn } from "../effective-period.ts";
import { LEGAL_READINESS_CASES } from "../canonical-readiness/case-registry.ts";
import { legalCorpusTopicGate } from "../canonical-readiness/delegates.ts";
import type { LegalReadinessCandidate, LegalReadinessReasonCode } from "../canonical-readiness/evaluate-legal-readiness.ts";
import { classifyRegisteredSourceRole, type CorpusRoleAssignment } from "./source-roles.ts";

export const WAVE2_REAL_CORPUS_TOPICS = ["minimum_wage", "working_time", "pension", "travel", "convalescence", "vacation", "sick_leave"] as const satisfies readonly LegalTopic[];
export const WAVE21_REQUIRED_READINESS_QUERIES = Object.freeze(LEGAL_READINESS_CASES.filter((entry) => entry.kind === "current" && entry.sector === "general").map((entry) => ({ topic: entry.topic as typeof WAVE2_REAL_CORPUS_TOPICS[number], target_date: entry.target_date, sector: "general" as const, population: "general_workforce" as const })));

type BuildRecord = Readonly<{ source_version_id: string; parse_status: string }>;
type CitationRecord = Readonly<{ source_version_id: string; status: string }>;
const gateByReason: Readonly<Record<LegalReadinessReasonCode, string>> = { PARSE_MISSING_OR_FAILED: "parse", CITATION_MISSING_OR_UNVERIFIED: "citation", SOURCE_ROLE_INELIGIBLE: "source_role", HUMAN_LEGAL_REVIEW_MISSING: "review", EFFECTIVE_INTERVAL_MISSING_OR_UNVERIFIED: "effective_interval", SECTOR_MISSING_OR_UNVERIFIED: "sector", POPULATION_MISSING_OR_UNVERIFIED: "population", ACTIVATION_MISSING: "activation" };

/** @deprecated Decision logic lives only in evaluateLegalReadiness; this is a report-shaping adapter. */
export function evaluateStrictRealCorpusReadiness(input: Readonly<{ sources: readonly LegalSource[]; buildRecords: readonly BuildRecord[]; citationRecords: readonly CitationRecord[]; stagedArtifacts?: readonly CorpusRoleAssignment[] }>) {
  const buildByVersion = new Map(input.buildRecords.map((record) => [record.source_version_id, record]));
  const citationByVersion = new Map(input.citationRecords.map((record) => [record.source_version_id, record]));
  const candidates: LegalReadinessCandidate[] = input.sources.map((source) => {
    const sourceVersionId = `${source.source_id}@${source.source_version}`;
    const role = classifyRegisteredSourceRole(source);
    const reviewed = source.status === "reviewed" || source.status === "active";
    return { source_version_id: sourceVersionId, topics: source.topics, parse_succeeded: buildByVersion.get(sourceVersionId)?.parse_status === "parsed", citation_verified: citationByVersion.get(sourceVersionId)?.status === "round_trip_passed", operative_role_eligible: role.eligible_for_operative_resolution, human_reviewed: reviewed, effective_interval_verified: reviewed && isEffectiveOn(source, "2026-08-29"), verified_sectors: reviewed ? source.sectors : [], verified_populations: [], active: source.status === "active" };
  });
  const reports = WAVE21_REQUIRED_READINESS_QUERIES.map((requiredQuery) => {
    const readinessCase = LEGAL_READINESS_CASES.find((entry) => entry.topic === requiredQuery.topic && entry.kind === "current" && entry.sector === "general");
    if (!readinessCase) throw new Error(`canonical_current_readiness_case_missing:${requiredQuery.topic}`);
    const canonical = legalCorpusTopicGate(readinessCase, candidates).decision;
    const assignments = input.sources.filter((source) => source.topics.includes(requiredQuery.topic)).map(classifyRegisteredSourceRole);
    const missingGates = canonical.reason_codes.map((reason) => gateByReason[reason]).sort();
    const gates = Object.fromEntries(Object.entries(gateByReason).map(([reason, gate]) => [gate, Object.freeze({ passed: !canonical.reason_codes.includes(reason as LegalReadinessReasonCode), reason_codes: canonical.reason_codes.includes(reason as LegalReadinessReasonCode) ? Object.freeze([reason]) : Object.freeze([]) })]));
    return Object.freeze({ topic: requiredQuery.topic, required_query: requiredQuery, status: canonical.status === "READY" ? "ready" as const : "not_ready" as const, usable_for_rules: canonical.usable_for_rules, canonical_decision: canonical, operative_candidate_source_version_ids: canonical.operative_candidate_source_version_ids, non_operative_source_version_ids_excluded: assignments.filter((assignment) => !assignment.eligible_for_operative_resolution).map((assignment) => assignment.source_version_id).sort(), gates, missing_gates: missingGates });
  });
  const excludedStagedArtifacts = (input.stagedArtifacts ?? []).map((assignment) => {
    if (assignment.lifecycle !== "acquisition_only_staged") throw new Error("registered_source_must_not_enter_staged_artifact_input");
    return Object.freeze({ source_version_id: assignment.source_version_id, artifact_id: assignment.artifact_id, citation_gate_satisfied: false as const, effective_interval_gate_satisfied: false as const, parameter_gate_satisfied: false as const, activation_gate_satisfied: false as const, reason_codes: assignment.reason_codes });
  });
  const readyTopicCount = reports.filter((report) => report.canonical_decision.status === "READY").length;
  const strictGatePassed = readyTopicCount === reports.length;
  return Object.freeze({ schema_version: "wave22-canonical-real-corpus-readiness-v0.4.2" as const, decision_source: "evaluateLegalReadiness" as const, status: strictGatePassed ? "READY" as const : "LEGAL_SOURCE_CORPUS_INCOMPLETE" as const, strict_gate_passed: strictGatePassed, strict_exit_code: strictGatePassed ? 0 as const : 2 as const, topic_count: reports.length, ready_topic_count: readyTopicCount, excluded_staged_artifacts: Object.freeze(excludedStagedArtifacts), reports });
}
