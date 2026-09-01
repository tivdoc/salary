import { createHash, randomUUID } from "node:crypto";

import { canonicalSha256, deepFreeze } from "../../../engine/rule-runtime/canonical.ts";

const SHA256 = /^[a-f0-9]{64}$/;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9:._-]{2,159}$/;

export type CustodyDestinationClass = "local_synthetic" | "managed_off_host";

export type ReplicationEnvelope = Readonly<{
  schema_version: "tivdoc-custody-replication-envelope-v0.10.0";
  replication_id: string;
  idempotency_key: string;
  source_store_id: string;
  source_object_id: string;
  source_receipt_sha256: string;
  object_sha256: string;
  byte_count: number;
  retention_class: string;
  key_version: string;
  created_at: string;
  envelope_sha256: string;
}>;

export type CustodyDestinationReceipt = Readonly<{
  schema_version: "tivdoc-custody-destination-receipt-v0.10.0";
  destination_id: string;
  destination_class: CustodyDestinationClass;
  destination_locator: string;
  envelope_sha256: string;
  object_sha256: string;
  byte_count: number;
  stored_at: string;
  receipt_sha256: string;
}>;

export interface CustodySourcePort {
  readonly source_store_id: string;
  readExact(input: Readonly<{ object_id: string; expected_sha256: string; expected_length: number }>): Promise<Uint8Array>;
}

export interface CustodyDestinationPort {
  readonly destination_id: string;
  readonly destination_class: CustodyDestinationClass;
  putImmutable(input: Readonly<{ envelope: ReplicationEnvelope; bytes: Uint8Array; stored_at: string }>): Promise<CustodyDestinationReceipt>;
  readExact(input: Readonly<{ destination_locator: string; expected_sha256: string; expected_length: number }>): Promise<Uint8Array>;
  accessLog(): Promise<readonly CustodyAccessLogEntry[]>;
}

export type CustodyAccessLogEntry = Readonly<{
  destination_id: string;
  destination_locator: string;
  operation: "put" | "read";
  occurred_at: string;
  object_sha256: string;
  access_sha256: string;
}>;

export type ReplicationJob = Readonly<{
  replication_id: string;
  envelope: ReplicationEnvelope;
  destination_id: string;
  revision: number;
  state: "queued" | "leased" | "retry_wait" | "completed" | "diverged" | "cancelled";
  attempt_count: number;
  next_attempt_at: string;
  lease_token: string | null;
  lease_expires_at: string | null;
  receipt: CustodyDestinationReceipt | null;
  error_code: string | null;
  job_sha256: string;
}>;

export type ReplicationOutboxSnapshot = Readonly<{
  schema_version: "tivdoc-custody-replication-outbox-snapshot-v0.10.0";
  jobs: readonly ReplicationJob[];
  idempotency: readonly (readonly [string, string])[];
  snapshot_sha256: string;
}>;

type MutableJob = Omit<ReplicationJob, "job_sha256">;

export class CustodyReplicationOutbox {
  readonly #runtime: "test" | "development";
  readonly #idFactory: () => string;
  readonly #jobs = new Map<string, ReplicationJob>();
  readonly #idempotency = new Map<string, string>();

  constructor(input: Readonly<{
    runtime: "test" | "development";
    id_factory?: () => string;
    snapshot?: ReplicationOutboxSnapshot;
  }>) {
    this.#runtime = input.runtime;
    if (input.id_factory && input.runtime !== "test") throw new Error("CUSTODY_DETERMINISTIC_ID_FACTORY_TEST_ONLY");
    this.#idFactory = input.id_factory ?? randomUUID;
    if (input.snapshot) this.#restore(input.snapshot);
  }

