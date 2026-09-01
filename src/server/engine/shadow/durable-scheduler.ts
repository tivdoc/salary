import { canonicalSha256, deepFreeze } from "../../../engine/rule-runtime/canonical.ts";
import type { OfflineShadowFlags } from "./flags.ts";
import {
  durableShadowRunEnvelopeSchema,
  sealShadowJob,
  type DurableShadowJob,
  type DurableShadowRunEnvelope,
  type ShadowLease,
  type ShadowSchedulerAuditEvent,
  type ShadowSchedulerLimits,
  type ShadowSchedulerSnapshot,
} from "./durable-contracts.ts";
import { sealSnapshot, type DurableShadowStateStore } from "./durable-store.ts";

type CommandInput = Readonly<{ idempotency_key: string; correlation_id: string }>;

function assertId(value: string, code: string) {
  if (!/^[a-z][a-z0-9:._-]{2,159}$/u.test(value)) throw new Error(code);
}

function assertSha(value: string, code: string) {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(code);
}

function safeErrorCode(error: unknown) {
  return error instanceof Error && /^[A-Z][A-Z0-9_]{2,95}$/u.test(error.message)
    ? error.message
    : "SHADOW_WORKER_FAILED";
}

function projectJob(job: DurableShadowJob) {
  return deepFreeze({ ...job, envelope: { ...job.envelope } }) as DurableShadowJob;
}

export class DurableOfflineShadowScheduler {
  readonly #store: DurableShadowStateStore;
  readonly #flags: OfflineShadowFlags;
  readonly #limits: ShadowSchedulerLimits;
  readonly #now: () => string;

  constructor(input: Readonly<{
    store: DurableShadowStateStore;
    flags: OfflineShadowFlags;
    limits: ShadowSchedulerLimits;
    now?: () => string;
  }>) {
    this.#store = input.store;
    this.#flags = input.flags;
    this.#limits = this.#validateLimits(input.limits);
    this.#now = input.now ?? (() => new Date().toISOString());
  }

