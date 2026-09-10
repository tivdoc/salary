import {beforeEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {employmentSnapshotSchema} from '@/engine/facts/snapshot';
import type {PostgresStatement} from '@/server/platform/persistence/postgres/contracts';
import {runAutomaticDevMonth} from './automatic-dev-flow';

const financial=vi.hoisted(()=>vi.fn());
vi.mock('server-only',()=>({}));
vi.mock('./dev-financial-analysis',()=>({runSavedDevFinancialMonth:financial}));

const caseId='11111111-1111-4111-8111-111111111111',version='33333333-3333-4333-8333-333333333333',at='2026-09-10T04:30:00.000Z';
type Input=Parameters<typeof runAutomaticDevMonth>[0];
// A mocked transaction port checks control flow only. It does not prove that a
// real DB committed requests, authenticated answers or published artifacts.
function input(options:{salary?:'missing'|'hourly'|'monthly'|'mixed';periodConfirmed?:boolean;periodMismatch?:'dates'|'document'|'source';baseConfirmed?:boolean}={}){
 const salary=options.salary??'missing',baseMissing=salary==='missing'&&options.baseConfirmed===undefined,common={case_id:caseId,confidence:.94,conflicting_fact_ids:[],resolution:null,created_at:at,
  provenance:[{source_type:'documented',source_reference:{kind:'document',document_id:version,locator:{page:1}},read_by:'machine',verified:false}]};
 const facts=employmentSnapshotSchema.parse({snapshot_id:randomUUID(),analysis_run_id:randomUUID(),case_id:caseId,schema_version:'1.0.0',created_at:at,facts:[
  {...common,fact_id:randomUUID(),path:'compensation.salary_type',value:salary==='missing'?null:salary,status:salary==='missing'?'missing':'confirmed'},
  {...common,fact_id:randomUUID(),path:'compensation.base_monthly_salary',value:baseMissing?null:{currency:'ILS',minor_units:330000},status:baseMissing?'missing':options.baseConfirmed===false?'needs_confirmation':'confirmed'},
  {...common,fact_id:randomUUID(),path:'work.regular_hours',value:null,status:'missing'},
  {...common,fact_id:randomUUID(),path:'documents.period',value:{document_id:options.periodMismatch==='document'?randomUUID():version,
   period:options.periodMismatch==='dates'?{start_date:'2026-05-01',end_date:'2026-05-31'}:{start_date:'2026-06-01',end_date:'2026-06-30'}},status:options.periodConfirmed===false?'needs_confirmation':'confirmed',
   provenance:options.periodMismatch==='source'?[{source_type:'documented',source_reference:{kind:'document',document_id:randomUUID(),locator:{page:1}},read_by:'machine',verified:false}]:common.provenance},
 ]});
 const savedDrafts:Record<string,unknown>[]=[];
 const query=vi.fn(async(statement:PostgresStatement)=>{
  if(statement.name==='automatic_dev_draft_source')return {rows:[{source:{public_id:'TV-1234ABCD',document_id:randomUUID(),version_id:version,source_sha256:'1'.repeat(64)}}],row_count:1};
  if(statement.name==='automatic_dev_draft_offer')return {rows:[{offer_sha256:'2'.repeat(64)}],row_count:1};
  if(statement.name==='automatic_dev_canonical_draft_save'){
   const document=JSON.parse(String(statement.values[0]));savedDrafts.push(document);
   return {rows:[{value:{projection_id:document.id,publication:'draft',replayed:false}}],row_count:1};
  }
  throw Error('UNEXPECTED_ORCHESTRATION_QUERY');
 });
 // Only the saved parent fields consumed by this orchestration are mocked;
 // canonical execution/fact construction has its separate existing tests.
 const parent={bundle:{case_id:caseId,analysis_run_id:facts.analysis_run_id,result_sha256:'3'.repeat(64),as_of:at},
  stages:[{stage:'canonical_facts',payload:{facts}}]} as unknown as Input['parent'];
 const value:Input={context:{client:{query},transaction_id:'unit-no-database'},job:{schema_version:'saved-case-work-v1',case_id:caseId,revision:25,input_sha256:'4'.repeat(64),mode:'draft'},
  orderId:randomUUID(),month:'2026-06',parent};
 return {value,savedDrafts,query};
}

describe('automatic DEV source completion orchestration',()=>{
 beforeEach(()=>{financial.mockReset();financial.mockResolvedValue(undefined);});
 it('allows the new source-completion branch when canonical salary is absent and the period is confirmed',async()=>{
  const h=input(),original=structuredClone(h.value.parent);await runAutomaticDevMonth(h.value);
  expect(financial).toHaveBeenCalledExactlyOnceWith({context:h.value.context,job:h.value.job,orderId:h.value.orderId,parent:h.value.parent});
  expect(h.value.parent).toEqual(original);
  expect(h.savedDrafts).toHaveLength(1);expect(h.savedDrafts[0]).toMatchObject({findings:[],evidence:[],publication:{state:'draft',approved_input_sha256:null,published_at:null}});
 });
 it('keeps missing source-readings in the ordinary waiting result so the enclosing transaction can commit its requests',async()=>{
  const h=input();financial.mockRejectedValueOnce(Error('DEV_FINANCIAL_COMPLETIONS_REQUIRED'));
  await expect(runAutomaticDevMonth(h.value)).resolves.toBeUndefined();expect(h.savedDrafts).toHaveLength(1);
 });
 it('does not attempt financial completion when the existing period reading is still unconfirmed, even if salary is missing',async()=>{
  const h=input({periodConfirmed:false});await runAutomaticDevMonth(h.value);
  expect(financial).not.toHaveBeenCalled();expect(h.savedDrafts).toHaveLength(1);
 });
 it.each(['dates','document','source'] as const)('does not invoke financial completion with mismatching period %s',async periodMismatch=>{
  const h=input({periodMismatch});await runAutomaticDevMonth(h.value);expect(financial).not.toHaveBeenCalled();expect(h.savedDrafts).toHaveLength(1);
 });
 it('continues the original hourly path with the same saved parent',async()=>{
  const h=input({salary:'hourly'});await runAutomaticDevMonth(h.value);expect(financial).toHaveBeenCalledOnce();
 });
 it.each(['monthly','mixed'] as const)('does not reinterpret explicit %s salary as an hourly completion',async salary=>{
  const h=input({salary});await runAutomaticDevMonth(h.value);expect(financial).not.toHaveBeenCalled();
 });
 it('waits for a present base amount to be confirmed rather than invoking missing-source completion',async()=>{
  const h=input({baseConfirmed:false});await runAutomaticDevMonth(h.value);expect(financial).not.toHaveBeenCalled();
 });
 it.each(['ANALYSIS_INPUT_SUPERSEDED','DEV_FINANCIAL_COMPLETION_BINDING','DEV_FINANCIAL_COMPLETION_SOURCE_UNSUPPORTED'])('propagates %s instead of acknowledging a waiting success',async code=>{
  const h=input();financial.mockRejectedValueOnce(Error(code));await expect(runAutomaticDevMonth(h.value)).rejects.toThrow(code);
 });
});
