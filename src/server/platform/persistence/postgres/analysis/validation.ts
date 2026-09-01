import { createHash } from "node:crypto";

import {
  CASE_ANALYSIS_STAGES,
  type CaseAnalysisStage,
  type PinnedAnalysisDependencies,
} from "../../../../../engine/case-analysis/contracts";
import { calculationTraceSchema } from "../../../../../engine/calculations/contracts";
import { canonicalFactSchema } from "../../../../../engine/facts/contracts";
import {
  canonicalReadinessJson,
  evaluateLegalReadiness,
  type LegalReadinessCandidate,
  type LegalReadinessCase,
  type LegalReadinessDecision,
} from "../../../../../engine/legal-knowledge/canonical-readiness/evaluate-legal-readiness";
import { canonicalSha256 } from "../../../../../engine/rule-runtime/canonical";
import { ruleInputSnapshotSchema } from "../../../../../engine/wave1/contracts";
import {
  WAVE3_TOPICS,
  type AnalysisResultBundle,
  type CaseAnalysisCommand,
  type DeterministicReportArtifacts,
  type LegalCatalogSelection,
  type TopicAnalysisResult,
  type Wave3Topic,
} from "../../../../../engine/wave3/contracts";
import { PostgresAnalysisError } from "./errors";

const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^\S(?:[\s\S]{0,238}\S)?$/u;

export function assertSafeIdentifier(value: string): void {
  if (!SAFE_ID.test(value) || value.includes("\0")) throw new PostgresAnalysisError("ANALYSIS_OWNER_SCOPE_INVALID");
}

export function assertSha256(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new PostgresAnalysisError("ANALYSIS_ROW_MALFORMED");
}

function sha256(value: unknown): string {
  assertSha256(value);
  return value;
}

export function bytesSha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new PostgresAnalysisError("ANALYSIS_ROW_MALFORMED");
  }
}

export function object(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  const parsed = parseJson(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PostgresAnalysisError("ANALYSIS_ROW_MALFORMED");
  }
  const record = parsed as Readonly<Record<string, unknown>>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new PostgresAnalysisError("ANALYSIS_ROW_MALFORMED");
  }
  return record;
}

export function array(value: unknown): readonly unknown[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) throw new PostgresAnalysisError("ANALYSIS_ROW_MALFORMED");
  return parsed;
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new PostgresAnalysisError("ANALYSIS_ROW_MALFORMED");
  return value;
}

function integer(value: unknown): number {
  const parsed = typeof value === "string" && /^-?\d+$/u.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed)) {
    throw new PostgresAnalysisError("ANALYSIS_ROW_MALFORMED");
  }
  return parsed;
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new PostgresAnalysisError("ANALYSIS_ROW_MALFORMED");
  return value;
}

function nullableString(value: unknown): string | null {
  return value === null ? null : string(value);
}

function stringArray(value: unknown): readonly string[] {
  const values = array(value).map(string);
  if (new Set(values).size !== values.length) throw new PostgresAnalysisError("ANALYSIS_ROW_MALFORMED");
  return Object.freeze(values);
}

function oneOf<const T extends string>(value: unknown, values: readonly T[]): T {
  const decoded = string(value);
  if (!values.includes(decoded as T)) throw new PostgresAnalysisError("ANALYSIS_ROW_MALFORMED");
  return decoded as T;
}

function nullableOneOf<const T extends string>(value: unknown, values: readonly T[]): T | null {
  return value === null ? null : oneOf(value, values);
}

function readinessSha256(value: unknown): string {
  return createHash("sha256").update(canonicalReadinessJson(value)).digest("hex");
}

const CANONICAL_READINESS_SCHEMA = "tivdoc-legal-readiness-decision-v0.5.0";
const LEGACY_SYNTHETIC_READINESS_SCHEMA = "tivdoc-legal-readiness-v0.5.0";