  enqueue(input: Readonly<{
    replication_id: string;
    idempotency_key: string;
    source_store_id: string;
    source_object_id: string;
    source_receipt_sha256: string;
    object_sha256: string;
    byte_count: number;
    retention_class: string;
    key_version: string;
    destination_id: string;
    created_at: string;
  }>): ReplicationJob {
    validateOpaque(input.replication_id, "CUSTODY_REPLICATION_ID_INVALID");
    validateOpaque(input.idempotency_key, "CUSTODY_IDEMPOTENCY_KEY_INVALID");
    validateOpaque(input.source_store_id, "CUSTODY_SOURCE_STORE_INVALID");
    validateOpaque(input.source_object_id, "CUSTODY_SOURCE_OBJECT_INVALID");
    validateOpaque(input.destination_id, "CUSTODY_DESTINATION_INVALID");
    validateOpaque(input.retention_class, "CUSTODY_RETENTION_CLASS_INVALID");
    validateOpaque(input.key_version, "CUSTODY_KEY_VERSION_INVALID");
    assertSha(input.source_receipt_sha256);
    assertSha(input.object_sha256);
    assertLength(input.byte_count);
    assertTime(input.created_at);
    const commandSha = canonicalSha256(input);
    const replay = this.#idempotency.get(input.idempotency_key);
    if (replay) {
      if (replay !== commandSha) throw new Error("CUSTODY_IDEMPOTENCY_CONFLICT");
      const job = this.#jobs.get(input.replication_id);
      if (!job) throw new Error("CUSTODY_SNAPSHOT_CORRUPT");
      return job;
    }
    if (this.#jobs.has(input.replication_id)) throw new Error("CUSTODY_REPLICATION_ID_COLLISION");
    const envelopeUnsigned = {
      schema_version: "tivdoc-custody-replication-envelope-v0.10.0" as const,
      replication_id: input.replication_id,
      idempotency_key: input.idempotency_key,
      source_store_id: input.source_store_id,
      source_object_id: input.source_object_id,
      source_receipt_sha256: input.source_receipt_sha256,
      object_sha256: input.object_sha256,
      byte_count: input.byte_count,
      retention_class: input.retention_class,
      key_version: input.key_version,
      created_at: normalizeTime(input.created_at),
    };
    const envelope = deepFreeze({ ...envelopeUnsigned, envelope_sha256: canonicalSha256(envelopeUnsigned) });
    const job = sealJob({
      replication_id: input.replication_id,
      envelope,
      destination_id: input.destination_id,
      revision: 1,
      state: "queued",
      attempt_count: 0,
      next_attempt_at: envelope.created_at,
      lease_token: null,
      lease_expires_at: null,
      receipt: null,
      error_code: null,
    });
    this.#jobs.set(job.replication_id, job);
    this.#idempotency.set(input.idempotency_key, commandSha);
    return job;
  }

  claim(input: Readonly<{ destination: CustodyDestinationPort; now: string; lease_seconds: number }>): ReplicationJob | null {
    this.#assertDestinationAllowed(input.destination);
    assertTime(input.now);
    if (!Number.isSafeInteger(input.lease_seconds) || input.lease_seconds < 1 || input.lease_seconds > 3_600) throw new Error("CUSTODY_LEASE_DURATION_INVALID");
    const now = normalizeTime(input.now);
    const candidate = [...this.#jobs.values()]
      .filter((job) => job.destination_id === input.destination.destination_id
        && (job.state === "queued" || job.state === "retry_wait" || (job.state === "leased" && job.lease_expires_at! <= now))
        && job.next_attempt_at <= now)
      .sort((left, right) => compareStrings(`${left.next_attempt_at}\u0000${left.replication_id}`, `${right.next_attempt_at}\u0000${right.replication_id}`))[0];
    if (!candidate) return null;
    return this.#replace(candidate.replication_id, {
      ...candidate,
      revision: candidate.revision + 1,
      state: "leased",
      attempt_count: candidate.attempt_count + 1,
      lease_token: `custody-lease:${this.#idFactory()}`,
      lease_expires_at: new Date(Date.parse(now) + input.lease_seconds * 1_000).toISOString(),
      receipt: null,
      error_code: null,
    });
  }

