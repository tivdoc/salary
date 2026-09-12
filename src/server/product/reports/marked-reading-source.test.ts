import {createHash} from 'node:crypto';
import {PDFDocument} from 'pdf-lib';
import {expect,it,vi} from 'vitest';
import {markReadingSource} from './marked-reading-source';
import {reviewRowCellCoverageFixture,reviewSourceScopeCoverageFixture,reviewSourceTranscriptionFixture} from './review-field-coverage.fixture';
import {documentRowCellTarget} from './document-row-cell-confirmation';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import type {CaseAccessDb} from '../case-access/db';
import {documentSourceScopeTarget} from './document-source-scope-confirmation';
import {documentSourceTranscriptionTarget} from './document-source-transcription';
import {documentTravelTariffTarget} from './document-travel-tariff';
vi.mock('server-only',()=>({}));
async function fixture(box=true){
 const f=reviewRowCellCoverageFixture(),pdf=await PDFDocument.create();pdf.addPage([400,600]);const bytes=Buffer.from(await pdf.save());
 const {bounding_box:ignored,...unlocated}=f.component.source;void ignored;
 const digest=createHash('sha256').update(bytes).digest('hex'),component={...f.component,source:{...unlocated,
  ...(box?{bounding_box:{x:.1,y:.2,width:.4,height:.1,coordinate_space:'normalized' as const}}:{})}};
 const result={...f.checkpoint.run.result,final_extraction:{...f.checkpoint.run.result.final_extraction,additional_components:[component]}};
 const checkpoint={...f.checkpoint,input_sha256:digest,result_sha256:canonicalSha256(result),run:{result}};
 const target=documentRowCellTarget({checkpoint,policyVersion:'marked-source-test',componentId:component.component_id,cell:'quantity'});
 const calls:unknown[]=[];
 const db:CaseAccessDb={provider:'fake',async rpc<T>(fn:string,args:Readonly<Record<string,unknown>>){calls.push({fn,args});return [{request_id:f.fieldRequest.request_id,target}]as T[];}};
 const input={caseId:target.case_id,identityId:'11111111-1111-4111-8111-111111111111',requestId:f.fieldRequest.request_id,version:target.version_id,bytes,mime:'application/pdf'};
 return {input,db,calls,digest};
}
it('marks an authorized row source while preserving original bytes and requesting the exact case identity',async()=>{
 const f=await fixture(),result=await markReadingSource(f.input,f.db);expect(result).not.toBeNull();expect(result!.equals(f.input.bytes)).toBe(false);
 expect(createHash('sha256').update(f.input.bytes).digest('hex')).toBe(f.digest);expect((await PDFDocument.load(result!)).getPageCount()).toBe(1);
 expect(f.calls).toEqual([{fn:'case_request_field_reading_targets',args:{target_case:f.input.caseId,target_identity:f.input.identityId}}]);
});
it('refuses foreign bytes, source versions and cases before generating a marked view',async()=>{
 const f=await fixture();
 for(const change of [{version:'22222222-2222-4222-8222-222222222222'},{caseId:'22222222-2222-4222-8222-222222222222'},{bytes:Buffer.from('foreign')}]){
  await expect(markReadingSource({...f.input,...change},f.db)).rejects.toThrow('REQUEST_FIELD_SOURCE_CHANGED');
 }
});
it('does not guess a rectangle from an unlocated row label',async()=>{
 const f=await fixture(false);expect(await markReadingSource(f.input,f.db)).toBeNull();
});
it('uses the source-scope candidate page and rectangle only after the same protected hash check',async()=>{
 const f=reviewSourceScopeCoverageFixture(),pdf=await PDFDocument.create();pdf.addPage([400,600]);const bytes=Buffer.from(await pdf.save());
 const observation={...f.observation,candidate:{...f.observation.candidate,source:{...f.observation.candidate.source,
  bounding_box:{x:.1,y:.2,width:.4,height:.1,coordinate_space:'normalized' as const}}}};
 const result={...f.checkpoint.run.result,final_extraction:{...f.checkpoint.run.result.final_extraction,source_scope_observations:[observation]}};
 const checkpoint={...f.checkpoint,input_sha256:createHash('sha256').update(bytes).digest('hex'),result_sha256:canonicalSha256(result),run:{result}};
 const target=documentSourceScopeTarget({checkpoint,policyVersion:'marked-scope-test',candidateId:observation.candidate.candidate_id});
 const db:CaseAccessDb={provider:'fake',async rpc<T>(){return [{request_id:f.fieldRequest.request_id,target}]as T[];}};
 const input={caseId:target.case_id,identityId:'11111111-1111-4111-8111-111111111111',requestId:f.fieldRequest.request_id,version:target.version_id,bytes,mime:'application/pdf'};
 expect(await markReadingSource(input,db)).not.toBeNull();
 await expect(markReadingSource({...input,bytes:Buffer.from('not the source')},db)).rejects.toThrow('REQUEST_FIELD_SOURCE_CHANGED');
});
it('returns the original protected page for missing hours without inventing a highlighted cell and still rejects foreign bytes',async()=>{
 const f=reviewSourceTranscriptionFixture(),pdf=await PDFDocument.create();pdf.addPage([400,600]);const bytes=Buffer.from(await pdf.save());
 const checkpoint={...f.checkpoint,input_sha256:createHash('sha256').update(bytes).digest('hex')};
 const target=documentSourceTranscriptionTarget({checkpoint,policyVersion:'marked-transcription-test',subject:{kind:'reported_work_hours',page:1}});
 const db:CaseAccessDb={provider:'fake',async rpc<T>(){return [{request_id:f.fieldRequest.request_id,target}]as T[];}};
 const input={caseId:target.case_id,identityId:'11111111-1111-4111-8111-111111111111',requestId:f.fieldRequest.request_id,version:target.version_id,bytes,mime:'application/pdf'};
 expect(await markReadingSource(input,db)).toBeNull();
 await expect(markReadingSource({...input,bytes:Buffer.from('foreign bytes')},db)).rejects.toThrow('REQUEST_FIELD_SOURCE_CHANGED');
});
it('accepts the exact tariff wrapper and page without inventing a rectangle, while retaining the byte/version/case fences',async()=>{
 const pdf=await PDFDocument.create();pdf.addPage([400,600]);pdf.addPage([400,600]);const bytes=Buffer.from(await pdf.save());
 const target=documentTravelTariffTarget({source:{document:{case_id:'11111111-1111-4111-8111-111111111111',document_id:'22222222-2222-4222-8222-222222222222',
  version_id:'33333333-3333-4333-8333-333333333333',file_sha256:createHash('sha256').update(bytes).digest('hex'),page_count:2,month:'2026-06',
  document_type:'other',evidence_purpose:'travel_tariff',purpose_sha256:'d'.repeat(64)},group:{page:2,locator:'Synthetic tariff source group'}},subject:'daily_fare'});
 const input={caseId:target.case_id,identityId:'44444444-4444-4444-8444-444444444444',requestId:'55555555-5555-4555-8555-555555555555',version:target.version_id,bytes,mime:'application/pdf'};
 const calls:unknown[]=[];
 const db:CaseAccessDb={provider:'fake',async rpc<T>(fn:string,args:Readonly<Record<string,unknown>>){calls.push({fn,args});return [{request_id:input.requestId,target}] as T[];}};
 expect(await markReadingSource(input,db)).toBeNull();expect(createHash('sha256').update(bytes).digest('hex')).toBe(target.source_sha256);
 expect(calls).toEqual([{fn:'case_request_field_reading_targets',args:{target_case:input.caseId,target_identity:input.identityId}}]);
 for(const changed of [{caseId:input.identityId},{version:input.identityId},{bytes:Buffer.from('different source')}])
  await expect(markReadingSource({...input,...changed},db)).rejects.toThrow('REQUEST_FIELD_SOURCE_CHANGED');
});