function decodeCanonicalReadinessCase(value: unknown): LegalReadinessCase {
  const row = object(value, [
    "case_id", "topic", "kind", "target_date", "as_of", "sector", "population", "contract_version", "use_case",
  ]);
  if (row.contract_version !== "v0.5.0") throw new PostgresAnalysisError("ANALYSIS_ROW_VERSION_UNSUPPORTED");
  return Object.freeze({
    case_id: string(row.case_id),
    topic: string(row.topic),
    kind: oneOf(row.kind, ["historical", "current", "missing_sector", "sector_placeholder", "adapter", "synthetic"]),
    target_date: string(row.target_date),
    as_of: string(row.as_of),
    sector: nullableString(row.sector),
    population: nullableString(row.population),
    contract_version: "v0.5.0",
    use_case: oneOf(row.use_case, ["monetary_rule", "non_monetary_review"]),
  });
}

function nullableRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> | null {
  return value === null ? null : object(value, keys);
}

function decodeCanonicalReadinessCandidate(value: unknown): LegalReadinessCandidate {
  const row = object(value, [
    "source_version_id", "source_id", "topics", "acquisition_status", "technical_parse_status",
    "instrument_boundary_status", "publication_status", "retrieval_visibility", "retrieval_surface", "source_role",
    "monetary_support_eligibility", "citation", "review_attestation", "valid_time", "knowledge_time", "sector_status",
    "verified_sectors", "population_status", "verified_populations", "activation_status", "bound_source_version_id",
  ]);
  const citation = nullableRecord(row.citation, ["citation_id", "verified", "source_version_id"]);
  const review = nullableRecord(row.review_attestation, ["attestation_id", "status", "source_version_id", "reviewed_at"]);
  const validTime = nullableRecord(row.valid_time, ["from", "to", "verified"]);
  const knowledgeTime = nullableRecord(row.knowledge_time, ["available_from", "unavailable_from"]);
  return Object.freeze({
    source_version_id: string(row.source_version_id),
    source_id: nullableString(row.source_id) ?? undefined,
    topics: stringArray(row.topics),
    // The V0.5 evaluator deliberately ignores the retired booleans, but its
    // public candidate type still requires them for legacy callers.
    parse_succeeded: false,
    citation_verified: false,
    operative_role_eligible: false,
    human_reviewed: false,
    effective_interval_verified: false,
    verified_sectors: stringArray(row.verified_sectors),
    verified_populations: stringArray(row.verified_populations),
    active: false,
    acquisition_status: nullableOneOf(row.acquisition_status, ["available", "missing"]) ?? undefined,
    technical_parse_status: nullableOneOf(row.technical_parse_status, ["parsed", "missing", "failed"]) ?? undefined,
    instrument_boundary_status: nullableOneOf(row.instrument_boundary_status, ["resolved", "ambiguous", "unresolved"]) ?? undefined,
    publication_status: nullableOneOf(row.publication_status, ["review_candidate", "quarantined", "unpublished"]) ?? undefined,
    retrieval_visibility: nullableOneOf(row.retrieval_visibility, ["visible", "hidden"]) ?? undefined,
    retrieval_surface: nullableOneOf(row.retrieval_surface, ["canonical_review", "corroborative_review", "explanatory_review", "none"]) ?? undefined,
    source_role: nullableOneOf(row.source_role, ["binding_role_candidate", "corroborative", "secondary_explanatory", "role_pending"]) ?? undefined,
    monetary_support_eligibility: nullableOneOf(row.monetary_support_eligibility, ["eligible", "ineligible"]) ?? undefined,
    citation: citation ? Object.freeze({
      citation_id: string(citation.citation_id),
      verified: boolean(citation.verified),
      source_version_id: string(citation.source_version_id),
    }) : undefined,
    review_attestation: review ? Object.freeze({
      attestation_id: string(review.attestation_id),
      status: oneOf(review.status, ["reviewed", "needs_review"]),
      source_version_id: string(review.source_version_id),
      reviewed_at: string(review.reviewed_at),
    }) : undefined,
    valid_time: validTime ? Object.freeze({
      from: string(validTime.from),
      to: nullableString(validTime.to),
      verified: boolean(validTime.verified),
    }) : undefined,
    knowledge_time: knowledgeTime ? Object.freeze({
      available_from: string(knowledgeTime.available_from),
      unavailable_from: nullableString(knowledgeTime.unavailable_from),
    }) : undefined,
    sector_status: nullableOneOf(row.sector_status, ["verified", "unverified", "unknown"]) ?? undefined,
    population_status: nullableOneOf(row.population_status, ["verified", "unverified"]) ?? undefined,
    activation_status: nullableOneOf(row.activation_status, ["active", "inactive"]) ?? undefined,
    bound_source_version_id: nullableString(row.bound_source_version_id) ?? undefined,
  });
}

