// L7-8. The shadow summary the /operations panel reads: what the durable
// scheduler holds — mode, pins, job states, hashes, the audit chain — and,
// beside it, the counts the last draft run wrote (cases, refusals by reason,
// grades). No content: no snapshot, no output, no delta, no trace. The
// sidecar is validated by a strict schema that names every field it may
// carry, so a summary that grew a content field would fail to load rather
// than be served.
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { canonicalSha256 } from "../../../engine/rule-runtime/canonical.ts";
import type { DurableShadowJob, ShadowSchedulerSnapshot } from "./durable-contracts.ts";
import { verifySchedulerAuditChain, type DurableShadowStateStore } from "./durable-store.ts";

export const SHADOW_SUMMARY_SCHEMA_VERSION = "tivdoc-offline-shadow-summary-v0.11.0" as const;

const sha = z.string().regex(/^[a-f0-9]{64}$/u);
const counts = z.record(z.string().max(120), z.number().int().nonnegative());

/** Everything the run's sidecar may say. Strict: an unknown key is a refusal. */
export const draftShadowSummarySidecarSchema = z.object({
  schema_version: z.literal("tivdoc-draft-shadow-summary-v1"),
  run_id: z.string().regex(/^[a-z][a-z0-9:._-]{2,159}$/u),
  execution_mode: z.literal("draft_parameters_synthetic_inputs"),
  envelope_sha256: sha,
  draft_input_pin: z.object({
    pin_id: z.string(),
    version: z.string(),
    sha256: sha,
    mode: z.literal("draft_parameters_synthetic_inputs"),
    active_real_parameter_count: z.literal(0),
    draft_parameter_versions: z.number().int().positive(),
    synthetic_inputs: z.number().int().positive(),
    extraction_used: z.literal(false),
    corpus_sha256: sha,
    tenant_id: z.literal("legal.synthetic.proof"),
  }).strict(),
  counts: z.object({
    cases: z.number().int().nonnegative(),
    executions: z.number().int().nonnegative(),
    ran: z.number().int().nonnegative(),
    preparation_refused: z.number().int().nonnegative(),
    executor_refused: z.number().int().nonnegative(),
    deltas_computed: z.number().int().nonnegative(),
    deltas_not_applicable: z.number().int().nonnegative(),
    deltas_paid_refused: z.number().int().nonnegative(),
    draft_parameter_versions: z.number().int().nonnegative(),
    active_real_parameter_count: z.literal(0),
    monetary_output_count: z.literal(0),
    finding_count: z.literal(0),
    customer_report_count: z.literal(0),
  }).strict(),
  refusals_by_reason: counts,
  grades: counts,
  result_sha256: sha,
  comparison_sha256: sha,
  traces_included: z.number().int().nonnegative(),
  traces_replayed_from_database: z.number().int().nonnegative(),
  audit_chain: z.object({ valid: z.literal(true), event_count: z.number().int().nonnegative(), tail_sha256: sha.nullable() }).strict(),
  decisions_compared: z.array(z.object({
    decision_id: z.string(),
    cases_compared: z.number().int().nonnegative(),
    cases_differing: z.number().int().nonnegative(),
  }).strict()).readonly(),
  content_included: z.literal(false),
  delivery_allowed: z.literal(false),
  is_finding: z.literal(false),
  activation_allowed: z.literal(false),
  completed_at: z.string(),
  summary_sha256: sha,
}).strict().superRefine((value, context) => {
  const { summary_sha256: expected, ...content } = value;
  if (canonicalSha256(content) !== expected) context.addIssue({ code: "custom", message: "SHADOW_SUMMARY_SIDECAR_HASH_MISMATCH" });
});

export type DraftShadowSummarySidecar = z.infer<typeof draftShadowSummarySidecarSchema>;

export type ShadowJobSummary = Readonly<{
  run_id: string;
  state: DurableShadowJob["state"];
  attempt: number;
  envelope_schema_version: string;
  execution_mode: string;
  envelope_sha256: string;
  draft_input_pin: DurableShadowJob["envelope"]["draft_input_pin"] | null;
  active_real_parameter_count: 0;
  result_sha256: string | null;
  comparison_sha256: string | null;
  safe_error_code: string | null;
  created_at: string;
  updated_at: string;
}>;

