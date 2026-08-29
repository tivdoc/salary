import { createHash } from "node:crypto";

export type SyntheticActor = Readonly<{
  actor_id: string;
  tenant_id: string;
  permitted_case_ids: readonly string[];
}>;

export type SyntheticRecordKind =
  | "analysis_run"
  | "conversation"
  | "message"
  | "document"
  | "extraction"
  | "hypothesis"
  | "finding"
  | "confirmation"
  | "job";

export type SyntheticPersistenceRecord = Readonly<{
  id: string;
  kind: SyntheticRecordKind;
  tenant_id: string;
  case_id: string;
  idempotency_key: string;
  payload: Readonly<Record<string, string | number | boolean | null>>;
  version: number;
}>;

export class SyntheticPersistenceConflict extends Error {}
export class SyntheticCaseAccessDenied extends Error {}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(record: SyntheticPersistenceRecord) {
  return createHash("sha256")
    .update(canonical({
      kind: record.kind,
      tenant_id: record.tenant_id,
      case_id: record.case_id,
      idempotency_key: record.idempotency_key,
      payload: record.payload,
    }))
    .digest("hex");
}

/**
 * Deterministic model probe only. It is not a PostgreSQL or Supabase emulator and
 * cannot establish that the migration executes successfully.
 */
export class SyntheticPersistenceStore {
  private records = new Map<string, SyntheticPersistenceRecord>();
  private idempotency = new Map<string, string>();

  private authorize(actor: SyntheticActor, tenantId: string, caseId: string) {
    if (actor.tenant_id !== tenantId || !actor.permitted_case_ids.includes(caseId)) {
      throw new SyntheticCaseAccessDenied("synthetic_case_access_denied");
    }
  }

  insert(actor: SyntheticActor, record: Omit<SyntheticPersistenceRecord, "version">) {
    this.authorize(actor, record.tenant_id, record.case_id);
    const scopedKey = `${record.tenant_id}:${record.case_id}:${record.kind}:${record.idempotency_key}`;
    const next: SyntheticPersistenceRecord = { ...record, version: 1 };
    const existingId = this.idempotency.get(scopedKey);
    if (existingId !== undefined) {
      const existing = this.records.get(existingId)!;
      if (fingerprint(existing) !== fingerprint(next)) {
        throw new SyntheticPersistenceConflict("synthetic_idempotency_conflict");
      }
      return existing;
    }
    if (this.records.has(record.id)) throw new SyntheticPersistenceConflict("synthetic_primary_key_conflict");
    this.records.set(record.id, next);
    this.idempotency.set(scopedKey, record.id);
    return next;
  }

  read(actor: SyntheticActor, id: string) {
    const record = this.records.get(id);
    if (record === undefined) return null;
    this.authorize(actor, record.tenant_id, record.case_id);
    return record;
  }

  update(
    actor: SyntheticActor,
    id: string,
    expectedVersion: number,
    payload: SyntheticPersistenceRecord["payload"],
  ) {
    const current = this.read(actor, id);
    if (current === null) throw new SyntheticPersistenceConflict("synthetic_record_missing");
    if (current.version !== expectedVersion) {
      throw new SyntheticPersistenceConflict("synthetic_optimistic_write_conflict");
    }
    const next = { ...current, payload, version: current.version + 1 };
    this.records.set(id, next);
    return next;
  }

  transaction<T>(operation: (store: SyntheticPersistenceStore) => T): T {
    const recordsBefore = new Map(this.records);
    const idempotencyBefore = new Map(this.idempotency);
    try {
      return operation(this);
    } catch (error) {
      this.records = recordsBefore;
      this.idempotency = idempotencyBefore;
      throw error;
    }
  }

  size() {
    return this.records.size;
  }
}
