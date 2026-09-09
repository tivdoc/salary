import {beforeEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {openSavedDocumentFieldRequests} from './saved-field-requests';
import type {SavedOrderScope} from './saved-order-scope';
import type {SourceJob} from './source-dispatch';

const ports=vi.hoisted(()=>({admit:vi.fn(),orders:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('./saved-admission',()=>({admitSavedSource:ports.admit}));
vi.mock('./saved-order-scope',async importOriginal=>({...await importOriginal<typeof import('./saved-order-scope')>(),readSavedOrders:ports.orders}));
beforeEach(()=>{vi.resetAllMocks();ports.admit.mockResolvedValue({});});

function setup(){
 const fixture=buildSyntheticCaseFixture({fixture_id:'purchased-field-requests',mode:'real'}),doc=fixture.stored.documents[0];
 const extraction=structuredClone(fixture.stored.extractions[0]);
 for(const candidate of extraction.fields)if(['base_monthly_salary','pension_base'].includes(candidate.field))candidate.confidence=0.6;
 const checkpoint={schema_version:'tivdoc-saved-extraction-v1',case_id:doc.case_id,product_document_id:randomUUID(),version_id:doc.document_id,input_sha256:doc.content_sha256,expected_month:'2025-01',period_mismatch:false,result_sha256:'',run:{result:{final_extraction:extraction}}};
 const rehash=()=>checkpoint.result_sha256=canonicalSha256(checkpoint.run.result);rehash();
 const job:SourceJob={schema_version:'saved-case-work-v1',case_id:doc.case_id,revision:1,input_sha256:'a'.repeat(64),mode:'draft'};
 const order:SavedOrderScope={id:randomUUID(),kind:'initial',from:'2025-01-01',to:'2025-01-01',topics:['minimum_wage'],offer_sha256:'b'.repeat(64)};
 ports.orders.mockResolvedValue([order]);
 const state:{allowed:unknown;rows?:Record<string,unknown>[];opened:string[];topics:unknown[]}={allowed:['salary_type','salary_period','base_monthly_salary','hourly_rate','gross_salary','net_salary','regular_hours'],opened:[],topics:[]};
 const context:PostgresTransactionContext={transaction_id:'field-unit',client:{async query(s){
  if(s.name==='saved_field_question_scope'){expect(s.text).toContain('document_field_question_fields_v2(');expect(typeof s.values[0]).toBe('string');state.topics.push(JSON.parse(String(s.values[0])));const rows=state.rows??[{fields:state.allowed}];return {rows,row_count:rows.length};}
  if(s.name==='saved_field_request_open'){state.opened.push(JSON.parse(String(s.values[3])).candidate.field);return {rows:[{id:randomUUID()}],row_count:1};}
  throw Error('UNEXPECTED_QUERY:'+s.name);
 }}};
 return {job,checkpoint,extraction,rehash,order,state,run:()=>openSavedDocumentFieldRequests(context,job,checkpoint)};
}

it('opens the uncertain shared salary reading but not an unpurchased pension question',async()=>{
 const s=setup();await s.run();expect(s.state.opened).toEqual(['base_monthly_salary']);expect(s.state.topics).toEqual([['minimum_wage']]);
});
it('unions only purchased topics covering this document month',async()=>{
 const s=setup();ports.orders.mockResolvedValue([s.order,{...s.order,id:randomUUID(),topics:['pension'],from:'2025-02-01',to:'2025-02-01'},{...s.order,id:randomUUID(),topics:['travel','minimum_wage']}]);
 await s.run();expect(s.state.topics).toEqual([['minimum_wage','travel']]);expect(s.state.opened).toEqual(['base_monthly_salary']);
});
it('includes a purchased dedicated field when the server policy authorizes it',async()=>{
 const s=setup();s.order.topics=['pension'];s.state.allowed=['base_monthly_salary','pension_base'];await s.run();expect(s.state.opened).toEqual(['base_monthly_salary','pension_base']);
});
it('refuses a document outside every purchased period before creating questions',async()=>{
 const s=setup();s.order.from=s.order.to='2025-02-01';await expect(s.run()).rejects.toThrow('REQUEST_FIELD_UNPURCHASED_MONTH');expect(s.state.opened).toEqual([]);
});
it.each(['SAVED_ORDER_ENTITLEMENT_REQUIRED','SAVED_ORDER_SCOPE'])('refuses a revoked or changed saved scope: %s',async error=>{
 const s=setup();ports.orders.mockRejectedValue(Error(error));await expect(s.run()).rejects.toThrow(error);expect(s.state.opened).toEqual([]);
});
it.each([null,['unknown'],['base_monthly_salary','base_monthly_salary']])('refuses an invalid policy response %j before creating questions',async allowed=>{
 const s=setup();s.state.allowed=allowed;await expect(s.run()).rejects.toThrow();expect(s.state.opened).toEqual([]);
});
it('refuses an ambiguous policy acknowledgement',async()=>{
 const s=setup();s.state.rows=[{fields:['base_monthly_salary']},{fields:['pension_base']}];await expect(s.run()).rejects.toThrow('REQUEST_FIELD_SCOPE_ACK');expect(s.state.opened).toEqual([]);
});
it('keeps confident, absent or invalid readings out even when their topic is purchased',async()=>{
 const s=setup();s.order.topics=['pension'];s.state.allowed=['base_monthly_salary','pension_base'];for(const c of s.extraction.fields){if(c.field==='base_monthly_salary')c.confidence=1;if(c.field==='pension_base')c.normalized_value=null;}s.rehash();await s.run();expect(s.state.opened).toEqual([]);
});
it('does not ask from a mismatched document period or a refused case admission',async()=>{
 const s=setup();s.checkpoint.period_mismatch=true;expect(await s.run()).toEqual([]);expect(ports.orders).not.toHaveBeenCalled();ports.admit.mockRejectedValueOnce(Error('SAVED_WORKER_SCOPE_FORBIDDEN'));await expect(s.run()).rejects.toThrow('SAVED_WORKER_SCOPE_FORBIDDEN');expect(s.state.opened).toEqual([]);
});
it('opens low-confidence salary type and period readings through purchased v2 scope without changing confidence',async()=>{
 const s=setup();for(const candidate of s.extraction.fields)if(['salary_type','salary_period'].includes(candidate.field))candidate.confidence=0.94;s.rehash();
 await s.run();expect(s.state.opened).toEqual(['salary_period','salary_type','base_monthly_salary']);
 expect(s.extraction.fields.filter(c=>['salary_type','salary_period'].includes(c.field)).every(c=>c.confidence===0.94)).toBe(true);
});
it('accepts all fourteen valid server-policy fields while retaining topic-specific candidate checks',async()=>{
 const s=setup();s.order.topics=['minimum_wage','working_time','pension'];s.state.allowed=['salary_type','salary_period','base_monthly_salary','hourly_rate','gross_salary','net_salary','regular_hours','overtime_125_hours','overtime_150_hours','pension_base','travel_amount','convalescence_amount','vacation_balance','sick_balance'];
 await s.run();expect(s.state.opened).toEqual(['base_monthly_salary','pension_base']);
});
