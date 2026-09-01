import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalSha256 } from "../../../engine/rule-runtime/canonical.ts";
import { DurableOfflineShadowScheduler } from "./durable-scheduler.ts";
import { buildDurableSyntheticShadowEnvelope } from "./durable-synthetic-fixtures.ts";
import { LocalFileDurableShadowStateStore, validateShadowSchedulerSnapshot, verifySchedulerAuditChain } from "./durable-store.ts";

const ENABLED = Object.freeze({ enabled: true, synthetic_enabled: true, public_enabled: false });
const LIMITS = Object.freeze({ max_jobs: 8, max_queued: 4, max_concurrent_leases: 2, max_attempts: 2, max_dataset_bytes: 8_192, max_lease_ms: 5_000 });
let roots: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots = [];
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "tivdoc-shadow-v010-"));
  roots.push(root);
  const store = new LocalFileDurableShadowStateStore({ root, root_kind: "generated_offline_synthetic_state" });
  let current = "2042-01-01T00:00:00.000Z";
  const scheduler = () => new DurableOfflineShadowScheduler({ store, flags: ENABLED, limits: LIMITS, now: () => current });
  return { root, store, scheduler, setNow: (value: string) => { current = value; } };
}

function command(suffix: string) {
  return { idempotency_key: `idempotency_${suffix}`, correlation_id: `correlation_${suffix}` } as const;
}