function decodeCanonicalReadiness(value: unknown): LegalReadinessDecision {
  const row = object(value, [
    "schema_version", "evaluator_version", "decision_source", "normalized_input", "normalized_input_sha256",
    "status", "reason_codes", "selected_source_version_id", "considered_source_version_ids",
    "operative_candidate_source_version_ids", "usable_for_rules", "test_only_synthetic", "decision_sha256",
  ]);
  if (row.schema_version !== CANONICAL_READINESS_SCHEMA
      || row.evaluator_version !== "evaluateLegalReadiness@v0.5.0") {
    throw new PostgresAnalysisError("ANALYSIS_ROW_VERSION_UNSUPPORTED");
  }
  if (row.decision_source !== "evaluateLegalReadiness") throw new PostgresAnalysisError("ANALYSIS_ROW_MALFORMED");
  const normalized = object(row.normalized_input, ["readiness_case", "candidates"]);
  const readinessCase = decodeCanonicalReadinessCase(normalized.readiness_case);
  const candidates = Object.freeze(array(normalized.candidates).map(decodeCanonicalReadinessCandidate));
  const normalizedInputSha256 = sha256(row.normalized_input_sha256);
  const decisionSha256 = sha256(row.decision_sha256);
  oneOf(row.status, ["READY", "BLOCKED_NOT_READY"]);
  stringArray(row.reason_codes);
  nullableString(row.selected_source_version_id);
  stringArray(row.considered_source_version_ids);
  stringArray(row.operative_candidate_source_version_ids);
  boolean(row.usable_for_rules);
  boolean(row.test_only_synthetic);
  if (readinessSha256(row.normalized_input) !== normalizedInputSha256) {
    throw new PostgresAnalysisError("ANALYSIS_ROW_MALFORMED");
  }
  const decisionSeed = Object.fromEntries(Object.entries(row).filter(([key]) => key !== "decision_sha256"));
  if (readinessSha256(decisionSeed) !== decisionSha256) throw new PostgresAnalysisError("ANALYSIS_ROW_MALFORMED");

  const evaluated = evaluateLegalReadiness({ readinessCase, candidates });
  if (canonicalReadinessJson(evaluated) !== canonicalReadinessJson(row)) {
    throw new PostgresAnalysisError("ANALYSIS_ROW_MALFORMED");
  }
  return evaluated;
}

function decodeLegacySyntheticReadiness(value: unknown): LegalReadinessDecision {
  const row = object(value, [
    "schema_version", "decision_source", "status", "reason_codes", "decision_sha256", "usable_for_rules",
    "operative_candidate_source_version_ids", "normalized_input_sha256",
  ]);
  if (row.schema_version !== LEGACY_SYNTHETIC_READINESS_SCHEMA) {
    throw new PostgresAnalysisError("ANALYSIS_ROW_VERSION_UNSUPPORTED");
  }
  if (row.decision_source !== "evaluateLegalReadiness") throw new PostgresAnalysisError("ANALYSIS_ROW_MALFORMED");
  const status = oneOf(row.status, ["READY", "BLOCKED_NOT_READY"]);
  const reasonCodes = stringArray(row.reason_codes);
  const usableForRules = boolean(row.usable_for_rules);
  if (row.normalized_input_sha256 !== null
      || usableForRules !== (status === "READY")
      || (status === "READY") !== (reasonCodes.length === 0)) {
    throw new PostgresAnalysisError("ANALYSIS_ROW_MALFORMED");
  }
  return Object.freeze({
    schema_version: LEGACY_SYNTHETIC_READINESS_SCHEMA,
    decision_source: "evaluateLegalReadiness",
    status,
    reason_codes: reasonCodes,
    decision_sha256: sha256(row.decision_sha256),
    usable_for_rules: usableForRules,
    operative_candidate_source_version_ids: stringArray(row.operative_candidate_source_version_ids),
    normalized_input_sha256: null,
  });
}

