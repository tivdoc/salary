import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";

import type {
  AuditEventPort,
  CommandEnvelope,
  ObjectRetentionClass,
  ObjectStoragePort,
  ObjectWriteReservation,
  VerifiedActor,
} from "../../../engine/wave4/contracts";

const SHA256 = /^[a-f0-9]{64}$/;
const OPAQUE = /^[a-z][a-z0-9_-]{7,63}$/;
const REASON = /^[A-Z][A-Z0-9_]{7,63}$/;
const ALLOWED_MIME = new Set(["application/json", "application/octet-stream", "application/pdf", "text/plain"]);
const RETENTION_CLASSES = new Set<ObjectRetentionClass>(["temporary", "case_record", "legal_record", "report_record", "audit_record"]);
const MAX_BYTES = 8 * 1024 * 1024;

type ReservationState = Readonly<{
  reservation: ObjectWriteReservation;
  actor_id: string;
  command_hash: string;
  created_ms: number;
  staged: Uint8Array | null;
  staged_sha256: string | null;
  status: "failed_quarantine" | "reserved" | "verified_quarantine";
}>;

type ObjectRecord = Readonly<{
  version_id: string;
  opaque_key: string;
  sha256: string;
  byte_count: number;
  detected_mime: string;
  retention_class: ObjectRetentionClass;
  revision: number;
  status: "active" | "quarantined" | "tombstoned";
  legal_hold: boolean;
  internal_path: string;
}>;

type Grant = Readonly<{
  token_hash: string;
  version_id: string;
  actor_id: string;
  scope_ref: string;
  expires_ms: number;
}>;

function hash(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertActor(actor: VerifiedActor): void {
  if (actor.verified_server_side !== true || !OPAQUE.test(actor.actor_id)) throw new Error("PRIVATE_OBJECT_ACTOR_UNVERIFIED");
}

function assertCommand(command: CommandEnvelope<unknown>): void {
  assertActor(command.actor);
  if (!OPAQUE.test(command.command_id) || !OPAQUE.test(command.idempotency_key) || !REASON.test(command.reason) || !Number.isSafeInteger(command.expected_revision) || command.expected_revision < 0) {
    throw new Error("PRIVATE_OBJECT_COMMAND_INVALID");
  }
}

function detectAndValidateMime(bytes: Uint8Array, expected: string): string {
  if (!ALLOWED_MIME.has(expected)) throw new Error("PRIVATE_OBJECT_MIME_FORBIDDEN");
  const prefix = Buffer.from(bytes.subarray(0, Math.min(bytes.byteLength, 4096)));
  const pdfMagic = prefix.subarray(0, 5).equals(Buffer.from("%PDF-"));
  if (pdfMagic && expected !== "application/pdf") throw new Error("PRIVATE_OBJECT_MIME_MISMATCH");
  if (expected === "application/pdf") {
    const full = Buffer.from(bytes).toString("latin1");
    if (!prefix.subarray(0, 5).equals(Buffer.from("%PDF-")) || !full.trimEnd().endsWith("%%EOF")) throw new Error("PRIVATE_OBJECT_PDF_MALFORMED");
    if (/\/(Encrypt|JavaScript|JS|OpenAction|AA|EmbeddedFile|Filespec|Launch|RichMedia)\b/i.test(full) || /\/(URI|SubmitForm|ImportData)\b/i.test(full)) {
      throw new Error("PRIVATE_OBJECT_PDF_ACTIVE_CONTENT");
    }
    if ((full.match(/\bobj\b/g) ?? []).length > 10_000) throw new Error("PRIVATE_OBJECT_PDF_RESOURCE_LIMIT");
    return "application/pdf";
  }
  if (expected === "application/json") {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      JSON.parse(text);
    } catch {
      throw new Error("PRIVATE_OBJECT_JSON_INVALID");
    }
    return "application/json";
  }
  if (expected === "text/plain") {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (text.includes("\0")) throw new Error("PRIVATE_OBJECT_TEXT_INVALID");
    } catch {
      throw new Error("PRIVATE_OBJECT_TEXT_INVALID");
    }
    return "text/plain";
  }
  return "application/octet-stream";
}

