import {describe,it,expect,vi} from 'vitest';
vi.mock('server-only',()=>({}));
import {createHash} from 'node:crypto';
import {immutableDocumentSchema} from '@/engine/domain/documents';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {createOpenAiDocumentEvidenceExtractor} from './document-evidence-adapter';
import {parseOpenAiProviderReceipt} from './provider-receipt';
import {extractSavedDocumentEvidence,savedDocumentEvidenceSchema} from '../../saved-document-evidence';

const uuid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=','base64');
const hash=createHash('sha256').update(bytes).digest('hex');
const document=immutableDocumentSchema.parse({document_id:uuid(2),case_id:uuid(1),document_type:'attendance',original_filename:'synthetic-dot.png',mime_type:'image/png',
 size_bytes:bytes.length,content_sha256:hash,storage_path:`cases/${uuid(1)}/documents/${uuid(2)}/original.png`,document_period:null,
 supersedes_document_id:null,created_at:'2026-07-01T00:00:00Z'});
const output={schema_version:'document-evidence-provider-v1',detected_document_type:'attendance',page_count:1,
 pages:[{page:1,coverage:'partial',missing_regions:['synthetic fixture contains no attendance']}],observations:[],warnings:['synthetic_only']};
const response={id:'resp_synthetic_only',status:'completed',outputParsed:output,model:'gpt-5.6-sol',requestId:'req_synthetic_only',usage:{input_tokens:10,output_tokens:20,total_tokens:30}};
const args={document,source:{read:async()=>bytes},analysisRunId:uuid(3),extractionId:uuid(4),createdAt:'2026-07-01T00:00:00Z'};
describe('ordinary non-payroll provider entry, no live requests',()=>{
 it('requires successful existing-budget authorization before exactly one dispatch',async()=>{
  const order:string[]=[],parse=vi.fn(async()=>{order.push('dispatch');return response;});
  const extractor=createOpenAiDocumentEvidenceExtractor({origin:'injected_test_provider',model:'gpt-5.6-sol',authorize:async p=>{
   expect(p.sourceSha256).toBe(hash);expect(p.maxOutputTokens).toBe(10000);order.push('authorize');},transport:{parse}});
  const result=await extractor.extract(args);expect(order).toEqual(['authorize','dispatch']);expect(parse).toHaveBeenCalledTimes(1);
  expect(result.raw).toEqual(output);expect(result.normalized?.observations).toEqual([]);
  const receipt=parseOpenAiProviderReceipt(result.provider_receipt);expect(receipt.origin).toBe('injected_test_provider');
  expect(receipt.raw_extraction_sha256).toBe(canonicalSha256(output));expect(receipt.token_usage?.total_tokens).toBe(30);
 });
 it('does not call transport after budget refusal',async()=>{
  const parse=vi.fn(async()=>response),extractor=createOpenAiDocumentEvidenceExtractor({origin:'injected_test_provider',model:'gpt-5.6-sol',
   authorize:async()=>{throw Error('BUDGET_EXHAUSTED');},transport:{parse}});
  await expect(extractor.extract(args)).rejects.toThrow('BUDGET_EXHAUSTED');expect(parse).not.toHaveBeenCalled();
 });
 it('preserves invalid provider output as a failed receipt without automatic retry',async()=>{
  const parse=vi.fn(async()=>({...response,outputParsed:{...output,page_count:2}}));
  const result=await createOpenAiDocumentEvidenceExtractor({origin:'injected_test_provider',model:'gpt-5.6-sol',authorize:async()=>{},transport:{parse}}).extract(args);
  expect(result.status).toBe('failed');expect(result.normalized).toBeNull();expect(result.provider_output).toEqual({...output,page_count:2});expect(parse).toHaveBeenCalledTimes(1);
 });
 it('rejects changed original bytes before authorization',async()=>{
  const authorize=vi.fn(async()=>{}),extractor=createOpenAiDocumentEvidenceExtractor({origin:'injected_test_provider',model:'gpt-5.6-sol',authorize,transport:{parse:async()=>response}});
  await expect(extractor.extract({...args,source:{read:async()=>new Uint8Array([1])}})).rejects.toThrow('DOCUMENT_EVIDENCE_SOURCE_CHANGED');expect(authorize).not.toHaveBeenCalled();
 });
 it('uses verified product upload and stores an independent versioned checkpoint',async()=>{
  const extractor=createOpenAiDocumentEvidenceExtractor({origin:'injected_test_provider',model:'gpt-5.6-sol',authorize:async()=>{},transport:{parse:async()=>response}});
  const download=vi.fn(async()=>({data:new Blob([bytes],{type:'image/png'}),error:null}));
  const result=await extractSavedDocumentEvidence({caseId:uuid(1),versionId:uuid(2),requestedMonths:['2026-07'],
   analysisRunId:uuid(3),extractionId:uuid(4),createdAt:args.createdAt,extractor,storage:{download},db:{query:async(_sql,values)=>{
    expect(values).toEqual([uuid(1),uuid(2)]);return {rows:[{id:uuid(5),case_id:uuid(1),version_id:uuid(2),document_type:'attendance',
     storage_path:`cases/${uuid(1)}/versions/${uuid(2)}.png`,original_filename:'synthetic-dot.png',mime_type:'image/png',size:bytes.length,content_sha256:hash,created_at:args.createdAt}]};}}});
  expect(result.schema_version).toBe('tivdoc-saved-document-evidence-v1');expect(result.result_sha256).toBe(canonicalSha256(result.run.result));
  expect(result.requested_months).toEqual(['2026-07']);expect(result.run.result.normalized?.detected_document_type).toBe('attendance');expect(download).toHaveBeenCalledTimes(1);
  expect(result.dispatch_month).toBe('2026-07');
  expect(savedDocumentEvidenceSchema.safeParse({...result,dispatch_month:'2026-06'}).success).toBe(false);
  expect(savedDocumentEvidenceSchema.safeParse({...result,requested_months:['2026-07','2026-06']}).success).toBe(false);
 });
});
