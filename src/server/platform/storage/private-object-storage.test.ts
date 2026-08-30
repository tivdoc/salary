import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { CommandEnvelope, ObjectRetentionClass, VerifiedActor } from "../../../engine/wave4/contracts";
import { InMemoryHashChainAudit } from "../audit/hash-chain";
import { LocalPrivateObjectStorage } from "./private-object-storage";

const roots: string[] = [];
const actor: VerifiedActor = Object.freeze({ actor_id: "actor_00000001", role: "fact_reviewer", tenant_id: "tenant_0000001", assigned_case_ids: ["case_000000001"], verified_server_side: true, break_glass_reason: null, break_glass_expires_at: null });

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function command<T>(payload: T, index = 1, expectedRevision = 0): CommandEnvelope<T> {
  return Object.freeze({ command_id: `command_0000000${index}`, idempotency_key: `idempotency_000${index}`, expected_revision: expectedRevision, actor, reason: "STORAGE_WRITE", payload });
}

async function harness(now: { value: number }) {
  const root = await mkdtemp(join(tmpdir(), "tivdoc-storage-"));
  roots.push(root);
  const audit = new InMemoryHashChainAudit();
  const storage = new LocalPrivateObjectStorage({ root, environment: "generated_local_test_root", audit, nowMs: () => now.value, authorizeRead: (candidate, _version, scope) => candidate.actor_id === actor.actor_id && scope === "case_000000001" });
  return { storage, audit };
}

