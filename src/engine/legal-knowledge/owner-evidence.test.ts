import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  APPROVAL_RECORD_SHA256,
  BLOCKED_EVIDENCE_MISMATCH,
  LEGAL_OPINION_SHA256,
  OWNER_EVIDENCE_FILES,
  OWNER_EVIDENCE_SOURCE_GRADE,
  ownerEvidenceRecord,
  ownerEvidenceRecordSchema,
  verifyOwnerEvidence,
  type OwnerEvidenceExpectation,
} from "./owner-evidence.ts";
import { PROVENANCE_GRADES } from "./visual-citation-v1.ts";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// Synthetic stand-ins: the real files are not copied into the repository, so
// the gate is exercised on bytes made here whose digests are computed here.
const opinionBytes = Buffer.from("# synthetic opinion\nsix decisions, none attested\n", "utf8");
const opinionSha = sha(opinionBytes);
const recordBytes = Buffer.from(`# synthetic approval record\nopinion sha256: ${opinionSha}\n`, "utf8");
const synthetic: readonly OwnerEvidenceExpectation[] = [
  { ...OWNER_EVIDENCE_FILES[0], sha256: opinionSha, byte_count: opinionBytes.byteLength },
  { ...OWNER_EVIDENCE_FILES[1], sha256: sha(recordBytes), byte_count: recordBytes.byteLength },
];

describe("L11-1 / D1: owner evidence is stored by exception and never becomes a source", () => {
  it("owner_evidence is not a provenance grade — no parameter citation can carry it", () => {
    expect((PROVENANCE_GRADES as readonly string[]).includes(OWNER_EVIDENCE_SOURCE_GRADE)).toBe(false);
  });

  it("pins the opinion's digest and the approval record's digest as constants, not as files", () => {
    expect(LEGAL_OPINION_SHA256).toMatch(/^[a-f0-9]{64}$/u);
    expect(APPROVAL_RECORD_SHA256).toMatch(/^[a-f0-9]{64}$/u);
    expect(OWNER_EVIDENCE_FILES.map((entry) => entry.key)).toEqual(["legal_opinion", "approval_record"]);
    expect(new Set(OWNER_EVIDENCE_FILES.map((entry) => entry.source_id)).size).toBe(2);
  });

  it("accepts bytes whose digests and byte counts match, when the record names the opinion's digest", () => {
    const result = verifyOwnerEvidence({ legal_opinion: opinionBytes, approval_record: recordBytes }, synthetic);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.verified.map((entry) => entry.key)).toEqual(["legal_opinion", "approval_record"]);
  });

  it("refuses with BLOCKED_EVIDENCE_MISMATCH when the opinion's bytes differ from the recorded digest, listing every mismatch", () => {
    const tampered = Buffer.concat([opinionBytes, Buffer.from(" ", "utf8")]);
    const result = verifyOwnerEvidence({ legal_opinion: tampered, approval_record: recordBytes }, synthetic);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(BLOCKED_EVIDENCE_MISMATCH);
      expect(result.mismatches.map((entry) => `${entry.key}:${entry.reason}`)).toEqual(["legal_opinion:sha256", "legal_opinion:byte_count"]);
    }
  });

  it("refuses when the approval record does not name the opinion's digest", () => {
    const silent = Buffer.from("# synthetic approval record without a digest\n", "utf8");
    const expectations: readonly OwnerEvidenceExpectation[] = [synthetic[0], { ...synthetic[1], sha256: sha(silent), byte_count: silent.byteLength }];
    const result = verifyOwnerEvidence({ legal_opinion: opinionBytes, approval_record: silent }, expectations);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.mismatches.map((entry) => entry.reason)).toEqual(["approval_record_does_not_name_opinion_sha256"]);
  });

  it("refuses random bytes against the real pins — the pins are the record, not the file", () => {
    const noise = Buffer.from("not the opinion", "utf8");
    const result = verifyOwnerEvidence({ legal_opinion: noise, approval_record: noise });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.mismatches.some((entry) => entry.key === "legal_opinion" && entry.expected === LEGAL_OPINION_SHA256)).toBe(true);
  });

  it("the ledger record carries the grade, the time, the bytes' digest, and says it attests nothing", () => {
    const record = ownerEvidenceRecord({ expectation: synthetic[0], acquired_at: "2026-09-05T12:00:00.000Z", artifact_path: "eval/legal-knowledge/artifacts/X/v/x.md" });
    expect(ownerEvidenceRecordSchema.parse(record)).toEqual(record);
    expect(record.source_grade).toBe("owner_evidence");
    expect(record.approver_identity).toBeNull();
    expect(record.attestation).toBe("none");
    expect(record.citable_as_source).toBe(false);
    expect(record.artifact_sha256).toBe(opinionSha);
  });
});