function decodeLegalReadiness(value: unknown): LegalReadinessDecision {
  const parsed = parseJson(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PostgresAnalysisError("ANALYSIS_ROW_MALFORMED");
  }
  const schemaVersion = string((parsed as Readonly<Record<string, unknown>>).schema_version);
  if (schemaVersion === CANONICAL_READINESS_SCHEMA) return decodeCanonicalReadiness(parsed);
  if (schemaVersion === LEGACY_SYNTHETIC_READINESS_SCHEMA) return decodeLegacySyntheticReadiness(parsed);
  throw new PostgresAnalysisError("ANALYSIS_ROW_VERSION_UNSUPPORTED");
}

export function decodeCommand(value: unknown): CaseAnalysisCommand {
  const row = object(value, [
    "case_id", "case_revision", "document_snapshot_id", "document_snapshot_sha256",
    "extraction_snapshot_id", "extraction_snapshot_sha256", "declared_fact_snapshot_id",
    "declared_fact_snapshot_sha256", "period", "as_of", "requested_topics", "sector",
    "population", "mode", "idempotency_key",
  ]);
  const period = object(row.period, ["start_date", "end_date"]);
  const requestedTopics = array(row.requested_topics).map((topic) => decodeTopic(topic));
  if (requestedTopics.length === 0 || new Set(requestedTopics).size !== requestedTopics.length) {
    throw new PostgresAnalysisError("ANALYSIS_ROW_MALFORMED");
  }
  for (const hash of [row.document_snapshot_sha256, row.extraction_snapshot_sha256, row.declared_fact_snapshot_sha256]) {
    assertSha256(hash);
  }
  const mode = string(row.mode);
  if (mode !== "real" && mode !== "synthetic_test") throw new PostgresAnalysisError("ANALYSIS_ROW_MALFORMED");
  return Object.freeze({
    case_id: string(row.case_id),
    case_revision: integer(row.case_revision),
    document_snapshot_id: string(row.document_snapshot_id),
    document_snapshot_sha256: sha256(row.document_snapshot_sha256),
    extraction_snapshot_id: string(row.extraction_snapshot_id),
    extraction_snapshot_sha256: sha256(row.extraction_snapshot_sha256),
    declared_fact_snapshot_id: string(row.declared_fact_snapshot_id),
    declared_fact_snapshot_sha256: sha256(row.declared_fact_snapshot_sha256),
    period: Object.freeze({ start_date: string(period.start_date), end_date: string(period.end_date) }),
    as_of: string(row.as_of),
    requested_topics: Object.freeze(requestedTopics),
    sector: string(row.sector),
    population: string(row.population),
    mode,
    idempotency_key: string(row.idempotency_key),
  });
}

export function decodeStage(value: unknown) {
  const row = object(value, ["stage", "payload_sha256", "payload"]);
  const stage = string(row.stage);
  if (!CASE_ANALYSIS_STAGES.includes(stage as CaseAnalysisStage)) throw new PostgresAnalysisError("ANALYSIS_ROW_MALFORMED");
  assertSha256(row.payload_sha256);
  if (canonicalSha256(row.payload) !== row.payload_sha256) throw new PostgresAnalysisError("ANALYSIS_ROW_MALFORMED");
  return Object.freeze({ stage: stage as CaseAnalysisStage, payload_sha256: row.payload_sha256, payload: row.payload });
}

export function decodeDependencies(value: unknown): PinnedAnalysisDependencies {
  const row = object(value, [
    "extraction_snapshot_sha256", "facts_snapshot_sha256", "catalog_sha256", "source_version_ids",
    "parameter_version_ids", "rule_spec_versions", "code_version", "template_version",
  ]);
  for (const hash of [row.extraction_snapshot_sha256, row.facts_snapshot_sha256, row.catalog_sha256]) assertSha256(hash);
  if (row.code_version !== "case-analysis@0.6.0") throw new PostgresAnalysisError("ANALYSIS_ROW_VERSION_UNSUPPORTED");
  return Object.freeze({
    extraction_snapshot_sha256: sha256(row.extraction_snapshot_sha256),
    facts_snapshot_sha256: sha256(row.facts_snapshot_sha256),
    catalog_sha256: sha256(row.catalog_sha256),
    source_version_ids: stringArray(row.source_version_ids),
    parameter_version_ids: stringArray(row.parameter_version_ids),
    rule_spec_versions: stringArray(row.rule_spec_versions),
    code_version: row.code_version,
    template_version: string(row.template_version),
  });
}

