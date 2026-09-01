import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalSha256, canonicalStringify, deepFreeze } from "../../../engine/rule-runtime/canonical.ts";
import {
  validateShadowJob,
  type ShadowSchedulerAuditEvent,
  type ShadowSchedulerSnapshot,
} from "./durable-contracts.ts";

export interface DurableShadowStateStore {
  read(): Promise<ShadowSchedulerSnapshot>;
  update(transform: (current: ShadowSchedulerSnapshot) => ShadowSchedulerSnapshot): Promise<ShadowSchedulerSnapshot>;
}

function stableBytes(value: unknown) {
  return `${canonicalStringify(value)}\n`;
}

function emptySnapshot(): ShadowSchedulerSnapshot {
  return sealSnapshot({
    schema_version: "tivdoc-durable-shadow-scheduler-state-v0.10.0",
    snapshot_revision: 0,
    previous_snapshot_sha256: null,
    scheduler_paused: false,
    kill_switch: { engaged: false, revision: 0, reason_code: null },
    jobs: {},
    idempotency: {},
    audit: [],
  });
}

export function sealSnapshot(input: Omit<ShadowSchedulerSnapshot, "snapshot_sha256">): ShadowSchedulerSnapshot {
  return deepFreeze({ ...input, snapshot_sha256: canonicalSha256(input) }) as ShadowSchedulerSnapshot;
}

export function verifySchedulerAuditChain(events: readonly ShadowSchedulerAuditEvent[]) {
  const expectedKeys = ["action", "correlation_id", "event_sha256", "mode", "occurred_at", "previous_event_sha256", "resource_revision", "resource_sha256", "run_id", "sequence"];
  const actions = new Set(["scheduled", "enqueued", "leased", "started", "completed", "failed", "retried", "cancelled", "scheduler_paused", "scheduler_resumed", "kill_switch_engaged", "kill_switch_released", "lease_recovered"]);
  for (const [index, event] of events.entries()) {
    if (!event || typeof event !== "object") throw new Error("SHADOW_AUDIT_CHAIN_INVALID");
    const { event_sha256: expected, ...content } = event;
    if (Object.keys(event).sort().join("|") !== expectedKeys.join("|")
      || event.sequence !== index + 1
      || event.previous_event_sha256 !== (events[index - 1]?.event_sha256 ?? null)
      || !actions.has(event.action) || event.mode !== "offline_synthetic_only"
      || !Number.isSafeInteger(event.resource_revision) || event.resource_revision < 1
      || !/^[a-f0-9]{64}$/u.test(event.resource_sha256)
      || !/^[a-z][a-z0-9:._-]{2,159}$/u.test(event.correlation_id)
      || (event.run_id !== null && !/^[a-z][a-z0-9:._-]{2,159}$/u.test(event.run_id))
      || !Number.isFinite(Date.parse(event.occurred_at))
      || (event.previous_event_sha256 !== null && !/^[a-f0-9]{64}$/u.test(event.previous_event_sha256))
      || !/^[a-f0-9]{64}$/u.test(expected)
      || canonicalSha256(content) !== expected) throw new Error("SHADOW_AUDIT_CHAIN_INVALID");
  }
  return Object.freeze({ valid: true as const, event_count: events.length, tail_sha256: events.at(-1)?.event_sha256 ?? null });
}

export function validateShadowSchedulerSnapshot(input: unknown): ShadowSchedulerSnapshot {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("SHADOW_SNAPSHOT_INVALID");
  const value = input as ShadowSchedulerSnapshot;
  const expectedKeys = ["audit", "idempotency", "jobs", "kill_switch", "previous_snapshot_sha256", "scheduler_paused", "schema_version", "snapshot_revision", "snapshot_sha256"];
  if (Object.keys(value).sort().join("|") !== expectedKeys.join("|")
    || value.schema_version !== "tivdoc-durable-shadow-scheduler-state-v0.10.0"
    || !Number.isSafeInteger(value.snapshot_revision) || value.snapshot_revision < 0
    || (value.previous_snapshot_sha256 !== null && !/^[a-f0-9]{64}$/u.test(value.previous_snapshot_sha256))
    || typeof value.scheduler_paused !== "boolean"
    || !value.kill_switch || typeof value.kill_switch !== "object"
    || Object.keys(value.kill_switch).sort().join("|") !== "engaged|reason_code|revision"
    || typeof value.kill_switch.engaged !== "boolean"
    || !Number.isSafeInteger(value.kill_switch.revision) || value.kill_switch.revision < 0
    || (value.kill_switch.reason_code !== null && !/^[A-Z][A-Z0-9_]{2,95}$/u.test(value.kill_switch.reason_code))
    || value.kill_switch.engaged !== (value.kill_switch.reason_code !== null)
    || !value.jobs || !value.idempotency || !Array.isArray(value.audit)) throw new Error("SHADOW_SNAPSHOT_INVALID");
  const { snapshot_sha256: expected, ...content } = value;
  if (!/^[a-f0-9]{64}$/u.test(expected) || canonicalSha256(content) !== expected) throw new Error("SHADOW_SNAPSHOT_HASH_MISMATCH");
  for (const [runId, job] of Object.entries(value.jobs)) {
    if (runId !== job.run_id) throw new Error("SHADOW_JOB_KEY_MISMATCH");
    validateShadowJob(job);
  }
  for (const [key, record] of Object.entries(value.idempotency)) {
    if (!/^[a-z][a-z0-9:._-]{2,159}$/u.test(key) || !record || typeof record !== "object"
      || Object.keys(record).sort().join("|") !== "command_sha256|run_id"
      || !/^[a-f0-9]{64}$/u.test(record.command_sha256) || !value.jobs[record.run_id]) throw new Error("SHADOW_IDEMPOTENCY_RECORD_INVALID");
  }
  verifySchedulerAuditChain(value.audit);
  return deepFreeze(value) as ShadowSchedulerSnapshot;
}

