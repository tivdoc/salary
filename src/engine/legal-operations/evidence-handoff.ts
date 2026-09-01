import { z } from "zod";
import { isoTimestampSchema } from "../domain/primitives.ts";
import { bytesSha256, frozen, legalOperationsSha256 } from "./canonical.ts";
import { humanTrustIdSchema, type HumanTrustPurpose, type HumanTrustVerificationPort } from "./human-trust.ts";
import { legalOperationsIdSchema, legalOperationsSha256Schema } from "./contracts.ts";

export const EVIDENCE_HANDOFF_SCHEMA = "tivdoc-external-evidence-handoff-v0.10.0" as const;

const reasonCode = z.string().regex(/^[A-Z][A-Z0-9_]{2,99}$/);
const evidenceFileSchema = z.object({
  file_id: legalOperationsIdSchema,
  byte_length: z.number().int().positive().max(134_217_728),
  bytes_sha256: legalOperationsSha256Schema,
}).strict().readonly();

export const evidencePackageManifestSchema = z.object({
  schema_version: z.literal(EVIDENCE_HANDOFF_SCHEMA),
  handoff_id: legalOperationsIdSchema,
  package_version: z.string().regex(/^[1-9]\d*(?:\.\d+){0,2}$/),
  files: z.array(evidenceFileSchema).min(1).max(128).readonly(),
  total_byte_length: z.number().int().positive().max(268_435_456),
  prepared_at: isoTimestampSchema,
  preparation_reason_code: reasonCode,
  manifest_sha256: legalOperationsSha256Schema,
}).strict().superRefine((manifest, context) => {
  if (new Set(manifest.files.map((file) => file.file_id)).size !== manifest.files.length) context.addIssue({ code: "custom", message: "evidence_handoff_duplicate_file_id" });
  if (manifest.files.reduce((sum, file) => sum + file.byte_length, 0) !== manifest.total_byte_length) context.addIssue({ code: "custom", message: "evidence_handoff_total_length_mismatch" });
}).readonly();

export type EvidencePackageManifest = z.infer<typeof evidencePackageManifestSchema>;
export type EvidenceHandoffState = "prepared" | "delivered" | "received" | "verified" | "rejected";

export type EvidenceHandoffEvent = Readonly<{
  schema_version: typeof EVIDENCE_HANDOFF_SCHEMA;
  sequence: number;
  event_id: string;
  event_kind: "prepared" | "delivered" | "received" | "verified" | "rejected";
  handoff_id: string;
  package_version: string;
  prior_state: "unregistered" | EvidenceHandoffState;
  state: EvidenceHandoffState;
  actor_id: string;
  occurred_at: string;
  package_manifest_sha256: string;
  observed_manifest_sha256: string | null;
  envelope_sha256: string | null;
  reason_code: string;
  prior_event_sha256: string | null;
  event_sha256: string;
}>;

type ByteFile = Readonly<{ file_id: string; bytes: Uint8Array }>;
type HandoffRecord = {
  manifest: EvidencePackageManifest;
  prepared_bytes: ReadonlyMap<string, Uint8Array>;
  received_bytes: ReadonlyMap<string, Uint8Array> | null;
  state: EvidenceHandoffState;
  delivery_actor_id: string | null;
  receipt_actor_id: string | null;
  events: EvidenceHandoffEvent[];
};

function exactBytes(files: readonly ByteFile[]) {
  if (files.length === 0 || files.length > 128) throw new Error("EVIDENCE_HANDOFF_ACTUAL_BYTES_REQUIRED");
  const ids = new Set<string>();
  const stored = new Map<string, Uint8Array>();
  const rows = files.map((file) => {
    const fileId = legalOperationsIdSchema.parse(file.file_id);
    if (ids.has(fileId)) throw new Error("EVIDENCE_HANDOFF_DUPLICATE_FILE_ID");
    ids.add(fileId);
    if (!(file.bytes instanceof Uint8Array) || file.bytes.byteLength === 0) throw new Error("EVIDENCE_HANDOFF_ACTUAL_BYTES_REQUIRED");
    if (file.bytes.byteLength > 134_217_728) throw new Error("EVIDENCE_HANDOFF_FILE_SIZE_LIMIT_EXCEEDED");
    const copy = new Uint8Array(file.bytes);
    stored.set(fileId, copy);
    return frozen({ file_id: fileId, byte_length: copy.byteLength, bytes_sha256: bytesSha256(copy) });
  }).sort((left, right) => left.file_id.localeCompare(right.file_id));
  const total = rows.reduce((sum, row) => sum + row.byte_length, 0);
  if (total > 268_435_456) throw new Error("EVIDENCE_HANDOFF_PACKAGE_SIZE_LIMIT_EXCEEDED");
  return frozen({ rows, total, stored });
}

