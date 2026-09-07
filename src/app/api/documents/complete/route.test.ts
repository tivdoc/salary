import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ caseId: vi.fn(), complete: vi.fn(), cancel: vi.fn(), prepare: vi.fn(), event: vi.fn() }));
vi.mock("@/lib/case-cookie", () => ({ readCaseIdFromCookie: mocks.caseId }));
vi.mock("@/lib/funnel-server", () => ({ recordCaseFunnelEvent: mocks.event }));
vi.mock("@/server/product/documents/upload", async (original) => ({ ...(await original<object>()), completeUpload: mocks.complete, cancelUpload: mocks.cancel, prepareUpload: mocks.prepare }));
vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/server/platform/capabilities/stable-http-entrypoint", () => ({ guardStableHttpEntrypoint: async () => {} }));
const caseId = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const batchId = "33333333-3333-4333-8333-333333333333";
const req = (body: unknown) => new Request("http://localhost/api/documents/complete", { method: "POST", body: JSON.stringify(body) });
beforeEach(() => {
  vi.clearAllMocks(); mocks.caseId.mockResolvedValue(caseId);
  mocks.complete.mockResolvedValue({ caseId, publicId: "TV-SYNTH001", status: "under_review", paymentStatus: "verified", documents: [{ id: "first" }, { id: "contract" }, { id: "second" }] });
  mocks.event.mockResolvedValue(undefined);
});
describe("document HTTP boundaries", () => {
  it("completes by owned batch id and returns actual persisted state and paid destination", async () => {
    const { POST } = await import("./route");
    const response = await POST(req({ caseId, batchId }));
    expect(response.status).toBe(200);
    expect(mocks.complete).toHaveBeenCalledExactlyOnceWith(caseId, batchId);
    expect(await response.json()).toMatchObject({ next: "/case/TV-SYNTH001/documents", documents: [{ id: "first" }, { id: "contract" }, { id: "second" }] });
  });
  it("refuses absent cookie and mismatching case without touching storage or DB", async () => {
    const { POST } = await import("./route");
    expect((await POST(req({ caseId: other, batchId }))).status).toBe(403);
    mocks.caseId.mockResolvedValue(null);
    expect((await POST(req({ caseId, batchId }))).status).toBe(401);
    expect(mocks.complete).not.toHaveBeenCalled();
  });
  it("rejects client-supplied paths and legacy slot manifests", async () => {
    const { POST } = await import("./route");
    expect((await POST(req({ caseId, batchId, path: "another-case/file.pdf" }))).status).toBe(422);
    expect((await POST(req({ files: [{ slot: "payslip-01" }] }))).status).toBe(422);
    expect(mocks.complete).not.toHaveBeenCalled();
  });
  it("returns retryable failure without claiming completion", async () => {
    const { POST } = await import("./route");
    const { UploadError } = await import("@/server/product/documents/upload");
    mocks.complete.mockRejectedValueOnce(new UploadError("UPLOAD_INCOMPLETE", 503));
    expect((await POST(req({ caseId, batchId }))).status).toBe(503);
    expect(mocks.event).not.toHaveBeenCalled();
  });
  it("analytics failure cannot undo or hide committed success", async () => {
    const { POST } = await import("./route");
    mocks.event.mockRejectedValueOnce(new Error("offline"));
    expect((await POST(req({ caseId, batchId }))).status).toBe(200);
  });
  it("sign refuses cross-case requests and accepts a contract-only descriptor", async () => {
    const { POST } = await import("../sign/route");
    const body = { caseId, batchId, files: [{ clientId: batchId, documentType: "contract", name: "synthetic.pdf", type: "application/pdf", size: 100, sha256: "a".repeat(64) }] };
    expect((await POST(req({ ...body, caseId: other }))).status).toBe(403);
    expect(mocks.prepare).not.toHaveBeenCalled();
    mocks.prepare.mockResolvedValue({ batchId, uploads: [] });
    expect((await POST(req(body))).status).toBe(200);
    expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith(body);
  });
});
