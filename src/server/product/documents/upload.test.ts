import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { beforeEach, describe, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ rpc: vi.fn(), info: vi.fn(), download: vi.fn(), sign: vi.fn(), remove: vi.fn(), cookie: vi.fn(), identity: vi.fn() }));
vi.mock("../case-access/db", () => ({ resolveCaseAccessDb: async () => ({ rpc: fake.rpc }) }));
vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: () => ({ storage: { from: () => ({ info: fake.info, download: fake.download, createSignedUploadUrl: fake.sign, remove: fake.remove }) } }) }));
vi.mock("../case-access/session-cookie", () => ({ readCaseSessionCookie: fake.cookie }));
vi.mock("../case-access/service", () => ({ resolveIdentitySession: fake.identity }));
import { completeUpload, prepareUpload, type UploadBatch, type ReservedFile, type ReviewUploadSnapshot } from "./upload";
import type { DocumentUpload } from "@/lib/document-upload";
import { generateReviewCompletions } from "@/engine/document-review/completions";
import { buildReviewUploadReceipt, type ReviewUploadReceipt, type ReviewUploadScope } from "./review-fulfillment";
import { canonicalSha256 } from "@/engine/rule-runtime/canonical";
// One real synthetic page; physical validation now covers every document kind.
const bytes = new Uint8Array(Buffer.from('JVBERi0xLjcKJYGBgYEKCjUgMCBvYmoKPDwKL0ZpbHRlciAvRmxhdGVEZWNvZGUKL1R5cGUgL09ialN0bQovTiA0Ci9GaXJzdCAyMAovTGVuZ3RoIDI1Ngo+PgpzdHJlYW0KeJzVUk1LxDAUvOdXvKOe8ppm266UgvbjIsKyeFL2ELZhKchG0hb03ztJVsWDeDZhyMfMS14yLyMmRVpTTmVFmja5oroW8vH91ZLcmZOdhbyfxpmewTLt6SBk69bzQploGvGtbc1iXtxJpCDKgvhTsfNuXI/WUz30w8BcMnOhgYJZdRhbYAsorMGpCnOg1Bdgr8yZ81twQ0JRppjAR+3mEt9jhLYImi5pdZXWX/eGu/p0hvorn20j5IMbO7NYuupuQn6cocf2dI3v8NYs7v8+LuY/ufOvL/zhc7A3mOxtqIHostzb2a3+CNuha8J/2XEyd+4NVcPoOCriEMgPBaSNhgplbmRzdHJlYW0KZW5kb2JqCgo2IDAgb2JqCjw8Ci9TaXplIDcKL1Jvb3QgMiAwIFIKL0luZm8gMyAwIFIKL0ZpbHRlciAvRmxhdGVEZWNvZGUKL1R5cGUgL1hSZWYKL0xlbmd0aCAzNAovVyBbIDEgMiAyIF0KL0luZGV4IFsgMCA3IF0KPj4Kc3RyZWFtCnicFcQxDgAgCASwHsbd1/p9CB2K7nLZstV24pF8BkN9AqoKZW5kc3RyZWFtCmVuZG9iagoKc3RhcnR4cmVmCjM3NAolJUVPRg==','base64'));
const digest = createHash("sha256").update(bytes).digest("hex");
const caseId = "11111111-1111-4111-8111-111111111111";
const batchId = "22222222-2222-4222-8222-222222222222";
const file = { clientId: batchId, documentType: "payslip", name: "second.pdf", type: "application/pdf", size: bytes.length, sha256: digest, periodMonth: "2026-08" } as const;
const reserved = { ...file, documentId: "second", versionId: "new-version", slot: "payslip-02", path: `cases/${caseId}/versions/new-version.pdf` };
const snapshot = { documents: [{ id: "first", storage_path: "legacy/first.pdf" }, { id: "contract", storage_path: "legacy/contract.pdf" }, { id: "second", storage_path: reserved.path }] };
let batch: UploadBatch;
beforeEach(() => {
  vi.clearAllMocks();
  batch = { id: batchId, case_id: caseId, files: [reserved], completed_at: null, cancelled_at: null, expires_at: "2099-01-01T00:00:00Z" };
  fake.rpc.mockImplementation(async (fn: string) => [{ value: fn === "case_documents_commit" || fn === "case_documents_snapshot" ? snapshot : batch }]);
  fake.info.mockResolvedValue({ data: null, error: { statusCode: "404" } });
  fake.sign.mockResolvedValue({ data: { signedUrl: "https://synthetic.invalid/upload" }, error: null });
  fake.download.mockResolvedValue({ data: new Blob([bytes], { type: "application/pdf" }), error: null });
  fake.cookie.mockResolvedValue("server-session-token");
  fake.identity.mockResolvedValue({ identity_id: "88888888-8888-4888-8888-888888888888" });
});
describe("immutable upload/storage boundary", () => {
  it("regression: adding a second payslip preserves first and contract; never deletes storage", async () => {
    expect(await completeUpload(caseId, batchId)).toEqual(snapshot);
    expect(fake.download).toHaveBeenCalledExactlyOnceWith(reserved.path);
    expect(fake.rpc).toHaveBeenLastCalledWith("case_documents_commit", { target_case: caseId, target_batch: batchId, target_checks: { "new-version": digest,'physical:new-version':{page_count:1} } });
    expect(fake.remove).not.toHaveBeenCalled();
  });
  it("signs only server-reserved immutable paths, never enables upsert", async () => {
    await prepareUpload({ caseId, batchId, files: [file] });
    expect(fake.sign).toHaveBeenCalledExactlyOnceWith(reserved.path, { upsert: false });
    expect(fake.cookie).not.toHaveBeenCalled(); expect(fake.identity).not.toHaveBeenCalled();
    expect(fake.rpc).toHaveBeenCalledWith("case_documents_reserve", { target_case: caseId, target_batch: batchId, target_manifest: { caseId, batchId, files: [file] } });
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

async function tariffBatch(pages = 2) {
  const pdf = await PDFDocument.create();
  for (let index = 0; index < pages; index++) pdf.addPage();
  const tariffBytes = await pdf.save({ addDefaultPage: false });
  const tariffFile: ReservedFile = {
    ...reserved, documentType: "other", periodMonth: undefined, slot: "other-01",
    versionId: "77777777-7777-4777-8777-777777777777", size: tariffBytes.length,
    sha256: createHash("sha256").update(tariffBytes).digest("hex"),
    evidencePurpose: { kind: "travel_tariff", month: "2026-07", page: 2, locator: "טבלת כרטיסים" },
  };
  batch.files = [tariffFile];
  fake.download.mockResolvedValue({ data: new Blob([new Uint8Array(tariffBytes)], { type: "application/pdf" }), error: null });
  const manifest: DocumentUpload = { caseId, batchId, files: [{
    clientId: tariffFile.clientId, documentType: "other", name: tariffFile.name, type: "application/pdf", size: tariffFile.size,
    sha256: tariffFile.sha256, evidencePurpose: tariffFile.evidencePurpose,
  }] };
  return { tariffFile, manifest };
}
describe("tariff PDF purpose and trusted upload actor", () => {
  it("uses only the resolved server identity in reserve4; SQL remains responsible for matching that identity to the case", async () => {
    const { manifest } = await tariffBatch();
    await prepareUpload(manifest);
    expect(fake.cookie).toHaveBeenCalledOnce();expect(fake.identity).toHaveBeenCalledExactlyOnceWith("server-session-token");
    expect(fake.rpc).toHaveBeenCalledWith("case_documents_reserve", { target_case: caseId, target_batch: batchId, target_manifest: manifest, target_identity: "88888888-8888-4888-8888-888888888888" });
  });
  it("refuses an absent or expired identity before reserving or signing", async () => {
    const { manifest } = await tariffBatch();fake.identity.mockResolvedValue(null);
    await expect(prepareUpload(manifest)).rejects.toMatchObject({code:"UPLOAD_FORBIDDEN",status:403});
    expect(fake.rpc).not.toHaveBeenCalled();expect(fake.info).not.toHaveBeenCalled();expect(fake.sign).not.toHaveBeenCalled();
  });
  it("propagates foreign-case or changed-actor refusal without issuing a storage URL", async () => {
    const { manifest } = await tariffBatch();fake.rpc.mockRejectedValue(new Error("UPLOAD_FORBIDDEN"));
    await expect(prepareUpload(manifest)).rejects.toMatchObject({code:"UPLOAD_FORBIDDEN",status:403});
    expect(fake.info).not.toHaveBeenCalled();expect(fake.sign).not.toHaveBeenCalled();
  });
  it("adds actual parsed page count alongside the unchanged source digest and never duplicates it on completed retry", async () => {
    const { tariffFile } = await tariffBatch();
    await completeUpload(caseId,batchId);
    expect(fake.rpc).toHaveBeenLastCalledWith("case_documents_commit", {target_case:caseId,target_batch:batchId,target_checks:{[tariffFile.versionId]:tariffFile.sha256,[`purpose:${tariffFile.versionId}`]:{page_count:2},[`physical:${tariffFile.versionId}`]:{page_count:2}}});
    batch.completed_at="2026-09-12T00:00:00Z";fake.download.mockClear();fake.rpc.mockClear();
    await completeUpload(caseId,batchId);expect(fake.download).not.toHaveBeenCalled();
    expect(fake.rpc.mock.calls.some(call=>call[0]==="case_documents_commit")).toBe(false);expect(fake.remove).not.toHaveBeenCalled();
  });
  it.each([0,1,101])("rejects a %i-page source incompatible with the declared page and supported bound", async (pages) => {
    await tariffBatch(pages);
    await expect(completeUpload(caseId,batchId)).rejects.toMatchObject({code:"UPLOAD_INVALID_FILE",status:422});
    expect(fake.rpc.mock.calls.some(call=>call[0]==="case_documents_commit")).toBe(false);
  });
  it("rejects a PDF-looking byte string even when its MIME, size and digest match", async () => {
    const { tariffFile } = await tariffBatch();
    const broken=new TextEncoder().encode('%PDF-1.7\nSynthetic invalid physical tree\n%%EOF');
    batch.files=[{...tariffFile,size:broken.length,sha256:createHash('sha256').update(broken).digest('hex')}];
    fake.download.mockResolvedValue({data:new Blob([broken],{type:"application/pdf"}),error:null});
    await expect(completeUpload(caseId,batchId)).rejects.toMatchObject({code:"UPLOAD_INVALID_FILE",status:422});
    expect(fake.rpc.mock.calls.some(call=>call[0]==="case_documents_commit")).toBe(false);
  });
  it("refuses a source with an encryption dictionary instead of ignoring protection", async () => {
    const {tariffFile}=await tariffBatch();
    const protectedPdf=await PDFDocument.create();protectedPdf.addPage();protectedPdf.addPage();
    protectedPdf.context.trailerInfo.Encrypt=protectedPdf.context.register(protectedPdf.context.obj({Filter:'Standard'}));
    const protectedBytes=await protectedPdf.save();
    batch.files=[{...tariffFile,size:protectedBytes.length,sha256:createHash('sha256').update(protectedBytes).digest('hex')}];
    fake.download.mockResolvedValue({data:new Blob([new Uint8Array(protectedBytes)],{type:'application/pdf'}),error:null});
    await expect(completeUpload(caseId,batchId)).rejects.toMatchObject({code:'UPLOAD_INVALID_FILE',status:422});
    expect(fake.rpc.mock.calls.some(call=>call[0]==='case_documents_commit')).toBe(false);
  });
  it.each(["foreign case","independent month","missing purpose","unsupported month"])("rejects %s in reserved source metadata",async kind=>{
    const {tariffFile}=await tariffBatch();
    if(kind==="foreign case")batch.case_id=batchId;
    else if(kind==="independent month")batch.files=[{...tariffFile,periodMonth:"2026-07"}];
    else if(kind==="missing purpose")batch.files=[{...tariffFile,evidencePurpose:undefined}];
    else batch.files=[{...tariffFile,evidencePurpose:{kind:"travel_tariff",month:"2026-08",page:2,locator:"טבלה"}}];
    await expect(completeUpload(caseId,batchId)).rejects.toMatchObject(kind==="foreign case"?{code:"UPLOAD_FORBIDDEN",status:403}:{code:"UPLOAD_INVALID_FILE",status:422});
    if(kind==="foreign case")expect(fake.download).not.toHaveBeenCalled();
    expect(fake.rpc.mock.calls.some(call=>call[0]==="case_documents_commit")).toBe(false);
  });
});

function reviewedBatch() {
  const requestId = '33333333-3333-4333-8333-333333333333';
  const request = generateReviewCompletions({case_id:caseId,period:{from:'2026-08-01',to:'2026-08-31'},documents:[],evidence:[],needs:[{
    fact_key:'payslip.complete',kind:'document',document_kind:'payslip',reason:'missing',required_evidence_kind:'document',
    question:'נא לצרף תלוש מלא לאוגוסט.',answer_kind:'document',source_pins:[],dependent_check_ids:['source.payslip'],general_question:false,
  }]}).customer_requests[0];
  const scope:ReviewUploadScope={request_id:requestId,request,order_id:'44444444-4444-4444-8444-444444444444',order_origin:'saved_order',order_receipt_sha256:'a'.repeat(64)};
  const receipt=buildReviewUploadReceipt({scope,case_id:caseId,batch_id:batchId,received_at:'2026-09-11T00:00:00Z',existing_source_hashes:[],
    files:[{document_id:'55555555-5555-4555-8555-555555555555',version_id:'66666666-6666-4666-8666-666666666666',source_sha256:digest,document_kind:'payslip',period_month:'2026-08',duplicate_content:false}]});
  const result:{documents:typeof snapshot.documents;reviewReceipts:ReviewUploadReceipt[]}={...snapshot,reviewReceipts:[receipt]};
  const scoped=Object.assign(batch,{case_id:caseId,review_scope:scope,files:[{...reserved,documentId:receipt.files[0].document_id,versionId:receipt.files[0].version_id}]});
  fake.rpc.mockImplementation(async(fn:string)=>[{value:fn==='case_documents_commit'||fn==='case_documents_snapshot'?result:scoped}]);
  return {scope,receipt,result,scoped};
}
describe('received document review completion',()=>{
  it('returns the committed source receipt as pending review and preserves it on retry without storage access',async()=>{
    const f=reviewedBatch();expect(await completeUpload(caseId,batchId)).toEqual(f.result);
    expect(f.result.reviewReceipts[0].state).toBe('received_pending_review');
    expect(f.result.reviewReceipts[0]).not.toHaveProperty('information_satisfied');
    f.scoped.completed_at='2026-09-11T00:00:00Z';fake.download.mockClear();
    expect(await completeUpload(caseId,batchId)).toEqual(f.result);expect(fake.download).not.toHaveBeenCalled();expect(fake.remove).not.toHaveBeenCalled();
  });
  it('refuses a completed response missing its exact batch receipt instead of claiming successful fulfillment',async()=>{
    const f=reviewedBatch();f.scoped.completed_at='2026-09-11T00:00:00Z';f.result.reviewReceipts=[];
    await expect(completeUpload(caseId,batchId)).rejects.toMatchObject({code:'UPLOAD_UNAVAILABLE',status:503});expect(fake.download).not.toHaveBeenCalled();
  });
  it('checks request identity before signing and never accepts a client-selected different target',async()=>{
    const f=reviewedBatch();await expect(prepareUpload({caseId,batchId,requestId:batchId,files:[file]})).rejects.toMatchObject({code:'UPLOAD_FORBIDDEN',status:403});
    expect(fake.sign).not.toHaveBeenCalled();expect(fake.info).not.toHaveBeenCalled();
    await expect(prepareUpload({caseId,batchId,requestId:f.scope.request_id,files:[file]})).resolves.toMatchObject({batchId,completed:false});
  });
  it('rejects a valid receipt belonging to different submitted source metadata',async()=>{
    const f=reviewedBatch();f.scoped.files[0].versionId='77777777-7777-4777-8777-777777777777';
    await expect(completeUpload(caseId,batchId)).rejects.toMatchObject({code:'UPLOAD_UNAVAILABLE',status:503});expect(fake.remove).not.toHaveBeenCalled();
  });
});

async function reviewedTariffBatch() {
  const {tariffFile,manifest}=await tariffBatch();
  tariffFile.documentId='55555555-5555-4555-8555-555555555555';
  const purpose=tariffFile.evidencePurpose;if(!purpose)throw Error('TEST_TARIFF_PURPOSE');
  const request=generateReviewCompletions({case_id:caseId,period:{from:'2026-07-01',to:'2026-07-31'},documents:[],evidence:[],needs:[{
    fact_key:'travel.tariff_source',kind:'document',document_kind:'other',reason:'missing',required_evidence_kind:'document',
    question:'נא לצרף מקור תעריף ליולי.',answer_kind:'document',source_pins:[],dependent_check_ids:['travel.expected'],general_question:false,
  }]}).customer_requests[0];
  const scope:ReviewUploadScope={request_id:'33333333-3333-4333-8333-333333333333',request,order_id:'44444444-4444-4444-8444-444444444444',order_origin:'saved_order',order_receipt_sha256:'a'.repeat(64)};
  const receipt=buildReviewUploadReceipt({scope,case_id:caseId,batch_id:batchId,received_at:'2026-09-12T00:00:00Z',existing_source_hashes:[],files:[{
    document_id:tariffFile.documentId,version_id:tariffFile.versionId,source_sha256:tariffFile.sha256,document_kind:'other',period_month:null,duplicate_content:false,
    tariff_source:{document:{case_id:caseId,document_id:tariffFile.documentId,version_id:tariffFile.versionId,file_sha256:tariffFile.sha256,
      month:purpose.month,page_count:2,document_type:'other',evidence_purpose:'travel_tariff',purpose_sha256:'b'.repeat(64)},group:{page:purpose.page,locator:purpose.locator}},
  }]});
  if(receipt.schema_version!=='document-review-upload-receipt-v2')throw Error('TEST_V2_RECEIPT');
  const result:ReviewUploadSnapshot={caseId,publicId:'synthetic',status:'paid',paymentStatus:'paid',checkPeriodMonth:'2026-07',requests:[],documents:[{
    id:tariffFile.documentId,version_id:tariffFile.versionId,document_type:'other',slot:tariffFile.slot,original_filename:tariffFile.name,
    mime_type:tariffFile.type,size:tariffFile.size,period_month:null,evidence_purpose:{...purpose,page_count:2},
  }],reviewReceipts:[receipt]};
  batch.review_scope=scope;
  fake.rpc.mockImplementation(async(fn:string)=>[{value:fn==='case_documents_commit'||fn==='case_documents_snapshot'?result:batch}]);
  return {scope,receipt,result,tariffFile,manifest:{...manifest,requestId:scope.request_id}};
}

describe('travel source upload receipt v2',()=>{
  it('keeps the tariff request pending review after commit and replays the same receipt without reading Storage',async()=>{
    const f=await reviewedTariffBatch();
    await expect(prepareUpload(f.manifest)).resolves.toMatchObject({completed:false});
    await expect(completeUpload(caseId,batchId)).resolves.toEqual(f.result);
    expect(f.result.reviewReceipts).toEqual([f.receipt]);expect(f.receipt.state).toBe('received_pending_review');
    expect(f.receipt).not.toHaveProperty('information_satisfied');
    batch.completed_at='2026-09-12T00:00:00Z';fake.download.mockClear();fake.rpc.mockClear();
    await expect(completeUpload(caseId,batchId)).resolves.toEqual(f.result);
    expect(fake.download).not.toHaveBeenCalled();expect(fake.rpc.mock.calls.some(c=>c[0]==='case_documents_commit')).toBe(false);
  });
  it('rejects a source purpose for a different month before signing',async()=>{
    const f=await reviewedTariffBatch();f.tariffFile.evidencePurpose={kind:'travel_tariff',month:'2026-06',page:2,locator:'טבלת כרטיסים'};
    await expect(prepareUpload(f.manifest)).rejects.toMatchObject({code:'UPLOAD_REQUEST_CONFLICT',status:409});
    expect(fake.sign).not.toHaveBeenCalled();expect(fake.info).not.toHaveBeenCalled();
  });
  it.each(['page','locator','month','physical page count'])('refuses a validly hashed receipt with changed %s',async field=>{
    const f=await reviewedTariffBatch(),changed=structuredClone(f.receipt),source=changed.files[0].tariff_source;
    if(field==='page')source.group.page=1;
    if(field==='locator')source.group.locator='טבלה אחרת';
    if(field==='month'){source.document.month='2026-06';changed.period={from:'2026-06-01',to:'2026-06-30'};}
    if(field==='physical page count'){
      source.document.page_count=3;
      const saved=f.result.documents[0].evidence_purpose;if(!saved)throw Error('TEST_SAVED_PURPOSE');saved.page_count=3;
    }
    const {receipt_sha256:oldHash,...body}=changed;expect(oldHash).toBe(f.receipt.receipt_sha256);
    f.result.reviewReceipts=[{...body,receipt_sha256:canonicalSha256(body)}];
    await expect(completeUpload(caseId,batchId)).rejects.toMatchObject({code:'UPLOAD_UNAVAILABLE',status:503});
    expect(fake.remove).not.toHaveBeenCalled();
  });
  it.each(['replaced version','missing purpose','changed saved locator'])('refuses a completed retry with %s in the current snapshot',async field=>{
    const f=await reviewedTariffBatch();batch.completed_at='2026-09-12T00:00:00Z';
    if(field==='replaced version')f.result.documents[0].version_id='99999999-9999-4999-8999-999999999999';
    if(field==='missing purpose')f.result.documents[0].evidence_purpose=null;
    if(field==='changed saved locator'){
      const saved=f.result.documents[0].evidence_purpose;if(!saved)throw Error('TEST_SAVED_PURPOSE');saved.locator='מקור אחר';
    }
    await expect(completeUpload(caseId,batchId)).rejects.toMatchObject({code:'UPLOAD_UNAVAILABLE',status:503});
    expect(fake.download).not.toHaveBeenCalled();expect(fake.rpc.mock.calls.some(c=>c[0]==='case_documents_commit')).toBe(false);
  });
});