export class LocalPrivateObjectStorage implements ObjectStoragePort {
  readonly #root: string;
  readonly #audit: AuditEventPort;
  readonly #nowMs: () => number;
  readonly #authorizeRead: (actor: VerifiedActor, versionId: string, scopeRef: string) => boolean;
  readonly #reservations = new Map<string, ReservationState>();
  readonly #idempotency = new Map<string, string>();
  readonly #mutationIdempotency = new Map<string, string>();
  readonly #objects = new Map<string, ObjectRecord>();
  readonly #byHash = new Map<string, string>();
  readonly #grants = new Map<string, Grant>();

  constructor(input: Readonly<{
    root: string;
    environment: "generated_local_test_root";
    audit: AuditEventPort;
    nowMs: () => number;
    authorizeRead: (actor: VerifiedActor, versionId: string, scopeRef: string) => boolean;
  }>) {
    const root = resolve(input.root);
    if (input.environment !== "generated_local_test_root" || !basename(root).startsWith("tivdoc-")) throw new Error("PRIVATE_OBJECT_ROOT_NOT_GENERATED");
    this.#root = root;
    this.#audit = input.audit;
    this.#nowMs = input.nowMs;
    this.#authorizeRead = input.authorizeRead;
  }

  async reserve(input: CommandEnvelope<Omit<ObjectWriteReservation, "reservation_id" | "opaque_key">>): Promise<ObjectWriteReservation> {
    assertCommand(input);
    const payload = input.payload;
    if (Object.keys(payload).some((key) => !["expected_sha256", "expected_length", "detected_mime", "retention_class"].includes(key))) {
      throw new Error("PRIVATE_OBJECT_RESERVATION_FIELD_FORBIDDEN");
    }
    if (!SHA256.test(payload.expected_sha256) || !Number.isSafeInteger(payload.expected_length) || payload.expected_length <= 0 || payload.expected_length > MAX_BYTES || !ALLOWED_MIME.has(payload.detected_mime) || !RETENTION_CLASSES.has(payload.retention_class)) {
      throw new Error("PRIVATE_OBJECT_RESERVATION_INVALID");
    }
    const commandHash = hash(JSON.stringify({ command_id: input.command_id, expected_revision: input.expected_revision, actor_id: input.actor.actor_id, reason: input.reason, payload }));
    const existingId = this.#idempotency.get(input.idempotency_key);
    if (this.#mutationIdempotency.has(input.idempotency_key)) throw new Error("PRIVATE_OBJECT_IDEMPOTENCY_CONFLICT");
    if (existingId) {
      const existing = this.#reservations.get(existingId);
      if (!existing || existing.command_hash !== commandHash) throw new Error("PRIVATE_OBJECT_IDEMPOTENCY_CONFLICT");
      return existing.reservation;
    }
    const reservationId = `reservation_${hash(`${input.command_id}:${input.idempotency_key}`).slice(0, 24)}`;
    const reservation = Object.freeze({
      reservation_id: reservationId,
      opaque_key: `object_${hash(`tivdoc-private-object-v0.7:${payload.expected_sha256}`).slice(0, 48)}`,
      expected_sha256: payload.expected_sha256,
      expected_length: payload.expected_length,
      detected_mime: payload.detected_mime,
      retention_class: payload.retention_class,
    });
    this.#reservations.set(reservationId, Object.freeze({ reservation, actor_id: input.actor.actor_id, command_hash: commandHash, created_ms: this.#nowMs(), staged: null, staged_sha256: null, status: "reserved" }));
    this.#idempotency.set(input.idempotency_key, reservationId);
    await this.#audit.append({ actor_id: input.actor.actor_id, action: "OBJECT_RESERVED", resource_id: reservationId, resource_revision: 0, resource_sha256: payload.expected_sha256, reason: input.reason, occurred_at: new Date(this.#nowMs()).toISOString() });
    return reservation;
  }

  async stage(reservation: ObjectWriteReservation, chunks: AsyncIterable<Uint8Array>): Promise<Readonly<{ staged_sha256: string; staged_length: number }>> {
    const state = this.#reservations.get(reservation.reservation_id);
    if (!state || state.reservation !== reservation || state.status !== "reserved") throw new Error("PRIVATE_OBJECT_RESERVATION_UNKNOWN");
    const collected: Uint8Array[] = [];
    let total = 0;
    let chunkCount = 0;
    try {
      for await (const chunk of chunks) {
        chunkCount += 1;
        if (chunkCount > 8_192 || !(chunk instanceof Uint8Array) || chunk.byteLength === 0) throw new Error("PRIVATE_OBJECT_CHUNK_INVALID");
        total += chunk.byteLength;
        if (total > reservation.expected_length || total > MAX_BYTES) throw new Error("PRIVATE_OBJECT_STREAM_LIMIT");
        collected.push(Uint8Array.from(chunk));
      }
      const bytes = Buffer.concat(collected.map((item) => Buffer.from(item)));
      const stagedHash = hash(bytes);
      if (total !== reservation.expected_length) throw new Error("PRIVATE_OBJECT_LENGTH_MISMATCH");
      if (stagedHash !== reservation.expected_sha256) throw new Error("PRIVATE_OBJECT_CHECKSUM_MISMATCH");
      detectAndValidateMime(bytes, reservation.detected_mime);
      this.#reservations.set(reservation.reservation_id, Object.freeze({ ...state, staged: Uint8Array.from(bytes), staged_sha256: stagedHash, status: "verified_quarantine" }));
      return Object.freeze({ staged_sha256: stagedHash, staged_length: total });
    } catch (error) {
      this.#reservations.set(reservation.reservation_id, Object.freeze({ ...state, status: "failed_quarantine" }));
      throw error;
    }
  }

  async finalize(reservation: ObjectWriteReservation): Promise<Readonly<{ object_version_id: string; object_sha256: string }>> {
    const state = this.#reservations.get(reservation.reservation_id);
    if (!state || state.reservation !== reservation || state.status !== "verified_quarantine" || !state.staged || state.staged_sha256 !== reservation.expected_sha256) {
      throw new Error("PRIVATE_OBJECT_NOT_VERIFIED_CLEAN");
    }
    if (this.#byHash.has(reservation.expected_sha256)) throw new Error("PRIVATE_OBJECT_IMMUTABLE_EXISTS");
    const directory = join(this.#root, "objects", reservation.expected_sha256.slice(0, 2));
    const internalPath = resolve(directory, reservation.expected_sha256);
    if (!internalPath.startsWith(`${this.#root}${sep}`)) throw new Error("PRIVATE_OBJECT_INTERNAL_PATH_ESCAPE");
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(internalPath, state.staged, { flag: "wx" });
    } catch {
      throw new Error("PRIVATE_OBJECT_IMMUTABLE_EXISTS");
    }
    const versionId = `version_${hash(`${reservation.reservation_id}:${reservation.expected_sha256}`).slice(0, 24)}`;
    const record = Object.freeze({
      version_id: versionId,
      opaque_key: reservation.opaque_key,
      sha256: reservation.expected_sha256,
      byte_count: reservation.expected_length,
      detected_mime: reservation.detected_mime,
      retention_class: reservation.retention_class,
      revision: 1,
      status: "active" as const,
      legal_hold: false,
      internal_path: internalPath,
    });
    this.#objects.set(versionId, record);
    this.#byHash.set(record.sha256, versionId);
    this.#reservations.delete(reservation.reservation_id);
    await this.#audit.append({ actor_id: state.actor_id, action: "OBJECT_FINALIZED", resource_id: versionId, resource_revision: 1, resource_sha256: record.sha256, reason: "STORAGE_WRITE", occurred_at: new Date(this.#nowMs()).toISOString() });
    return Object.freeze({ object_version_id: versionId, object_sha256: record.sha256 });
  }

  async quarantine(objectVersionId: string, command: CommandEnvelope<Readonly<{ cause_code: string }>>): Promise<void> {
    assertCommand(command);
    if (this.#isMutationReplay(command, "quarantine", objectVersionId)) return;
    const record = this.#objects.get(objectVersionId);
    if (!record || record.status !== "active" || !REASON.test(command.payload.cause_code)) throw new Error("PRIVATE_OBJECT_ACCESS_DENIED");
    if (command.expected_revision !== record.revision) throw new Error("PRIVATE_OBJECT_STALE_REVISION");
    this.#recordMutation(command, "quarantine", objectVersionId);
    this.#objects.set(objectVersionId, Object.freeze({ ...record, status: "quarantined", revision: record.revision + 1 }));
    await this.#audit.append({ actor_id: command.actor.actor_id, action: "OBJECT_QUARANTINED", resource_id: objectVersionId, resource_revision: record.revision + 1, resource_sha256: record.sha256, reason: command.reason, occurred_at: new Date(this.#nowMs()).toISOString() });
  }

  async issuePrivateGrant(input: Readonly<{ actor: VerifiedActor; version_id: string; scope_ref: string; ttl_ms: number }>): Promise<Readonly<{ token: string; expires_at: string }>> {
    assertActor(input.actor);
    const record = this.#objects.get(input.version_id);
    if (!record || record.status !== "active" || !OPAQUE.test(input.scope_ref) || !Number.isSafeInteger(input.ttl_ms) || input.ttl_ms <= 0 || input.ttl_ms > 5 * 60_000 || !this.#authorizeRead(input.actor, input.version_id, input.scope_ref)) {
      throw new Error("PRIVATE_OBJECT_ACCESS_DENIED");
    }
    const token = `grant_${randomBytes(24).toString("hex")}`;
    const tokenHash = hash(token);
    this.#grants.set(tokenHash, Object.freeze({ token_hash: tokenHash, version_id: input.version_id, actor_id: input.actor.actor_id, scope_ref: input.scope_ref, expires_ms: this.#nowMs() + input.ttl_ms }));
    await this.#audit.append({ actor_id: input.actor.actor_id, action: "PRIVATE_GRANT_ISSUED", resource_id: input.version_id, resource_revision: record.revision, resource_sha256: record.sha256, reason: "PRIVATE_ACCESS", occurred_at: new Date(this.#nowMs()).toISOString() });
    return Object.freeze({ token, expires_at: new Date(this.#nowMs() + input.ttl_ms).toISOString() });
  }

  async readWithGrant(token: string, actor: VerifiedActor, scopeRef: string): Promise<Uint8Array> {
    assertActor(actor);
    const grant = this.#grants.get(hash(token));
    const record = grant ? this.#objects.get(grant.version_id) : undefined;
    if (!grant || !record || record.status !== "active" || grant.actor_id !== actor.actor_id || grant.scope_ref !== scopeRef || grant.expires_ms <= this.#nowMs() || !this.#authorizeRead(actor, grant.version_id, scopeRef)) {
      throw new Error("PRIVATE_OBJECT_ACCESS_DENIED");
    }
    const bytes = await readFile(record.internal_path);
    if (bytes.byteLength !== record.byte_count || hash(bytes) !== record.sha256) throw new Error("PRIVATE_OBJECT_INTEGRITY_FAILURE");
    await this.#audit.append({ actor_id: actor.actor_id, action: "PRIVATE_OBJECT_READ", resource_id: record.version_id, resource_revision: record.revision, resource_sha256: record.sha256, reason: "PRIVATE_ACCESS", occurred_at: new Date(this.#nowMs()).toISOString() });
    return Uint8Array.from(bytes);
  }

  async setLegalHold(versionId: string, held: boolean, command: CommandEnvelope<Readonly<{ held: boolean }>>): Promise<void> {
    assertCommand(command);
    if (this.#isMutationReplay(command, "legal_hold", versionId)) return;
    if (command.payload.held !== held) throw new Error("PRIVATE_OBJECT_COMMAND_INVALID");
    const record = this.#objects.get(versionId);
    if (!record || record.status === "tombstoned") throw new Error("PRIVATE_OBJECT_ACCESS_DENIED");
    if (command.expected_revision !== record.revision) throw new Error("PRIVATE_OBJECT_STALE_REVISION");
    this.#recordMutation(command, "legal_hold", versionId);
    const revision = record.revision + 1;
    this.#objects.set(versionId, Object.freeze({ ...record, legal_hold: held, revision }));
    await this.#audit.append({ actor_id: command.actor.actor_id, action: "OBJECT_LEGAL_HOLD_CHANGED", resource_id: versionId, resource_revision: revision, resource_sha256: record.sha256, reason: command.reason, occurred_at: new Date(this.#nowMs()).toISOString() });
  }

  async tombstone(versionId: string, command: CommandEnvelope<Readonly<{ retention_complete: true }>>): Promise<void> {
    assertCommand(command);
    if (this.#isMutationReplay(command, "tombstone", versionId)) return;
    const record = this.#objects.get(versionId);
    if (!record || record.status === "tombstoned") throw new Error("PRIVATE_OBJECT_ACCESS_DENIED");
    if (record.legal_hold) throw new Error("PRIVATE_OBJECT_LEGAL_HOLD");
    if (command.payload.retention_complete !== true) throw new Error("PRIVATE_OBJECT_RETENTION_ACTIVE");
    if (command.expected_revision !== record.revision) throw new Error("PRIVATE_OBJECT_STALE_REVISION");
    this.#recordMutation(command, "tombstone", versionId);
    await unlink(record.internal_path);
    this.#objects.set(versionId, Object.freeze({ ...record, status: "tombstoned", revision: record.revision + 1 }));
    this.#byHash.delete(record.sha256);
    await this.#audit.append({ actor_id: command.actor.actor_id, action: "OBJECT_TOMBSTONED", resource_id: versionId, resource_revision: record.revision + 1, resource_sha256: record.sha256, reason: command.reason, occurred_at: new Date(this.#nowMs()).toISOString() });
  }

  reconcileStaging(input: Readonly<{ older_than_ms: number; dry_run: boolean }>): Readonly<{ candidates: readonly string[]; removed: number; visible_objects_changed: 0 }> {
    if (!Number.isSafeInteger(input.older_than_ms) || input.older_than_ms < 60_000) throw new Error("PRIVATE_OBJECT_RECONCILE_WINDOW_INVALID");
    const candidates = [...this.#reservations.entries()]
      .filter(([, state]) => this.#nowMs() - state.created_ms >= input.older_than_ms)
      .map(([id]) => id)
      .sort();
    if (!input.dry_run) candidates.forEach((id) => this.#reservations.delete(id));
    return Object.freeze({ candidates: Object.freeze(candidates), removed: input.dry_run ? 0 : candidates.length, visible_objects_changed: 0 });
  }

  metadata(versionId: string): Readonly<Omit<ObjectRecord, "internal_path">> | null {
    const record = this.#objects.get(versionId);
    if (!record) return null;
    const { internal_path: ignored, ...safe } = record;
    void ignored;
    return Object.freeze(safe);
  }

  #mutationHash(command: CommandEnvelope<unknown>, operation: string, versionId: string): string {
    return hash(JSON.stringify({ operation, version_id: versionId, actor_id: command.actor.actor_id, expected_revision: command.expected_revision, reason: command.reason, payload: command.payload }));
  }

  #isMutationReplay(command: CommandEnvelope<unknown>, operation: string, versionId: string): boolean {
    if (this.#idempotency.has(command.idempotency_key)) throw new Error("PRIVATE_OBJECT_IDEMPOTENCY_CONFLICT");
    const existing = this.#mutationIdempotency.get(command.idempotency_key);
    if (!existing) return false;
    if (existing !== this.#mutationHash(command, operation, versionId)) throw new Error("PRIVATE_OBJECT_IDEMPOTENCY_CONFLICT");
    return true;
  }

  #recordMutation(command: CommandEnvelope<unknown>, operation: string, versionId: string): void {
    this.#mutationIdempotency.set(command.idempotency_key, this.#mutationHash(command, operation, versionId));
  }
}
