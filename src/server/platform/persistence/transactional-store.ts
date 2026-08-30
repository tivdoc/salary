import { canonicalSha256, clone } from "./canonical";
import type { AtomicCommand, DurableRecord, TransactionReceipt } from "./contracts";
import { PlatformPersistenceError } from "./contracts";

export const TRANSACTION_FAILURE_STAGES = [
  "after_idempotency_reservation",
  "after_domain_mutation",
  "after_audit_append",
  "after_outbox_append",
] as const;
export type TransactionFailureStage = (typeof TRANSACTION_FAILURE_STAGES)[number];

export type PlatformAuditEvent = Readonly<{
  sequence: number;
  tenant_id: string;
  case_id: string;
  actor_id: string;
  action: string;
  case_revision: number;
  command_sha256: string;
  previous_sha256: string | null;
  occurred_at: string;
  event_sha256: string;
}>;

export type OutboxEvent = Readonly<{
  outbox_id: string;
  tenant_id: string;
  case_id: string;
  logical_effect_id: string;
  effect_kind: string;
  payload_sha256: string;
  payload: unknown;
  status: "pending" | "leased" | "published";
  fencing_token: number;
  lease_owner: string | null;
  lease_expires_at_ms: number | null;
  logical_effect_sha256: string | null;
  created_at: string;
}>;

type StoredIdempotency = Readonly<{ command_sha256: string; receipt: TransactionReceipt }>;
export type PlatformStoreSnapshot = Readonly<{
  schema_version: "tivdoc-local-durable-platform-snapshot-v0.7.0";
  case_revisions: readonly (readonly [string, number])[];
  records: readonly (readonly [string, readonly DurableRecord[]])[];
  idempotency: readonly (readonly [string, StoredIdempotency])[];
  audit: readonly PlatformAuditEvent[];
  outbox: readonly OutboxEvent[];
  logical_effects: readonly (readonly [string, string])[];
}>;

type MutableState = {
  case_revisions: Map<string, number>;
  records: Map<string, DurableRecord[]>;
  idempotency: Map<string, StoredIdempotency>;
  audit: PlatformAuditEvent[];
  outbox: Map<string, OutboxEvent>;
  logical_effects: Map<string, string>;
};

