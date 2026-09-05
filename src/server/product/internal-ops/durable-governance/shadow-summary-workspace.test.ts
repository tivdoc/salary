// L7-8 (S-8). The offline-shadow summary on the canonical service: the
// capability exists only when a state root is configured; the read verifies
// the scheduler state and the sidecar before projecting; every reader role
// the panel declares is admitted and every other refused; nothing in the
// projection is content.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { VerifiedActor } from "../../../../engine/wave4/contracts.ts";
import { canonicalSha256 } from "../../../../engine/rule-runtime/canonical.ts";
import { runDraftShadow } from "../../../../engine/shadow/draft-shadow-run.ts";
import { SYNTHETIC_CORPUS, SYNTHETIC_CORPUS_SHA256 } from "../../../../engine/shadow/synthetic-corpus.ts";
import { testBindings } from "../../../../engine/shadow/test-support.ts";
import { DurableOfflineShadowScheduler } from "../../../engine/shadow/durable-scheduler.ts";
import { LocalFileDurableShadowStateStore } from "../../../engine/shadow/durable-store.ts";
import { buildDraftShadowEnvelope } from "../../../engine/shadow/durable-synthetic-fixtures.ts";
import { readOfflineShadowSummary } from "../../../engine/shadow/summary-projection.ts";
import type { DurableProductRouteContext, DurableProductRouteServiceAdapter, DurableProductRouteSessionContextPort } from "../../routes/durable-registration.ts";
import type { InternalOpsApplicationPort } from "../application-port.ts";
import type { InternalOpsReadKind } from "../service.ts";
import { createDurableGovernanceOperationsRouteAdapter } from "./application.ts";

const NOW = "2026-09-05T00:00:00.000Z";
const CORRELATION = "correlation.shadow.001";

function actor(role: VerifiedActor["role"] = "legal_reviewer"): VerifiedActor {
  return Object.freeze({
    actor_id: `actor.${role}.001`, role, tenant_id: "tenant.synthetic.001", assigned_case_ids: Object.freeze([]), verified_server_side: true,
    break_glass_reason: role === "break_glass_admin" ? "synthetic verification only" : null,
    break_glass_expires_at: role === "break_glass_admin" ? "2027-01-02T03:04:05.000Z" : null,
  }) as VerifiedActor;
}

const bindings = testBindings;

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

/** A completed draft run in a fresh state root, with its summary sidecar beside it. */
async function completedRun() {
  const base = await mkdtemp(path.join(os.tmpdir(), "tivdoc-shadow-summary-"));
  roots.push(base);
  const root = path.join(base, "state");
  const store = new LocalFileDurableShadowStateStore({ root, root_kind: "generated_offline_synthetic_state" });
  const scheduler = new DurableOfflineShadowScheduler({ store, flags: { enabled: true, synthetic_enabled: true, public_enabled: false }, limits: { max_jobs: 4, max_queued: 4, max_concurrent_leases: 1, max_attempts: 2, max_dataset_bytes: 8_192, max_lease_ms: 60_000 }, now: () => NOW });
  const envelope = buildDraftShadowEnvelope({ run_id: "shadow.run.summary.001", corpus_sha256: SYNTHETIC_CORPUS_SHA256, draft_parameter_versions: 25, synthetic_inputs: SYNTHETIC_CORPUS.length, requested_at: NOW });
  const scheduled = await scheduler.schedule(envelope, { idempotency_key: "idem.summary.schedule", correlation_id: "corr.summary.schedule" });
  await scheduler.enqueue({ run_id: scheduled.run_id, expected_revision: scheduled.revision, idempotency_key: "idem.summary.enqueue", correlation_id: "corr.summary.enqueue" });
  const [lease] = await scheduler.lease({ worker_id: "worker.summary", now: NOW, lease_ms: 60_000, limit: 1, correlation_id: "corr.summary.lease" });
  const run = runDraftShadow({ run_id: scheduled.run_id, bindings });
  const comparisonSha = canonicalSha256({ deltas: run.executions.map((execution) => execution.delta) });
  const completed = await scheduler.executeLease(lease, "corr.summary.execute", async () => ({
    result_sha256: run.result_sha256, comparison_sha256: comparisonSha, disagreement_id: null,
    monetary_output_count: 0 as const, finding_count: 0 as const, customer_report_count: 0 as const,
    automatic_customer_promotion: false as const, automatic_production_promotion: false as const,
  }));
  const sidecarContent = {
    schema_version: "tivdoc-draft-shadow-summary-v1", run_id: scheduled.run_id, execution_mode: envelope.execution_mode,
    envelope_sha256: envelope.envelope_sha256, draft_input_pin: envelope.draft_input_pin,
    counts: run.counts, refusals_by_reason: run.refusals_by_reason, grades: run.grades,
    result_sha256: run.result_sha256, comparison_sha256: comparisonSha, traces_included: run.counts.ran, traces_replayed_from_database: run.counts.ran,
    audit_chain: { valid: true, event_count: 5, tail_sha256: null },
    decisions_compared: [{ decision_id: "legal.reference.il.decision.min_wage_hourly_divisor", cases_compared: 5, cases_differing: 5 }],
    content_included: false, delivery_allowed: false, is_finding: false, activation_allowed: false, completed_at: completed.updated_at,
  };
  const summaryPath = path.join(base, "draft-shadow-summary-v1.json");
  await writeFile(summaryPath, `${JSON.stringify({ ...sidecarContent, summary_sha256: canonicalSha256(sidecarContent) })}\n`, "utf8");
  return { root, store, summaryPath, run, envelope, sidecarContent };
}