describe("MC-23 / V010-W7.1 durable offline synthetic scheduler", () => {
  it("survives restart and completes a fenced lease with immutable pins and no promotion", async () => {
    const { scheduler, store } = await fixture();
    const first = scheduler();
    const envelope = buildDurableSyntheticShadowEnvelope();
    const scheduled = await first.schedule(envelope, command("schedule_001"));
    expect((await first.schedule(envelope, command("schedule_001"))).job_sha256).toBe(scheduled.job_sha256);
    const queued = await first.enqueue({ run_id: scheduled.run_id, expected_revision: scheduled.revision, ...command("enqueue_001") });
    const [lease] = await first.lease({ worker_id: "worker_shadow_001", now: "2042-01-01T00:00:00.000Z", lease_ms: 1_000, limit: 1, correlation_id: "correlation_lease_001" });
    const restarted = scheduler();
    await restarted.start(lease, "correlation_start_001");
    const completed = await restarted.complete(lease, {
      correlation_id: "correlation_complete_001",
      result_sha256: canonicalSha256({ result: "synthetic-only" }),
      comparison_sha256: canonicalSha256({ comparison: "synthetic-only" }),
      disagreement_id: "disagreement.synthetic.001",
      monetary_output_count: 0,
      finding_count: 0,
      customer_report_count: 0,
      automatic_customer_promotion: false,
      automatic_production_promotion: false,
    });
    expect(queued.state).toBe("queued");
    expect(completed).toMatchObject({ state: "completed", automatic_customer_promotion: false, automatic_production_promotion: false });
    expect(completed.envelope).toMatchObject({ execution_mode: "offline_synthetic_only", customer_input_allowed: false, network_allowed: false, delivery_allowed: false });
    expect(verifySchedulerAuditChain((await store.read()).audit).valid).toBe(true);
  });

  it("recovers an expired crash lease and rejects the stale fencing token", async () => {
    const { scheduler, setNow } = await fixture();
    const first = scheduler();
    const scheduled = await first.schedule(buildDurableSyntheticShadowEnvelope({ run_id: "shadow.run.synthetic.crash" }), command("schedule_crash"));
    await first.enqueue({ run_id: scheduled.run_id, expected_revision: scheduled.revision, ...command("enqueue_crash") });
    const [staleLease] = await first.lease({ worker_id: "worker_shadow_crash", now: "2042-01-01T00:00:00.000Z", lease_ms: 100, limit: 1, correlation_id: "correlation_lease_crash" });
    setNow("2042-01-01T00:00:00.101Z");
    const restarted = scheduler();
    const recovered = await restarted.recoverExpiredLeases({ now: "2042-01-01T00:00:00.101Z", correlation_id: "correlation_recover_crash" });
    expect(recovered[0]).toMatchObject({ state: "queued", recovery_count: 1 });
    await expect(restarted.start(staleLease, "correlation_stale_crash")).rejects.toThrow("SHADOW_LEASE_FENCED");
    const [freshLease] = await restarted.lease({ worker_id: "worker_shadow_restart", now: "2042-01-01T00:00:00.101Z", lease_ms: 100, limit: 1, correlation_id: "correlation_released_crash" });
    expect(freshLease.fencing_token).toBeGreaterThan(staleLease.fencing_token);
  });

  it("enforces pause, kill switch, concurrency and queue limits fail closed", async () => {
    const { scheduler } = await fixture();
    const control = scheduler();
    await control.pause(command("pause_001"));
    await expect(control.schedule(buildDurableSyntheticShadowEnvelope(), command("paused_schedule"))).rejects.toThrow("SHADOW_SCHEDULER_PAUSED");
    await control.resume(command("resume_001"));
    const jobs = [];
    for (let index = 1; index <= 4; index += 1) {
      const runId = `shadow.run.limit.00${index}`;
      const scheduled = await control.schedule(buildDurableSyntheticShadowEnvelope({ run_id: runId }), command(`schedule_limit_00${index}`));
      jobs.push(await control.enqueue({ run_id: runId, expected_revision: scheduled.revision, ...command(`enqueue_limit_00${index}`) }));
    }
    const extra = await control.schedule(buildDurableSyntheticShadowEnvelope({ run_id: "shadow.run.limit.005" }), command("schedule_limit_005"));
    await expect(control.enqueue({ run_id: extra.run_id, expected_revision: extra.revision, ...command("enqueue_limit_005") })).rejects.toThrow("SHADOW_QUEUE_LIMIT_EXCEEDED");
    expect(await control.lease({ worker_id: "worker_shadow_limits", now: "2042-01-01T00:00:00.000Z", lease_ms: 1_000, limit: 2, correlation_id: "correlation_lease_limits" })).toHaveLength(2);
    expect(await control.lease({ worker_id: "worker_shadow_limits2", now: "2042-01-01T00:00:00.000Z", lease_ms: 1_000, limit: 2, correlation_id: "correlation_lease_limits2" })).toHaveLength(0);
    await control.engageKillSwitch({ ...command("kill_001"), reason_code: "SYNTHETIC_EMERGENCY_STOP" });
    expect((await control.snapshot()).kill_switch.engaged).toBe(true);
    expect(Object.values((await control.snapshot()).jobs).every((job) => job.state === "cancelled")).toBe(true);
    await expect(control.schedule(buildDurableSyntheticShadowEnvelope({ run_id: "shadow.run.killed.001" }), command("killed_schedule"))).rejects.toThrow("SHADOW_KILL_SWITCH_ENGAGED");
  });

  it("blocks customer or real-corpus envelopes before any evaluation", async () => {
    const { scheduler } = await fixture();
    const control = scheduler();
    const evaluator = vi.fn();
    const valid = buildDurableSyntheticShadowEnvelope();
    await expect(control.schedule({ ...valid, customer_input_allowed: true }, command("customer_block"))).rejects.toThrow("SHADOW_CUSTOMER_INPUT_FORBIDDEN");
    await expect(control.schedule({ ...valid, source_state_pin: { ...valid.source_state_pin, active_real_source_count: 1 } }, command("real_block"))).rejects.toThrow("SHADOW_REAL_CORPUS_PRECALCULATION_BLOCKED");
    await expect(control.schedule(buildDurableSyntheticShadowEnvelope({ run_id: "shadow.run.oversized.001", dataset_byte_count: 8_193 }), command("oversized_block"))).rejects.toThrow("SHADOW_DATASET_SIZE_LIMIT_EXCEEDED");
    expect(evaluator).not.toHaveBeenCalled();
    expect(Object.keys((await control.snapshot()).jobs)).toHaveLength(0);
  });

  it("supports explicit cancel and bounded failed-run retry", async () => {
    const { scheduler } = await fixture();
    const control = scheduler();
    const cancelledInput = await control.schedule(buildDurableSyntheticShadowEnvelope({ run_id: "shadow.run.cancel.001" }), command("cancel_schedule"));
    expect((await control.cancel({ run_id: cancelledInput.run_id, expected_revision: cancelledInput.revision, ...command("cancel_command") })).state).toBe("cancelled");

    const scheduled = await control.schedule(buildDurableSyntheticShadowEnvelope({ run_id: "shadow.run.retry.001" }), command("retry_schedule"));
    await control.enqueue({ run_id: scheduled.run_id, expected_revision: scheduled.revision, ...command("retry_enqueue") });
    const [lease] = await control.lease({ worker_id: "worker_shadow_retry", now: "2042-01-01T00:00:00.000Z", lease_ms: 1_000, limit: 1, correlation_id: "correlation_retry_lease" });
    const failed = await control.fail(lease, { correlation_id: "correlation_retry_fail", safe_error_code: "SYNTHETIC_WORKER_FAILURE" });
    const retried = await control.retry({ run_id: failed.run_id, expected_revision: failed.revision, available_at: "2042-01-01T00:00:00.000Z", ...command("retry_command") });
    expect(retried).toMatchObject({ state: "queued", attempt: 1, safe_error_code: null });
  });

  it("detects committed-state tampering and ignores uncommitted partial snapshots", async () => {
    const { scheduler, store, root } = await fixture();
    await scheduler().schedule(buildDurableSyntheticShadowEnvelope(), command("tamper_schedule"));
    const states = path.join(root, "states");
    await writeFile(path.join(states, "truncated.pending-deadbeef"), "{", "utf8");
    expect((await store.read()).snapshot_revision).toBe(1);
    const [name] = (await readdir(states)).filter((candidate) => candidate.endsWith(".json"));
    const target = path.join(states, name);
    const bytes = await readFile(target, "utf8");
    await writeFile(target, bytes.replace('"state":"scheduled"', '"state":"cancelled"'), "utf8");
    await expect(store.read()).rejects.toThrow(/SHADOW_(SNAPSHOT_HASH_MISMATCH|JOB_HASH_MISMATCH)/u);
  });

  it("rejects non-allowlisted job payload fields even when an attacker recomputes hashes", async () => {
    const { scheduler } = await fixture();
    const control = scheduler();
    await control.schedule(buildDurableSyntheticShadowEnvelope(), command("allowlist_schedule"));
    const snapshot = await control.snapshot();
    const job = snapshot.jobs["shadow.run.synthetic.001"];
    const { job_sha256: ignoredJobSha, ...jobContent } = job;
    void ignoredJobSha;
    const poisonedJobContent = { ...jobContent, report_text: "synthetic-prohibited-field" };
    const poisonedJob = { ...poisonedJobContent, job_sha256: canonicalSha256(poisonedJobContent) };
    const { snapshot_sha256: ignoredSnapshotSha, ...snapshotContent } = snapshot;
    void ignoredSnapshotSha;
    const poisonedSnapshotContent = { ...snapshotContent, jobs: { ...snapshot.jobs, [job.run_id]: poisonedJob } };
    expect(() => validateShadowSchedulerSnapshot({ ...poisonedSnapshotContent, snapshot_sha256: canonicalSha256(poisonedSnapshotContent) })).toThrow("SHADOW_JOB_INVALID");
  });
});