function observedManifest(files: readonly ByteFile[]) {
  const exact = exactBytes(files);
  const payload = { files: exact.rows, total_byte_length: exact.total };
  return frozen({ ...exact, observed_manifest_sha256: legalOperationsSha256(payload) });
}

export function evidenceHandoffActionPayload(input: Readonly<{
  action: "deliver" | "receive" | "verify";
  manifest: EvidencePackageManifest;
  prior_state: EvidenceHandoffState;
  target_state: EvidenceHandoffState;
  observed_manifest_sha256: string | null;
  reference_sha256: string;
  occurred_at: string;
  reason_code: string;
}>) {
  const payload = {
    schema_version: EVIDENCE_HANDOFF_SCHEMA,
    action: input.action,
    handoff_id: input.manifest.handoff_id,
    package_version: input.manifest.package_version,
    package_manifest_sha256: input.manifest.manifest_sha256,
    prior_state: input.prior_state,
    target_state: input.target_state,
    observed_manifest_sha256: input.observed_manifest_sha256,
    reference_sha256: legalOperationsSha256Schema.parse(input.reference_sha256),
    occurred_at: isoTimestampSchema.parse(input.occurred_at),
    reason_code: reasonCode.parse(input.reason_code),
  } as const;
  return frozen(payload);
}

export class ExternalEvidenceHandoffLedger {
  readonly #trust: HumanTrustVerificationPort;
  readonly #records = new Map<string, HandoffRecord>();
  readonly #events: EvidenceHandoffEvent[] = [];

  constructor(trust: HumanTrustVerificationPort) {
    this.#trust = trust;
  }

  prepare(input: Readonly<{ handoff_id: string; package_version: string; files: readonly ByteFile[]; prepared_at: string; reason_code: string }>) {
    const material = exactBytes(input.files);
    const seed = {
      schema_version: EVIDENCE_HANDOFF_SCHEMA,
      handoff_id: legalOperationsIdSchema.parse(input.handoff_id),
      package_version: input.package_version,
      files: material.rows,
      total_byte_length: material.total,
      prepared_at: isoTimestampSchema.parse(input.prepared_at),
      preparation_reason_code: reasonCode.parse(input.reason_code),
    } as const;
    const manifest = evidencePackageManifestSchema.parse({ ...seed, manifest_sha256: legalOperationsSha256(seed) });
    const existing = this.#records.get(manifest.handoff_id);
    if (existing) {
      if (existing.manifest.manifest_sha256 !== manifest.manifest_sha256) throw new Error("EVIDENCE_HANDOFF_APPEND_ONLY_PACKAGE_MUTATION_REJECTED");
      return frozen({ manifest: existing.manifest, state: existing.state, idempotent_replay: true });
    }
    const record: HandoffRecord = { manifest, prepared_bytes: material.stored, received_bytes: null, state: "prepared", delivery_actor_id: null, receipt_actor_id: null, events: [] };
    this.#records.set(manifest.handoff_id, record);
    this.#append(record, "prepared", "unregistered", "prepared", "evidence.handoff.system", input.prepared_at, null, null, input.reason_code);
    return frozen({ manifest, state: "prepared" as const, idempotent_replay: false });
  }