  async schedule(envelopeInput: unknown, command: CommandInput): Promise<DurableShadowJob> {
    this.#requireEnabled();
    const envelope = this.#validateEnvelope(envelopeInput);
    this.#assertCommand(command);
    let result!: DurableShadowJob;
    await this.#store.update((current) => {
      this.#assertOperational(current);
      const commandSha = canonicalSha256({ action: "schedule", envelope_sha256: envelope.envelope_sha256, ...command });
      const replay = this.#commandReplay(current, command.idempotency_key, commandSha);
      if (replay) {
        result = projectJob(current.jobs[replay]);
        return current;
      }
      if (Object.keys(current.jobs).length >= this.#limits.max_jobs) throw new Error("SHADOW_JOB_LIMIT_EXCEEDED");
      if (current.jobs[envelope.run_id]) throw new Error("SHADOW_RUN_ID_ALREADY_EXISTS");
      const now = this.#now();
      const job = sealShadowJob({
        run_id: envelope.run_id,
        envelope,
        state: "scheduled",
        revision: 1,
        attempt: 0,
        available_at: envelope.scheduled_for,
        lease_owner: null,
        lease_expires_at: null,
        fencing_token: 0,
        recovery_count: 0,
        result_sha256: null,
        comparison_sha256: null,
        disagreement_id: null,
        safe_error_code: null,
        created_at: now,
        updated_at: now,
        automatic_customer_promotion: false,
        automatic_production_promotion: false,
      });
      result = job;
      return this.#next(current, {
        jobs: { ...current.jobs, [job.run_id]: job },
        idempotency: { ...current.idempotency, [command.idempotency_key]: { command_sha256: commandSha, run_id: job.run_id } },
      }, this.#event(current, "scheduled", job, command.correlation_id));
    });
    return result;
  }

  async enqueue(input: Readonly<{ run_id: string; expected_revision: number }> & CommandInput) {
    return await this.#transition(input, "enqueued", ["scheduled"], "queued");
  }

  async cancel(input: Readonly<{ run_id: string; expected_revision: number }> & CommandInput) {
    return await this.#transition(input, "cancelled", ["scheduled", "queued", "leased", "running", "failed"], "cancelled");
  }

  async retry(input: Readonly<{ run_id: string; expected_revision: number; available_at: string }> & CommandInput) {
    this.#requireEnabled();
    this.#assertCommand(input);
    let result!: DurableShadowJob;
    await this.#store.update((current) => {
      this.#assertOperational(current);
      const job = this.#requiredJob(current, input.run_id);
      const commandSha = canonicalSha256({ action: "retry", ...input });
      const replay = this.#commandReplay(current, input.idempotency_key, commandSha);
      if (replay) {
        result = projectJob(current.jobs[replay]);
        return current;
      }
      if (job.revision !== input.expected_revision) throw new Error("SHADOW_REVISION_CONFLICT");
      if (job.state !== "failed") throw new Error("SHADOW_STATE_TRANSITION_FORBIDDEN");
      if (job.attempt >= this.#limits.max_attempts) throw new Error("SHADOW_RETRY_LIMIT_EXCEEDED");
      if (!Number.isFinite(Date.parse(input.available_at))) throw new Error("SHADOW_AVAILABLE_AT_INVALID");
      const nextJob = sealShadowJob({ ...this.#withoutHash(job), state: "queued", revision: job.revision + 1, available_at: input.available_at, safe_error_code: null, updated_at: this.#now() });
      result = nextJob;
      return this.#next(current, {
        jobs: { ...current.jobs, [job.run_id]: nextJob },
        idempotency: { ...current.idempotency, [input.idempotency_key]: { command_sha256: commandSha, run_id: job.run_id } },
      }, this.#event(current, "retried", nextJob, input.correlation_id));
    });
    return result;
  }

  async lease(input: Readonly<{ worker_id: string; now: string; lease_ms: number; limit: number; correlation_id: string }>): Promise<readonly ShadowLease[]> {
    this.#requireEnabled();
    assertId(input.worker_id, "SHADOW_WORKER_ID_INVALID");
    assertId(input.correlation_id, "SHADOW_CORRELATION_ID_INVALID");
    const nowMs = Date.parse(input.now);
    if (!Number.isFinite(nowMs) || !Number.isSafeInteger(input.lease_ms) || input.lease_ms < 100 || input.lease_ms > this.#limits.max_lease_ms
      || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > this.#limits.max_concurrent_leases) throw new Error("SHADOW_LEASE_ARGUMENT_INVALID");
    const leases: ShadowLease[] = [];
    await this.#store.update((current) => {
      this.#assertOperational(current);
      const active = Object.values(current.jobs).filter((job) => job.state === "leased" || job.state === "running").length;
      const capacity = Math.min(input.limit, this.#limits.max_concurrent_leases - active);
      if (capacity <= 0) return current;
      const candidates = Object.values(current.jobs)
        .filter((job) => job.state === "queued" && Date.parse(job.available_at) <= nowMs && job.attempt < this.#limits.max_attempts)
        .sort((left, right) => left.available_at.localeCompare(right.available_at) || left.run_id.localeCompare(right.run_id, "en"))
        .slice(0, capacity);
      if (candidates.length === 0) return current;
      let next = current;
      const jobs = { ...current.jobs };
      const events: ShadowSchedulerAuditEvent[] = [];
      for (const job of candidates) {
        const nextJob = sealShadowJob({
          ...this.#withoutHash(job),
          state: "leased",
          revision: job.revision + 1,
          attempt: job.attempt + 1,
          lease_owner: input.worker_id,
          lease_expires_at: new Date(nowMs + input.lease_ms).toISOString(),
          fencing_token: job.fencing_token + 1,
          updated_at: input.now,
        });
        jobs[job.run_id] = nextJob;
        leases.push(Object.freeze({
          run_id: job.run_id,
          worker_id: input.worker_id,
          fencing_token: nextJob.fencing_token,
          attempt: nextJob.attempt,
          lease_expires_at: nextJob.lease_expires_at!,
          envelope_sha256: nextJob.envelope.envelope_sha256,
        }));
        events.push(this.#event({ ...current, audit: [...current.audit, ...events] } as ShadowSchedulerSnapshot, "leased", nextJob, input.correlation_id));
      }
      next = this.#next(current, { jobs }, events);
      return next;
    });
    return Object.freeze(leases);
  }

  async start(lease: ShadowLease, correlationId: string) {
    return await this.#leaseTransition(lease, correlationId, "leased", "running", "started", {});
  }

  async complete(lease: ShadowLease, input: Readonly<{
    correlation_id: string;
    result_sha256: string;
    comparison_sha256: string;
    disagreement_id: string | null;
    monetary_output_count: 0;
    finding_count: 0;
    customer_report_count: 0;
    automatic_customer_promotion: false;
    automatic_production_promotion: false;
  }>) {
    assertSha(input.result_sha256, "SHADOW_RESULT_HASH_INVALID");
    assertSha(input.comparison_sha256, "SHADOW_COMPARISON_HASH_INVALID");
    if (input.disagreement_id !== null) assertId(input.disagreement_id, "SHADOW_DISAGREEMENT_ID_INVALID");
    if (input.monetary_output_count !== 0 || input.finding_count !== 0 || input.customer_report_count !== 0
      || input.automatic_customer_promotion || input.automatic_production_promotion) throw new Error("SHADOW_PROHIBITED_OUTPUT_OR_PROMOTION");
    return await this.#leaseTransition(lease, input.correlation_id, "running", "completed", "completed", {
      result_sha256: input.result_sha256,
      comparison_sha256: input.comparison_sha256,
      disagreement_id: input.disagreement_id,
    });
  }

  async fail(lease: ShadowLease, input: Readonly<{ correlation_id: string; safe_error_code: string }>) {
    if (!/^[A-Z][A-Z0-9_]{2,95}$/u.test(input.safe_error_code)) throw new Error("SHADOW_SAFE_ERROR_CODE_INVALID");
    return await this.#leaseTransition(lease, input.correlation_id, ["leased", "running"], "failed", "failed", { safe_error_code: input.safe_error_code });
  }

  async pause(command: CommandInput) {
    return await this.#schedulerSwitch(command, true);
  }

  async resume(command: CommandInput) {
    return await this.#schedulerSwitch(command, false);
  }

  async engageKillSwitch(input: CommandInput & Readonly<{ reason_code: string }>) {
    this.#requireEnabled();
    this.#assertCommand(input);
    if (!/^[A-Z][A-Z0-9_]{2,95}$/u.test(input.reason_code)) throw new Error("SHADOW_KILL_SWITCH_REASON_INVALID");
    return await this.#store.update((current) => {
      if (current.kill_switch.engaged) return current;
      const jobs = Object.fromEntries(Object.entries(current.jobs).map(([runId, job]) => {
        if (["completed", "cancelled"].includes(job.state)) return [runId, job];
        return [runId, sealShadowJob({ ...this.#withoutHash(job), state: "cancelled", revision: job.revision + 1, lease_owner: null, lease_expires_at: null, fencing_token: job.fencing_token + 1, safe_error_code: "SHADOW_KILL_SWITCH_ENGAGED", updated_at: this.#now() })];
      }));
      const resourceSha = canonicalSha256({ jobs: Object.values(jobs).map((job) => job.job_sha256).sort(), reason_code: input.reason_code });
      const event = this.#controlEvent(current, "kill_switch_engaged", resourceSha, input.correlation_id);
      return this.#next(current, { jobs, kill_switch: { engaged: true, revision: current.kill_switch.revision + 1, reason_code: input.reason_code } }, event);
    });
  }

  async releaseKillSwitch(command: CommandInput) {
    this.#requireEnabled();
    this.#assertCommand(command);
    return await this.#store.update((current) => {
      if (!current.kill_switch.engaged) return current;
      const killSwitch = { engaged: false, revision: current.kill_switch.revision + 1, reason_code: null };
      return this.#next(current, { kill_switch: killSwitch }, this.#controlEvent(current, "kill_switch_released", canonicalSha256(killSwitch), command.correlation_id));
    });
  }

  async recoverExpiredLeases(input: Readonly<{ now: string; correlation_id: string }>) {
    const nowMs = Date.parse(input.now);
    assertId(input.correlation_id, "SHADOW_CORRELATION_ID_INVALID");
    if (!Number.isFinite(nowMs)) throw new Error("SHADOW_RECOVERY_TIME_INVALID");
    const recovered: DurableShadowJob[] = [];
    await this.#store.update((current) => {
      const jobs = { ...current.jobs };
      const events: ShadowSchedulerAuditEvent[] = [];
      for (const job of Object.values(current.jobs).sort((left, right) => left.run_id.localeCompare(right.run_id, "en"))) {
        if (!(job.state === "leased" || job.state === "running") || job.lease_expires_at === null || Date.parse(job.lease_expires_at) > nowMs) continue;
        const retryable = job.attempt < this.#limits.max_attempts && !current.kill_switch.engaged;
        const nextJob = sealShadowJob({
          ...this.#withoutHash(job),
          state: retryable ? "queued" : "failed",
          revision: job.revision + 1,
          available_at: input.now,
          lease_owner: null,
          lease_expires_at: null,
          fencing_token: job.fencing_token + 1,
          recovery_count: job.recovery_count + 1,
          safe_error_code: retryable ? null : "SHADOW_RESTART_RECOVERY_EXHAUSTED",
          updated_at: input.now,
        });
        jobs[job.run_id] = nextJob;
        recovered.push(nextJob);
        events.push(this.#event({ ...current, audit: [...current.audit, ...events] } as ShadowSchedulerSnapshot, "lease_recovered", nextJob, input.correlation_id));
      }
      return recovered.length === 0 ? current : this.#next(current, { jobs }, events);
    });
    return Object.freeze(recovered.map(projectJob));
  }

  async executeLease<T extends Readonly<{
    result_sha256: string;
    comparison_sha256: string;
    disagreement_id: string | null;
    monetary_output_count: 0;
    finding_count: 0;
    customer_report_count: 0;
    automatic_customer_promotion: false;
    automatic_production_promotion: false;
  }>>(lease: ShadowLease, correlationId: string, evaluator: (envelope: DurableShadowRunEnvelope) => Promise<T>) {
    const running = await this.start(lease, correlationId);
    this.#validateEnvelope(running.envelope);
    try {
      const result = await evaluator(running.envelope);
      return await this.complete(lease, { ...result, correlation_id: correlationId });
    } catch (error) {
      return await this.fail(lease, { correlation_id: correlationId, safe_error_code: safeErrorCode(error) });
    }
  }

  async get(runId: string) {
    return projectJob(this.#requiredJob(await this.#store.read(), runId));
  }

  async snapshot() {
    return await this.#store.read();
  }

  async #transition(input: Readonly<{ run_id: string; expected_revision: number }> & CommandInput, action: "enqueued" | "cancelled", allowed: readonly DurableShadowJob["state"][], target: DurableShadowJob["state"]) {
    this.#requireEnabled();
    this.#assertCommand(input);
    let result!: DurableShadowJob;
    await this.#store.update((current) => {
      if (action !== "cancelled") this.#assertOperational(current);
      const job = this.#requiredJob(current, input.run_id);
      const commandSha = canonicalSha256({ action, ...input });
      const replay = this.#commandReplay(current, input.idempotency_key, commandSha);
      if (replay) {
        result = projectJob(current.jobs[replay]);
        return current;
      }
      if (job.revision !== input.expected_revision) throw new Error("SHADOW_REVISION_CONFLICT");
      if (!allowed.includes(job.state)) throw new Error("SHADOW_STATE_TRANSITION_FORBIDDEN");
      if (target === "queued" && Object.values(current.jobs).filter((candidate) => candidate.state === "queued").length >= this.#limits.max_queued) throw new Error("SHADOW_QUEUE_LIMIT_EXCEEDED");
      const nextJob = sealShadowJob({ ...this.#withoutHash(job), state: target, revision: job.revision + 1, lease_owner: null, lease_expires_at: null, fencing_token: target === "cancelled" ? job.fencing_token + 1 : job.fencing_token, updated_at: this.#now() });
      result = nextJob;
      return this.#next(current, {
        jobs: { ...current.jobs, [job.run_id]: nextJob },
        idempotency: { ...current.idempotency, [input.idempotency_key]: { command_sha256: commandSha, run_id: job.run_id } },
      }, this.#event(current, action, nextJob, input.correlation_id));
    });
    return result;
  }

  async #leaseTransition(lease: ShadowLease, correlationId: string, allowed: DurableShadowJob["state"] | readonly DurableShadowJob["state"][], target: DurableShadowJob["state"], action: "started" | "completed" | "failed", fields: Partial<Omit<DurableShadowJob, "run_id" | "envelope" | "job_sha256">>) {
    this.#requireEnabled();
    assertId(correlationId, "SHADOW_CORRELATION_ID_INVALID");
    let result!: DurableShadowJob;
    await this.#store.update((current) => {
      if (action === "started") this.#assertOperational(current);
      const job = this.#requiredJob(current, lease.run_id);
      const states = Array.isArray(allowed) ? allowed : [allowed];
      if (!states.includes(job.state) || job.lease_owner !== lease.worker_id || job.fencing_token !== lease.fencing_token
        || job.attempt !== lease.attempt || job.envelope.envelope_sha256 !== lease.envelope_sha256
        || job.lease_expires_at === null || Date.parse(job.lease_expires_at) <= Date.parse(this.#now())) throw new Error("SHADOW_LEASE_FENCED");
      const nextJob = sealShadowJob({ ...this.#withoutHash(job), ...fields, state: target, revision: job.revision + 1, lease_owner: target === "completed" || target === "failed" ? null : job.lease_owner, lease_expires_at: target === "completed" || target === "failed" ? null : job.lease_expires_at, updated_at: this.#now() });
      result = nextJob;
      return this.#next(current, { jobs: { ...current.jobs, [job.run_id]: nextJob } }, this.#event(current, action, nextJob, correlationId));
    });
    return result;
  }

  async #schedulerSwitch(command: CommandInput, paused: boolean) {
    this.#requireEnabled();
    this.#assertCommand(command);
    return await this.#store.update((current) => {
      if (current.scheduler_paused === paused) return current;
      const action = paused ? "scheduler_paused" as const : "scheduler_resumed" as const;
      const resourceSha = canonicalSha256({ scheduler_paused: paused, revision: current.snapshot_revision + 1 });
      return this.#next(current, { scheduler_paused: paused }, this.#controlEvent(current, action, resourceSha, command.correlation_id));
    });
  }

  #next(current: ShadowSchedulerSnapshot, changes: Partial<Omit<ShadowSchedulerSnapshot, "schema_version" | "snapshot_revision" | "previous_snapshot_sha256" | "snapshot_sha256" | "audit">>, event: ShadowSchedulerAuditEvent | readonly ShadowSchedulerAuditEvent[]) {
    return sealSnapshot({
      schema_version: "tivdoc-durable-shadow-scheduler-state-v0.10.0",
      snapshot_revision: current.snapshot_revision + 1,
      previous_snapshot_sha256: current.snapshot_sha256,
      scheduler_paused: changes.scheduler_paused ?? current.scheduler_paused,
      kill_switch: changes.kill_switch ?? current.kill_switch,
      jobs: changes.jobs ?? current.jobs,
      idempotency: changes.idempotency ?? current.idempotency,
      audit: [...current.audit, ...(Array.isArray(event) ? event : [event])],
    });
  }

  #event(current: ShadowSchedulerSnapshot, action: ShadowSchedulerAuditEvent["action"], job: DurableShadowJob, correlationId: string): ShadowSchedulerAuditEvent {
    return this.#makeEvent(current.audit, action, job.run_id, job.revision, job.job_sha256, correlationId, this.#now());
  }

  #controlEvent(current: ShadowSchedulerSnapshot, action: ShadowSchedulerAuditEvent["action"], resourceSha: string, correlationId: string): ShadowSchedulerAuditEvent {
    return this.#makeEvent(current.audit, action, null, current.snapshot_revision + 1, resourceSha, correlationId, this.#now());
  }

  #makeEvent(priorEvents: readonly ShadowSchedulerAuditEvent[], action: ShadowSchedulerAuditEvent["action"], runId: string | null, revision: number, resourceSha: string, correlationId: string, occurredAt: string) {
    assertId(correlationId, "SHADOW_CORRELATION_ID_INVALID");
    const content = {
      sequence: priorEvents.length + 1,
      action,
      run_id: runId,
      resource_revision: revision,
      resource_sha256: resourceSha,
      correlation_id: correlationId,
      mode: "offline_synthetic_only" as const,
      occurred_at: occurredAt,
      previous_event_sha256: priorEvents.at(-1)?.event_sha256 ?? null,
    };
    return deepFreeze({ ...content, event_sha256: canonicalSha256(content) }) as ShadowSchedulerAuditEvent;
  }

  #validateEnvelope(input: unknown): DurableShadowRunEnvelope {
    try {
      const envelope = durableShadowRunEnvelopeSchema.parse(input);
      if (envelope.dataset_pin.byte_count > this.#limits.max_dataset_bytes) throw new Error("SHADOW_DATASET_SIZE_LIMIT_EXCEEDED");
      return envelope;
    } catch (error) {
      const candidate = input as { execution_mode?: unknown; customer_input_allowed?: unknown; dataset_pin?: { customer_material?: unknown }; source_state_pin?: { active_real_source_count?: unknown; selected_real_source_count?: unknown }; parameter_state_pin?: { active_real_parameter_count?: unknown }; rule_state_pin?: { active_real_rule_count?: unknown } };
      if (candidate.customer_input_allowed === true || candidate.dataset_pin?.customer_material === true) throw new Error("SHADOW_CUSTOMER_INPUT_FORBIDDEN");
      if (candidate.execution_mode !== "offline_synthetic_only"
        || Number(candidate.source_state_pin?.active_real_source_count ?? 0) > 0
        || Number(candidate.source_state_pin?.selected_real_source_count ?? 0) > 0
        || Number(candidate.parameter_state_pin?.active_real_parameter_count ?? 0) > 0
        || Number(candidate.rule_state_pin?.active_real_rule_count ?? 0) > 0) throw new Error("SHADOW_REAL_CORPUS_PRECALCULATION_BLOCKED");
      throw error;
    }
  }

  #validateLimits(limits: ShadowSchedulerLimits) {
    if (!Number.isSafeInteger(limits.max_jobs) || limits.max_jobs < 1 || limits.max_jobs > 10_000
      || !Number.isSafeInteger(limits.max_queued) || limits.max_queued < 1 || limits.max_queued > limits.max_jobs
      || !Number.isSafeInteger(limits.max_concurrent_leases) || limits.max_concurrent_leases < 1 || limits.max_concurrent_leases > 100
      || !Number.isSafeInteger(limits.max_attempts) || limits.max_attempts < 1 || limits.max_attempts > 10
      || !Number.isSafeInteger(limits.max_dataset_bytes) || limits.max_dataset_bytes < 1
      || !Number.isSafeInteger(limits.max_lease_ms) || limits.max_lease_ms < 100 || limits.max_lease_ms > 3_600_000) throw new Error("SHADOW_SCHEDULER_LIMITS_INVALID");
    return Object.freeze({ ...limits });
  }

  #assertCommand(command: CommandInput) {
    assertId(command.idempotency_key, "SHADOW_IDEMPOTENCY_KEY_INVALID");
    assertId(command.correlation_id, "SHADOW_CORRELATION_ID_INVALID");
  }

  #commandReplay(current: ShadowSchedulerSnapshot, key: string, commandSha: string) {
    const record = current.idempotency[key];
    if (!record) return null;
    if (record.command_sha256 !== commandSha) throw new Error("SHADOW_IDEMPOTENCY_CONFLICT");
    return record.run_id;
  }

  #requiredJob(current: ShadowSchedulerSnapshot, runId: string) {
    const job = current.jobs[runId];
    if (!job) throw new Error("SHADOW_RUN_NOT_FOUND");
    return job;
  }

  #withoutHash(job: DurableShadowJob): Omit<DurableShadowJob, "job_sha256"> {
    const { job_sha256, ...content } = job;
    void job_sha256;
    return content;
  }

  #requireEnabled() {
    if (!this.#flags.enabled || !this.#flags.synthetic_enabled) throw new Error("SHADOW_OFFLINE_SYNTHETIC_DISABLED");
    if (this.#flags.public_enabled) throw new Error("SHADOW_PUBLIC_MODE_FORBIDDEN_FOR_DURABLE_SYNTHETIC_SCHEDULER");
  }

  #assertOperational(current: ShadowSchedulerSnapshot) {
    if (current.kill_switch.engaged) throw new Error("SHADOW_KILL_SWITCH_ENGAGED");
    if (current.scheduler_paused) throw new Error("SHADOW_SCHEDULER_PAUSED");
  }
}
