import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { PinnedAnalysisDependencies } from "../../../../engine/case-analysis/contracts";
import { canonicalSha256 } from "../../../../engine/rule-runtime/canonical";
import {
  WAVE3_TOPICS,
  type AnalysisResultBundle,
  type CaseAnalysisCommand,
  type DeterministicReportArtifacts,
  type LegalCatalogSelection,
  type TopicAnalysisResult,
} from "../../../../engine/wave3/contracts";
import type {
  PostgresClient,
  PostgresQueryResult,
  PostgresStatement,
  PostgresTransactionContext,
} from "./contracts";
import {
  createPostgresAnalysisRepositories,
  PostgresAnalysisError,
} from "./analysis";
import { decodeBundle, decodeDependencies, decodeReport } from "./analysis/validation";

const H = Object.freeze({
  command: "1".repeat(64),
  document: "2".repeat(64),
  extraction: "3".repeat(64),
  declared: "4".repeat(64),
  facts: "5".repeat(64),
  catalog: "6".repeat(64),
});

const CASE_ID = "canonical-case:text-001";
const RUN_ID = "canonical-analysis-run:text-001";
const TENANT_ID = "tenant-synthetic-001";

class RecordingClient implements PostgresClient {
  readonly statements: PostgresStatement[] = [];

  constructor(private readonly respond: (statement: PostgresStatement, index: number) => PostgresQueryResult) {}

  async query(query: PostgresStatement): Promise<PostgresQueryResult> {
    this.statements.push(query);
    return this.respond(query, this.statements.length - 1);
  }
}

function result(rows: readonly Readonly<Record<string, unknown>>[] = []): PostgresQueryResult {
  return Object.freeze({ rows, row_count: rows.length });
}

function context(client: PostgresClient): PostgresTransactionContext {
  return Object.freeze({ client, transaction_id: "tx-v09-w2-synthetic-001" });
}

function command(): CaseAnalysisCommand {
  const value: CaseAnalysisCommand = Object.freeze({
    case_id: CASE_ID,
    case_revision: 7,
    document_snapshot_id: "document-snapshot-001",
    document_snapshot_sha256: H.document,
    extraction_snapshot_id: "extraction-snapshot-001",
    extraction_snapshot_sha256: H.extraction,
    declared_fact_snapshot_id: "declared-snapshot-001",
    declared_fact_snapshot_sha256: H.declared,
    period: Object.freeze({ start_date: "2025-01-01", end_date: "2025-01-31" }),
    as_of: "2025-02-01",
    requested_topics: WAVE3_TOPICS,
    sector: "synthetic_sector",
    population: "synthetic_population",
    mode: "synthetic_test",
    idempotency_key: "analysis.synthetic.001",
  });
  return value;
}

function commandHash(): string {
  return canonicalSha256(command());
}

function topicResults(): readonly TopicAnalysisResult[] {
  return WAVE3_TOPICS.map((topic) => Object.freeze({
    topic,
    status: "blocked_legal_readiness" as const,
    blockers: Object.freeze(["SYNTHETIC_BLOCKED"]),
    rule_input_sha256: "7".repeat(64),
    amount: null,
    trace: null,
    legal_readiness: null,
  }));
}

function bundle(overrides: Partial<AnalysisResultBundle> = {}): AnalysisResultBundle {
  const seed = {
    schema_version: "tivdoc-analysis-result-bundle-v0.6.0" as const,
    analysis_run_id: RUN_ID,
    case_id: CASE_ID,
    case_revision: 7,
    period: Object.freeze({ start_date: "2025-01-01", end_date: "2025-01-31" }),
    as_of: "2025-02-01",
    document_snapshot_sha256: H.document,
    extraction_snapshot_sha256: H.extraction,
    declared_fact_snapshot_sha256: H.declared,
    facts_snapshot_sha256: H.facts,
    facts: Object.freeze([]),
    rule_inputs: Object.freeze([]),
    catalog_sha256: H.catalog,
    topic_results: topicResults(),
    known_subtotal: null,
    coverage_complete: false,
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "result_sha256")),
  };
  return Object.freeze({ ...seed, result_sha256: overrides.result_sha256 ?? canonicalSha256(seed) }) as AnalysisResultBundle;
}