function harness(shadow: { root: string; summaryPath: string | null } | null) {
  const postgres = Object.freeze({ marker: "postgres" });
  const product = Object.freeze({ marker: "product" });
  const transactionInputs: unknown[] = [];
  const baseService: InternalOpsApplicationPort = Object.freeze({
    read: async (_actor: VerifiedActor, kind: InternalOpsReadKind) => Object.freeze({ schema_version: "synthetic-core", kind }) as never,
    mutate: async () => Object.freeze({ synthetic: true }) as never,
  });
  const sessionContext = Object.freeze({
    proof_class: "LEAST_PRIVILEGE_VERIFIED_SESSION_CONTEXT", uses_service_role: false, bypasses_rls: false, postgres,
    transaction: async (input: unknown) => { transactionInputs.push(input); throw new Error("unexpected_transaction"); },
  }) as unknown as DurableProductRouteSessionContextPort;
  const context = Object.freeze({ postgres, product, session_context: sessionContext }) as unknown as DurableProductRouteContext;
  const base = Object.freeze({ service: baseService, postgres, product, session_context: sessionContext, proof_class: "POSTGRESQL_TRANSACTIONAL_ROUTE_SERVICE" }) as unknown as DurableProductRouteServiceAdapter<InternalOpsApplicationPort>;
  const adapter = createDurableGovernanceOperationsRouteAdapter({
    context, base, now: () => NOW,
    shadow: shadow ? { store: new LocalFileDurableShadowStateStore({ root: shadow.root, root_kind: "generated_offline_synthetic_state" }), summary_path: shadow.summaryPath } : null,
  });
  return { adapter, transactionInputs };
}