export function decodeTopic(value: unknown): Wave3Topic {
  const topic = string(value);
  if (!WAVE3_TOPICS.includes(topic as Wave3Topic)) throw new PostgresAnalysisError("ANALYSIS_ROW_MALFORMED");
  return topic as Wave3Topic;
}

const TOPIC_STATUSES = new Set([
  "calculated", "not_applicable", "blocked_missing_facts", "blocked_conflict", "blocked_legal_readiness", "error",
]);

export function validateTopicResult(value: unknown): TopicAnalysisResult {
  const row = object(value, ["topic", "status", "blockers", "rule_input_sha256", "amount", "trace", "legal_readiness"]);
  const topic = decodeTopic(row.topic);
  const status = string(row.status);
  if (!TOPIC_STATUSES.has(status)) throw new PostgresAnalysisError("ANALYSIS_ROW_MALFORMED");
  const amount = row.amount === null ? null : object(row.amount, ["currency", "minor_units"]);
  if (amount && (string(amount.currency).length !== 3 || integer(amount.minor_units) < 0)) {
    throw new PostgresAnalysisError("ANALYSIS_ROW_MALFORMED");
  }
  if (row.rule_input_sha256 !== null) assertSha256(row.rule_input_sha256);
  let trace: TopicAnalysisResult["trace"] = null;
  if (row.trace !== null) {
    const parsedTrace = calculationTraceSchema.safeParse(row.trace);
    if (!parsedTrace.success) throw new PostgresAnalysisError("ANALYSIS_ROW_MALFORMED");
    trace = parsedTrace.data;
  }
  let legalReadiness: TopicAnalysisResult["legal_readiness"] = null;
  if (row.legal_readiness !== null) {
    legalReadiness = decodeLegalReadiness(row.legal_readiness);
  }
  return Object.freeze({
    topic,
    status: status as TopicAnalysisResult["status"],
    blockers: stringArray(row.blockers),
    rule_input_sha256: nullableString(row.rule_input_sha256),
    amount: amount ? Object.freeze({ currency: string(amount.currency), minor_units: integer(amount.minor_units) }) : null,
    trace,
    legal_readiness: legalReadiness,
  });
}