function dependencies(): PinnedAnalysisDependencies {
  return Object.freeze({
    extraction_snapshot_sha256: H.extraction,
    facts_snapshot_sha256: H.facts,
    catalog_sha256: H.catalog,
    source_version_ids: Object.freeze(["synthetic-source-v1"]),
    parameter_version_ids: Object.freeze(["synthetic-parameter-v1"]),
    rule_spec_versions: Object.freeze(["synthetic-rule@1.0.0"]),
    code_version: "case-analysis@0.6.0",
    template_version: "synthetic-template-v1",
  });
}

function selections(): readonly LegalCatalogSelection[] {
  return WAVE3_TOPICS.map((topic) => ({
    catalog_id: "synthetic-catalog",
    catalog_version: "1.0.0",
    catalog_sha256: H.catalog,
    mode: "synthetic_test" as const,
    topic,
    source_version_ids: ["synthetic-source-v1"],
    parameter_version_ids: ["synthetic-parameter-v1"],
    rule_spec_id: `synthetic.${topic}`,
    rule_spec_version: "1.0.0",
    readiness: {
      schema_version: "tivdoc-legal-readiness-v0.5.0",
      decision_source: "evaluateLegalReadiness",
      status: "BLOCKED_NOT_READY",
      reason_codes: ["SYNTHETIC_BLOCKED"],
      operative_candidate_source_version_ids: [],
      decision_sha256: "8".repeat(64),
      usable_for_rules: false,
      normalized_input_sha256: null,
    },
  }));
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function sha(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function report(): DeterministicReportArtifacts {
  const json = bytes("synthetic-json");
  const html = bytes("synthetic-html");
  const pdf = bytes("%PDF-synthetic");
  const manifest = bytes("synthetic-manifest");
  const hashes = { json_sha256: sha(json), html_sha256: sha(html), pdf_sha256: sha(pdf), manifest_sha256: sha(manifest) };
  const reportId = "synthetic-report-001";
  return Object.freeze({
    report_id: reportId,
    report_revision: 7,
    analysis_result_sha256: bundle().result_sha256,
    json,
    html,
    pdf,
    manifest,
    ...hashes,
    report_sha256: canonicalSha256({ report_id: reportId, report_revision: 7, analysis_result_sha256: bundle().result_sha256, ...hashes }),
  });
}

function runRow(completionPayload: unknown = null): Readonly<Record<string, unknown>> {
  return Object.freeze({
    analysis_run_id: RUN_ID,
    idempotency_key: command().idempotency_key,
    command_sha256: commandHash(),
    command: command(),
    completed: completionPayload !== null,
    stages: [],
    completion_payload: completionPayload,
  });
}

describe("V0.9 W2 canonical PostgreSQL analysis adapters", () => {
  it("exports one five-adapter bundle bound to the exact transaction context", () => {
    const client = new RecordingClient(() => result());
    const tx = context(client);
    const repositories = createPostgresAnalysisRepositories(tx, TENANT_ID);
    expect(Object.keys(repositories).sort()).toEqual(["caseAnalysis", "legalPins", "reports", "topicResults", "traceFindings"]);
    expect(repositories.caseAnalysis).toBeDefined();
  });

  it("begins through parameterized SQL, preserves opaque canonical IDs, and implements the existing port", async () => {
    let finalRead = false;
    const client = new RecordingClient((query) => {
      if (query.name === "analysis_run_by_idem" || query.name === "analysis_run_by_id") {
        if (query.name === "analysis_run_by_id" && finalRead) return result([runRow()]);
        return result();
      }
      if (query.name === "analysis_run_begin") {
        finalRead = true;
        return result([{ canonical_analysis_run_id: RUN_ID }]);
      }
      throw new Error("unexpected query");
    });
    const repository = createPostgresAnalysisRepositories(context(client), TENANT_ID).caseAnalysis;
    const port: import("../../../../engine/case-analysis/contracts").CaseAnalysisRepositoryPort = repository;
    const created = await port.begin({
      analysis_run_id: RUN_ID,
      idempotency_key: command().idempotency_key,
      command_sha256: commandHash(),
      command: command(),
    });
    expect(created).toMatchObject({ analysis_run_id: RUN_ID, completed: false });
    const insert = client.statements.find((query) => query.name === "analysis_run_begin")!;
    expect(insert.values).toContain(RUN_ID);
    expect(insert.values).toContain(CASE_ID);
    expect(insert.text).not.toContain(RUN_ID);
    expect(insert.text).not.toContain(CASE_ID);
    expect(insert.text).toContain("private.resolve_engine_case_id($1, $2)");
    expect(insert.text).toContain("current_setting('tivdoc.engine_git_sha', true)");
  });

  it("rejects an immutable stage hash conflict with a safe typed error", async () => {
    const client = new RecordingClient((query) => {
      if (query.name === "analysis_stage_insert") return result();
      if (query.name === "analysis_stage_existing") return result([{ payload_sha256: "9".repeat(64) }]);
      throw new Error("unexpected query");
    });
    const repository = createPostgresAnalysisRepositories(context(client), TENANT_ID).caseAnalysis;
    const payload = { synthetic: true };
    await expect(repository.persistStage({
      analysis_run_id: RUN_ID,
      stage: "input_snapshot",
      payload,
      payload_sha256: canonicalSha256(payload),
    })).rejects.toMatchObject({ code: "IMMUTABLE_STAGE_MISMATCH" });
  });

  it("persists one run, all pins, exactly seven topic rows, exact report hashes, then completion", async () => {
    let completionPayload: unknown = null;
    const client = new RecordingClient((query) => {
      if (query.name === "analysis_run_by_id") return result([runRow(completionPayload)]);
      if (query.name === "analysis_pin_insert") return result([{ version_sha256: query.values[5] }]);
      if (query.name === "analysis_topic_insert") return result([{ result_sha256: query.values[6] }]);
      if (query.name === "analysis_findings_disabled") return result([{ finding_count: "0" }]);
      if (query.name === "analysis_report_insert") return result([{ report_sha256: query.values[6], pdf_sha256: query.values[10] }]);
      if (query.name === "analysis_run_complete") {
        completionPayload = JSON.parse(query.values[2] as string) as unknown;
        return result([{ canonical_analysis_run_id: RUN_ID }]);
      }
      throw new Error(`unexpected query: ${query.name}`);
    });
    const repositories = createPostgresAnalysisRepositories(context(client), TENANT_ID);
    const completed = await repositories.caseAnalysis.complete({
      analysis_run_id: RUN_ID,
      selections: selections(),
      dependencies: dependencies(),
      bundle: bundle(),
      report: report(),
    });
    expect(completed.completed).toBe(true);
    expect(completed.report?.pdf_sha256).toBe(report().pdf_sha256);
    expect(client.statements.filter((query) => query.name === "analysis_topic_insert")).toHaveLength(7);
    expect(client.statements.filter((query) => query.name === "analysis_findings_disabled")).toHaveLength(1);
    expect(new Set(client.statements.filter((query) => query.name === "analysis_topic_insert").map((query) => query.values[3]))).toEqual(new Set(WAVE3_TOPICS));
    expect(client.statements.at(-2)?.name).toBe("analysis_run_complete");
    expect(client.statements.every((query) => !query.text.includes(CASE_ID) && !query.text.includes(RUN_ID))).toBe(true);
  });

  it("stops before completion when a later topic write fails", async () => {
    let topics = 0;
    const client = new RecordingClient((query) => {
      if (query.name === "analysis_run_by_id") return result([runRow()]);
      if (query.name === "analysis_pin_insert") return result([{ version_sha256: query.values[5] }]);
      if (query.name === "analysis_topic_insert") {
        topics += 1;
        if (topics === 3) throw Object.assign(new Error("driver detail must not escape"), { code: "08006" });
        return result([{ result_sha256: query.values[6] }]);
      }
      throw new Error(`unexpected query: ${query.name}`);
    });
    const repository = createPostgresAnalysisRepositories(context(client), TENANT_ID).caseAnalysis;
    await expect(repository.complete({
      analysis_run_id: RUN_ID,
      selections: selections(),
      dependencies: dependencies(),
      bundle: bundle(),
      report: report(),
    })).rejects.toEqual(new PostgresAnalysisError("POSTGRES_PERSISTENCE_UNAVAILABLE"));
    expect(client.statements.some((query) => query.name === "analysis_run_complete")).toBe(false);
  });

  it("binds approval to the exact model/report hash and conceals non-eligible reports", async () => {
    const decision = {
      task_id: "review-task-001",
      task_kind: "report_approval" as const,
      reviewer_id: "synthetic-reviewer",
      reviewer_role: "report_approver",
      decision: "approved" as const,
      input_sha256: report().report_sha256,
      output_sha256: report().report_sha256,
      decided_at: "2025-02-01T00:00:00.000Z",
      reason: "Synthetic fixture exact-hash approval.",
      schema_version: "tivdoc-case-review-decision-v0.6.0",
    };
    const client = new RecordingClient((query) => {
      if (query.name === "analysis_review_approve") return result([{ task_id: decision.task_id, revision: 1, decision_sha256: canonicalSha256(decision) }]);
      if (query.name === "analysis_report_eligible") return result([{ eligible: 1 }]);
      throw new Error("unexpected query");
    });
    const reports = createPostgresAnalysisRepositories(context(client), TENANT_ID).reports;
    await expect(reports.decide({ ...decision, output_sha256: "a".repeat(64) })).rejects.toMatchObject({ code: "REPORT_REVIEW_NOT_ELIGIBLE" });
    await expect(reports.decide(decision)).resolves.toEqual({
      task_id: decision.task_id,
      revision: 1,
      receipt_sha256: canonicalSha256(decision),
    });
    await expect(reports.isReportExportEligible(CASE_ID, report().report_sha256)).resolves.toBe(true);
    expect(client.statements.find((query) => query.name === "analysis_review_approve")?.text).toContain("r.report_sha256 = $4");
  });

  it("persists canonical text confirmation identities and keeps Findings hard-disabled", async () => {
    const client = new RecordingClient((query) => {
      if (query.name === "analysis_confirmation_insert") return result([{ canonical_confirmation_id: "confirmation:text-001" }]);
      throw new Error(`unexpected query: ${query.name}`);
    });
    const repository = createPostgresAnalysisRepositories(context(client), TENANT_ID).traceFindings;
    expect(() => repository.persistFindingDisabled({ finding_id: "must-not-persist" })).toThrow("FINDINGS_DISABLED");
    await repository.persistConfirmation({
      confirmation_id: "confirmation:text-001",
      case_id: CASE_ID,
      source_analysis_run_id: RUN_ID,
      target_fact_path: "compensation.base_monthly_salary",
      question_id: "synthetic.question",
      question_version: 1,
      proposed_value: null,
      answer: null,
      status: "pending",
      source_message_id: null,
      idempotency_key: "confirmation.synthetic.001",
      created_at: "2025-02-01T00:00:00.000Z",
      answered_at: null,
    });
    const insert = client.statements[0]!;
    expect(insert.text).toContain("private.canonical_text_uuid('confirmation', $4)");
    expect(insert.text).toContain("canonical_source_message_id");
    expect(insert.text).not.toContain("$4::uuid");

    const corrupt = new RecordingClient((query) => query.name === "analysis_findings_disabled"
      ? result([{ finding_count: "1" }])
      : result());
    await expect(createPostgresAnalysisRepositories(context(corrupt), TENANT_ID).traceFindings.assertFindingsDisabled({
      case_id: CASE_ID,
      analysis_run_id: RUN_ID,
    })).rejects.toMatchObject({ code: "FINDINGS_DISABLED" });
  });

  it("strict codecs reject unknown versions, malformed hashes, unsafe money, null ownership, and corrupted PDF bytes", async () => {
    expect(() => decodeBundle("{malformed-json")).toThrow("ANALYSIS_ROW_MALFORMED");
    expect(() => decodeDependencies({ ...dependencies(), code_version: "case-analysis@unknown" })).toThrow("ANALYSIS_ROW_VERSION_UNSUPPORTED");
    expect(() => decodeBundle({ ...bundle(), schema_version: "unknown" })).toThrow("ANALYSIS_ROW_VERSION_UNSUPPORTED");
    expect(() => decodeBundle({ ...bundle(), topic_results: topicResults().map((topic, index) => index === 0 ? { ...topic, status: "invented" } : topic) })).toThrow("ANALYSIS_ROW_MALFORMED");
    const unsafeTopics = topicResults().map((topic, index) => index === 0
      ? { ...topic, amount: { currency: "XTS", minor_units: Number.MAX_SAFE_INTEGER + 1 } }
      : topic);
    expect(() => decodeBundle({ ...bundle(), topic_results: unsafeTopics })).toThrow("ANALYSIS_ROW_MALFORMED");
    expect(() => decodeBundle({ ...bundle(), result_sha256: "f".repeat(64) })).toThrow("ANALYSIS_ROW_MALFORMED");
    expect(() => decodeReport({ ...encodedReportFixture(), report_revision: Number.MAX_SAFE_INTEGER + 1 })).toThrow("ANALYSIS_ROW_MALFORMED");
    expect(() => decodeReport({
      ...encodedReportFixture(),
      pdf_base64: Buffer.from("corrupted").toString("base64"),
    })).toThrow("REPORT_HASH_BINDING_INVALID");

    expect(() => createPostgresAnalysisRepositories(context(new RecordingClient(() => result())), "")).toThrow("ANALYSIS_OWNER_SCOPE_INVALID");

    const client = new RecordingClient(() => result([{ ...runRow(), analysis_run_id: null }]));
    const repository = createPostgresAnalysisRepositories(context(client), TENANT_ID).caseAnalysis;
    await expect(repository.getByRunId(RUN_ID)).rejects.toMatchObject({ code: "ANALYSIS_ROW_MALFORMED" });
  });

  it("does not expose SQL, opaque identifiers, or driver detail through typed failures", async () => {
    const client = new RecordingClient(() => { throw Object.assign(new Error(`select secret from ${CASE_ID}`), { code: "08006" }); });
    const repository = createPostgresAnalysisRepositories(context(client), TENANT_ID).caseAnalysis;
    let observed: unknown;
    try {
      await repository.getByRunId(RUN_ID);
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(PostgresAnalysisError);
    expect(String(observed)).toBe("PostgresAnalysisError: POSTGRES_PERSISTENCE_UNAVAILABLE");
    expect(String(observed)).not.toContain(CASE_ID);
  });
});

function encodedReportFixture(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    report_id: report().report_id,
    report_revision: report().report_revision,
    analysis_result_sha256: report().analysis_result_sha256,
    json_base64: Buffer.from(report().json).toString("base64"),
    html_base64: Buffer.from(report().html).toString("base64"),
    pdf_base64: Buffer.from(report().pdf).toString("base64"),
    manifest_base64: Buffer.from(report().manifest).toString("base64"),
    json_sha256: report().json_sha256,
    html_sha256: report().html_sha256,
    pdf_sha256: report().pdf_sha256,
    manifest_sha256: report().manifest_sha256,
    report_sha256: report().report_sha256,
  });
}