describe("L7-8 offline-shadow summary on the canonical service", () => {
  it("is absent from the service when no state root is configured — the route stays CAPABILITY_ABSENT", () => {
    const { adapter } = harness(null);
    expect(adapter.service).not.toHaveProperty("readShadowSummary");
    expect(typeof adapter.service.readGroundTruthQueue).toBe("function");
    expect(typeof adapter.service.proof).toBe("function");
    expect(adapter.service.proof().activation_allowed).toBe(false);
  });

  it("projects the scheduler state and the last run's counts, verified, with no content", async () => {
    const { root, summaryPath, run, envelope } = await completedRun();
    const { adapter, transactionInputs } = harness({ root, summaryPath });
    const projection = await adapter.service.readShadowSummary!({ actor: actor(), correlation_id: CORRELATION });
    expect(projection.governance_workflow).toBe("offline_shadow");
    expect(projection.persistence).toBe("local_file_durable_shadow_state");
    expect(projection.content_included).toBe(false);
    expect(projection.activation_allowed).toBe(false);
    expect(projection.delivery_allowed).toBe(false);
    expect(transactionInputs).toEqual([]);
    const summary = projection.summary;
    expect(summary.audit_chain).toMatchObject({ valid: true, event_count: 5 });
    expect(summary.kill_switch.engaged).toBe(false);
    expect(summary.jobs_by_state).toEqual({ completed: 1 });
    expect(summary.jobs[0]).toMatchObject({ run_id: "shadow.run.summary.001", state: "completed", execution_mode: "draft_parameters_synthetic_inputs", envelope_sha256: envelope.envelope_sha256, result_sha256: run.result_sha256, active_real_parameter_count: 0 });
    expect(summary.latest_draft_run).toMatchObject({ run_id: "shadow.run.summary.001", counts: run.counts, refusals_by_reason: run.refusals_by_reason, grades: run.grades, draft_input_pin: { active_real_parameter_count: 0, extraction_used: false } });
    const text = JSON.stringify(projection);
    for (const forbidden of ["\"snapshot\":", "minor_units", "\"output\"", "execution_trace", "\"delta\":", "\"facts\"", "provenance", "\"value\":"]) expect(text, forbidden).not.toContain(forbidden);
  });

  it("admits every reader role the panel declares, and refuses every other without touching the store", async () => {
    const { root, summaryPath } = await completedRun();
    for (const role of ["parameter_verifier", "legal_reviewer", "report_approver", "auditor", "break_glass_admin"] as const) {
      const { adapter } = harness({ root, summaryPath });
      await expect(adapter.service.readShadowSummary!({ actor: actor(role), correlation_id: CORRELATION })).resolves.toBeDefined();
    }
    for (const role of ["anonymous", "customer_owner", "intake_operator", "extraction_reviewer", "fact_reviewer", "scoped_background_worker"] as const) {
      const { adapter } = harness({ root: path.join(root, "does-not-exist"), summaryPath });
      await expect(adapter.service.readShadowSummary!({ actor: actor(role), correlation_id: CORRELATION })).rejects.toThrow(/FORBIDDEN/u);
    }
  });

  it("refuses a sidecar that does not match a completed job, and a sidecar that grew a content field", async () => {
    const { root, store, summaryPath, sidecarContent } = await completedRun();
    const tampered = { ...sidecarContent, result_sha256: "f".repeat(64) };
    await writeFile(summaryPath, `${JSON.stringify({ ...tampered, summary_sha256: canonicalSha256(tampered) })}\n`, "utf8");
    await expect(readOfflineShadowSummary({ store, summary_path: summaryPath })).rejects.toThrow("SHADOW_SUMMARY_SIDECAR_JOB_MISMATCH");
    const grown = { ...sidecarContent, executions: [{ output: { minor_units: 1 } }] };
    await writeFile(summaryPath, `${JSON.stringify({ ...grown, summary_sha256: canonicalSha256(grown) })}\n`, "utf8");
    await expect(readOfflineShadowSummary({ store, summary_path: summaryPath })).rejects.toThrow();
    const stale = { ...sidecarContent };
    await writeFile(summaryPath, `${JSON.stringify({ ...stale, summary_sha256: "0".repeat(64) })}\n`, "utf8");
    await expect(readOfflineShadowSummary({ store, summary_path: summaryPath })).rejects.toThrow(/HASH_MISMATCH/u);
    // A directory (or a link) at the sidecar path is not a regular file and is refused.
    await expect(readOfflineShadowSummary({ store, summary_path: root })).rejects.toThrow("SHADOW_SUMMARY_SIDECAR_NOT_A_REGULAR_FILE");
    // No sidecar at all: the scheduler state alone is served.
    const alone = await readOfflineShadowSummary({ store, summary_path: path.join(root, "missing.json") });
    expect(alone.latest_draft_run).toBeNull();
    expect(alone.jobs).toHaveLength(1);
  });
});
