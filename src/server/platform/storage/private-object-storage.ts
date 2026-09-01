import { createHash, randomBytes } from "node:crypto";

import type {
  AuditEventPort,
  CommandEnvelope,
  ObjectRetentionClass,
  ObjectStoragePort,
  ObjectWriteReservation,
  VerifiedActor,
} from "../../../engine/wave4/contracts";
import {
  HermeticFilesystemPrivateBlobProvider,
  type PrivateBlobProvider,
} from "./private-storage-provider";

const SHA256 = /^[a-f0-9]{64}$/;
const OPAQUE = /^[a-z][a-z0-9_-]{7,63}$/;
const REASON = /^[A-Z][A-Z0-9_]{7,63}$/;
const ALLOWED_MIME = new Set(["application/json", "application/octet-stream", "application/pdf", "text/plain"]);
const RETENTION_CLASSES = new Set<ObjectRetentionClass>(["temporary", "case_record", "legal_record", "report_record", "audit_record"]);
const MAX_BYTES = 8 * 1024 * 1024;

type ReservationState = Readonly<{
  reservation: ObjectWriteReservation;
  actor_id: string;
  scope: PrivateObjectScope;
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
  owner_actor_id: string;
  tenant_id: string;
  case_id: string;
  provider_locator: string | null;
}>;

type Grant = Readonly<{
  token_hash: string;
  version_id: string;
  actor_id: string;
  scope_ref: string;
  expires_ms: number;
}>;

export type PrivateObjectScope = Readonly<{
  owner_actor_id: string;
  tenant_id: string;
  case_id: string;
}>;

export type PrivateGrantRevocationReceipt = Readonly<{
  receipt_id: string;
  object_version_id: string;
  grants_revoked: number;
  cause_code: string;
  revoked_at: string;
}>;

export type PrivateObjectDeletionReceipt = Readonly<{
  receipt_id: string;
  object_version_id: string;
  deleted_sha256: string;
  deleted_at: string;
  bytes_removed: number;
  grants_revoked: number;
  retention_complete: true;
  legal_hold: false;
}>;

