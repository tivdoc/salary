import { canonicalSha256, clone } from "../persistence/canonical";
import { PlatformPersistenceError } from "../persistence/contracts";

export type DurableJobState = "queued" | "leased" | "running" | "succeeded" | "retry_wait" | "cancelled" | "dead_letter";

export type DurableJob = Readonly<{
  job_id: string;
  tenant_id: string;
  case_id: string | null;
  job_kind: string;
  idempotency_key: string;
  payload_sha256: string;
  payload: unknown;
  pinned_version_sha256s: readonly string[];
  state: DurableJobState;
  revision: number;
  attempt_count: number;
  max_attempts: number;
  available_at_ms: number;
  lease_owner: string | null;
  lease_expires_at_ms: number | null;
  fencing_token: number;
  cancellation_requested: boolean;
  terminal_effect_sha256: string | null;
  replayed_from_job_id: string | null;
}>;

export type JobHistoryEvent = Readonly<{
  sequence: number;
  job_id: string;
  from: DurableJobState | null;
  to: DurableJobState;
  revision: number;
  fencing_token: number;
  occurred_at_ms: number;
  reason_code: string;
  previous_sha256: string | null;
  event_sha256: string;
}>;

export type JobQueueSnapshot = Readonly<{
  schema_version: "tivdoc-local-durable-job-snapshot-v0.7.0";
  jobs: readonly DurableJob[];
  idempotency: readonly (readonly [string, readonly [string, string]])[];
  history: readonly JobHistoryEvent[];
  logical_effects: readonly (readonly [string, string])[];
}>;

class Gate {
  private tail = Promise.resolve();
  async run<T>(work: () => T | Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await work(); } finally { release(); }
  }
}

export class LocalDurableJobQueue {
  private readonly gate = new Gate();
  private readonly jobs = new Map<string, DurableJob>();
  private readonly idempotency = new Map<string, readonly [string, string]>();
  private readonly history: JobHistoryEvent[] = [];
  private readonly logicalEffects = new Map<string, string>();

  constructor(snapshot?: JobQueueSnapshot) {
    if (!snapshot) return;
    if (snapshot.schema_version !== "tivdoc-local-durable-job-snapshot-v0.7.0") throw new TypeError("JOB_SNAPSHOT_SCHEMA_MISMATCH");
    for (const job of clone(snapshot.jobs)) this.jobs.set(job.job_id, job);
    for (const [key, value] of clone(snapshot.idempotency)) this.idempotency.set(key, value);
    this.history.push(...clone(snapshot.history));
    for (const [key, value] of clone(snapshot.logical_effects)) this.logicalEffects.set(key, value);
  }

  async enqueue(input: Readonly<{
    job_id: string;
    tenant_id: string;
    case_id: string | null;
    job_kind: string;
    idempotency_key: string;
    payload_sha256: string;
    payload: unknown;
    pinned_version_sha256s: readonly string[];
    max_attempts: number;
    available_at_ms: number;
  }>): Promise<DurableJob> {
    return this.gate.run(() => {
      if (canonicalSha256(input.payload) !== input.payload_sha256) throw new PlatformPersistenceError("PAYLOAD_HASH_MISMATCH", input.job_id);
      const key = `${input.tenant_id}:${input.job_kind}:${input.idempotency_key}`;
      const prior = this.idempotency.get(key);
      if (prior) {
        if (prior[1] !== input.payload_sha256) throw new PlatformPersistenceError("IDEMPOTENCY_KEY_COMMAND_MISMATCH", key);
        return clone(this.jobs.get(prior[0])!);
      }
      if (this.jobs.has(input.job_id)) throw new PlatformPersistenceError("IMMUTABLE_VERSION_MISMATCH", input.job_id);
      if (!Number.isInteger(input.max_attempts) || input.max_attempts < 1) throw new RangeError("JOB_MAX_ATTEMPTS_INVALID");
      const job: DurableJob = Object.freeze({
        ...clone(input),
        state: "queued",
        revision: 1,
        attempt_count: 0,
        lease_owner: null,
        lease_expires_at_ms: null,
        fencing_token: 0,
        cancellation_requested: false,
        terminal_effect_sha256: null,
        replayed_from_job_id: null,
      });
      this.jobs.set(job.job_id, job);
      this.idempotency.set(key, [job.job_id, job.payload_sha256]);
      this.appendHistory(job, null, "queued", input.available_at_ms, "enqueued");
      return clone(job);
    });
  }

