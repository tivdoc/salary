import { bytesSha256, canonicalSha256, clone } from "./canonical";
import { PlatformPersistenceError } from "./contracts";

export type ObjectSagaState = "reserved" | "staged" | "verified" | "finalized" | "quarantined";
export type ObjectFailureStage = "after_reserve" | "after_stage" | "after_verify" | "after_finalize";

export type ObjectSagaRecord = Readonly<{
  reservation_id: string;
  tenant_id: string;
  case_id: string;
  opaque_key: string;
  expected_sha256: string;
  expected_length: number;
  detected_mime: string;
  retention_class: string;
  state: ObjectSagaState;
  revision: number;
  staged_sha256: string | null;
  staged_length: number | null;
  object_version_id: string | null;
  finalized_outbox_id: string | null;
  visible: boolean;
}>;

export type ObjectSagaSnapshot = Readonly<{
  schema_version: "tivdoc-local-object-saga-snapshot-v0.7.0";
  records: readonly ObjectSagaRecord[];
  bytes_by_sha256: readonly (readonly [string, Uint8Array])[];
}>;

export class LocalObjectWriteSaga {
  private readonly records = new Map<string, ObjectSagaRecord>();
  private readonly bytesBySha = new Map<string, Uint8Array>();

  constructor(snapshot?: ObjectSagaSnapshot) {
    if (!snapshot) return;
    if (snapshot.schema_version !== "tivdoc-local-object-saga-snapshot-v0.7.0") throw new TypeError("OBJECT_SNAPSHOT_SCHEMA_MISMATCH");
    for (const record of clone(snapshot.records)) this.records.set(record.reservation_id, record);
    for (const [sha, bytes] of clone(snapshot.bytes_by_sha256)) this.bytesBySha.set(sha, bytes);
  }

  reserve(input: Readonly<{
    tenant_id: string;
    case_id: string;
    expected_sha256: string;
    expected_length: number;
    detected_mime: string;
    retention_class: string;
  }>, failureAfter: ObjectFailureStage | null = null): ObjectSagaRecord {
    if (!/^[0-9a-f]{64}$/.test(input.expected_sha256) || !Number.isSafeInteger(input.expected_length) || input.expected_length < 0) {
      throw new PlatformPersistenceError("OBJECT_STAGE_INVALID", "reservation_input");
    }
    const reservationId = `reservation:${canonicalSha256(input)}`;
    const prior = this.records.get(reservationId);
    if (prior) return clone(prior);
    const record: ObjectSagaRecord = Object.freeze({
      ...input,
      reservation_id: reservationId,
      opaque_key: `sha256/${input.expected_sha256.slice(0, 2)}/${input.expected_sha256}`,
      state: "reserved",
      revision: 1,
      staged_sha256: null,
      staged_length: null,
      object_version_id: null,
      finalized_outbox_id: null,
      visible: false,
    });
    this.records.set(reservationId, record);
    failIf(failureAfter, "after_reserve");
    return clone(record);
  }

  async stage(reservationId: string, chunks: AsyncIterable<Uint8Array>, failureAfter: ObjectFailureStage | null = null): Promise<ObjectSagaRecord> {
    const current = this.required(reservationId);
    if (current.state !== "reserved") throw new PlatformPersistenceError("OBJECT_STAGE_INVALID", `${current.state}:stage`);
    const collected: Uint8Array[] = [];
    let length = 0;
    for await (const chunk of chunks) {
      const copied = Uint8Array.from(chunk);
      collected.push(copied);
      length += copied.byteLength;
      if (length > current.expected_length) throw new PlatformPersistenceError("OBJECT_STAGE_INVALID", "length_exceeded");
    }
    const bytes = Buffer.concat(collected.map((chunk) => Buffer.from(chunk)));
    const stagedSha = bytesSha256(bytes);
    this.bytesBySha.set(stagedSha, Uint8Array.from(bytes));
    const staged = this.update(current, { state: "staged", staged_sha256: stagedSha, staged_length: length });
    failIf(failureAfter, "after_stage");
    return clone(staged);
  }

  verify(reservationId: string, failureAfter: ObjectFailureStage | null = null): ObjectSagaRecord {
    const current = this.required(reservationId);
    if (current.state !== "staged") throw new PlatformPersistenceError("OBJECT_STAGE_INVALID", `${current.state}:verify`);
    if (current.staged_sha256 !== current.expected_sha256 || current.staged_length !== current.expected_length) {
      throw new PlatformPersistenceError("OBJECT_STAGE_INVALID", "checksum_or_length_mismatch");
    }
    const verified = this.update(current, { state: "verified" });
    failIf(failureAfter, "after_verify");
    return clone(verified);
  }

  finalize(reservationId: string, failureAfter: ObjectFailureStage | null = null): ObjectSagaRecord {
    const current = this.required(reservationId);
    if (current.state !== "verified") throw new PlatformPersistenceError("OBJECT_STAGE_INVALID", `${current.state}:finalize`);
    const objectVersionId = `object-version:${canonicalSha256({ reservation_id: reservationId, sha256: current.expected_sha256 })}`;
    const outboxId = `outbox:${canonicalSha256({ effect: "object_finalized", object_version_id: objectVersionId })}`;
    const finalized = Object.freeze({
      ...current,
      state: "finalized" as const,
      revision: current.revision + 1,
      object_version_id: objectVersionId,
      finalized_outbox_id: outboxId,
      visible: true,
    });
    failIf(failureAfter, "after_finalize");
    this.records.set(reservationId, finalized);
    return clone(finalized);
  }

  quarantine(reservationId: string): ObjectSagaRecord {
    const current = this.required(reservationId);
    if (current.state === "finalized") throw new PlatformPersistenceError("OBJECT_STAGE_INVALID", "finalized:quarantine");
    return clone(this.update(current, { state: "quarantined", visible: false }));
  }

  visibleObject(objectVersionId: string): Readonly<{ metadata: ObjectSagaRecord; bytes: Uint8Array }> | null {
    const record = [...this.records.values()].find((candidate) => candidate.object_version_id === objectVersionId && candidate.visible);
    if (!record || !record.staged_sha256) return null;
    return clone({ metadata: record, bytes: this.bytesBySha.get(record.staged_sha256)! });
  }

  record(reservationId: string): ObjectSagaRecord | null { return clone(this.records.get(reservationId) ?? null); }

  snapshot(): ObjectSagaSnapshot {
    return clone({ schema_version: "tivdoc-local-object-saga-snapshot-v0.7.0", records: [...this.records.values()], bytes_by_sha256: [...this.bytesBySha.entries()] });
  }

  private update(current: ObjectSagaRecord, changes: Partial<ObjectSagaRecord>): ObjectSagaRecord {
    const updated = Object.freeze({ ...current, ...changes, revision: current.revision + 1 });
    this.records.set(current.reservation_id, updated);
    return updated;
  }

  private required(reservationId: string): ObjectSagaRecord {
    const record = this.records.get(reservationId);
    if (!record) throw new PlatformPersistenceError("RECORD_NOT_FOUND", reservationId);
    return record;
  }
}

function failIf(actual: ObjectFailureStage | null, expected: ObjectFailureStage): void {
  if (actual === expected) throw new PlatformPersistenceError("INJECTED_FAILURE", expected);
}