function ensureChild(rootValue: string, candidateValue: string) {
  const root = path.resolve(rootValue);
  const candidate = path.resolve(candidateValue);
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("SHADOW_STATE_PATH_ESCAPE");
  return candidate;
}

async function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class LocalFileDurableShadowStateStore implements DurableShadowStateStore {
  readonly #root: string;
  readonly #states: string;
  readonly #lock: string;

  constructor(input: Readonly<{ root: string; root_kind: "generated_offline_synthetic_state" }>) {
    if (input.root_kind !== "generated_offline_synthetic_state" || !path.isAbsolute(input.root)) throw new Error("SHADOW_STATE_ROOT_NOT_OWNED");
    this.#root = path.resolve(input.root);
    this.#states = ensureChild(this.#root, path.join(this.#root, "states"));
    this.#lock = ensureChild(this.#root, path.join(this.#root, ".writer-lock"));
  }

  async read(): Promise<ShadowSchedulerSnapshot> {
    await mkdir(this.#states, { recursive: true });
    const names = (await readdir(this.#states)).filter((name) => /^\d{8}-[a-f0-9]{64}\.json$/u.test(name)).sort();
    if (names.length === 0) return emptySnapshot();
    const seenRevisions = new Set<number>();
    let prior: ShadowSchedulerSnapshot | null = null;
    for (const name of names) {
      const target = ensureChild(this.#states, path.join(this.#states, name));
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("SHADOW_STATE_FILE_INVALID");
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(target, "utf8"));
      } catch {
        throw new Error("SHADOW_STATE_FILE_TRUNCATED");
      }
      const current = validateShadowSchedulerSnapshot(parsed);
      const filenameRevision = Number(name.slice(0, 8));
      const filenameSha = name.slice(9, 73);
      if (current.snapshot_revision !== filenameRevision || current.snapshot_sha256 !== filenameSha || seenRevisions.has(filenameRevision)) {
        throw new Error("SHADOW_STATE_HISTORY_DIVERGED");
      }
      if (prior && (current.snapshot_revision !== prior.snapshot_revision + 1 || current.previous_snapshot_sha256 !== prior.snapshot_sha256)) {
        throw new Error("SHADOW_STATE_HISTORY_CHAIN_INVALID");
      }
      if (!prior && current.snapshot_revision !== 1) throw new Error("SHADOW_STATE_HISTORY_INITIAL_REVISION_INVALID");
      seenRevisions.add(filenameRevision);
      prior = current;
    }
    return prior!;
  }

  async update(transform: (current: ShadowSchedulerSnapshot) => ShadowSchedulerSnapshot): Promise<ShadowSchedulerSnapshot> {
    return await this.#withWriterLock(async () => {
      const current = await this.read();
      const candidate = validateShadowSchedulerSnapshot(transform(current));
      if (candidate.snapshot_sha256 === current.snapshot_sha256) return current;
      if (candidate.snapshot_revision !== current.snapshot_revision + 1 || candidate.previous_snapshot_sha256 !== current.snapshot_sha256) {
        throw new Error("SHADOW_STATE_REVISION_CONFLICT");
      }
      const target = ensureChild(this.#states, path.join(this.#states, `${String(candidate.snapshot_revision).padStart(8, "0")}-${candidate.snapshot_sha256}.json`));
      const temporary = ensureChild(this.#states, `${target}.pending-${randomUUID()}`);
      const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try {
        await handle.writeFile(stableBytes(candidate));
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await link(temporary, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        throw new Error("SHADOW_STATE_REVISION_CONFLICT");
      } finally {
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
      return candidate;
    });
  }

  async #withWriterLock<T>(action: () => Promise<T>): Promise<T> {
    await mkdir(this.#root, { recursive: true });
    const token = randomUUID();
    const owner = ensureChild(this.#lock, path.join(this.#lock, "owner.json"));
    const started = Date.now();
    while (true) {
      try {
        await mkdir(this.#lock);
        await writeFile(owner, stableBytes({ pid: process.pid, token }), { flag: "wx", mode: 0o600 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let stale = false;
        try {
          const parsed = JSON.parse(await readFile(owner, "utf8")) as { pid?: unknown };
          const lockInfo = await stat(this.#lock);
          stale = typeof parsed.pid === "number"
            ? !(await processAlive(parsed.pid))
            : Date.now() - lockInfo.mtimeMs > 10_000;
        } catch {
          const lockInfo = await stat(this.#lock);
          stale = Date.now() - lockInfo.mtimeMs > 10_000;
        }
        if (stale) {
          const staleTarget = ensureChild(this.#root, path.join(this.#root, `.writer-lock.stale-${randomUUID()}`));
          try {
            await rename(this.#lock, staleTarget);
            await rm(staleTarget, { recursive: true, force: true });
          } catch (takeoverError) {
            if ((takeoverError as NodeJS.ErrnoException).code !== "ENOENT") throw takeoverError;
          }
          continue;
        }
        if (Date.now() - started > 5_000) throw new Error("SHADOW_STATE_WRITER_LOCK_TIMEOUT");
        await delay(10);
      }
    }
    try {
      return await action();
    } finally {
      try {
        const parsed = JSON.parse(await readFile(owner, "utf8")) as { token?: unknown };
        if (parsed.token === token) await rm(this.#lock, { recursive: true, force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}