  async execute(input: Readonly<{
    replication_id: string;
    lease_token: string;
    source: CustodySourcePort;
    destination: CustodyDestinationPort;
    completed_at: string;
  }>): Promise<ReplicationJob> {
    this.#assertDestinationAllowed(input.destination);
    assertTime(input.completed_at);
    const job = this.#leased(input.replication_id, input.lease_token, input.completed_at);
    if (job.envelope.source_store_id !== input.source.source_store_id || job.destination_id !== input.destination.destination_id) {
      throw new Error("CUSTODY_ADAPTER_BINDING_MISMATCH");
    }
    let bytes: Uint8Array;
    try {
      bytes = await input.source.readExact({
        object_id: job.envelope.source_object_id,
        expected_sha256: job.envelope.object_sha256,
        expected_length: job.envelope.byte_count,
      });
    } catch {
      return this.#diverge(job, "CUSTODY_SOURCE_INTEGRITY_FAILURE");
    }
    if (bytes.byteLength !== job.envelope.byte_count || hash(bytes) !== job.envelope.object_sha256) {
      return this.#diverge(job, "CUSTODY_SOURCE_INTEGRITY_FAILURE");
    }
    let receipt: CustodyDestinationReceipt;
    try {
      receipt = await input.destination.putImmutable({ envelope: job.envelope, bytes, stored_at: normalizeTime(input.completed_at) });
      verifyDestinationReceipt(receipt, job, input.destination);
      const reopened = await input.destination.readExact({
        destination_locator: receipt.destination_locator,
        expected_sha256: receipt.object_sha256,
        expected_length: receipt.byte_count,
      });
      if (reopened.byteLength !== receipt.byte_count || hash(reopened) !== receipt.object_sha256) throw new Error("CUSTODY_DESTINATION_REOPEN_MISMATCH");
    } catch {
      return this.#diverge(job, "CUSTODY_DESTINATION_DIVERGENCE");
    }
    return this.#replace(job.replication_id, {
      ...job,
      revision: job.revision + 1,
      state: "completed",
      lease_token: null,
      lease_expires_at: null,
      receipt,
      error_code: null,
    });
  }

  retry(input: Readonly<{ replication_id: string; lease_token: string; error_code: string; next_attempt_at: string; now: string }>): ReplicationJob {
    assertTime(input.now);
    assertTime(input.next_attempt_at);
    validateOpaque(input.error_code, "CUSTODY_RETRY_CODE_INVALID");
    const job = this.#leased(input.replication_id, input.lease_token, input.now);
    if (input.next_attempt_at <= input.now) throw new Error("CUSTODY_RETRY_TIME_INVALID");
    return this.#replace(job.replication_id, {
      ...job,
      revision: job.revision + 1,
      state: "retry_wait",
      next_attempt_at: normalizeTime(input.next_attempt_at),
      lease_token: null,
      lease_expires_at: null,
      error_code: input.error_code,
    });
  }

  cancel(replicationId: string, reasonCode: string): ReplicationJob {
    validateOpaque(reasonCode, "CUSTODY_CANCEL_REASON_INVALID");
    const job = this.#jobs.get(replicationId);
    if (!job || job.state === "completed" || job.state === "diverged") throw new Error("CUSTODY_CANCEL_STATE_INVALID");
    return this.#replace(job.replication_id, {
      ...job,
      revision: job.revision + 1,
      state: "cancelled",
      lease_token: null,
      lease_expires_at: null,
      error_code: reasonCode,
    });
  }

  get(replicationId: string): ReplicationJob | null {
    return this.#jobs.get(replicationId) ?? null;
  }

  snapshot(): ReplicationOutboxSnapshot {
    const unsigned = {
      schema_version: "tivdoc-custody-replication-outbox-snapshot-v0.10.0" as const,
      jobs: [...this.#jobs.values()].sort((left, right) => compareStrings(left.replication_id, right.replication_id)),
      idempotency: [...this.#idempotency.entries()].sort(([left], [right]) => compareStrings(left, right)),
    };
    return deepFreeze({ ...unsigned, snapshot_sha256: canonicalSha256(unsigned) });
  }

  #restore(snapshot: ReplicationOutboxSnapshot): void {
    const { snapshot_sha256: ignored, ...unsigned } = snapshot;
    void ignored;
    if (snapshot.schema_version !== "tivdoc-custody-replication-outbox-snapshot-v0.10.0"
        || snapshot.snapshot_sha256 !== canonicalSha256(unsigned)) throw new Error("CUSTODY_SNAPSHOT_INTEGRITY_FAILURE");
    for (const job of snapshot.jobs) {
      if (job.job_sha256 !== canonicalSha256(jobCore(job)) || this.#jobs.has(job.replication_id)) throw new Error("CUSTODY_SNAPSHOT_INTEGRITY_FAILURE");
      this.#jobs.set(job.replication_id, deepFreeze(structuredClone(job)));
    }
    for (const [key, value] of snapshot.idempotency) {
      if (this.#idempotency.has(key) || !OPAQUE.test(key) || !SHA256.test(value)) throw new Error("CUSTODY_SNAPSHOT_INTEGRITY_FAILURE");
      this.#idempotency.set(key, value);
    }
  }

  #leased(replicationId: string, leaseToken: string, now: string): ReplicationJob {
    const job = this.#jobs.get(replicationId);
    if (!job || job.state !== "leased" || job.lease_token !== leaseToken) throw new Error("CUSTODY_LEASE_FENCED");
    if (job.lease_expires_at! <= normalizeTime(now)) throw new Error("CUSTODY_LEASE_EXPIRED");
    return job;
  }

  #replace(replicationId: string, next: MutableJob): ReplicationJob {
    const current = this.#jobs.get(replicationId);
    if (!current || next.revision !== current.revision + 1) throw new Error("CUSTODY_REVISION_CONFLICT");
    const sealed = sealJob(next);
    this.#jobs.set(replicationId, sealed);
    return sealed;
  }

  #diverge(job: ReplicationJob, code: string): ReplicationJob {
    return this.#replace(job.replication_id, {
      ...job,
      revision: job.revision + 1,
      state: "diverged",
      lease_token: null,
      lease_expires_at: null,
      receipt: null,
      error_code: code,
    });
  }

  #assertDestinationAllowed(destination: CustodyDestinationPort): void {
    validateOpaque(destination.destination_id, "CUSTODY_DESTINATION_INVALID");
    if (this.#runtime !== "test" && destination.destination_class === "local_synthetic") {
      throw new Error("CUSTODY_SYNTHETIC_DESTINATION_TEST_ONLY");
    }
  }
}

