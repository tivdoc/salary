import { expect, it } from "vitest";
import { documentUploadSchema, matchesDocumentSignature, uploadNextPath,selectedSourceIntakeUpload,type UploadSnapshot } from "./document-upload";
import { documentTypes } from "./validation";
const id = "11111111-1111-4111-8111-111111111111";
const contract = { clientId: id, documentType: "contract", name: "contract.pdf", type: "application/pdf", size: 10, sha256: "a".repeat(64) };
const input = { caseId: id, batchId: id, files: [contract] };
it.each([null,'2026-06'])('selects only server-listed intake metadata for month %s without putting month in the manifest marker',month=>{
 const snapshot:UploadSnapshot={caseId:id,publicId:'TV-SYNTH001',status:'documents_uploaded',paymentStatus:'not_started',checkPeriodMonth:null,documents:[],requests:[{
  id,code:'legacy.source.document:order',question:'מקור',documentType:'payslip',sourceIntake:{policy:'legacy-source-intake-v1',target_sha256:'c'.repeat(64),month}}]};
 expect(selectedSourceIntakeUpload(snapshot,id)).toEqual({policy:'legacy-source-intake-v1',target_sha256:'c'.repeat(64)});
 expect(()=>selectedSourceIntakeUpload({...snapshot,requests:[{...snapshot.requests[0],sourceIntake:undefined}]},id)).toThrow('UPLOAD_REQUEST_CONFLICT');
 expect(selectedSourceIntakeUpload({...snapshot,requests:[{...snapshot.requests[0],code:'document_review:old'}]},id)).toBeNull();
});
it('allows a monthless payslip only for explicit identified legacy source intake while preserving ordinary manifests',()=>{
 const sourceIntake={policy:'legacy-source-intake-v1',target_sha256:'c'.repeat(64)},candidate={...input,requestId:id,sourceIntake,files:[{...contract,documentType:'payslip'}]};
 expect(documentUploadSchema.parse(candidate)).toEqual(candidate);
 for(const change of [{requestId:undefined},{checkPeriodMonth:'2026-06'},{files:[{...candidate.files[0],periodMonth:'2026-06'}]},
  {sourceIntake:{...sourceIntake,month:'2026-06'}},{files:[{...contract,documentType:'other'}]}])expect(documentUploadSchema.safeParse({...candidate,...change}).success).toBe(false);
 expect(documentUploadSchema.parse(input)).toEqual(input);
});
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

const tariff = { ...contract, documentType: "other", evidencePurpose: { kind: "travel_tariff", month: "2026-07", page: 2, locator: "טבלת כרטיסי נסיעה" } };
it("adds a bounded PDF purpose without widening historical document types or rewriting old manifests", () => {
  expect(documentTypes).toEqual(["payslip", "contract", "attendance"]);
  expect(documentUploadSchema.parse(input)).toEqual(input);
  expect(documentUploadSchema.parse({ ...input, files: [tariff] }).files[0]).toEqual(tariff);
});
it("rejects tariff month, page and purpose tampering, and preserves payslip-only periodMonth", () => {
  const invalid = [
    { ...tariff, evidencePurpose: undefined }, { ...tariff, type: "image/png" },
    { ...tariff, periodMonth: "2026-07" }, { ...contract, evidencePurpose: tariff.evidencePurpose },
    ...[{ month: "2026-04" }, { month: "2026-08" }, { page: 0 }, { page: 101 }, { page: 1.5 }, { locator: " " }, { locator: "x".repeat(121) }, { kind: "contract" }, { page_count: 2 }, { identity_id: id }]
      .map(change => ({ ...tariff, evidencePurpose: { ...tariff.evidencePurpose, ...change } })),
  ];
  for (const row of invalid) expect(documentUploadSchema.safeParse({ ...input, files: [row] }).success).toBe(false);
  expect(documentUploadSchema.safeParse({ ...input, target_identity: id, files: [tariff] }).success).toBe(false);
});
it("retains the 14-file batch limit and allows at most 12 tariff slots", () => {
  const rows = Array.from({ length: 13 }, (_, index) => ({ ...tariff, clientId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}` }));
  expect(documentUploadSchema.safeParse({ ...input, files: rows.slice(0, 12) }).success).toBe(true);
  expect(documentUploadSchema.safeParse({ ...input, files: rows }).success).toBe(false);
});
