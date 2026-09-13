import {expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {syntheticPayslipFixtures} from '@/engine/extraction/fixtures/source-fixtures';
import {PAYSLIP_EXTRACTION_V21_VERSION} from '@/engine/extraction/v21';
import type {PreparedPayslipDocument} from '../../preprocessing';
import {OpenAiPayslipV2PassExtractor} from './v2-adapter';
import {OPENAI_SOL_COMPARISON_PROFILE} from './v2-request';
vi.mock('server-only',()=>({}));
const config={apiKey:'synthetic-not-a-live-key',model:'gpt-5.6-sol',timeoutMs:1000};
it('refuses a malformed extractor version and wrong model profile before a provider can be invoked',()=>{
 const parse=vi.fn();
 expect(()=>new OpenAiPayslipV2PassExtractor(config,{transport:{parse},extractorVersion:'payslip-extraction-2.1'})).toThrow();
 expect(()=>new OpenAiPayslipV2PassExtractor({...config,model:'gpt-5.6'},{transport:{parse},executionProfile:OPENAI_SOL_COMPARISON_PROFILE})).toThrow('MODEL_MISMATCH');
 expect(parse).not.toHaveBeenCalled();
});
it('produces a valid failure receipt with the actual version constant if the Sol provider refuses',async()=>{
 const bytes=new Uint8Array([1]),hash=createHash('sha256').update(bytes).digest('hex');
 const prepared={original:{bytes,mime_type:'image/png',sha256:hash},crops:[],metadata:{}} as unknown as PreparedPayslipDocument;
 const original=syntheticPayslipFixtures[0].request;
 const request={...original,document:{...original.document,mime_type:'image/png' as const,size_bytes:1,content_sha256:hash}};
 const parse=vi.fn().mockRejectedValue(new Error('synthetic provider refusal'));
 const extractor=new OpenAiPayslipV2PassExtractor(config,{transport:{parse},extractorVersion:PAYSLIP_EXTRACTION_V21_VERSION,executionProfile:OPENAI_SOL_COMPARISON_PROFILE});
 const result=await extractor.extractPreparedPass({request,prepared,kind:'first_pass',requestedFields:[],sourcePageCount:1});
 expect(parse).toHaveBeenCalledTimes(1);expect(parse.mock.calls[0][0]).toMatchObject({reasoning:{effort:'medium'},service_tier:'default'});
 expect(result.extraction.status).toBe('failed');expect(result.provider_receipt).toMatchObject({status:'failed',provider_attempted:true,
  origin:'injected_test_provider',extractor_version:PAYSLIP_EXTRACTION_V21_VERSION,requested_model:'gpt-5.6-sol'});
});