  previewDelivery(handoffId: string, input: Readonly<{ delivery_reference_sha256: string; delivered_at: string; reason_code: string }>) {
    const record = this.#record(handoffId);
    if (record.state !== "prepared") throw new Error("EVIDENCE_HANDOFF_DELIVERY_REQUIRES_PREPARED");
    return evidenceHandoffActionPayload({ action: "deliver", manifest: record.manifest, prior_state: "prepared", target_state: "delivered", observed_manifest_sha256: null, reference_sha256: input.delivery_reference_sha256, occurred_at: input.delivered_at, reason_code: input.reason_code });
  }

  deliver(handoffId: string, input: Readonly<{ delivery_reference_sha256: string; delivered_at: string; reason_code: string; envelope: unknown }>) {
    const record = this.#record(handoffId);
    const payload = this.previewDelivery(handoffId, input);
    const verification = this.#verify(input.envelope, payload, "evidence_handoff_delivery", "human_evidence_custodian", input.delivered_at);
    record.state = "delivered";
    record.delivery_actor_id = verification.reviewer_id;
    this.#append(record, "delivered", "prepared", "delivered", verification.reviewer_id, input.delivered_at, null, verification.envelope_sha256, input.reason_code);
    return this.status(handoffId);
  }

  previewReceipt(handoffId: string, input: Readonly<{ files: readonly ByteFile[]; receipt_reference_sha256: string; received_at: string; reason_code: string }>) {
    const record = this.#record(handoffId);
    if (record.state !== "delivered") throw new Error("EVIDENCE_HANDOFF_RECEIPT_REQUIRES_DELIVERED");
    const observed = observedManifest(input.files);
    const expectedObservedSha = legalOperationsSha256({ files: record.manifest.files, total_byte_length: record.manifest.total_byte_length });
    const exact = observed.observed_manifest_sha256 === expectedObservedSha;
    return frozen({
      payload: evidenceHandoffActionPayload({ action: "receive", manifest: record.manifest, prior_state: "delivered", target_state: exact ? "received" : "rejected", observed_manifest_sha256: observed.observed_manifest_sha256, reference_sha256: input.receipt_reference_sha256, occurred_at: input.received_at, reason_code: input.reason_code }),
      exact_bytes: exact,
    });
  }

  receive(handoffId: string, input: Readonly<{ files: readonly ByteFile[]; receipt_reference_sha256: string; received_at: string; reason_code: string; envelope: unknown }>) {
    const record = this.#record(handoffId);
    const observed = observedManifest(input.files);
    const preview = this.previewReceipt(handoffId, input);
    const verification = this.#verify(input.envelope, preview.payload, "evidence_handoff_receipt", "human_external_evidence_auditor", input.received_at);
    if (verification.reviewer_id === record.delivery_actor_id) throw new Error("EVIDENCE_HANDOFF_CUSTODY_AND_AUDIT_SEPARATION_REQUIRED");
    record.received_bytes = observed.stored;
    record.receipt_actor_id = verification.reviewer_id;
    record.state = preview.exact_bytes ? "received" : "rejected";
    this.#append(record, record.state, "delivered", record.state, verification.reviewer_id, input.received_at, observed.observed_manifest_sha256, verification.envelope_sha256, input.reason_code);
    return this.status(handoffId);
  }

  previewVerification(handoffId: string, input: Readonly<{ verification_reference_sha256: string; verified_at: string; reason_code: string }>) {
    const record = this.#record(handoffId);
    if (record.state !== "received" || record.received_bytes === null) throw new Error("EVIDENCE_HANDOFF_VERIFICATION_REQUIRES_RECEIVED_BYTES");
    const files = [...record.received_bytes].map(([file_id, bytes]) => ({ file_id, bytes }));
    const observed = observedManifest(files);
    const expectedObservedSha = legalOperationsSha256({ files: record.manifest.files, total_byte_length: record.manifest.total_byte_length });
    const exact = observed.observed_manifest_sha256 === expectedObservedSha;
    return frozen({
      payload: evidenceHandoffActionPayload({ action: "verify", manifest: record.manifest, prior_state: "received", target_state: exact ? "verified" : "rejected", observed_manifest_sha256: observed.observed_manifest_sha256, reference_sha256: input.verification_reference_sha256, occurred_at: input.verified_at, reason_code: input.reason_code }),
      exact_bytes: exact,
    });
  }