export type OfflineShadowSummary = Readonly<{
  schema_version: typeof SHADOW_SUMMARY_SCHEMA_VERSION;
  persistence: "local_file_durable_shadow_state";
  snapshot_revision: number;
  snapshot_sha256: string;
  scheduler_paused: boolean;
  kill_switch: ShadowSchedulerSnapshot["kill_switch"];
  jobs_by_state: Readonly<Record<string, number>>;
  jobs: readonly ShadowJobSummary[];
  audit_chain: Readonly<{ valid: true; event_count: number; tail_sha256: string | null }>;
  latest_draft_run: Omit<DraftShadowSummarySidecar, "summary_sha256"> & { summary_sha256: string } | null;
  content_included: false;
  delivery_allowed: false;
  is_finding: false;
  activation_allowed: false;
}>;

export type ShadowSummarySource = Readonly<{
  store: DurableShadowStateStore;
  /** Absolute path of the last run's summary sidecar, or null when no run has written one. */
  summary_path: string | null;
}>;

function jobSummary(job: DurableShadowJob): ShadowJobSummary {
  return Object.freeze({
    run_id: job.run_id,
    state: job.state,
    attempt: job.attempt,
    envelope_schema_version: job.envelope.schema_version,
    execution_mode: job.envelope.execution_mode,
    envelope_sha256: job.envelope.envelope_sha256,
    draft_input_pin: job.envelope.draft_input_pin ?? null,
    active_real_parameter_count: 0,
    result_sha256: job.result_sha256,
    comparison_sha256: job.comparison_sha256,
    safe_error_code: job.safe_error_code,
    created_at: job.created_at,
    updated_at: job.updated_at,
  });
}

async function readSidecar(summaryPath: string | null): Promise<DraftShadowSummarySidecar | null> {
  if (summaryPath === null) return null;
  let text: string;
  try {
    text = await readFile(summaryPath, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
  return draftShadowSummarySidecarSchema.parse(JSON.parse(text));
}

/** The summary, from the committed scheduler state and the run's sidecar; both verified before anything is projected. */
export async function readOfflineShadowSummary(source: ShadowSummarySource): Promise<OfflineShadowSummary> {
  const snapshot = await source.store.read();
  const audit = verifySchedulerAuditChain(snapshot.audit);
  const jobs = Object.values(snapshot.jobs)
    .sort((left, right) => (left.created_at < right.created_at ? 1 : left.created_at > right.created_at ? -1 : left.run_id.localeCompare(right.run_id, "en")))
    .map(jobSummary);
  const byState: Record<string, number> = {};
  for (const job of jobs) byState[job.state] = (byState[job.state] ?? 0) + 1;
  const sidecar = await readSidecar(source.summary_path);
  // The sidecar must describe a job the scheduler actually completed, with the
  // hashes the scheduler recorded; a sidecar that names an unknown run or a
  // different result is not served.
  if (sidecar !== null) {
    const job = snapshot.jobs[sidecar.run_id];
    if (!job || job.state !== "completed" || job.result_sha256 !== sidecar.result_sha256 || job.comparison_sha256 !== sidecar.comparison_sha256 || job.envelope.envelope_sha256 !== sidecar.envelope_sha256) {
      throw new Error("SHADOW_SUMMARY_SIDECAR_JOB_MISMATCH");
    }
  }
  return Object.freeze({
    schema_version: SHADOW_SUMMARY_SCHEMA_VERSION,
    persistence: "local_file_durable_shadow_state",
    snapshot_revision: snapshot.snapshot_revision,
    snapshot_sha256: snapshot.snapshot_sha256,
    scheduler_paused: snapshot.scheduler_paused,
    kill_switch: snapshot.kill_switch,
    jobs_by_state: Object.freeze(byState),
    jobs: Object.freeze(jobs),
    audit_chain: audit,
    latest_draft_run: sidecar,
    content_included: false,
    delivery_allowed: false,
    is_finding: false,
    activation_allowed: false,
  });
}
