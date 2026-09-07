import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ rpc: vi.fn(), info: vi.fn(), download: vi.fn(), sign: vi.fn(), remove: vi.fn() }));
vi.mock("../case-access/db", () => ({ resolveCaseAccessDb: async () => ({ rpc: fake.rpc }) }));
vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: () => ({ storage: { from: () => ({ info: fake.info, download: fake.download, createSignedUploadUrl: fake.sign, remove: fake.remove }) } }) }));
import { completeUpload, prepareUpload } from "./upload";
import type { DocumentUpload } from "@/lib/document-upload";
const bytes = new TextEncoder().encode("%PDF-1.7\nsynthetic-test-only\n%%EOF");
const digest = createHash("sha256").update(bytes).digest("hex");
const caseId = "11111111-1111-4111-8111-111111111111";
const batchId = "22222222-2222-4222-8222-222222222222";
const file = { clientId: batchId, documentType: "payslip", name: "second.pdf", type: "application/pdf", size: bytes.length, sha256: digest, periodMonth: "2026-08" } as const;
const reserved = { ...file, documentId: "second", versionId: "new-version", slot: "payslip-02", path: `cases/${caseId}/versions/new-version.pdf` };
const snapshot = { documents: [{ id: "first", storage_path: "legacy/first.pdf" }, { id: "contract", storage_path: "legacy/contract.pdf" }, { id: "second", storage_path: reserved.path }] };
let batch: { id: string; files: typeof reserved[]; completed_at: string | null; cancelled_at: string | null; expires_at: string };
beforeEach(() => {
  vi.clearAllMocks();
  batch = { id: batchId, files: [reserved], completed_at: null, cancelled_at: null, expires_at: "2099-01-01T00:00:00Z" };
  fake.rpc.mockImplementation(async (fn: string) => [{ value: fn === "case_documents_commit" || fn === "case_documents_snapshot" ? snapshot : batch }]);
  fake.info.mockResolvedValue({ data: null, error: { statusCode: "404" } });
  fake.sign.mockResolvedValue({ data: { signedUrl: "https://synthetic.invalid/upload" }, error: null });
  fake.download.mockResolvedValue({ data: new Blob([bytes], { type: "application/pdf" }), error: null });
});
describe("immutable upload/storage boundary", () => {
  it("regression: adding a second payslip preserves first and contract; never deletes storage", async () => {
    expect(await completeUpload(caseId, batchId)).toEqual(snapshot);
    expect(fake.download).toHaveBeenCalledExactlyOnceWith(reserved.path);
    expect(fake.rpc).toHaveBeenLastCalledWith("case_documents_commit", { target_case: caseId, target_batch: batchId, target_checks: { "new-version": digest } });
    expect(fake.remove).not.toHaveBeenCalled();
  });
  it("signs only server-reserved immutable paths, never enables upsert", async () => {
    await prepareUpload({ caseId, batchId, files: [file] });
    expect(fake.sign).toHaveBeenCalledExactlyOnceWith(reserved.path, { upsert: false });
  });
  it("a lost PUT response is recovered without writing the object again", async () => {
    fake.info.mockResolvedValue({ data: { size: bytes.length }, error: null });
    const result = await prepareUpload({ caseId, batchId, files: [file] });
    expect(result.uploads).toEqual([{ clientId: batchId, uploaded: true }]);
    expect(fake.sign).not.toHaveBeenCalled();
    await completeUpload(caseId, batchId);
    expect(fake.remove).not.toHaveBeenCalled();
  });
  it.each([
    ["missing object", null],
    ["wrong size", new Blob([bytes.slice(0, 8)], { type: "application/pdf" })],
    ["wrong MIME", new Blob([bytes], { type: "image/png" })],
    ["wrong digest", new Blob([new Uint8Array(bytes.length).fill(0x20)], { type: "application/pdf" })],
  ])("%s cannot commit or remove the previous object", async (_, blob) => {
    fake.download.mockResolvedValue({ data: blob, error: blob ? null : { statusCode: "404" } });
    await expect(completeUpload(caseId, batchId)).rejects.toThrow(/UPLOAD_/u);
    expect(fake.rpc.mock.calls.map((call) => call[0])).not.toContain("case_documents_commit");
    expect(fake.remove).not.toHaveBeenCalled();
  });
  it("matching digest with a false document signature is still refused", async () => {
    const invalid = new Uint8Array(bytes.length).fill(0x20);
    batch.files = [{ ...reserved, sha256: createHash("sha256").update(invalid).digest("hex") }];
    fake.download.mockResolvedValue({ data: new Blob([invalid], { type: "application/pdf" }), error: null });
    await expect(completeUpload(caseId, batchId)).rejects.toThrow("UPLOAD_INVALID_FILE");
  });
  it("a failed transaction never deletes or rewrites storage and can be retried", async () => {
    fake.rpc.mockImplementationOnce(async () => [{ value: batch }]).mockRejectedValueOnce(new Error("database disconnected"));
    await expect(completeUpload(caseId, batchId)).rejects.toThrow("UPLOAD_UNAVAILABLE");
    expect(fake.remove).not.toHaveBeenCalled(); expect(fake.sign).not.toHaveBeenCalled();
    await expect(completeUpload(caseId, batchId)).resolves.toEqual(snapshot);
  });
  it("a committed retry neither requires nor accesses uploaded bytes", async () => {
    batch.completed_at = new Date().toISOString();
    await expect(completeUpload(caseId, batchId)).resolves.toEqual(snapshot);
    expect(fake.download).not.toHaveBeenCalled();
    expect((await prepareUpload({ caseId, batchId, files: [file] } as DocumentUpload)).completed).toBe(true);
    expect(fake.sign).not.toHaveBeenCalled();
  });
  it("permission refusal happens before any storage access", async () => {
    fake.rpc.mockRejectedValue(new Error("UPLOAD_FORBIDDEN"));
    await expect(completeUpload(caseId, batchId)).rejects.toMatchObject({ status: 403 });
    await expect(prepareUpload({ caseId, batchId, files: [file] })).rejects.toMatchObject({ status: 403 });
    expect(fake.info).not.toHaveBeenCalled(); expect(fake.download).not.toHaveBeenCalled();
  });
});