  verify(handoffId: string, input: Readonly<{ verification_reference_sha256: string; verified_at: string; reason_code: string; envelope: unknown }>) {
    const record = this.#record(handoffId);
    const preview = this.previewVerification(handoffId, input);
    const verification = this.#verify(input.envelope, preview.payload, "evidence_handoff_verification", "human_external_evidence_auditor", input.verified_at);
    if (verification.reviewer_id === record.delivery_actor_id) throw new Error("EVIDENCE_HANDOFF_CUSTODY_AND_AUDIT_SEPARATION_REQUIRED");
    record.state = preview.exact_bytes ? "verified" : "rejected";
    this.#append(record, record.state, "received", record.state, verification.reviewer_id, input.verified_at, preview.payload.observed_manifest_sha256, verification.envelope_sha256, input.reason_code);
    return this.status(handoffId);
  }

  status(handoffId: string) {
    const record = this.#record(handoffId);
    return frozen({ handoff_id: record.manifest.handoff_id, package_version: record.manifest.package_version, state: record.state, package_manifest_sha256: record.manifest.manifest_sha256, file_count: record.manifest.files.length, total_byte_length: record.manifest.total_byte_length, audit_head_sha256: record.events.at(-1)?.event_sha256 ?? null });
  }

  events() { return frozen(this.#events.map((event) => ({ ...event }))); }

  verifyAuditChain() {
    let prior: string | null = null;
    for (const event of this.#events) {
      const { event_sha256: expected, ...body } = event;
      if (body.prior_event_sha256 !== prior || legalOperationsSha256(body) !== expected) return frozen({ valid: false, event_count: this.#events.length, tail_sha256: prior });
      prior = event.event_sha256;
    }
    return frozen({ valid: true, event_count: this.#events.length, tail_sha256: prior });
  }

  #verify(envelope: unknown, payload: unknown, purpose: HumanTrustPurpose, role: string, occurredAt: string) {
    const verification = this.#trust.verifyForAdmission({ envelope, payload, purpose, required_reviewer_role: role });
    if (verification.envelope.payload_schema_version !== EVIDENCE_HANDOFF_SCHEMA) throw new Error("EVIDENCE_HANDOFF_TRUST_SCHEMA_BINDING_MISMATCH");
    if (verification.envelope.issued_at !== occurredAt) throw new Error("EVIDENCE_HANDOFF_TRUST_TIMESTAMP_BINDING_MISMATCH");
    return verification;
  }

  #record(handoffId: string) {
    const record = this.#records.get(handoffId);
    if (!record) throw new Error("EVIDENCE_HANDOFF_NOT_FOUND");
    return record;
  }

  #append(record: HandoffRecord, kind: EvidenceHandoffEvent["event_kind"], priorState: EvidenceHandoffEvent["prior_state"], state: EvidenceHandoffState, actorId: string, occurredAt: string, observedSha256: string | null, envelopeSha256: string | null, reason: string) {
    const prior = this.#events.at(-1)?.event_sha256 ?? null;
    const body = {
      schema_version: EVIDENCE_HANDOFF_SCHEMA,
      sequence: this.#events.length + 1,
      event_id: `evidence.handoff.event.${String(this.#events.length + 1).padStart(8, "0")}`,
      event_kind: kind,
      handoff_id: record.manifest.handoff_id,
      package_version: record.manifest.package_version,
      prior_state: priorState,
      state,
      actor_id: humanTrustIdSchema.parse(actorId),
      occurred_at: isoTimestampSchema.parse(occurredAt),
      package_manifest_sha256: record.manifest.manifest_sha256,
      observed_manifest_sha256: observedSha256,
      envelope_sha256: envelopeSha256,
      reason_code: reasonCode.parse(reason),
      prior_event_sha256: prior,
    } as const;
    const event = frozen({ ...body, event_sha256: legalOperationsSha256(body) }) as EvidenceHandoffEvent;
    this.#events.push(event);
    record.events.push(event);
    return event;
  }
}