export type PrivateObjectInventoryReconciliation = Readonly<{
  orphan_locators: readonly string[];
  missing_object_version_ids: readonly string[];
  integrity_failure_version_ids: readonly string[];
  orphan_blobs_removed: number;
  objects_quarantined: number;
  grants_revoked: number;
  dry_run: boolean;
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

export class CanonicalPrivateObjectStorage implements ObjectStoragePort {
  readonly #provider: PrivateBlobProvider;
  readonly #audit: AuditEventPort;
  readonly #nowMs: () => number;
  readonly #authorizeRead: (actor: VerifiedActor, versionId: string, scopeRef: string) => boolean;
  readonly #resolveWriteScope: (actor: VerifiedActor) => PrivateObjectScope;
  readonly #reservations = new Map<string, ReservationState>();
  readonly #idempotency = new Map<string, string>();
  readonly #mutationIdempotency = new Map<string, string>();
  readonly #objects = new Map<string, ObjectRecord>();
  readonly #byHash = new Map<string, string>();
  readonly #grants = new Map<string, Grant>();
  readonly #deletionReceipts = new Map<string, PrivateObjectDeletionReceipt>();
  readonly #revocationReceipts = new Map<string, PrivateGrantRevocationReceipt>();

  constructor(input: Readonly<{
    provider: PrivateBlobProvider;
    audit: AuditEventPort;
    nowMs: () => number;
    authorizeRead: (actor: VerifiedActor, versionId: string, scopeRef: string) => boolean;
    resolveWriteScope?: (actor: VerifiedActor) => PrivateObjectScope;
  }>) {
    this.#provider = input.provider;
    this.#audit = input.audit;
    this.#nowMs = input.nowMs;
    this.#authorizeRead = input.authorizeRead;
    this.#resolveWriteScope = input.resolveWriteScope ?? defaultWriteScope;
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
    const scope = assertScope(this.#resolveWriteScope(input.actor), input.actor);
    const commandHash = hash(JSON.stringify({ command_id: input.command_id, expected_revision: input.expected_revision, actor_id: input.actor.actor_id, scope, reason: input.reason, payload }));
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
    this.#reservations.set(reservationId, Object.freeze({ reservation, actor_id: input.actor.actor_id, scope, command_hash: commandHash, created_ms: this.#nowMs(), staged: null, staged_sha256: null, status: "reserved" }));
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
    const duplicateVersionId = this.#byHash.get(reservation.expected_sha256);
    if (duplicateVersionId) {
      const duplicate = this.#objects.get(duplicateVersionId);
      if (!duplicate || duplicate.tenant_id !== state.scope.tenant_id || duplicate.case_id !== state.scope.case_id) throw new Error("PRIVATE_OBJECT_ACCESS_DENIED");
      throw new Error("PRIVATE_OBJECT_IMMUTABLE_EXISTS");
    }
    let quarantineLocator: string | null = null;
    let activeLocator: string;
    try {
      quarantineLocator = (await this.#provider.putQuarantined({ object_key: reservation.opaque_key, expected_sha256: reservation.expected_sha256, expected_length: reservation.expected_length, bytes: state.staged })).quarantine_locator;
      activeLocator = (await this.#provider.promoteQuarantined({ quarantine_locator: quarantineLocator, object_key: reservation.opaque_key, expected_sha256: reservation.expected_sha256, expected_length: reservation.expected_length })).active_locator;
    } catch (error) {
      if (quarantineLocator) await this.#provider.deleteExact({ locator: quarantineLocator, expected_sha256: reservation.expected_sha256 }).catch(() => Object.freeze({ deleted: false }));
      throw error;
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
      owner_actor_id: state.scope.owner_actor_id,
      tenant_id: state.scope.tenant_id,
      case_id: state.scope.case_id,
      provider_locator: activeLocator,
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
    this.#revokeGrantsForVersion(objectVersionId);
    this.#objects.set(objectVersionId, Object.freeze({ ...record, status: "quarantined", revision: record.revision + 1 }));
    await this.#audit.append({ actor_id: command.actor.actor_id, action: "OBJECT_QUARANTINED", resource_id: objectVersionId, resource_revision: record.revision + 1, resource_sha256: record.sha256, reason: command.reason, occurred_at: new Date(this.#nowMs()).toISOString() });
  }

  async issuePrivateGrant(input: Readonly<{ actor: VerifiedActor; version_id: string; scope_ref: string; ttl_ms: number }>): Promise<Readonly<{ token: string; expires_at: string }>> {
    assertActor(input.actor);
    const record = this.#objects.get(input.version_id);
    if (!record || record.status !== "active" || record.tenant_id !== input.actor.tenant_id || record.case_id !== input.scope_ref || !input.actor.assigned_case_ids.includes(record.case_id) || !OPAQUE.test(input.scope_ref) || !Number.isSafeInteger(input.ttl_ms) || input.ttl_ms <= 0 || input.ttl_ms > 5 * 60_000 || !this.#authorizeRead(input.actor, input.version_id, input.scope_ref)) {
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
    if (!grant || !record || !record.provider_locator || record.status !== "active" || record.tenant_id !== actor.tenant_id || record.case_id !== scopeRef || !actor.assigned_case_ids.includes(record.case_id) || grant.actor_id !== actor.actor_id || grant.scope_ref !== scopeRef || grant.expires_ms <= this.#nowMs() || !this.#authorizeRead(actor, grant.version_id, scopeRef)) {
      throw new Error("PRIVATE_OBJECT_ACCESS_DENIED");
    }
    const bytes = await this.#provider.readExact({ locator: record.provider_locator, expected_sha256: record.sha256, expected_length: record.byte_count });
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

  async revokeObjectGrants(versionId: string, command: CommandEnvelope<Readonly<{ cause_code: string }>>): Promise<PrivateGrantRevocationReceipt> {
    assertCommand(command);
    if (!REASON.test(command.payload.cause_code)) throw new Error("PRIVATE_OBJECT_COMMAND_INVALID");
    if (this.#isMutationReplay(command, "revoke_grants", versionId)) {
      const replay = this.#revocationReceipts.get(command.idempotency_key);
      if (!replay) throw new Error("PRIVATE_OBJECT_IDEMPOTENCY_CONFLICT");
      return replay;
    }
    const record = this.#objects.get(versionId);
    if (!record || record.status === "tombstoned") throw new Error("PRIVATE_OBJECT_ACCESS_DENIED");
    if (command.expected_revision !== record.revision) throw new Error("PRIVATE_OBJECT_STALE_REVISION");
    this.#recordMutation(command, "revoke_grants", versionId);
    const grantsRevoked = this.#revokeGrantsForVersion(versionId);
    const revision = record.revision + 1;
    this.#objects.set(versionId, Object.freeze({ ...record, revision }));
    const receipt = Object.freeze({
      receipt_id: `revocation_${hash(`${command.command_id}:${command.idempotency_key}:${versionId}`).slice(0, 24)}`,
      object_version_id: versionId,
      grants_revoked: grantsRevoked,
      cause_code: command.payload.cause_code,
      revoked_at: new Date(this.#nowMs()).toISOString(),
    });
    this.#revocationReceipts.set(command.idempotency_key, receipt);
    await this.#audit.append({ actor_id: command.actor.actor_id, action: "PRIVATE_GRANTS_REVOKED", resource_id: versionId, resource_revision: revision, resource_sha256: record.sha256, reason: command.reason, occurred_at: receipt.revoked_at });
    return receipt;
  }

  async tombstone(versionId: string, command: CommandEnvelope<Readonly<{ retention_complete: true }>>): Promise<PrivateObjectDeletionReceipt> {
    assertCommand(command);
    if (this.#isMutationReplay(command, "tombstone", versionId)) {
      const replay = this.#deletionReceipts.get(command.idempotency_key);
      if (!replay) throw new Error("PRIVATE_OBJECT_IDEMPOTENCY_CONFLICT");
      return replay;
    }
    const record = this.#objects.get(versionId);
    if (!record || record.status === "tombstoned" || !record.provider_locator) throw new Error("PRIVATE_OBJECT_ACCESS_DENIED");
    if (record.legal_hold) throw new Error("PRIVATE_OBJECT_LEGAL_HOLD");
    if (command.payload.retention_complete !== true) throw new Error("PRIVATE_OBJECT_RETENTION_ACTIVE");
    if (command.expected_revision !== record.revision) throw new Error("PRIVATE_OBJECT_STALE_REVISION");
    this.#recordMutation(command, "tombstone", versionId);
    const deleted = await this.#provider.deleteExact({ locator: record.provider_locator, expected_sha256: record.sha256 });
    const grantsRevoked = this.#revokeGrantsForVersion(versionId);
    this.#objects.set(versionId, Object.freeze({ ...record, status: "tombstoned", revision: record.revision + 1, provider_locator: null }));
    this.#byHash.delete(record.sha256);
    const receipt = Object.freeze({
      receipt_id: `deletion_${hash(`${command.command_id}:${command.idempotency_key}:${versionId}`).slice(0, 24)}`,
      object_version_id: versionId,
      deleted_sha256: record.sha256,
      deleted_at: new Date(this.#nowMs()).toISOString(),
      bytes_removed: deleted.deleted ? record.byte_count : 0,
      grants_revoked: grantsRevoked,
      retention_complete: true as const,
      legal_hold: false as const,
    });
    this.#deletionReceipts.set(command.idempotency_key, receipt);
    await this.#audit.append({ actor_id: command.actor.actor_id, action: "OBJECT_TOMBSTONED", resource_id: versionId, resource_revision: record.revision + 1, resource_sha256: record.sha256, reason: command.reason, occurred_at: receipt.deleted_at });
    return receipt;
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

  async reconcileInventory(command: CommandEnvelope<Readonly<{ dry_run: boolean }>>): Promise<PrivateObjectInventoryReconciliation> {
    assertCommand(command);
    if (typeof command.payload.dry_run !== "boolean" || Object.keys(command.payload).some((key) => key !== "dry_run")) throw new Error("PRIVATE_OBJECT_COMMAND_INVALID");
    const inventory = await this.#provider.inventory();
    const inventoryByLocator = new Map(inventory.map((entry) => [entry.locator, entry]));
    const recordsByLocator = new Map([...this.#objects.values()].filter((record) => record.status !== "tombstoned" && record.provider_locator).map((record) => [record.provider_locator!, record]));
    const orphanEntries = inventory.filter((entry) => !recordsByLocator.has(entry.locator)).sort((left, right) => left.locator.localeCompare(right.locator));
    const missing = [...recordsByLocator.entries()].filter(([locator]) => !inventoryByLocator.has(locator)).map(([, record]) => record.version_id).sort();
    const integrityFailures = [...recordsByLocator.entries()].filter(([locator, record]) => {
      const entry = inventoryByLocator.get(locator);
      return Boolean(entry && (entry.sha256 !== record.sha256 || entry.byte_count !== record.byte_count));
    }).map(([, record]) => record.version_id).sort();
    let orphanBlobsRemoved = 0;
    let objectsQuarantined = 0;
    let grantsRevoked = 0;

    if (!command.payload.dry_run) {
      for (const entry of orphanEntries) {
        const deletion = await this.#provider.deleteExact({ locator: entry.locator, expected_sha256: entry.sha256 });
        if (deletion.deleted) orphanBlobsRemoved += 1;
      }
      for (const versionId of [...new Set([...missing, ...integrityFailures])].sort()) {
        const record = this.#objects.get(versionId);
        if (!record || record.status === "tombstoned") continue;
        grantsRevoked += this.#revokeGrantsForVersion(versionId);
        this.#objects.set(versionId, Object.freeze({ ...record, status: "quarantined", revision: record.revision + 1 }));
        objectsQuarantined += 1;
        await this.#audit.append({ actor_id: command.actor.actor_id, action: "OBJECT_RECONCILIATION_QUARANTINE", resource_id: versionId, resource_revision: record.revision + 1, resource_sha256: record.sha256, reason: command.reason, occurred_at: new Date(this.#nowMs()).toISOString() });
      }
    }

    return Object.freeze({
      orphan_locators: Object.freeze(orphanEntries.map((entry) => entry.locator)),
      missing_object_version_ids: Object.freeze(missing),
      integrity_failure_version_ids: Object.freeze(integrityFailures),
      orphan_blobs_removed: orphanBlobsRemoved,
      objects_quarantined: objectsQuarantined,
      grants_revoked: grantsRevoked,
      dry_run: command.payload.dry_run,
    });
  }

  metadata(versionId: string): Readonly<Omit<ObjectRecord, "provider_locator">> | null {
    const record = this.#objects.get(versionId);
    if (!record) return null;
    const { provider_locator: ignored, ...safe } = record;
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

  #revokeGrantsForVersion(versionId: string): number {
    let revoked = 0;
    for (const [tokenHash, grant] of this.#grants.entries()) {
      if (grant.version_id !== versionId) continue;
      this.#grants.delete(tokenHash);
      revoked += 1;
    }
    return revoked;
  }
}

export class LocalPrivateObjectStorage extends CanonicalPrivateObjectStorage {
  constructor(input: Readonly<{
    root: string;
    environment: "generated_local_test_root";
    audit: AuditEventPort;
    nowMs: () => number;
    authorizeRead: (actor: VerifiedActor, versionId: string, scopeRef: string) => boolean;
    resolveWriteScope?: (actor: VerifiedActor) => PrivateObjectScope;
  }>) {
    super({
      provider: new HermeticFilesystemPrivateBlobProvider({ root: input.root, environment: input.environment }),
      audit: input.audit,
      nowMs: input.nowMs,
      authorizeRead: input.authorizeRead,
      resolveWriteScope: input.resolveWriteScope,
    });
  }
}

function defaultWriteScope(actor: VerifiedActor): PrivateObjectScope {
  if (actor.tenant_id === null || actor.assigned_case_ids.length !== 1) throw new Error("PRIVATE_OBJECT_SCOPE_REQUIRED");
  return Object.freeze({ owner_actor_id: actor.actor_id, tenant_id: actor.tenant_id, case_id: actor.assigned_case_ids[0]! });
}

function assertScope(scope: PrivateObjectScope, actor: VerifiedActor): PrivateObjectScope {
  if (!OPAQUE.test(scope.owner_actor_id) || !OPAQUE.test(scope.tenant_id) || !OPAQUE.test(scope.case_id) || scope.owner_actor_id !== actor.actor_id || scope.tenant_id !== actor.tenant_id || !actor.assigned_case_ids.includes(scope.case_id)) {
    throw new Error("PRIVATE_OBJECT_SCOPE_INVALID");
  }
  return Object.freeze({ ...scope });
}