export class LocalSyntheticCustodyStore implements CustodySourcePort, CustodyDestinationPort {
  readonly source_store_id: string;
  readonly destination_id: string;
  readonly destination_class = "local_synthetic" as const;
  readonly #objects = new Map<string, Uint8Array>();
  readonly #receipts = new Map<string, CustodyDestinationReceipt>();
  readonly #access: CustodyAccessLogEntry[] = [];

  constructor(storeId: string, seed: readonly Readonly<{ object_id: string; bytes: Uint8Array }>[] = []) {
    validateOpaque(storeId, "CUSTODY_STORE_ID_INVALID");
    this.source_store_id = storeId;
    this.destination_id = storeId;
    for (const entry of seed) {
      validateOpaque(entry.object_id, "CUSTODY_SOURCE_OBJECT_INVALID");
      this.#objects.set(entry.object_id, Uint8Array.from(entry.bytes));
    }
  }

  async readExact(input: Readonly<{ object_id?: string; destination_locator?: string; expected_sha256: string; expected_length: number }>): Promise<Uint8Array> {
    const locator = input.object_id ?? input.destination_locator;
    if (!locator) throw new Error("CUSTODY_LOCATOR_INVALID");
    const bytes = this.#objects.get(locator);
    if (!bytes || bytes.byteLength !== input.expected_length || hash(bytes) !== input.expected_sha256) throw new Error("CUSTODY_OBJECT_INTEGRITY_FAILURE");
    this.#recordAccess(locator, "read", input.expected_sha256, "2035-01-01T00:00:00.000Z");
    return Uint8Array.from(bytes);
  }

  async putImmutable(input: Readonly<{ envelope: ReplicationEnvelope; bytes: Uint8Array; stored_at: string }>): Promise<CustodyDestinationReceipt> {
    const locator = `replica:${input.envelope.replication_id}`;
    const existing = this.#objects.get(locator);
    if (existing && hash(existing) !== input.envelope.object_sha256) throw new Error("CUSTODY_IMMUTABLE_COLLISION");
    const prior = this.#receipts.get(locator);
    if (prior) return prior;
    if (input.bytes.byteLength !== input.envelope.byte_count || hash(input.bytes) !== input.envelope.object_sha256) throw new Error("CUSTODY_DESTINATION_INPUT_INVALID");
    this.#objects.set(locator, Uint8Array.from(input.bytes));
    const unsigned = {
      schema_version: "tivdoc-custody-destination-receipt-v0.10.0" as const,
      destination_id: this.destination_id,
      destination_class: this.destination_class,
      destination_locator: locator,
      envelope_sha256: input.envelope.envelope_sha256,
      object_sha256: input.envelope.object_sha256,
      byte_count: input.envelope.byte_count,
      stored_at: normalizeTime(input.stored_at),
    };
    const receipt = deepFreeze({ ...unsigned, receipt_sha256: canonicalSha256(unsigned) });
    this.#receipts.set(locator, receipt);
    this.#recordAccess(locator, "put", receipt.object_sha256, receipt.stored_at);
    return receipt;
  }