class SerialGate {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T> | T): Promise<T> {
    const prior = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export class LocalDurablePlatformStore {
  private state: MutableState;
  private readonly gate = new SerialGate();

  constructor(snapshot?: PlatformStoreSnapshot) {
    this.state = snapshot ? hydrate(snapshot) : emptyState();
  }

  async execute(command: AtomicCommand, failureAfter: TransactionFailureStage | null = null): Promise<TransactionReceipt> {
    return this.gate.run(() => {
      if (canonicalSha256(command.command) !== command.command_sha256) {
        throw new PlatformPersistenceError("PAYLOAD_HASH_MISMATCH", "command");
      }
      const idempotencyId = `${command.tenant_id}:${command.scope}:${command.idempotency_key}`;
      const prior = this.state.idempotency.get(idempotencyId);
      if (prior) {
        if (prior.command_sha256 !== command.command_sha256) {
          throw new PlatformPersistenceError("IDEMPOTENCY_KEY_COMMAND_MISMATCH");
        }
        return clone({ ...prior.receipt, idempotent_replay: true });
      }
      const currentCaseRevision = this.state.case_revisions.get(command.case_id) ?? 0;
      if (currentCaseRevision !== command.expected_case_revision) {
        throw new PlatformPersistenceError("CASE_REVISION_CONFLICT", `${currentCaseRevision}`);
      }

      const draft = cloneState(this.state);
      draft.idempotency.set(idempotencyId, {
        command_sha256: command.command_sha256,
        receipt: pendingReceipt(command),
      });
      failIf(failureAfter, "after_idempotency_reservation");

      for (const write of command.writes) {
        if (canonicalSha256(write.payload) !== write.payload_sha256) {
          throw new PlatformPersistenceError("PAYLOAD_HASH_MISMATCH", write.record_id);
        }
        const key = recordKey(write.entity, write.record_id);
        const versions = draft.records.get(key) ?? [];
        const currentRevision = versions.at(-1)?.revision ?? 0;
        if (currentRevision !== write.expected_revision) {
          throw new PlatformPersistenceError("ENTITY_REVISION_CONFLICT", `${write.entity}:${write.record_id}:${currentRevision}`);
        }
        versions.push(Object.freeze({
          entity: write.entity,
          tenant_id: command.tenant_id,
          case_id: command.case_id,
          record_id: write.record_id,
          revision: currentRevision + 1,
          payload_sha256: write.payload_sha256,
          payload: clone(write.payload),
          visible: write.visible ?? true,
          created_at: command.occurred_at,
        }));
        draft.records.set(key, versions);
      }
      for (const invalidation of command.invalidates) this.invalidateRecord(draft, command, invalidation);
      const nextCaseRevision = currentCaseRevision + 1;
      draft.case_revisions.set(command.case_id, nextCaseRevision);
      failIf(failureAfter, "after_domain_mutation");

      const previousSha = draft.audit.at(-1)?.event_sha256 ?? null;
      const unsignedAudit = {
        sequence: draft.audit.length + 1,
        tenant_id: command.tenant_id,
        case_id: command.case_id,
        actor_id: command.actor_id,
        action: command.scope,
        case_revision: nextCaseRevision,
        command_sha256: command.command_sha256,
        previous_sha256: previousSha,
        occurred_at: command.occurred_at,
      };
      const audit: PlatformAuditEvent = Object.freeze({ ...unsignedAudit, event_sha256: canonicalSha256(unsignedAudit) });
      draft.audit.push(audit);
      failIf(failureAfter, "after_audit_append");

      const outboxIds: string[] = [];
      for (const effect of command.outbox) {
        if (canonicalSha256(effect.payload) !== effect.payload_sha256) {
          throw new PlatformPersistenceError("PAYLOAD_HASH_MISMATCH", effect.logical_effect_id);
        }
        const outboxId = `outbox:${canonicalSha256({ case_id: command.case_id, command_sha256: command.command_sha256, logical_effect_id: effect.logical_effect_id })}`;
        if (draft.outbox.has(outboxId)) throw new PlatformPersistenceError("IMMUTABLE_VERSION_MISMATCH", outboxId);
        draft.outbox.set(outboxId, Object.freeze({
          outbox_id: outboxId,
          tenant_id: command.tenant_id,
          case_id: command.case_id,
          logical_effect_id: effect.logical_effect_id,
          effect_kind: effect.effect_kind,
          payload_sha256: effect.payload_sha256,
          payload: clone(effect.payload),
          status: "pending",
          fencing_token: 0,
          lease_owner: null,
          lease_expires_at_ms: null,
          logical_effect_sha256: null,
          created_at: command.occurred_at,
        }));
        outboxIds.push(outboxId);
      }
      failIf(failureAfter, "after_outbox_append");

      const receipt: TransactionReceipt = Object.freeze({
        tenant_id: command.tenant_id,
        case_id: command.case_id,
        case_revision: nextCaseRevision,
        command_sha256: command.command_sha256,
        audit_event_sha256: audit.event_sha256,
        outbox_ids: Object.freeze(outboxIds),
        idempotent_replay: false,
      });
      draft.idempotency.set(idempotencyId, { command_sha256: command.command_sha256, receipt });
      this.state = draft;
      return clone(receipt);
    });
  }

  async claimOutbox(workerId: string, nowMs: number, leaseMs: number): Promise<OutboxEvent | null> {
    return this.gate.run(() => {
      const candidate = [...this.state.outbox.values()]
        .filter((event) => event.status === "pending" || (event.status === "leased" && (event.lease_expires_at_ms ?? Infinity) <= nowMs))
        .sort((a, b) => a.outbox_id.localeCompare(b.outbox_id))[0];
      if (!candidate) return null;
      const claimed: OutboxEvent = Object.freeze({
        ...candidate,
        status: "leased",
        fencing_token: candidate.fencing_token + 1,
        lease_owner: workerId,
        lease_expires_at_ms: nowMs + leaseMs,
      });
      this.state.outbox.set(candidate.outbox_id, claimed);
      return clone(claimed);
    });
  }

  async publishOutbox(input: Readonly<{ outbox_id: string; worker_id: string; fencing_token: number; logical_effect_sha256: string }>): Promise<Readonly<{ deduplicated: boolean }>> {
    return this.gate.run(() => {
      const current = this.state.outbox.get(input.outbox_id);
      if (!current) throw new PlatformPersistenceError("RECORD_NOT_FOUND", input.outbox_id);
      if (current.status !== "leased" || current.lease_owner !== input.worker_id || current.fencing_token !== input.fencing_token) {
        throw new PlatformPersistenceError("STALE_FENCING_TOKEN", input.outbox_id);
      }
      const priorEffect = this.state.logical_effects.get(current.logical_effect_id);
      if (priorEffect && priorEffect !== input.logical_effect_sha256) {
        throw new PlatformPersistenceError("LOGICAL_EFFECT_MISMATCH", current.logical_effect_id);
      }
      this.state.logical_effects.set(current.logical_effect_id, input.logical_effect_sha256);
      this.state.outbox.set(input.outbox_id, Object.freeze({
        ...current,
        status: "published",
        lease_owner: null,
        lease_expires_at_ms: null,
        logical_effect_sha256: input.logical_effect_sha256,
      }));
      return Object.freeze({ deduplicated: priorEffect === input.logical_effect_sha256 });
    });
  }

  current(entity: DurableRecord["entity"], recordId: string): DurableRecord | null {
    return clone(this.state.records.get(recordKey(entity, recordId))?.at(-1) ?? null);
  }

  history(entity: DurableRecord["entity"], recordId: string): readonly DurableRecord[] {
    return clone(this.state.records.get(recordKey(entity, recordId)) ?? []);
  }

  caseRevision(caseId: string): number {
    return this.state.case_revisions.get(caseId) ?? 0;
  }

  auditEvents(): readonly PlatformAuditEvent[] {
    return clone(this.state.audit);
  }

  outboxEvents(): readonly OutboxEvent[] {
    return clone([...this.state.outbox.values()].sort((a, b) => a.outbox_id.localeCompare(b.outbox_id)));
  }

  assertPinnedVersionsAvailable(versionHashes: readonly string[]): void {
    const available = new Set([...this.state.records.values()].flat().map((record) => record.payload_sha256));
    const missing = versionHashes.find((hash) => !available.has(hash));
    if (missing) throw new PlatformPersistenceError("PINNED_VERSION_UNAVAILABLE", missing);
  }

  snapshot(): PlatformStoreSnapshot {
    return clone({
      schema_version: "tivdoc-local-durable-platform-snapshot-v0.7.0",
      case_revisions: [...this.state.case_revisions.entries()],
      records: [...this.state.records.entries()],
      idempotency: [...this.state.idempotency.entries()],
      audit: this.state.audit,
      outbox: [...this.state.outbox.values()],
      logical_effects: [...this.state.logical_effects.entries()],
    });
  }

  private invalidateRecord(draft: MutableState, command: AtomicCommand, invalidation: AtomicCommand["invalidates"][number]): void {
    const key = recordKey(invalidation.entity, invalidation.record_id);
    const versions = draft.records.get(key);
    if (!versions) throw new PlatformPersistenceError("RECORD_NOT_FOUND", invalidation.record_id);
    const current = versions.at(-1)!;
    if (current.revision !== invalidation.expected_revision) {
      throw new PlatformPersistenceError("ENTITY_REVISION_CONFLICT", `${invalidation.entity}:${invalidation.record_id}:${current.revision}`);
    }
    versions.push(Object.freeze({ ...current, revision: current.revision + 1, visible: false, created_at: command.occurred_at }));
    draft.records.set(key, versions);
  }
}

function pendingReceipt(command: AtomicCommand): TransactionReceipt {
  return {
    tenant_id: command.tenant_id,
    case_id: command.case_id,
    case_revision: command.expected_case_revision,
    command_sha256: command.command_sha256,
    audit_event_sha256: "0".repeat(64),
    outbox_ids: [],
    idempotent_replay: false,
  };
}

function failIf(actual: TransactionFailureStage | null, expected: TransactionFailureStage): void {
  if (actual === expected) throw new PlatformPersistenceError("INJECTED_FAILURE", expected);
}

function recordKey(entity: DurableRecord["entity"], recordId: string): string {
  return `${entity}:${recordId}`;
}

function emptyState(): MutableState {
  return { case_revisions: new Map(), records: new Map(), idempotency: new Map(), audit: [], outbox: new Map(), logical_effects: new Map() };
}

function cloneState(state: MutableState): MutableState {
  return {
    case_revisions: clone(state.case_revisions),
    records: clone(state.records),
    idempotency: clone(state.idempotency),
    audit: clone(state.audit),
    outbox: clone(state.outbox),
    logical_effects: clone(state.logical_effects),
  };
}

function hydrate(snapshot: PlatformStoreSnapshot): MutableState {
  if (snapshot.schema_version !== "tivdoc-local-durable-platform-snapshot-v0.7.0") throw new TypeError("SNAPSHOT_SCHEMA_MISMATCH");
  return {
    case_revisions: new Map(clone(snapshot.case_revisions)),
    records: new Map(clone(snapshot.records).map(([key, values]) => [key, [...values]])),
    idempotency: new Map(clone(snapshot.idempotency)),
    audit: [...clone(snapshot.audit)],
    outbox: new Map(clone(snapshot.outbox).map((event) => [event.outbox_id, event])),
    logical_effects: new Map(clone(snapshot.logical_effects)),
  };
}