  async claim(workerId: string, nowMs: number, leaseMs: number, limit = 1): Promise<readonly DurableJob[]> {
    return this.gate.run(() => {
      if (limit < 1 || leaseMs < 1) throw new RangeError("JOB_CLAIM_ARGUMENT_INVALID");
      for (const job of [...this.jobs.values()]) {
        if ((job.state === "leased" || job.state === "running") && (job.lease_expires_at_ms ?? Infinity) <= nowMs && job.attempt_count >= job.max_attempts) {
          this.transition(job, "dead_letter", nowMs, "expired_attempts_exhausted", { lease_owner: null, lease_expires_at_ms: null });
        }
      }
      const candidates = [...this.jobs.values()]
        .filter((job) => canClaim(job, nowMs))
        .sort((a, b) => a.available_at_ms - b.available_at_ms || a.job_id.localeCompare(b.job_id))
        .slice(0, limit);
      return candidates.map((job) => {
        const claimed = this.transition(job, "leased", nowMs, job.state === "leased" || job.state === "running" ? "lease_expired_reclaimed" : "claimed", {
          lease_owner: workerId,
          lease_expires_at_ms: nowMs + leaseMs,
          fencing_token: job.fencing_token + 1,
          attempt_count: job.attempt_count + 1,
          cancellation_requested: false,
        });
        return clone(claimed);
      });
    });
  }

  async start(jobId: string, workerId: string, token: number, nowMs: number): Promise<DurableJob> {
    return this.withLease(jobId, workerId, token, nowMs, (job) => this.transition(job, "running", nowMs, "started"));
  }

  async heartbeat(jobId: string, workerId: string, token: number, nowMs: number, leaseMs: number): Promise<DurableJob> {
    return this.withLease(jobId, workerId, token, nowMs, (job) => {
      if (job.state !== "leased" && job.state !== "running") throw new PlatformPersistenceError("INVALID_STATE_TRANSITION", `${job.state}:heartbeat`);
      const updated = Object.freeze({ ...job, revision: job.revision + 1, lease_expires_at_ms: nowMs + leaseMs });
      this.jobs.set(jobId, updated);
      this.appendHistory(updated, job.state, job.state, nowMs, "heartbeat");
      return updated;
    });
  }

  async succeed(jobId: string, workerId: string, token: number, nowMs: number, logicalEffectSha256: string): Promise<DurableJob> {
    return this.withLease(jobId, workerId, token, nowMs, (job) => {
      if (job.state !== "running") throw new PlatformPersistenceError("INVALID_STATE_TRANSITION", `${job.state}:succeeded`);
      const effectId = `${job.job_kind}:${job.idempotency_key}`;
      const prior = this.logicalEffects.get(effectId);
      if (prior && prior !== logicalEffectSha256) throw new PlatformPersistenceError("LOGICAL_EFFECT_MISMATCH", effectId);
      this.logicalEffects.set(effectId, logicalEffectSha256);
      return this.transition(job, "succeeded", nowMs, prior ? "logical_effect_deduplicated" : "logical_effect_committed", {
        terminal_effect_sha256: logicalEffectSha256,
        lease_owner: null,
        lease_expires_at_ms: null,
      });
    });
  }

  async fail(jobId: string, workerId: string, token: number, nowMs: number, retryDelayMs: number): Promise<DurableJob> {
    return this.withLease(jobId, workerId, token, nowMs, (job) => {
      if (job.state !== "running") throw new PlatformPersistenceError("INVALID_STATE_TRANSITION", `${job.state}:fail`);
      const dead = job.attempt_count >= job.max_attempts;
      return this.transition(job, dead ? "dead_letter" : "retry_wait", nowMs, dead ? "attempts_exhausted" : "retry_scheduled", {
        available_at_ms: nowMs + retryDelayMs,
        lease_owner: null,
        lease_expires_at_ms: null,
      });
    });
  }

  async cancel(jobId: string, nowMs: number): Promise<DurableJob> {
    return this.gate.run(() => {
      const job = this.required(jobId);
      if (["succeeded", "cancelled", "dead_letter"].includes(job.state)) throw new PlatformPersistenceError("INVALID_STATE_TRANSITION", `${job.state}:cancelled`);
      return clone(this.transition(job, "cancelled", nowMs, "cancelled", { cancellation_requested: true, lease_owner: null, lease_expires_at_ms: null }));
    });
  }

