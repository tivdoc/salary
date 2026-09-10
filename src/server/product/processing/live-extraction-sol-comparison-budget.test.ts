import {describe,expect,it,vi} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {buildOpenAiV2ResponsesRequest,OPENAI_SOL_COMPARISON_PROFILE} from '@/server/engine/extraction/providers/openai/v2-request';
import type {PreparedPayslipDocument} from '@/server/engine/extraction/preprocessing';
import {newSolComparisonLedger,parseSolComparisonLedger,reserveSolRequest,recordSolCount,solInputCountRequest,summarizeSolBudget} from './live-extraction-sol-comparison-budget';
vi.mock('server-only',()=>({}));
const now='2026-09-10T16:00:00Z',base={sourceSha256:'a'.repeat(64),requestSha256:'b'.repeat(64),codeRevision:'c'.repeat(40),attempt:1,now};
const prepared={original:{bytes:new Uint8Array([1]),mime_type:'image/png',sha256:'a'.repeat(64)},crops:[]} as unknown as PreparedPayslipDocument;
describe('separate Sol comparison spend and request boundary',()=>{
 it('preserves the existing request body by default and binds medium reasoning to exact Sol only',()=>{
  const old=buildOpenAiV2ResponsesRequest({model:'gpt-4o-mini-2024-07-18',prepared,kind:'first_pass'});
  expect(Object.keys(old).sort()).toEqual(['input','instructions','max_output_tokens','model','store','text']);
  const sol=buildOpenAiV2ResponsesRequest({model:'gpt-5.6-sol',prepared,kind:'first_pass',executionProfile:OPENAI_SOL_COMPARISON_PROFILE});
  expect(sol).toMatchObject({reasoning:{effort:'medium'},service_tier:'default',store:false,max_output_tokens:10000});
  expect(sol.input).toEqual(old.input);expect(sol.instructions).toBe(old.instructions);expect(sol.text).toEqual(old.text);
  expect(()=>buildOpenAiV2ResponsesRequest({model:'gpt-5.6',prepared,kind:'first_pass',executionProfile:OPENAI_SOL_COMPARISON_PROFILE})).toThrow('MODEL_MISMATCH');
  const count=solInputCountRequest(sol);expect(count.requestSha256).toBe(canonicalSha256(sol));
  expect(count.request).toEqual({model:sol.model,instructions:sol.instructions,input:sol.input,text:sol.text,reasoning:sol.reasoning});
 });
 it('charges a count request before its result and does not admit generation before a bounded exact count',()=>{
  expect(()=>reserveSolRequest({ledger:newSolComparisonLedger(),...base,kind:'generation'})).toThrow('WITHOUT_COUNT');
  let ledger=reserveSolRequest({ledger:newSolComparisonLedger(),...base,kind:'input_tokens'});
  expect(summarizeSolBudget(ledger)).toMatchObject({contentRequests:1,unknownOutcomes:1,reservedUpperBoundUsd:0.256});
  expect(()=>reserveSolRequest({ledger,...base,kind:'generation'})).toThrow('UNKNOWN_OUTCOME');
  expect(()=>recordSolCount(ledger,'d'.repeat(64),4000)).toThrow('OUTSIDE_BOUND');
  for(const count of [0,-1,1.5,64001,NaN])expect(()=>recordSolCount(ledger,base.requestSha256,count)).toThrow('OUTSIDE_BOUND');
  ledger=recordSolCount(ledger,base.requestSha256,64000);
  ledger=reserveSolRequest({ledger,...base,kind:'generation'});
  expect(summarizeSolBudget(ledger)).toMatchObject({contentRequests:2,generations:1,reservedUpperBoundUsd:0.712});
  expect(()=>reserveSolRequest({ledger,...base,sourceSha256:'d'.repeat(64),kind:'input_tokens'})).toThrow('UNKNOWN_OUTCOME');
 });
 it('rejects replay, arbitrary retry, stale pricing, tampered reservations and an alias ledger',()=>{
  const counted=recordSolCount(reserveSolRequest({ledger:newSolComparisonLedger(),...base,kind:'input_tokens'}),base.requestSha256,1000);
  expect(()=>reserveSolRequest({ledger:counted,...base,kind:'input_tokens'})).toThrow('REPLAY');
  expect(()=>reserveSolRequest({ledger:newSolComparisonLedger(),...base,attempt:2,kind:'input_tokens'})).toThrow('HISTORY');
  expect(()=>reserveSolRequest({ledger:newSolComparisonLedger(),...base,now:'2026-09-17T00:00:00Z',kind:'input_tokens'})).toThrow('PRICING');
  expect(()=>parseSolComparisonLedger({...counted,model:'gpt-5.6'})).toThrow();
  expect(()=>parseSolComparisonLedger({...counted,reservations:counted.reservations.map(row=>({...row,reservedMicroUsd:1}))})).toThrow('INVALID');
 });
 it('counts twelve preflight requests toward the ceiling even without generation',()=>{
  let ledger=newSolComparisonLedger();
  for(let i=0;i<12;i++){
   const requestSha256=i.toString(16).padStart(64,'0'),sourceSha256=(i+20).toString(16).padStart(64,'0');
   ledger=recordSolCount(reserveSolRequest({ledger,...base,requestSha256,sourceSha256,kind:'input_tokens'}),requestSha256,1000);
  }
  expect(summarizeSolBudget(ledger)).toMatchObject({contentRequests:12,reservedUpperBoundUsd:3.072});
  expect(()=>reserveSolRequest({ledger,...base,kind:'input_tokens'})).toThrow();
 });
});