export function decodeBundle(value: unknown): AnalysisResultBundle {
  const row = object(value, [
    "schema_version", "analysis_run_id", "case_id", "case_revision", "period", "as_of",
    "document_snapshot_sha256", "extraction_snapshot_sha256", "declared_fact_snapshot_sha256",
    "facts_snapshot_sha256", "facts", "rule_inputs", "catalog_sha256", "topic_results",
    "known_subtotal", "coverage_complete", "result_sha256",
  ]);
  if (row.schema_version !== "tivdoc-analysis-result-bundle-v0.6.0") {
    throw new PostgresAnalysisError("ANALYSIS_ROW_VERSION_UNSUPPORTED");
  }
  for (const hash of [
    row.document_snapshot_sha256, row.extraction_snapshot_sha256, row.declared_fact_snapshot_sha256,
    row.facts_snapshot_sha256, row.catalog_sha256, row.result_sha256,
  ]) assertSha256(hash);
  const topicResults = array(row.topic_results).map(validateTopicResult);
  assertSevenTopics(topicResults);
  const knownSubtotal = row.known_subtotal === null ? null : object(row.known_subtotal, ["currency", "minor_units"]);
  if (knownSubtotal && (string(knownSubtotal.currency).length !== 3 || integer(knownSubtotal.minor_units) < 0)) {
    throw new PostgresAnalysisError("ANALYSIS_ROW_MALFORMED");
  }
  const period = object(row.period, ["start_date", "end_date"]);
  const decoded = {
    schema_version: row.schema_version,
    analysis_run_id: string(row.analysis_run_id),
    case_id: string(row.case_id),
    case_revision: integer(row.case_revision),
    period: Object.freeze({ start_date: string(period.start_date), end_date: string(period.end_date) }),
    as_of: string(row.as_of),
    document_snapshot_sha256: sha256(row.document_snapshot_sha256),
    extraction_snapshot_sha256: sha256(row.extraction_snapshot_sha256),
    declared_fact_snapshot_sha256: sha256(row.declared_fact_snapshot_sha256),
    facts_snapshot_sha256: sha256(row.facts_snapshot_sha256),
    facts: Object.freeze(array(row.facts).map((fact) => {
      const parsed = canonicalFactSchema.safeParse(fact);
      if (!parsed.success) throw new PostgresAnalysisError("ANALYSIS_ROW_MALFORMED");
      return parsed.data;
    })),
    rule_inputs: Object.freeze(array(row.rule_inputs).map((ruleInput) => {
      const parsed = ruleInputSnapshotSchema.safeParse(ruleInput);
      if (!parsed.success) throw new PostgresAnalysisError("ANALYSIS_ROW_MALFORMED");
      return parsed.data;
    })),
    catalog_sha256: sha256(row.catalog_sha256),
    topic_results: Object.freeze(topicResults),
    known_subtotal: knownSubtotal
      ? Object.freeze({ currency: string(knownSubtotal.currency), minor_units: integer(knownSubtotal.minor_units) })
      : null,
    coverage_complete: boolean(row.coverage_complete),
    result_sha256: sha256(row.result_sha256),
  } satisfies AnalysisResultBundle;
  const seed = Object.fromEntries(Object.entries(decoded).filter(([key]) => key !== "result_sha256"));
  if (canonicalSha256(seed) !== decoded.result_sha256) throw new PostgresAnalysisError("ANALYSIS_ROW_MALFORMED");
  return Object.freeze(decoded);
}

export function assertSevenTopics(results: readonly Pick<TopicAnalysisResult, "topic">[]): void {
  if (results.length !== WAVE3_TOPICS.length
      || WAVE3_TOPICS.some((topic) => results.filter((result) => result.topic === topic).length !== 1)) {
    throw new PostgresAnalysisError("TOPIC_SET_INVALID");
  }
}

export type EncodedReport = Readonly<{
  report_id: string;
  report_revision: number;
  analysis_result_sha256: string;
  json_base64: string;
  html_base64: string;
  pdf_base64: string;
  manifest_base64: string;
  json_sha256: string;
  html_sha256: string;
  pdf_sha256: string;
  manifest_sha256: string;
  report_sha256: string;
}>;

export function encodeReport(report: DeterministicReportArtifacts): EncodedReport {
  validateReport(report);
  return Object.freeze({
    report_id: report.report_id,
    report_revision: report.report_revision,
    analysis_result_sha256: report.analysis_result_sha256,
    json_base64: Buffer.from(report.json).toString("base64"),
    html_base64: Buffer.from(report.html).toString("base64"),
    pdf_base64: Buffer.from(report.pdf).toString("base64"),
    manifest_base64: Buffer.from(report.manifest).toString("base64"),
    json_sha256: report.json_sha256,
    html_sha256: report.html_sha256,
    pdf_sha256: report.pdf_sha256,
    manifest_sha256: report.manifest_sha256,
    report_sha256: report.report_sha256,
  });
}

export function decodeReport(value: unknown): DeterministicReportArtifacts {
  const row = object(value, [
    "report_id", "report_revision", "analysis_result_sha256", "json_base64", "html_base64", "pdf_base64",
    "manifest_base64", "json_sha256", "html_sha256", "pdf_sha256", "manifest_sha256", "report_sha256",
  ]);
  const report = {
    report_id: string(row.report_id),
    report_revision: integer(row.report_revision),
    analysis_result_sha256: string(row.analysis_result_sha256),
    json: new Uint8Array(Buffer.from(string(row.json_base64), "base64")),
    html: new Uint8Array(Buffer.from(string(row.html_base64), "base64")),
    pdf: new Uint8Array(Buffer.from(string(row.pdf_base64), "base64")),
    manifest: new Uint8Array(Buffer.from(string(row.manifest_base64), "base64")),
    json_sha256: string(row.json_sha256),
    html_sha256: string(row.html_sha256),
    pdf_sha256: string(row.pdf_sha256),
    manifest_sha256: string(row.manifest_sha256),
    report_sha256: string(row.report_sha256),
  } satisfies DeterministicReportArtifacts;
  validateReport(report);
  return Object.freeze(report);
}

