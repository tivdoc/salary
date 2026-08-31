import { createHash } from "node:crypto";

import {
  CASE_ANALYSIS_STAGES,
  type CaseAnalysisStage,
  type PinnedAnalysisDependencies,
} from "../../../../../engine/case-analysis/contracts";
import { calculationTraceSchema } from "../../../../../engine/calculations/contracts";
import { canonicalFactSchema } from "../../../../../engine/facts/contracts";
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

function objectWithOptional(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): Readonly<Record<string, unknown>> {
  const parsed = parseJson(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PostgresAnalysisError("ANALYSIS_ROW_MALFORMED");
  }
  const record = parsed as Readonly<Record<string, unknown>>;
  const actual = new Set(Object.keys(record));
  if (required.some((key) => !actual.has(key)) || [...actual].some((key) => !required.includes(key) && !optional.includes(key))) {
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
    const readiness = objectWithOptional(row.legal_readiness, [
      "schema_version", "decision_source", "status", "reason_codes", "decision_sha256",
      "usable_for_rules", "operative_candidate_source_version_ids", "normalized_input_sha256",
    ], ["normalized_input"]);
    if (readiness.decision_source !== "evaluateLegalReadiness"
        || (readiness.status !== "READY" && readiness.status !== "BLOCKED_NOT_READY")
        || typeof readiness.usable_for_rules !== "boolean") {
      throw new PostgresAnalysisError("ANALYSIS_ROW_MALFORMED");
    }
    assertSha256(readiness.decision_sha256);
    legalReadiness = row.legal_readiness as TopicAnalysisResult["legal_readiness"];
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
  const readiness = objectWithOptional(row.readiness, [
    "schema_version", "decision_source", "status", "reason_codes", "decision_sha256",
    "usable_for_rules", "operative_candidate_source_version_ids", "normalized_input_sha256",
  ], ["normalized_input"]);
  if (readiness.decision_source !== "evaluateLegalReadiness"
      || (readiness.status !== "READY" && readiness.status !== "BLOCKED_NOT_READY")
      || typeof readiness.usable_for_rules !== "boolean") {
    throw new PostgresAnalysisError("ANALYSIS_ROW_MALFORMED");
  }
  assertSha256(readiness.decision_sha256);
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
    readiness: row.readiness as LegalCatalogSelection["readiness"],
  });
}
