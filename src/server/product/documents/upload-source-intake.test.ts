import {beforeEach,it,expect,vi} from 'vitest';
import {PDFDocument} from 'pdf-lib';
import {createHash} from 'node:crypto';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {sourceIntakeUploadFixture} from './source-intake-upload.fixture';
import {sourceIntakeUploadReceiptSchema} from './source-intake-upload';
import {documentUploadSchema,uploadNextPath} from '@/lib/document-upload';
const fake=vi.hoisted(()=>({rpc:vi.fn(),download:vi.fn(),info:vi.fn(),sign:vi.fn(),identity:vi.fn(),cookie:vi.fn()}));
vi.mock('../case-access/db',()=>({resolveCaseAccessDb:async()=>({rpc:fake.rpc})}));
vi.mock('../case-access/session-cookie',()=>({readCaseSessionCookie:fake.cookie}));
vi.mock('../case-access/service',()=>({resolveIdentitySession:fake.identity}));
vi.mock('@/lib/supabase-admin',()=>({getSupabaseAdmin:()=>({storage:{from:()=>({download:fake.download,info:fake.info,createSignedUploadUrl:fake.sign})}})}));
import {prepareUpload,completeUpload,type UploadBatch,type ReviewUploadSnapshot} from './upload';
async function fixture(month?:string){
 const f=sourceIntakeUploadFixture(month),pdf=await PDFDocument.create();pdf.addPage();pdf.addPage();const bytes=new Uint8Array(await pdf.save()),sha=createHash('sha256').update(bytes).digest('hex');
 const manifest=documentUploadSchema.parse({caseId:f.caseId,batchId:f.receipt.batch_id,requestId:f.scope.request_id,sourceIntake:{policy:'legacy-source-intake-v1',target_sha256:f.scope.target.target_sha256},files:[{
  clientId:f.document.id,documentType:'payslip',name:'synthetic-source.pdf',type:'application/pdf',size:bytes.length,sha256:sha}]});
 const reserved={...manifest.files[0],documentId:f.document.id,versionId:f.document.version_id,slot:'payslip-01',path:`cases/${f.caseId}/versions/${f.document.version_id}.pdf`};
 const batch:UploadBatch={id:manifest.batchId,case_id:f.caseId,files:[reserved],completed_at:null,cancelled_at:null,expires_at:'2099-01-01T00:00:00Z',source_intake_scope:f.scope};
 const {receipt_sha256,...body}=f.receipt;void receipt_sha256;const receiptBody={...body,files:f.receipt.files.map(file=>({...file,source_sha256:sha}))};
 const receipt=sourceIntakeUploadReceiptSchema.parse({...receiptBody,receipt_sha256:canonicalSha256(receiptBody)});
 const snapshot:ReviewUploadSnapshot={caseId:f.caseId,publicId:'TV-SYNTH001',status:'documents_uploaded',paymentStatus:'not_started',checkPeriodMonth:null,requests:[],sourceIntakeReceipts:[receipt],
  documents:[{id:f.document.id,version_id:f.document.version_id,document_type:'payslip',slot:'payslip-01',original_filename:'synthetic-source.pdf',mime_type:'application/pdf',size:bytes.length,period_month:null}]};
 fake.rpc.mockImplementation(async name=>[{value:name==='case_documents_commit'||name==='case_documents_snapshot'?snapshot:batch}]);
 fake.download.mockResolvedValue({data:new Blob([bytes],{type:'application/pdf'}),error:null});fake.info.mockResolvedValue({data:null,error:{statusCode:'404'}});
 fake.sign.mockResolvedValue({data:{signedUrl:'https://synthetic.invalid/put'},error:null});fake.identity.mockResolvedValue({identity_id:f.answerRow.answer_identity_id});fake.cookie.mockResolvedValue('synthetic-session');
 return {...f,manifest,batch,receipt,snapshot,bytes};
}
beforeEach(()=>vi.resetAllMocks());
it('uses the existing reserve overload with authenticated actor and never invents a month',async()=>{
 const f=await fixture();await prepareUpload(f.manifest);expect(fake.rpc).toHaveBeenCalledWith('case_documents_reserve',{target_case:f.caseId,target_batch:f.manifest.batchId,target_manifest:f.manifest,target_identity:f.answerRow.answer_identity_id});
 expect(fake.sign).toHaveBeenCalledWith(f.batch.files[0].path,{upsert:false});expect(f.manifest).not.toHaveProperty('checkPeriodMonth');expect(f.manifest.files[0]).not.toHaveProperty('periodMonth');
});
it('commits verified physical metadata and received-only receipt, then retries without re-reading or a second commit',async()=>{
 const f=await fixture(),snapshot=await completeUpload(f.caseId,f.manifest.batchId);
 expect(fake.rpc).toHaveBeenLastCalledWith('case_documents_commit',{target_case:f.caseId,target_batch:f.manifest.batchId,target_checks:{[f.document.version_id]:f.manifest.files[0].sha256,[`physical:${f.document.version_id}`]:{page_count:2}}});
 expect(snapshot.sourceIntakeReceipts?.[0]).toMatchObject({month:null,state:'received_pending_reading',information_satisfied:false});expect(uploadNextPath(snapshot,true)).toBe('/case/TV-SYNTH001/thread');
 f.batch.completed_at='2026-09-12T12:00:00Z';fake.rpc.mockClear();fake.download.mockClear();expect(await completeUpload(f.caseId,f.manifest.batchId)).toEqual(snapshot);
 expect(fake.download).not.toHaveBeenCalled();expect(fake.rpc.mock.calls.some(c=>c[0]==='case_documents_commit')).toBe(false);
});
it.each(['no_actor','missing_scope','wrong_target','guessed_month','foreign_case'])('refuses %s before signing',async kind=>{
 const f=await fixture();if(kind==='no_actor')fake.identity.mockResolvedValue(null);if(kind==='missing_scope')f.batch.source_intake_scope=null;
 if(kind==='wrong_target')f.manifest.sourceIntake!.target_sha256='a'.repeat(64);if(kind==='guessed_month')f.batch.files[0].periodMonth='2026-06';if(kind==='foreign_case')f.batch.case_id=f.scope.request_id;
 await expect(prepareUpload(f.manifest)).rejects.toMatchObject({code:kind==='no_actor'||kind==='foreign_case'?'UPLOAD_FORBIDDEN':'UPLOAD_REQUEST_CONFLICT'});expect(fake.sign).not.toHaveBeenCalled();expect(fake.info).not.toHaveBeenCalled();
});
it.each(['absent','wrong_page_count','duplicate','changed_source','changed_month'])('rejects %s commit receipt despite a nominal completed batch',async kind=>{
 const f=await fixture();if(kind==='absent')f.snapshot.sourceIntakeReceipts=[];if(kind==='duplicate')f.snapshot.sourceIntakeReceipts=[f.receipt,f.receipt];
 if(kind==='wrong_page_count'||kind==='changed_source'||kind==='changed_month'){
  const {receipt_sha256,...body}=f.receipt;void receipt_sha256;const changed={...body,...(kind==='changed_month'?{month:'2026-06'}:{}),files:body.files.map(file=>({...file,...(kind==='wrong_page_count'?{page_count:3}:kind==='changed_source'?{source_sha256:'f'.repeat(64)}:{})}))};
  f.snapshot.sourceIntakeReceipts=[sourceIntakeUploadReceiptSchema.parse({...changed,receipt_sha256:canonicalSha256(changed)})];
 }
 await expect(completeUpload(f.caseId,f.manifest.batchId)).rejects.toMatchObject({code:'UPLOAD_UNAVAILABLE'});
});
it('keeps a known-month source request in intake mode without assigning that month to uploaded bytes',async()=>{
 const f=await fixture('2026-06');await prepareUpload(f.manifest);const saved=await completeUpload(f.caseId,f.manifest.batchId);
 expect(saved.sourceIntakeReceipts?.[0]).toMatchObject({month:'2026-06',files:[{period_month:null}],information_satisfied:false});
 expect(f.manifest).not.toHaveProperty('checkPeriodMonth');expect(f.manifest.files[0]).not.toHaveProperty('periodMonth');expect(f.batch.review_scope).toBeUndefined();
});
it('rejects invalid physical PDF even when filename, signature, size and hash agree',async()=>{
 const f=await fixture(),bytes=new TextEncoder().encode('%PDF-1.7\nno physical page tree\n%%EOF');f.batch.files[0].size=bytes.length;f.batch.files[0].sha256=createHash('sha256').update(bytes).digest('hex');
 fake.download.mockResolvedValue({data:new Blob([bytes],{type:'application/pdf'}),error:null});await expect(completeUpload(f.caseId,f.manifest.batchId)).rejects.toMatchObject({code:'UPLOAD_INVALID_FILE'});
 expect(fake.rpc.mock.calls.some(c=>c[0]==='case_documents_commit')).toBe(false);
});