async function writeObject(storage: LocalPrivateObjectStorage, bytes: Uint8Array, mime = "application/octet-stream", index = 1, retention: ObjectRetentionClass = "case_record") {
  const reservation = await storage.reserve(command({ expected_sha256: hash(bytes), expected_length: bytes.byteLength, detected_mime: mime, retention_class: retention }, index));
  await storage.stage(reservation, (async function* () { yield bytes.subarray(0, 1); yield bytes.subarray(1); })());
  return storage.finalize(reservation);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("V07-P2-STORAGE", () => {
  it("reserves, stream-verifies, quarantines before finalization and reads by short private grant", async () => {
    const now = { value: Date.parse("2026-08-30T00:00:00.000Z") };
    const { storage, audit } = await harness(now);
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const finalized = await writeObject(storage, bytes);
    expect(storage.metadata(finalized.object_version_id)).toMatchObject({ status: "active", sha256: hash(bytes), legal_hold: false });
    const grant = await storage.issuePrivateGrant({ actor, version_id: finalized.object_version_id, scope_ref: "case_000000001", ttl_ms: 60_000 });
    expect(await storage.readWithGrant(grant.token, actor, "case_000000001")).toEqual(bytes);
    expect((await audit.verify()).valid).toBe(true);
    expect(JSON.stringify(storage.metadata(finalized.object_version_id))).not.toContain(rootMarker());
  });

  it("denies unauthorized, wrong-scope and expired grants with one non-enumerating error", async () => {
    const now = { value: Date.parse("2026-08-30T00:00:00.000Z") };
    const { storage } = await harness(now);
    const finalized = await writeObject(storage, Uint8Array.from([1, 2]));
    await expect(storage.issuePrivateGrant({ actor: { ...actor, actor_id: "actor_00000002" }, version_id: finalized.object_version_id, scope_ref: "case_000000001", ttl_ms: 1_000 })).rejects.toThrow("PRIVATE_OBJECT_ACCESS_DENIED");
    const grant = await storage.issuePrivateGrant({ actor, version_id: finalized.object_version_id, scope_ref: "case_000000001", ttl_ms: 1_000 });
    await expect(storage.readWithGrant(grant.token, actor, "case_000000002")).rejects.toThrow("PRIVATE_OBJECT_ACCESS_DENIED");
    now.value += 1_001;
    await expect(storage.readWithGrant(grant.token, actor, "case_000000001")).rejects.toThrow("PRIVATE_OBJECT_ACCESS_DENIED");
    await expect(storage.readWithGrant("grant_unknown_0001", actor, "case_000000001")).rejects.toThrow("PRIVATE_OBJECT_ACCESS_DENIED");
  });

  it("rejects checksum, length, MIME spoofing and active or malformed PDFs", async () => {
    const now = { value: Date.now() };
    const { storage } = await harness(now);
    const bytes = Uint8Array.from([1, 2]);
    const badHash = await storage.reserve(command({ expected_sha256: "a".repeat(64), expected_length: 2, detected_mime: "application/octet-stream", retention_class: "temporary" }));
    await expect(storage.stage(badHash, (async function* () { yield bytes; })())).rejects.toThrow("PRIVATE_OBJECT_CHECKSUM_MISMATCH");

    const json = new TextEncoder().encode("not-json");
    const jsonReservation = await storage.reserve(command({ expected_sha256: hash(json), expected_length: json.byteLength, detected_mime: "application/json", retention_class: "temporary" }, 2));
    await expect(storage.stage(jsonReservation, (async function* () { yield json; })())).rejects.toThrow("PRIVATE_OBJECT_JSON_INVALID");

    const activePdf = new TextEncoder().encode("%PDF-1.7\n1 0 obj <</OpenAction 2 0 R>> endobj\n%%EOF");
    const pdfReservation = await storage.reserve(command({ expected_sha256: hash(activePdf), expected_length: activePdf.byteLength, detected_mime: "application/pdf", retention_class: "temporary" }, 3));
    await expect(storage.stage(pdfReservation, (async function* () { yield activePdf; })())).rejects.toThrow("PRIVATE_OBJECT_PDF_ACTIVE_CONTENT");

    const spoofed = await storage.reserve(command({ expected_sha256: hash(activePdf), expected_length: activePdf.byteLength, detected_mime: "application/octet-stream", retention_class: "temporary" }, 4));
    await expect(storage.stage(spoofed, (async function* () { yield activePdf; })())).rejects.toThrow("PRIVATE_OBJECT_MIME_MISMATCH");

    for (const [index, marker] of ["/Encrypt true", "/URI (https://example.test)", "/EmbeddedFile true"].entries()) {
      const dangerous = new TextEncoder().encode(`%PDF-1.7\n1 0 obj <<${marker}>> endobj\n%%EOF`);
      const reservation = await storage.reserve(command({ expected_sha256: hash(dangerous), expected_length: dangerous.byteLength, detected_mime: "application/pdf", retention_class: "temporary" }, 5 + index));
      await expect(storage.stage(reservation, (async function* () { yield dangerous; })())).rejects.toThrow("PRIVATE_OBJECT_PDF_ACTIVE_CONTENT");
    }

    const malformed = new TextEncoder().encode("%PDF-1.7\nmissing terminator");
    const malformedReservation = await storage.reserve(command({ expected_sha256: hash(malformed), expected_length: malformed.byteLength, detected_mime: "application/pdf", retention_class: "temporary" }, 8));
    await expect(storage.stage(malformedReservation, (async function* () { yield malformed; })())).rejects.toThrow("PRIVATE_OBJECT_PDF_MALFORMED");

    const bomb = new TextEncoder().encode(`%PDF-1.7\n${"1 0 obj endobj\n".repeat(10_001)}%%EOF`);
    const bombReservation = await storage.reserve(command({ expected_sha256: hash(bomb), expected_length: bomb.byteLength, detected_mime: "application/pdf", retention_class: "temporary" }, 9));
    await expect(storage.stage(bombReservation, (async function* () { yield bomb; })())).rejects.toThrow("PRIVATE_OBJECT_PDF_RESOURCE_LIMIT");
  });

  it("rejects caller-supplied path/bucket fields instead of trusting names or extensions", async () => {
    const now = { value: Date.now() };
    const { storage } = await harness(now);
    const bytes = Uint8Array.from([1]);
    await expect(storage.reserve(command({
      expected_sha256: hash(bytes),
      expected_length: bytes.byteLength,
      detected_mime: "application/octet-stream",
      retention_class: "temporary",
      path: "../escape",
      bucket: "public",
    } as never))).rejects.toThrow("PRIVATE_OBJECT_RESERVATION_FIELD_FORBIDDEN");
  });

  it("enforces immutable content, quarantine visibility, retention hold and audited tombstone", async () => {
    const now = { value: Date.now() };
    const { storage } = await harness(now);
    const bytes = Uint8Array.from([4, 5, 6]);
    const finalized = await writeObject(storage, bytes);
    const duplicate = await storage.reserve(command({ expected_sha256: hash(bytes), expected_length: bytes.byteLength, detected_mime: "application/octet-stream", retention_class: "case_record" }, 2));
    await storage.stage(duplicate, (async function* () { yield bytes; })());
    await expect(storage.finalize(duplicate)).rejects.toThrow("PRIVATE_OBJECT_IMMUTABLE_EXISTS");
    const quarantine = command({ cause_code: "CORRUPTION_SUSPECTED" }, 3, 1);
    await storage.quarantine(finalized.object_version_id, quarantine);
    await storage.quarantine(finalized.object_version_id, quarantine);
    await expect(storage.issuePrivateGrant({ actor, version_id: finalized.object_version_id, scope_ref: "case_000000001", ttl_ms: 1_000 })).rejects.toThrow("PRIVATE_OBJECT_ACCESS_DENIED");

    const other = await writeObject(storage, Uint8Array.from([7, 8]), "application/octet-stream", 4);
    await storage.setLegalHold(other.object_version_id, true, command({ held: true }, 5, 1));
    await expect(storage.tombstone(other.object_version_id, command({ retention_complete: true as const }, 6, 2))).rejects.toThrow("PRIVATE_OBJECT_LEGAL_HOLD");
    await storage.setLegalHold(other.object_version_id, false, command({ held: false }, 7, 2));
    const tombstone = command({ retention_complete: true as const }, 8, 3);
    await storage.tombstone(other.object_version_id, tombstone);
    await storage.tombstone(other.object_version_id, tombstone);
    expect(storage.metadata(other.object_version_id)?.status).toBe("tombstoned");
  });

  it("reconciles only old staging records and never changes visible objects", async () => {
    const now = { value: 1_000_000 };
    const { storage } = await harness(now);
    const bytes = Uint8Array.from([1]);
    await storage.reserve(command({ expected_sha256: hash(bytes), expected_length: 1, detected_mime: "application/octet-stream", retention_class: "temporary" }));
    now.value += 120_000;
    expect(storage.reconcileStaging({ older_than_ms: 60_000, dry_run: true })).toMatchObject({ removed: 0, visible_objects_changed: 0 });
    expect(storage.reconcileStaging({ older_than_ms: 60_000, dry_run: false })).toMatchObject({ removed: 1, visible_objects_changed: 0 });
  });
});

function rootMarker(): string {
  return "tivdoc-storage-";
}