  async accessLog(): Promise<readonly CustodyAccessLogEntry[]> {
    return deepFreeze(this.#access.map((entry) => ({ ...entry })));
  }

  corruptForTest(locator: string): void {
    this.#objects.set(locator, Uint8Array.from([0]));
  }

  #recordAccess(locator: string, operation: CustodyAccessLogEntry["operation"], objectSha256: string, occurredAt: string): void {
    const unsigned = { destination_id: this.destination_id, destination_locator: locator, operation, occurred_at: occurredAt, object_sha256: objectSha256 };
    this.#access.push(deepFreeze({ ...unsigned, access_sha256: canonicalSha256(unsigned) }));
  }
}

export function selectRestoreSource(receipts: readonly CustodyDestinationReceipt[], expectedSha256: string): CustodyDestinationReceipt {
  assertSha(expectedSha256);
  const eligible = receipts.filter((receipt) => receipt.object_sha256 === expectedSha256 && receipt.receipt_sha256 === canonicalSha256(receiptCore(receipt)));
  if (eligible.length === 0) throw new Error("CUSTODY_RESTORE_SOURCE_UNAVAILABLE");
  return [...eligible].sort((left, right) => {
    const classOrder = Number(right.destination_class === "managed_off_host") - Number(left.destination_class === "managed_off_host");
    return classOrder || compareStrings(`${right.stored_at}\u0000${right.destination_id}`, `${left.stored_at}\u0000${left.destination_id}`);
  })[0]!;
}

export function offHostCustodyCapability(): Readonly<{
  status: "BLOCKED";
  blocker_codes: readonly ["OFF_HOST_AUDIT_CUSTODY_PENDING", "DURABLE_REPLICATED_CUSTODY_NOT_IMPLEMENTED"];
  local_two_store_proof_available: true;
  managed_destination_verified: false;
}> {
  return deepFreeze({
    status: "BLOCKED",
    blocker_codes: ["OFF_HOST_AUDIT_CUSTODY_PENDING", "DURABLE_REPLICATED_CUSTODY_NOT_IMPLEMENTED"],
    local_two_store_proof_available: true,
    managed_destination_verified: false,
  });
}

function sealJob(job: MutableJob): ReplicationJob {
  const { job_sha256: ignored, ...core } = job as MutableJob & { job_sha256?: string };
  void ignored;
  return deepFreeze({ ...core, job_sha256: canonicalSha256(core) });
}

function jobCore(job: ReplicationJob): MutableJob {
  const { job_sha256: ignored, ...core } = job;
  void ignored;
  return core;
}

function receiptCore(receipt: CustodyDestinationReceipt) {
  const { receipt_sha256: ignored, ...core } = receipt;
  void ignored;
  return core;
}

function verifyDestinationReceipt(receipt: CustodyDestinationReceipt, job: ReplicationJob, destination: CustodyDestinationPort): void {
  if (receipt.schema_version !== "tivdoc-custody-destination-receipt-v0.10.0"
      || receipt.destination_id !== destination.destination_id
      || receipt.destination_class !== destination.destination_class
      || receipt.envelope_sha256 !== job.envelope.envelope_sha256
      || receipt.object_sha256 !== job.envelope.object_sha256
      || receipt.byte_count !== job.envelope.byte_count
      || receipt.receipt_sha256 !== canonicalSha256(receiptCore(receipt))) throw new Error("CUSTODY_DESTINATION_RECEIPT_INVALID");
}

function validateOpaque(value: string, code: string): void {
  if (!OPAQUE.test(value)) throw new Error(code);
}

function assertSha(value: string): void {
  if (!SHA256.test(value)) throw new Error("CUSTODY_SHA256_INVALID");
}

function assertLength(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 64 * 1024 * 1024) throw new Error("CUSTODY_LENGTH_INVALID");
}

function assertTime(value: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error("CUSTODY_TIMESTAMP_INVALID");
}

function normalizeTime(value: string): string {
  assertTime(value);
  return new Date(value).toISOString();
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
