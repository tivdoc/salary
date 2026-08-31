import { createHash } from "node:crypto";

import { canonicalSha256 } from "../../../src/server/platform/persistence/canonical.ts";
import {
  startCanonicalApplicationPostgres,
  type CanonicalApplicationPostgresComposition,
} from "../../../src/server/platform/composition/canonical-postgres-application.ts";
import { NodePostgresConnectionFactory } from "../../../src/server/platform/persistence/postgres/runtime/node-pg-driver.ts";
import type {
  ManagedPostgresClient,
  PostgresConnectionFactory,
} from "../../../src/server/platform/persistence/postgres/runtime/transaction-manager.ts";
import {
  statement,
  type PostgresQueryResult,
  type PostgresStatement,
} from "../../../src/server/platform/persistence/postgres/contracts.ts";
import type {
  CaseAnalysisCommand,
  DeterministicReportArtifacts,
} from "../../../src/engine/wave3/contracts.ts";
import { WAVE3_TOPICS } from "../../../src/engine/wave3/contracts.ts";

export type MatrixApplication = Extract<CanonicalApplicationPostgresComposition, { mode: "isolated_postgres" }>;

export type DynamicMatrixInput = Readonly<{
  connection_url: string;
  build_identity_sha: string;
  matrix_run_id: string;
  max_connections?: number;
}>;

export type SafeError = Readonly<{
  name: string;
  code: string | null;
}>;

export type SafeTableState = Readonly<{
  table: string;
  row_count: number;
  state_sha256: string;
}>;

export type SafeStateSnapshot = Readonly<{
  tables: readonly SafeTableState[];
  snapshot_sha256: string;
}>;

const TABLES = Object.freeze([
  "engine_case_identity",
  "engine_case_state",
  "engine_case_lifecycle_revisions",
  "engine_payment_evidence_refs",
  "documents",
  "document_extractions",
  "case_conversations",
  "case_messages",
  "analysis_runs",
  "analysis_hypotheses",
  "analysis_findings",
  "engine_analysis_stage_versions",
  "engine_canonical_fact_versions",
  "engine_rule_input_versions",
  "engine_legal_version_pins",
  "engine_topic_result_versions",
  "engine_calculation_trace_versions",
  "case_confirmations",
  "engine_report_versions",
  "engine_review_task_versions",
  "engine_idempotency_records",
  "engine_durable_jobs",
  "engine_job_history",
  "engine_outbox_events",
  "engine_logical_effect_receipts",
  "engine_platform_audit_events",
  "engine_object_write_sagas",
] as const);

const SNAPSHOTS = Object.freeze(TABLES.map((table) => Object.freeze({
  table,
  query: statement(
    `matrix_snapshot_${table}`,
    `select count(*)::text as row_count,
            encode(public.digest(coalesce(string_agg(to_jsonb(snapshot_row)::text, E'\\n' order by to_jsonb(snapshot_row)::text), ''), 'sha256'), 'hex') as state_sha256
       from public.${table} snapshot_row
      where snapshot_row.tenant_id = $1`,
    ["placeholder"],
  ),
})));

