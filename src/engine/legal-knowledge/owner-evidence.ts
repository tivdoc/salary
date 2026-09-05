// L11-1 / D1 (run 11). Owner evidence, by exception.
//
// Two files a labour lawyer approved on 5 September 2026 — the opinion on the
// six open legal decisions and the record of its approval — are stored as
// evidence artifacts through the same immutable artifact path every legal
// source goes through: bytes under the artifact root, addressed by sha256,
// with a ledger record that names the acquisition time and the grade.
//
// The grade is `owner_evidence` and it is deliberately NOT a provenance grade.
// A parameter cites a source of the law; an opinion about the law is evidence
// of what the owner decided, and no citation may point at it. The test beside
// this file proves `owner_evidence` is outside `PROVENANCE_GRADES`.
//
// Before anything else is done with the files, the opinion's sha256 must equal
// the value the approval record names. A mismatch is `BLOCKED_EVIDENCE_MISMATCH`
// and the run stops there — nothing is stored, nothing is recorded.
import { createHash } from "node:crypto";
import { z } from "zod";
import { PROVENANCE_GRADES } from "./visual-citation-v1.ts";

export const OWNER_EVIDENCE_SOURCE_GRADE = "owner_evidence" as const;
export const OWNER_EVIDENCE_SOURCE_VERSION = "owner-evidence-2026-09-05" as const;
export const OWNER_EVIDENCE_MEDIA_TYPE = "text/markdown" as const;
export const OWNER_EVIDENCE_RECORD_SCHEMA = "tivdoc-owner-evidence-record-v1" as const;
export const BLOCKED_EVIDENCE_MISMATCH = "BLOCKED_EVIDENCE_MISMATCH" as const;

/** The opinion's sha256 as the approval record names it. Pinned; never recomputed from the file. */
export const LEGAL_OPINION_SHA256 = "3ddad7e8c9fd81ec9715e84b3df65e9d780cc06ec09072eab4c6b73740acad6e" as const;
export const LEGAL_OPINION_BYTE_COUNT = 50_165 as const;
/** The approval record's own sha256, taken once when it was read on 5.9.2026. */
export const APPROVAL_RECORD_SHA256 = "0258b6400040b156d246b84900a6db353d3f62aa0089816063a8ba42639234d4" as const;
export const APPROVAL_RECORD_BYTE_COUNT = 9_200 as const;
export const APPROVED_ON = "2026-09-05" as const;

if ((PROVENANCE_GRADES as readonly string[]).includes(OWNER_EVIDENCE_SOURCE_GRADE)) {
  throw new Error("OWNER_EVIDENCE_GRADE_MUST_NOT_BE_A_PROVENANCE_GRADE");
}

export type OwnerEvidenceKey = "legal_opinion" | "approval_record";

export type OwnerEvidenceExpectation = Readonly<{
  key: OwnerEvidenceKey;
  source_id: string;
  filename: string;
  sha256: string;
  byte_count: number;
  role: "lawyer_approved_opinion" | "approval_record";
}>;

export const OWNER_EVIDENCE_FILES: readonly OwnerEvidenceExpectation[] = Object.freeze([
  {
    key: "legal_opinion",
    source_id: "IL_OWNER_EVIDENCE_LEGAL_OPINION_2026_09_05",
    filename: "tivdoc-open-decisions-legal-opinion.md",
    sha256: LEGAL_OPINION_SHA256,
    byte_count: LEGAL_OPINION_BYTE_COUNT,
    role: "lawyer_approved_opinion",
  },
  {
    key: "approval_record",
    source_id: "IL_OWNER_EVIDENCE_APPROVAL_RECORD_2026_09_05",
    filename: "tivdoc-legal-opinion-approval-record.md",
    sha256: APPROVAL_RECORD_SHA256,
    byte_count: APPROVAL_RECORD_BYTE_COUNT,
    role: "approval_record",
  },
]);

