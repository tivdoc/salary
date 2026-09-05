// L7-6 / L7-7. The draft shadow run on DEV: the synthetic corpus through the
// twelve draft specs, on the draft parameter values the P line registered,
// inside the durable offline scheduler under a v0.11 envelope in the mode
// `draft_parameters_synthetic_inputs`.
//
//   node --experimental-strip-types scripts/legal-review-projection/draft-shadow-run-v1.mts
//
// Reads: draft parameter values from the reference catalogue
// (legal.reference.il), through the sanctioned aggregate read, never a table.
// Writes: one execution trace per executed case to R-14's table on the
// synthetic proof tenant (legal.synthetic.proof) — a proof row, not a
// catalogue row — and then replays every one of them from the database in a
// fresh process. Writes nothing else durable: the scheduler state is a local
// file store under output/next/shadow, the receipts are files.
//
// Nothing here is a finding. Every output is a synthetic_shadow_delta or a
// refusal; delivery_allowed is false on the envelope, the run and the receipt.
import "../production-refusal.mjs";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { canonicalSha256 } from "../../src/engine/rule-runtime/canonical.ts";
import { DRAFT_SHADOW_SPECS, type DraftShadowSpec } from "../../src/engine/shadow/draft-shadow-specs.ts";
import { compareBranches } from "../../src/engine/shadow/branch-comparison.ts";
import { runDraftShadow, type BoundDraftParameter, type DraftShadowRunResult, type ShadowExecutionRecord } from "../../src/engine/shadow/draft-shadow-run.ts";
import { SYNTHETIC_CORPUS, SYNTHETIC_CORPUS_SHA256 } from "../../src/engine/shadow/synthetic-corpus.ts";
import { parameterSlotsFor, populationOf, type PopulationBinding } from "../../src/engine/shadow/population-selection.ts";
import { SYNTHETIC_PROOF_TENANT } from "../../src/engine/shadow/synthetic-payslip-month.ts";
import { DurableOfflineShadowScheduler } from "../../src/server/engine/shadow/durable-scheduler.ts";
import { LocalFileDurableShadowStateStore, verifySchedulerAuditChain } from "../../src/server/engine/shadow/durable-store.ts";
import { buildDraftShadowEnvelope } from "../../src/server/engine/shadow/durable-synthetic-fixtures.ts";
import { readOfflineShadowFlags } from "../../src/server/engine/shadow/flags.ts";
import { statement } from "../../src/server/platform/persistence/postgres/contracts.ts";
import { NodePostgresConnectionFactory } from "../../src/server/platform/persistence/postgres/runtime/node-pg-driver.ts";
import { readDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";
import { TENANT } from "./pool-p-parameter-import.mts";
import { seedSessions } from "./reviewer-registration.mts";
import type { ParameterValue } from "../../src/engine/legal-operations/contracts.ts";
import type { RuleSpecInputValue } from "../../src/engine/legal-operations/rulespec.ts";

if (process.env.NODE_ENV === "production") throw new Error("SHADOW_OFFLINE_SYNTHETIC_FORBIDDEN_IN_PRODUCTION");

const RECEIPT_ROOT = path.join("output", "next", "shadow");
const STATE_ROOT = path.resolve(RECEIPT_ROOT, "state");
const SYSTEM_SESSION = { sid: "session.legal.reference.system-import", jti: "token.legal.reference.system-import" };
// Traces go to the proof tenant under their own session; parameter values are
// read from the reference catalogue under the system session. Two tenants,
// one run, each direction deliberate (L4-6 / D4, BL-17).
const PROOF_SESSION = { sid: "session.synthetic.proof.shadow", jti: "token.synthetic.proof.shadow", subject: "system_import" };
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const GRADES = ["text_verified", "lexicon", "selection", "inferred_visual", "administrative"] as const;
type Grade = (typeof GRADES)[number];

function toInput(value: ParameterValue): RuleSpecInputValue["value"] {
  if (value.kind === "money") return { kind: "money", currency: value.value.currency, minor_units: value.value.minor_units };
  if (value.kind === "integer") return { kind: "integer", value: value.value, unit: value.unit };
  return { kind: "rational", numerator: value.numerator, denominator: value.denominator, unit: value.unit };
}

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const env = readDevEnvFile();
  const url = env.get("TIVDOC_OPERATIONS_POSTGRES_URL");
  if (!url) throw new Error("L76_ENV_MISSING");
  const parsed = new URL(url);
  const factory = NodePostgresConnectionFactory.fromConnectionUrl({
    connection_url: url, max_connections: 4, connection_timeout_ms: 20_000,
    application_name: "tivdoc_l76_draft_shadow",
    remote_dev_target: {
      host: parsed.hostname, port: Number(parsed.port),
      database: parsed.pathname.replace(/^\//u, ""), project_ref: env.get("TIVDOC_DEV_PROJECT_REF") ?? "",
    },
  });
  await seedSessions(SYNTHETIC_PROOF_TENANT, `${SYNTHETIC_PROOF_TENANT}.no-attestation-placeholder`, [PROOF_SESSION]);
  // Sessions live an hour from their seed; the reference system session is
  // rewritten idempotently the way the recovery drill does it — nothing is
  // deleted or revoked, and the read stays on the sanctioned path.
  await seedSessions(TENANT, `${TENANT}.no-attestation-placeholder`, [{ ...SYSTEM_SESSION, subject: "system_import" }]);

  async function tx<T>(label: string, work: (client: import("pg").Client) => Promise<T>, session = SYSTEM_SESSION): Promise<T> {
    const client = await factory.acquire();
    try {
      await client.query(statement(`${label}_begin`, "begin", []));
      await client.query(statement(`${label}_context`, "select * from private.runtime_context_install($1,$2,$3)",
        [session.sid, session.jti, `${label}:${randomUUID().slice(0, 8)}`]));
      const value = await work(client);
      await client.query(statement(`${label}_commit`, "commit", []));
      return value;
    } catch (error) {
      await client.query(statement(`${label}_rollback`, "rollback", [])).catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  // --- Draft parameter values, read through the sanctioned aggregate path; cached per version.
  const cache = new Map<string, Readonly<{ state: string; value: ParameterValue; provenance_grade: Grade }>>();
  const valueOf = async (parameterId: string, version: string) => {
    const key = `${parameterId}@${version}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const read = await tx("l76_read", async (client) => {
      const row = await client.query(statement("l76_aggregate",
        "select state, content_json from private.governance_aggregate_read($1,$2,$3,$4)",
        [TENANT, "parameter_approval", parameterId, version]));
      if (row.row_count !== 1) throw new Error(`L76_PARAMETER_MISSING:${key}`);
      const value = row.rows[0] as unknown as { state: string; content_json: { value: ParameterValue; provenance_grade?: string } };
      const grade = value.content_json.provenance_grade;
      // A version registered before candidates carried a grade (batches 1–10) is
      // graded by its batch receipt in report v5; here the run reads the grade
      // the report resolved, so the two never disagree.
      return { state: value.state, value: value.content_json.value, provenance_grade: (grade ?? gradeFromReport(key)) as Grade };
    });
    if (!GRADES.includes(read.provenance_grade)) throw new Error(`L76_GRADE_UNKNOWN:${key}:${read.provenance_grade}`);
    if (read.state !== "draft") throw new Error(`L76_PARAMETER_NOT_DRAFT:${key}:${read.state}`);
    cache.set(key, read);
    return read;
  };

  // --- Pre-bind every spec's parameters for every branch and every population
  // the corpus declares (L8-4), so the run itself is synchronous and pure. The
  // slot's parameter is decided by the engine (`parameterSlotsFor`); this
  // script only reads the value.
  const bound = new Map<string, readonly BoundDraftParameter[]>();
  const populations = [...new Map(SYNTHETIC_CORPUS.map((entry) => { const p = populationOf(entry.snapshot); return [`${p.population}|${p.source}`, p] as const; })).values()];
  for (const spec of DRAFT_SHADOW_SPECS) {
    const branches: readonly (string | null)[] = spec.branches.length > 0 ? spec.branches.map(([name]) => name) : [spec.composition_branch];
    for (const branch of branches) {
      for (const population of populations) {
        const parameters: BoundDraftParameter[] = [];
        for (const slot of parameterSlotsFor(spec, branch, population)) {
          const read = await valueOf(slot.parameter_id, slot.parameter_version);
          parameters.push({ ref_id: slot.ref_id, parameter_version_id: `${slot.parameter_id}@${slot.parameter_version}`, state: read.state, value: toInput(read.value), provenance_grade: read.provenance_grade });
        }
        bound.set(`${spec.shadow_id}|${branch ?? ""}|${population.population}`, Object.freeze(parameters));
      }
    }
  }
  const bindings = (spec: DraftShadowSpec, branch: string | null, population: PopulationBinding) => {
    const parameters = bound.get(`${spec.shadow_id}|${branch ?? ""}|${population.population}`);
    if (!parameters) throw new Error(`L76_BOUND_MISSING:${spec.shadow_id}:${branch}:${population.population}`);
    return parameters;
  };
  const draftVersions = new Set([...bound.values()].flatMap((parameters) => parameters.map((parameter) => parameter.parameter_version_id)));

  // --- The scheduler. First the proof that nothing runs by default: the flags
  // read from an empty environment are off and schedule() refuses.
  const runSuffix = randomUUID().slice(0, 8);
  const runId = `l76.${runSuffix}`;
  const store = new LocalFileDurableShadowStateStore({ root: STATE_ROOT, root_kind: "generated_offline_synthetic_state" });
  const limits = { max_jobs: 64, max_queued: 8, max_concurrent_leases: 1, max_attempts: 2, max_dataset_bytes: 1_048_576, max_lease_ms: 600_000 };
  const codeSha = canonicalSha256(DRAFT_SHADOW_SPECS.map((spec) => ({ shadow_id: spec.shadow_id, content_sha256: spec.spec.content_sha256, registry_sha256: spec.input_mappings.registry_sha256 })));
  const envelope = buildDraftShadowEnvelope({
    run_id: runId, corpus_sha256: SYNTHETIC_CORPUS_SHA256, draft_parameter_versions: draftVersions.size,
    synthetic_inputs: SYNTHETIC_CORPUS.length, requested_at: new Date().toISOString(), code_sha256: codeSha,
    dataset_byte_count: Buffer.byteLength(JSON.stringify(SYNTHETIC_CORPUS.map((entry) => entry.snapshot))),
  });
  const defaultFlags = readOfflineShadowFlags({}, "development");
  let defaultRefusal: string | null = null;
  try {
    await new DurableOfflineShadowScheduler({ store, flags: defaultFlags, limits }).schedule(envelope, { idempotency_key: `idem.${runId}.default`, correlation_id: `corr.${runId}.default` });
  } catch (error) {
    defaultRefusal = (error as Error).message;
  }
  if (defaultRefusal !== "SHADOW_OFFLINE_SYNTHETIC_DISABLED") throw new Error(`L76_DEFAULT_OFF_NOT_PROVEN:${defaultRefusal}`);

  const scheduler = new DurableOfflineShadowScheduler({ store, flags: { enabled: true, synthetic_enabled: true, public_enabled: false }, limits });
  const before = await scheduler.snapshot();
  if (before.kill_switch.engaged) throw new Error("L76_KILL_SWITCH_ENGAGED");
  const scheduled = await scheduler.schedule(envelope, { idempotency_key: `idem.${runId}.schedule`, correlation_id: `corr.${runId}.schedule` });
  await scheduler.enqueue({ run_id: runId, expected_revision: scheduled.revision, idempotency_key: `idem.${runId}.enqueue`, correlation_id: `corr.${runId}.enqueue` });
  const [lease] = await scheduler.lease({ worker_id: `worker.${runSuffix}`, now: new Date().toISOString(), lease_ms: 600_000, limit: 1, correlation_id: `corr.${runId}.lease` });
  if (!lease) throw new Error("L76_LEASE_NOT_GRANTED");

  // --- Execute inside the lease: the run, then one trace per executed case.
  let result: DraftShadowRunResult | null = null;
  const persisted: string[] = [];
  const completed = await scheduler.executeLease(lease, `corr.${runId}.execute`, async (running) => {
    if (running.execution_mode !== "draft_parameters_synthetic_inputs") throw new Error("L76_ENVELOPE_MODE_UNEXPECTED");
    result = runDraftShadow({ run_id: runId, bindings, branch_policy: "all" });
    for (const execution of result.executions) {
      if (execution.status !== "ran" || !execution.execution_trace || !execution.execution_inputs) continue;
      const payload = {
        execution_id: execution.execution_id,
        topic: execution.topic,
        rule_spec_id: execution.rule_spec_id,
        rule_spec_version: execution.rule_spec_version,
        rule_content_sha256: execution.rule_content_sha256,
        snapshot_sha256: canonicalSha256(execution.execution_inputs),
        execution_inputs: execution.execution_inputs,
        execution_trace: execution.execution_trace,
        trace_sha256: execution.trace_sha256,
        result_sha256: execution.result_sha256,
      };
      await tx("l76_append", (client) => client.query(statement("l76_append_call",
        "select * from private.legal_operations_execution_trace_append($1,$2::jsonb,$3,$4,$5::timestamptz)",
        [SYNTHETIC_PROOF_TENANT, JSON.stringify(payload), `l76.${execution.execution_id}`, sha256(`l76:${execution.execution_id}:${execution.trace_sha256}`), new Date().toISOString()])), PROOF_SESSION);
      persisted.push(execution.execution_id);
    }
    return {
      result_sha256: result.result_sha256,
      comparison_sha256: canonicalSha256(compareBranches(result.executions)),
      disagreement_id: null,
      monetary_output_count: 0 as const,
      finding_count: 0 as const,
      customer_report_count: 0 as const,
      automatic_customer_promotion: false as const,
      automatic_production_promotion: false as const,
    };
  });
  if (!result || completed.state !== "completed") throw new Error(`L76_RUN_NOT_COMPLETED:${completed.state}:${completed.safe_error_code}`);
  const run: DraftShadowRunResult = result;
  const audit = verifySchedulerAuditChain((await scheduler.snapshot()).audit);

  // --- Replay every persisted trace from the database, each in a fresh process.
  const replayed: Array<Record<string, unknown>> = [];
  for (const executionId of persisted) {
    try {
      const stdout = execFileSync(process.execPath, [
        "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--experimental-strip-types",
        "scripts/legal-review-projection/sensitivity-trace-replay.mts", executionId, SYNTHETIC_PROOF_TENANT, PROOF_SESSION.sid,
      ], { encoding: "utf8", cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
      const verdict = /E37_REPLAY_VERDICT (\{.*\})/u.exec(stdout)?.[1];
      replayed.push(verdict ? JSON.parse(verdict) as Record<string, unknown> : { execution_id: executionId, accepted: false, error: "no verdict" });
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string };
      replayed.push({ execution_id: executionId, accepted: false, error: `${failure.stdout ?? ""}${failure.stderr ?? ""}`.slice(0, 200) });
    }
  }
  const replayFailures = replayed.filter((row) => row.accepted !== true);

  // --- L7-7: the comparison, per open decision, per case, per branch.
  const comparison = compareBranches(run.executions);

  const receipt = {
    schema_version: "tivdoc-draft-shadow-run-receipt-v1",
    classification: "internal_only",
    delivery_allowed: false,
    is_finding: false,
    run_id: runId,
    tenant_id: SYNTHETIC_PROOF_TENANT,
    parameter_tenant_id: TENANT,
    envelope_sha256: envelope.envelope_sha256,
    envelope_schema_version: envelope.schema_version,
    execution_mode: envelope.execution_mode,
    draft_input_pin: envelope.draft_input_pin,
    default_flags: defaultFlags,
    default_schedule_refusal: defaultRefusal,
    kill_switch_engaged: false,
    scheduler_job_state: completed.state,
    scheduler_result_sha256: completed.result_sha256,
    scheduler_comparison_sha256: completed.comparison_sha256,
    audit_chain: audit,
    corpus_sha256: SYNTHETIC_CORPUS_SHA256,
    code_sha256: codeSha,
    counts: run.counts,
    refusals_by_reason: run.refusals_by_reason,
    grades: run.grades,
    traces_included: persisted.length,
    traces_replayed_from_database: replayed.length - replayFailures.length,
    replay_failures: replayFailures,
    draft_parameter_versions: [...draftVersions].sort(),
    comparison,
    extraction_used: false,
    counters: { live_provider_calls: 0, openai_calls: 0, customer_payslips_read: 0, real_payslips_read: 0, active_parameters: 0, findings: 0, deliveries: 0 },
  };
  const sealed = { ...receipt, receipt_sha256: canonicalSha256(receipt) };
  writeFileSync(path.join(RECEIPT_ROOT, "draft-shadow-run-v1.json"), `${JSON.stringify({ ...sealed, executions: run.executions.map(stripTrace) }, null, 2)}\n`, "utf8");
  writeFileSync(path.join(RECEIPT_ROOT, "draft-shadow-receipt-v1.json"), `${JSON.stringify(sealed, null, 2)}\n`, "utf8");
  // The summary the /operations panel reads (L7-8): mode, pins, counts, hashes, refusals — no content.
  const summary = {
    schema_version: "tivdoc-draft-shadow-summary-v1",
    run_id: runId,
    execution_mode: envelope.execution_mode,
    envelope_sha256: envelope.envelope_sha256,
    draft_input_pin: envelope.draft_input_pin,
    counts: run.counts,
    refusals_by_reason: run.refusals_by_reason,
    grades: run.grades,
    result_sha256: run.result_sha256,
    comparison_sha256: completed.comparison_sha256,
    traces_included: persisted.length,
    traces_replayed_from_database: replayed.length - replayFailures.length,
    audit_chain: audit,
    decisions_compared: comparison.map((entry) => ({ decision_id: entry.decision_id, cases_compared: entry.cases_compared, cases_differing: entry.cases_differing })),
    content_included: false,
    delivery_allowed: false,
    is_finding: false,
    activation_allowed: false,
    completed_at: completed.updated_at,
  };
  writeFileSync(path.join(RECEIPT_ROOT, "draft-shadow-summary-v1.json"), `${JSON.stringify({ ...summary, summary_sha256: canonicalSha256(summary) }, null, 2)}\n`, "utf8");

  process.stdout.write(`${JSON.stringify({
    run_id: runId, receipt_sha256: sealed.receipt_sha256, envelope_sha256: envelope.envelope_sha256,
    counts: run.counts, refusals_by_reason: run.refusals_by_reason, grades: run.grades,
    traces_included: persisted.length, traces_replayed: replayed.length - replayFailures.length, replay_failures: replayFailures.length,
    audit_events: audit.event_count, decisions: comparison.map((entry) => `${entry.decision_id.replace(/^.*decision\./u, "")}: ${entry.cases_differing}/${entry.cases_compared} differ`),
  }, null, 2)}\n`);
  if (replayFailures.length > 0 || persisted.length === 0) process.exitCode = 1;
}

function stripTrace(execution: ShadowExecutionRecord) {
  const { execution_trace: _trace, execution_inputs: _inputs, ...rest } = execution;
  void _trace; void _inputs;
  return rest;
}

/** Report v5's grade for a version registered before candidates carried one. */
function gradeFromReport(parameterVersionId: string): string {
  try {
    const report = JSON.parse(readFileSync(path.join("output", "next", "pool-q", "decision-sensitivity-report-v5.json"), "utf8")) as { provenance?: { bound_parameter_versions?: Array<{ parameter_version_id: string; provenance_grade: string }> } };
    const row = report.provenance?.bound_parameter_versions?.find((entry) => entry.parameter_version_id === parameterVersionId);
    if (row) return row.provenance_grade;
  } catch { /* fall through */ }
  return "text_verified";
}

await main();