export class StatementNameFailureInjector implements PostgresConnectionFactory {
  readonly #delegate: PostgresConnectionFactory;
  #armed: Readonly<{ statement_name: string; occurrence: number }> | null = null;
  #barrier: {
    statement_name: string;
    participants: number;
    arrived: number;
    released: boolean;
    release_reason: "participants" | "timeout" | "disarm" | null;
    arrived_at_release: number | null;
    promise: Promise<void>;
    release: () => void;
    timeout: ReturnType<typeof setTimeout>;
  } | null = null;
  #seen = 0;
  #injected = 0;

  constructor(delegate: PostgresConnectionFactory) {
    this.#delegate = delegate;
  }

  arm(statementName: string, occurrence = 1): void {
    if (!/^[a-z][a-z0-9_]{2,63}$/u.test(statementName) || !Number.isSafeInteger(occurrence) || occurrence < 1) {
      throw new TypeError("FAILURE_INJECTOR_ARGUMENT_INVALID");
    }
    if (this.#armed !== null) throw new Error("FAILURE_INJECTOR_ALREADY_ARMED");
    this.#armed = Object.freeze({ statement_name: statementName, occurrence });
    this.#seen = 0;
    this.#injected = 0;
  }

  disarm(): Readonly<{ matched: number; injected: number }> {
    const receipt = Object.freeze({ matched: this.#seen, injected: this.#injected });
    this.#armed = null;
    this.#seen = 0;
    return receipt;
  }

  armBarrier(statementName: string, participants = 2): void {
    if (!/^[a-z][a-z0-9_]{2,63}$/u.test(statementName)
        || !Number.isSafeInteger(participants) || participants < 2 || participants > 16) {
      throw new TypeError("QUERY_BARRIER_ARGUMENT_INVALID");
    }
    if (this.#barrier !== null) throw new Error("QUERY_BARRIER_ALREADY_ARMED");
    let release = (): void => undefined;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    const timeout = setTimeout(() => {
      const active = this.#barrier;
      if (active && !active.released) {
        active.released = true;
        active.release_reason = "timeout";
        active.arrived_at_release = active.arrived;
        active.release();
      }
    }, 10_000);
    this.#barrier = {
      statement_name: statementName,
      participants,
      arrived: 0,
      released: false,
      release_reason: null,
      arrived_at_release: null,
      promise,
      release,
      timeout,
    };
  }

  disarmBarrier(): Readonly<{
    arrived: number;
    released: boolean;
    release_reason: "participants" | "timeout" | "disarm" | null;
    arrived_at_release: number | null;
    timed_out: boolean;
  }> {
    const barrier = this.#barrier;
    if (!barrier) return Object.freeze({
      arrived: 0,
      released: false,
      release_reason: null,
      arrived_at_release: null,
      timed_out: false,
    });
    if (!barrier.released) {
      barrier.released = true;
      barrier.release_reason = "disarm";
      barrier.arrived_at_release = barrier.arrived;
      barrier.release();
    }
    clearTimeout(barrier.timeout);
    const receipt = Object.freeze({
      arrived: barrier.arrived,
      released: barrier.released,
      release_reason: barrier.release_reason,
      arrived_at_release: barrier.arrived_at_release,
      timed_out: barrier.release_reason === "timeout",
    });
    this.#barrier = null;
    return receipt;
  }

  async acquire(): Promise<ManagedPostgresClient> {
    const client = await this.#delegate.acquire();
    return new FailureInjectingClient(client, (query) => this.#beforeQuery(query));
  }

  async #beforeQuery(query: PostgresStatement): Promise<boolean> {
    const barrier = this.#barrier;
    if (barrier && query.name === barrier.statement_name) {
      barrier.arrived += 1;
      if (barrier.arrived >= barrier.participants && !barrier.released) {
        barrier.released = true;
        barrier.release_reason = "participants";
        barrier.arrived_at_release = barrier.arrived;
        barrier.release();
      }
      await barrier.promise;
    }
    return this.#shouldInject(query);
  }

  #shouldInject(query: PostgresStatement): boolean {
    const armed = this.#armed;
    if (!armed || query.name !== armed.statement_name) return false;
    this.#seen += 1;
    if (this.#seen !== armed.occurrence) return false;
    this.#injected += 1;
    return true;
  }
}

class FailureInjectingClient implements ManagedPostgresClient {
  readonly #delegate: ManagedPostgresClient;
  readonly #shouldInject: (query: PostgresStatement) => Promise<boolean>;

  constructor(delegate: ManagedPostgresClient, shouldInject: (query: PostgresStatement) => Promise<boolean>) {
    this.#delegate = delegate;
    this.#shouldInject = shouldInject;
  }

  async query(query: PostgresStatement): Promise<PostgresQueryResult> {
    if (await this.#shouldInject(query)) throw new Error("MATRIX_INJECTED_FAILURE");
    return this.#delegate.query(query);
  }

  release(): Promise<void> | void {
    return this.#delegate.release();
  }
}

export async function withMatrixApplication<T>(
  input: DynamicMatrixInput,
  operation: (resources: Readonly<{
    application: MatrixApplication;
    driver: NodePostgresConnectionFactory;
    injector: StatementNameFailureInjector;
    tenant_id: string;
  }>) => Promise<T>,
): Promise<T> {
  assertMatrixInput(input);
  const driver = NodePostgresConnectionFactory.fromConnectionUrl({
    connection_url: input.connection_url,
    max_connections: input.max_connections ?? 16,
    application_name: "tivdoc-canonical-postgresql-dynamic-v0.9.1",
  });
  const injector = new StatementNameFailureInjector(driver);
  try {
    const composition = await startCanonicalApplicationPostgres({
      mode: "isolated_postgres",
      execution_boundary: "test",
      target: driver.target,
      build_identity_sha: input.build_identity_sha,
    }, { connection_factory: injector });
    if (composition.mode !== "isolated_postgres") throw new Error("MATRIX_POSTGRES_COMPOSITION_REQUIRED");
    return await operation(Object.freeze({
      application: composition,
      driver,
      injector,
      tenant_id: `tenant-v091-${input.matrix_run_id}`,
    }));
  } finally {
    await driver.close();
  }
}

export async function snapshotState(
  application: MatrixApplication,
  tenantId: string,
  caseId: string,
): Promise<SafeStateSnapshot> {
  const tables = await application.transaction(tenantId, caseId, async (bundle) => {
    const rows: SafeTableState[] = [];
    for (const definition of SNAPSHOTS) {
      const result = await bundle.context.client.query(Object.freeze({
        ...definition.query,
        values: Object.freeze([tenantId]),
      }));
      const row = result.rows[0];
      const rawCount = row?.row_count;
      const digest = row?.state_sha256;
      const rowCount = typeof rawCount === "string" && /^\d+$/u.test(rawCount) ? Number(rawCount) : Number.NaN;
      if (!Number.isSafeInteger(rowCount) || typeof digest !== "string" || !/^[0-9a-f]{64}$/u.test(digest)) {
        throw new Error("MATRIX_STATE_ROW_INVALID");
      }
      rows.push(Object.freeze({ table: definition.table, row_count: rowCount, state_sha256: digest }));
    }
    return Object.freeze(rows);
  });
  return Object.freeze({ tables, snapshot_sha256: canonicalSha256(tables) });
}

export async function seedCase(
  application: MatrixApplication,
  tenantId: string,
  caseId: string,
  marker: string,
): Promise<void> {
  const hashes = boundaryHashes(marker);
  await application.transaction(tenantId, caseId, async (bundle) => {
    await bundle.intake.case_lifecycle.append(bundle.context, {
      tenant_id: tenantId,
      case_id: caseId,
      expected_revision: 0,
      state_before: null,
      state_after: "awaiting_documents",
      event_kind: `seed.${marker}`,
      command_sha256: hashes.command,
      event_sha256: hashes.event,
      previous_sha256: null,
      state_sha256: hashes.state,
      occurred_at: matrixTimestamp(0),
    });
  });
}

export async function seedConversation(
  application: MatrixApplication,
  tenantId: string,
  caseId: string,
  conversationId: string,
): Promise<void> {
  await application.transaction(tenantId, caseId, async (bundle) => {
    await bundle.intake.conversations.appendConversation(bundle.context, {
      tenant_id: tenantId,
      case_id: caseId,
      conversation_id: conversationId,
      analysis_run_id: null,
      status: "open",
      idempotency_key: `idem-${conversationId}`,
      created_at: matrixTimestamp(1),
      closed_at: null,
    });
  });
}

export async function seedAnalysisRun(
  application: MatrixApplication,
  tenantId: string,
  caseId: string,
  runId: string,
  idempotencyKey: string,
  caseRevision = 1,
): Promise<void> {
  const command = analysisCommand(caseId, idempotencyKey, caseRevision);
  await application.transaction(tenantId, caseId, async (bundle) => {
    await bundle.analysis.caseAnalysis.begin({
      analysis_run_id: runId,
      idempotency_key: idempotencyKey,
      command_sha256: canonicalSha256(command),
      command,
    });
  });
}

export async function seedReport(
  application: MatrixApplication,
  tenantId: string,
  caseId: string,
  runId: string,
  idempotencyKey: string,
  reportId: string,
  caseRevision = 1,
): Promise<DeterministicReportArtifacts> {
  const command = analysisCommand(caseId, idempotencyKey, caseRevision);
  const report = reportFixture(reportId, caseRevision, canonicalSha256({ case_id: caseId, run_id: runId, result: "synthetic_blocked" }));
  await application.transaction(tenantId, caseId, async (bundle) => {
    await bundle.analysis.caseAnalysis.begin({
      analysis_run_id: runId,
      idempotency_key: idempotencyKey,
      command_sha256: canonicalSha256(command),
      command,
    });
    await bundle.analysis.reports.persistReport({
      case_id: caseId,
      analysis_run_id: runId,
      report,
      review_eligible: true,
    });
  });
  return report;
}

export function analysisCommand(caseId: string, idempotencyKey: string, caseRevision = 1): CaseAnalysisCommand {
  return Object.freeze({
    case_id: caseId,
    case_revision: caseRevision,
    document_snapshot_id: `document-snapshot-${idempotencyKey}`,
    document_snapshot_sha256: canonicalSha256({ idempotencyKey, kind: "document" }),
    extraction_snapshot_id: `extraction-snapshot-${idempotencyKey}`,
    extraction_snapshot_sha256: canonicalSha256({ idempotencyKey, kind: "extraction" }),
    declared_fact_snapshot_id: `declared-snapshot-${idempotencyKey}`,
    declared_fact_snapshot_sha256: canonicalSha256({ idempotencyKey, kind: "declared" }),
    period: Object.freeze({ start_date: "2026-01-01", end_date: "2026-01-31" }),
    as_of: "2026-02-01",
    requested_topics: WAVE3_TOPICS,
    sector: "synthetic_sector",
    population: "synthetic_population",
    mode: "synthetic_test",
    idempotency_key: idempotencyKey,
  });
}

export function reportFixture(reportId: string, revision: number, analysisResultSha256: string): DeterministicReportArtifacts {
  const json = bytes(`synthetic-json:${reportId}`);
  const html = bytes(`synthetic-html:${reportId}`);
  const pdf = bytes(`%PDF-synthetic:${reportId}`);
  const manifest = bytes(`synthetic-manifest:${reportId}`);
  const hashes = Object.freeze({
    json_sha256: byteSha256(json),
    html_sha256: byteSha256(html),
    pdf_sha256: byteSha256(pdf),
    manifest_sha256: byteSha256(manifest),
  });
  return Object.freeze({
    report_id: reportId,
    report_revision: revision,
    analysis_result_sha256: analysisResultSha256,
    json,
    html,
    pdf,
    manifest,
    ...hashes,
    report_sha256: canonicalSha256({ report_id: reportId, report_revision: revision, analysis_result_sha256: analysisResultSha256, ...hashes }),
  });
}

export function approvalDecision(taskId: string, report: DeterministicReportArtifacts) {
  return Object.freeze({
    task_id: taskId,
    task_kind: "report_approval" as const,
    reviewer_id: "synthetic-reviewer-v091",
    reviewer_role: "report_approver",
    decision: "approved" as const,
    input_sha256: report.report_sha256,
    output_sha256: report.report_sha256,
    decided_at: matrixTimestamp(5),
    reason: "Synthetic isolated PostgreSQL verification.",
    schema_version: "tivdoc-case-review-decision-v0.6.0",
  });
}

export function boundaryHashes(marker: string): Readonly<{ command: string; event: string; state: string; payload: string }> {
  return Object.freeze({
    command: canonicalSha256({ marker, kind: "command" }),
    event: canonicalSha256({ marker, kind: "event" }),
    state: canonicalSha256({ marker, kind: "state" }),
    payload: canonicalSha256({ marker, kind: "payload" }),
  });
}

export function matrixTimestamp(offsetSeconds: number): string {
  return new Date(Date.UTC(2026, 7, 31, 12, 0, offsetSeconds)).toISOString();
}

export function safeError(error: unknown): SafeError {
  const candidate = typeof error === "object" && error !== null ? error as { name?: unknown; code?: unknown } : null;
  return Object.freeze({
    name: typeof candidate?.name === "string" && /^[A-Za-z][A-Za-z0-9]*$/u.test(candidate.name) ? candidate.name : "Error",
    code: typeof candidate?.code === "string" && /^[A-Z0-9_]{3,80}$/u.test(candidate.code) ? candidate.code : null,
  });
}

export function snapshotTable(snapshot: SafeStateSnapshot, table: string): SafeTableState {
  const row = snapshot.tables.find((entry) => entry.table === table);
  if (!row) throw new Error("MATRIX_SNAPSHOT_TABLE_MISSING");
  return row;
}

function assertMatrixInput(input: DynamicMatrixInput): void {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(input.build_identity_sha)) throw new TypeError("MATRIX_BUILD_IDENTITY_INVALID");
  if (!/^[a-z0-9]{8,32}$/u.test(input.matrix_run_id)) throw new TypeError("MATRIX_RUN_ID_INVALID");
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function byteSha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
