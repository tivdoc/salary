import { expect, it } from "vitest";
import { documentUploadSchema, matchesDocumentSignature, uploadNextPath } from "./document-upload";
const id = "11111111-1111-4111-8111-111111111111";
const contract = { clientId: id, documentType: "contract", name: "contract.pdf", type: "application/pdf", size: 10, sha256: "a".repeat(64) };
const input = { caseId: id, batchId: id, files: [contract] };
it("accepts contract-only batches; payslip and month requirements are evaluated against the saved case by SQL", () => {
  expect(documentUploadSchema.safeParse(input).success).toBe(true);
});
it("rejects caller-controlled slots, paths, duplicate client ids and duplicate replacement targets", () => {
  expect(documentUploadSchema.safeParse({ ...input, files: [{ ...contract, slot: "contract" }] }).success).toBe(false);
  expect(documentUploadSchema.safeParse({ ...input, files: [{ ...contract, path: "other-case/file" }] }).success).toBe(false);
  expect(documentUploadSchema.safeParse({ ...input, files: [contract, contract] }).success).toBe(false);
  const replacement = { documentId: id, versionId: id };
  expect(documentUploadSchema.safeParse({ ...input, files: [{ ...contract, replace: replacement }, { ...contract, clientId: "22222222-2222-4222-8222-222222222222", replace: replacement }] }).success).toBe(false);
});
it("requires payslip month, bounded sizes, approved MIME and a checksum", () => {
  for (const change of [{ size: 10485761 }, { type: "text/html" }, { sha256: "" }, { documentType: "payslip" }, { periodMonth: "2026-08" }]) {
    expect(documentUploadSchema.safeParse({ ...input, files: [{ ...contract, ...change }] }).success).toBe(false);
  }
});
it("recognizes all supported signatures and rejects arbitrary bytes", () => {
  expect(matchesDocumentSignature(new Uint8Array([0xff, 0xd8, 0xff, 0]), "image/jpeg")).toBe(true);
  expect(matchesDocumentSignature(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]), "image/png")).toBe(true);
  expect(matchesDocumentSignature(new TextEncoder().encode("%PDF-1.7"), "application/pdf")).toBe(true);
  expect(matchesDocumentSignature(new TextEncoder().encode("<html>"), "application/pdf")).toBe(false);
});
it("paid, pending and refunded cases return to the case instead of checkout", () => {
  for (const status of ["payment_pending", "paid", "under_review", "completed"]) expect(uploadNextPath({ status, paymentStatus: "verified", publicId: "TV-SYNTH001" })).toBe("/case/TV-SYNTH001/documents");
  expect(uploadNextPath({ status: "documents_uploaded", paymentStatus: "refunded", publicId: "TV-SYNTH001" })).toBe("/case/TV-SYNTH001/documents");
  expect(uploadNextPath({ status: "documents_uploaded", paymentStatus: "not_started", publicId: "TV-SYNTH001" })).toBe("/check/payment");
});