export function validateReport(report: DeterministicReportArtifacts): void {
  assertSafeIdentifier(report.report_id);
  if (!Number.isSafeInteger(report.report_revision) || report.report_revision < 1) {
    throw new PostgresAnalysisError("REPORT_HASH_BINDING_INVALID");
  }
  for (const hash of [
    report.analysis_result_sha256, report.json_sha256, report.html_sha256, report.pdf_sha256,
    report.manifest_sha256, report.report_sha256,
  ]) assertSha256(hash);
  if (bytesSha256(report.json) !== report.json_sha256
      || bytesSha256(report.html) !== report.html_sha256
      || bytesSha256(report.pdf) !== report.pdf_sha256
      || bytesSha256(report.manifest) !== report.manifest_sha256) {
    throw new PostgresAnalysisError("REPORT_HASH_BINDING_INVALID");
  }
  const fixtureHash = canonicalSha256({
    report_id: report.report_id,
    json_sha256: report.json_sha256,
    html_sha256: report.html_sha256,
    pdf_sha256: report.pdf_sha256,
    manifest_sha256: report.manifest_sha256,
  });
  const canonicalHash = canonicalSha256({
    report_id: report.report_id,
    report_revision: report.report_revision,
    analysis_result_sha256: report.analysis_result_sha256,
    json_sha256: report.json_sha256,
    html_sha256: report.html_sha256,
    pdf_sha256: report.pdf_sha256,
    manifest_sha256: report.manifest_sha256,
  });
  if (report.report_sha256 !== fixtureHash && report.report_sha256 !== canonicalHash) {
    throw new PostgresAnalysisError("REPORT_HASH_BINDING_INVALID");
  }
}

export function validateSelections(values: readonly LegalCatalogSelection[]): void {
  if (values.length !== WAVE3_TOPICS.length || new Set(values.map((selection) => selection.topic)).size !== WAVE3_TOPICS.length) {
    throw new PostgresAnalysisError("TOPIC_SET_INVALID");
  }
  for (const selection of values) {
    decodeSelection(selection);
  }
  if (new Set(values.map((selection) => selection.catalog_id)).size !== 1
      || new Set(values.map((selection) => selection.catalog_sha256)).size !== 1) {
    throw new PostgresAnalysisError("ANALYSIS_ROW_MALFORMED");
  }
}

export function decodeSelection(value: unknown): LegalCatalogSelection {
  const row = object(value, [
    "catalog_id", "catalog_version", "catalog_sha256", "mode", "topic", "source_version_ids",
    "parameter_version_ids", "rule_spec_id", "rule_spec_version", "readiness",
  ]);
  const mode = string(row.mode);
  if (mode !== "real" && mode !== "synthetic_test") throw new PostgresAnalysisError("ANALYSIS_ROW_MALFORMED");
  const readiness = decodeLegalReadiness(row.readiness);
  if (mode !== "synthetic_test" && readiness.schema_version === LEGACY_SYNTHETIC_READINESS_SCHEMA) {
    throw new PostgresAnalysisError("ANALYSIS_ROW_MALFORMED");
  }
  assertSha256(row.catalog_sha256);
  return Object.freeze({
    catalog_id: string(row.catalog_id),
    catalog_version: string(row.catalog_version),
    catalog_sha256: sha256(row.catalog_sha256),
    mode,
    topic: decodeTopic(row.topic),
    source_version_ids: stringArray(row.source_version_ids),
    parameter_version_ids: stringArray(row.parameter_version_ids),
    rule_spec_id: nullableString(row.rule_spec_id),
    rule_spec_version: nullableString(row.rule_spec_version),
    readiness,
  });
}