  async replayDeadLetter(jobId: string, newJobId: string, idempotencyKey: string, nowMs: number): Promise<DurableJob> {
    return this.gate.run(() => {
      const original = this.required(jobId);
      if (original.state !== "dead_letter") throw new PlatformPersistenceError("INVALID_STATE_TRANSITION", `${original.state}:replay`);
      if (this.jobs.has(newJobId)) throw new PlatformPersistenceError("IMMUTABLE_VERSION_MISMATCH", newJobId);
      const key = `${original.tenant_id}:${original.job_kind}:${idempotencyKey}`;
      if (this.idempotency.has(key)) throw new PlatformPersistenceError("IDEMPOTENCY_KEY_COMMAND_MISMATCH", key);
      const replay: DurableJob = Object.freeze({
        ...original,
        job_id: newJobId,
        idempotency_key: idempotencyKey,
        state: "queued",
        revision: 1,
        attempt_count: 0,
        available_at_ms: nowMs,
        lease_owner: null,
        lease_expires_at_ms: null,
        fencing_token: 0,
        cancellation_requested: false,
        terminal_effect_sha256: null,
        replayed_from_job_id: original.job_id,
      });
      this.jobs.set(newJobId, replay);
      this.idempotency.set(key, [newJobId, replay.payload_sha256]);
      this.appendHistory(replay, null, "queued", nowMs, "dead_letter_replayed");
      return clone(replay);
    });
  }

  get(jobId: string): DurableJob | null { return clone(this.jobs.get(jobId) ?? null); }
  events(jobId?: string): readonly JobHistoryEvent[] { return clone(jobId ? this.history.filter((event) => event.job_id === jobId) : this.history); }
  countByState(state: DurableJobState): number { return [...this.jobs.values()].filter((job) => job.state === state).length; }

  snapshot(): JobQueueSnapshot {
    return clone({
      schema_version: "tivdoc-local-durable-job-snapshot-v0.7.0",
      jobs: [...this.jobs.values()],
      idempotency: [...this.idempotency.entries()],
      history: this.history,
      logical_effects: [...this.logicalEffects.entries()],
    });
  }

  private async withLease(jobId: string, workerId: string, token: number, nowMs: number, operation: (job: DurableJob) => DurableJob): Promise<DurableJob> {
    return this.gate.run(() => {
      const job = this.required(jobId);
      if (job.lease_owner !== workerId || job.fencing_token !== token) throw new PlatformPersistenceError("STALE_FENCING_TOKEN", jobId);
      if ((job.lease_expires_at_ms ?? -Infinity) <= nowMs) throw new PlatformPersistenceError("STALE_FENCING_TOKEN", `${jobId}:lease_expired`);
      return clone(operation(job));
    });
  }

  private transition(job: DurableJob, to: DurableJobState, nowMs: number, reason: string, changes: Partial<DurableJob> = {}): DurableJob {
    if (!allowed(job.state, to)) throw new PlatformPersistenceError("INVALID_STATE_TRANSITION", `${job.state}:${to}`);
    const updated: DurableJob = Object.freeze({ ...job, ...changes, state: to, revision: job.revision + 1 });
    this.jobs.set(job.job_id, updated);
    this.appendHistory(updated, job.state, to, nowMs, reason);
    return updated;
  }

  private appendHistory(job: DurableJob, from: DurableJobState | null, to: DurableJobState, occurredAtMs: number, reasonCode: string): void {
    const previous = this.history.at(-1)?.event_sha256 ?? null;
    const unsigned = { sequence: this.history.length + 1, job_id: job.job_id, from, to, revision: job.revision, fencing_token: job.fencing_token, occurred_at_ms: occurredAtMs, reason_code: reasonCode, previous_sha256: previous };
    this.history.push(Object.freeze({ ...unsigned, event_sha256: canonicalSha256(unsigned) }));
  }

  private required(jobId: string): DurableJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new PlatformPersistenceError("RECORD_NOT_FOUND", jobId);
    return job;
  }
}

function canClaim(job: DurableJob, nowMs: number): boolean {
  if (job.attempt_count >= job.max_attempts) return false;
  if ((job.state === "queued" || job.state === "retry_wait") && job.available_at_ms <= nowMs) return true;
  return (job.state === "leased" || job.state === "running") && (job.lease_expires_at_ms ?? Infinity) <= nowMs;
}

function allowed(from: DurableJobState, to: DurableJobState): boolean {
  const graph: Readonly<Record<DurableJobState, readonly DurableJobState[]>> = {
    queued: ["leased", "cancelled"],
    leased: ["leased", "running", "cancelled", "dead_letter"],
    running: ["leased", "running", "succeeded", "retry_wait", "cancelled", "dead_letter"],
    retry_wait: ["leased", "cancelled"],
    succeeded: [],
    cancelled: [],
    dead_letter: [],
  };
  return graph[from].includes(to);
}