export const ownerEvidenceRecordSchema = z.object({
  schema_version: z.literal(OWNER_EVIDENCE_RECORD_SCHEMA),
  key: z.enum(["legal_opinion", "approval_record"]),
  source_id: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{2,79}$/u),
  source_version: z.literal(OWNER_EVIDENCE_SOURCE_VERSION),
  artifact_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  byte_count: z.number().int().positive(),
  media_type: z.literal(OWNER_EVIDENCE_MEDIA_TYPE),
  original_filename: z.string().min(1),
  acquired_at: z.string().datetime(),
  source_grade: z.literal(OWNER_EVIDENCE_SOURCE_GRADE),
  acquisition_method: z.literal("owner_supplied_file"),
  artifact_path: z.string().min(1),
  role: z.enum(["lawyer_approved_opinion", "approval_record"]),
  approved_on: z.literal(APPROVED_ON),
  // What this record is not: the lawyer has no reviewer identity, and storing
  // the files attests nothing.
  approver_identity: z.null(),
  attestation: z.literal("none"),
  citable_as_source: z.literal(false),
}).strict().readonly();

export type OwnerEvidenceRecord = z.infer<typeof ownerEvidenceRecordSchema>;

export type OwnerEvidenceMismatch = Readonly<{
  key: OwnerEvidenceKey;
  reason: "sha256" | "byte_count" | "approval_record_does_not_name_opinion_sha256";
  expected: string;
  observed: string;
}>;

export type OwnerEvidenceVerification =
  | Readonly<{ ok: true; verified: readonly Readonly<{ key: OwnerEvidenceKey; sha256: string; byte_count: number }>[] }>
  | Readonly<{ ok: false; code: typeof BLOCKED_EVIDENCE_MISMATCH; mismatches: readonly OwnerEvidenceMismatch[] }>;

export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * The gate. Every expected file's bytes are hashed and compared with the
 * pinned digest and byte count, and the approval record must name the
 * opinion's digest in its own text. Any mismatch is the one refusal code;
 * all mismatches are listed, none is hidden behind the first.
 */
export function verifyOwnerEvidence(
  bytesByKey: Readonly<Record<OwnerEvidenceKey, Uint8Array>>,
  expectations: readonly OwnerEvidenceExpectation[] = OWNER_EVIDENCE_FILES,
): OwnerEvidenceVerification {
  const mismatches: OwnerEvidenceMismatch[] = [];
  const verified: Array<{ key: OwnerEvidenceKey; sha256: string; byte_count: number }> = [];
  for (const expected of expectations) {
    const bytes = bytesByKey[expected.key];
    const observed = sha256Hex(bytes);
    if (observed !== expected.sha256) mismatches.push({ key: expected.key, reason: "sha256", expected: expected.sha256, observed });
    if (bytes.byteLength !== expected.byte_count) {
      mismatches.push({ key: expected.key, reason: "byte_count", expected: String(expected.byte_count), observed: String(bytes.byteLength) });
    }
    verified.push({ key: expected.key, sha256: observed, byte_count: bytes.byteLength });
  }
  const opinion = expectations.find((entry) => entry.key === "legal_opinion");
  const record = bytesByKey.approval_record;
  if (opinion && record && !Buffer.from(record).toString("utf8").includes(opinion.sha256)) {
    mismatches.push({ key: "approval_record", reason: "approval_record_does_not_name_opinion_sha256", expected: opinion.sha256, observed: "absent" });
  }
  if (mismatches.length > 0) return Object.freeze({ ok: false, code: BLOCKED_EVIDENCE_MISMATCH, mismatches: Object.freeze(mismatches) });
  return Object.freeze({ ok: true, verified: Object.freeze(verified) });
}

/** The ledger record for one stored file. Pure: the path and the time are handed in. */
export function ownerEvidenceRecord(input: Readonly<{
  expectation: OwnerEvidenceExpectation;
  acquired_at: string;
  artifact_path: string;
}>): OwnerEvidenceRecord {
  return ownerEvidenceRecordSchema.parse({
    schema_version: OWNER_EVIDENCE_RECORD_SCHEMA,
    key: input.expectation.key,
    source_id: input.expectation.source_id,
    source_version: OWNER_EVIDENCE_SOURCE_VERSION,
    artifact_sha256: input.expectation.sha256,
    byte_count: input.expectation.byte_count,
    media_type: OWNER_EVIDENCE_MEDIA_TYPE,
    original_filename: input.expectation.filename,
    acquired_at: input.acquired_at,
    source_grade: OWNER_EVIDENCE_SOURCE_GRADE,
    acquisition_method: "owner_supplied_file",
    artifact_path: input.artifact_path,
    role: input.expectation.role,
    approved_on: APPROVED_ON,
    approver_identity: null,
    attestation: "none",
    citable_as_source: false,
  });
}
