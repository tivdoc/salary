import {beforeEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import type {PostgresTransactionContext,PostgresStatement} from '@/server/platform/persistence/postgres/contracts';
import {documentTranscriptionTargetSchema,documentTranscriptionQuestion,type DocumentTranscriptionSelector} from '../reports/document-field-transcription';
import {openSavedTranscriptionRequests} from './saved-transcription-requests';
import {SAVED_EXTRACTION_POLICY} from './saved-snapshot';
import type {SavedOrderScope} from './saved-order-scope';
import type {SourceJob} from './source-dispatch';

const ports=vi.hoisted(()=>({admit:vi.fn(),orders:vi.fn(),buildTarget:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('./saved-admission',()=>({admitSavedSource:ports.admit}));
vi.mock('./saved-order-scope',async load=>({...await load<typeof import('./saved-order-scope')>(),readSavedOrders:ports.orders}));
vi.mock('../reports/document-field-transcription',async load=>({...await load<typeof import('../reports/document-field-transcription')>(),createDocumentTranscriptionTarget:ports.buildTarget}));
beforeEach(()=>vi.resetAllMocks());

/** Recording adapter test: saved admission/order authority and the separately
 * tested pure checkpoint validator are explicit boundaries, not DB evidence. */
function setup(){
 const caseId=randomUUID(),version=randomUUID(),events:string[]=[];
 const component={component_id:randomUUID(),source_label:'Synthetic row',normalized_label:null,semantic_kind:'unknown' as const,
  quantity_raw:null,rate_raw:'33.00',percentage_raw:null,amount_raw:'3,300.00',confidence:.94,source:{document_id:version,page:1},
  extraction_method:'ai_vision' as const,warning_flags:[],quantity:null,rate:{currency:'ILS',minor_units:3300},percentage:null,amount:{currency:'ILS',minor_units:330000},normalization_warnings:[]};
 const checkpoint={schema_version:'tivdoc-saved-extraction-v1',case_id:caseId,product_document_id:randomUUID(),version_id:version,input_sha256:'c'.repeat(64),
  expected_month:'2026-06',period_mismatch:false,result_sha256:'d'.repeat(64),run:{result:{final_extraction:{fields:[] as {field:string;normalized_value?:unknown}[],additional_components:[component]}}}};
 const job:SourceJob={schema_version:'saved-case-work-v1',case_id:caseId,revision:7,input_sha256:'a'.repeat(64),mode:'draft'};
 const order:SavedOrderScope={id:randomUUID(),kind:'initial',from:'2026-06-01',to:'2026-06-01',topics:['minimum_wage'],offer_sha256:'b'.repeat(64)};
 const state:{orders:SavedOrderScope[];acks:unknown[];queries:PostgresStatement[];targets:unknown[]}={orders:[order],acks:[],queries:[],targets:[]};
 const context:PostgresTransactionContext={transaction_id:'transcription-opener-unit',client:{async query(statement){
  events.push('persist');state.queries.push(statement);
  const target=documentTranscriptionTargetSchema.parse(JSON.parse(String(statement.values[3])));state.targets.push(target);
  expect(statement.name).toBe('saved_transcription_open');expect(statement.text).toBe('select private.document_transcription_request_open($1::uuid,$2,$3,$4::jsonb,$5) id');
  expect(statement.values.slice(0,3)).toEqual([caseId,job.revision,job.input_sha256]);expect(statement.values[4]).toBe(documentTranscriptionQuestion(target).question);
  return {rows:[{id:state.acks.length?state.acks.shift():randomUUID()}],row_count:1};
 }}};
 ports.admit.mockImplementation(async(actualContext,actualJob)=>{expect(actualContext).toBe(context);expect(actualJob).toBe(job);events.push('admit');return {};});
 ports.orders.mockImplementation(async(actualContext,actualJob)=>{expect(actualContext).toBe(context);expect(actualJob).toBe(job);events.push('orders');return state.orders;});
 ports.buildTarget.mockImplementation((input:{checkpoint:typeof checkpoint;policyVersion:string;subject:DocumentTranscriptionSelector})=>{
  expect(input.checkpoint).toBe(checkpoint);expect(input.policyVersion).toBe(SAVED_EXTRACTION_POLICY);events.push('target:'+input.subject.kind);
  const subject=input.subject.kind==='salary_type'?{kind:'salary_type' as const,page:1 as const}:{kind:'component_amount' as const,component};
  if(input.subject.kind==='component_amount')expect(input.subject.componentId).toBe(component.component_id);
  const body={schema_version:'document-transcription-v1',case_id:caseId,product_document_id:checkpoint.product_document_id,version_id:version,
   source_sha256:checkpoint.input_sha256,month:'2026-06',policy_version:input.policyVersion,extraction_result_sha256:checkpoint.result_sha256,subject};
  return documentTranscriptionTargetSchema.parse({...body,target_sha256:canonicalSha256(body)});
 });
 return {job,checkpoint,component,order,state,events,context,run:()=>openSavedTranscriptionRequests(context,job,checkpoint)};
}

it('authorizes the exact job and purchased period before building either missing-source request, preserving the checkpoint',async()=>{
 const s=setup(),before=structuredClone(s.checkpoint);expect(await s.run()).toHaveLength(2);
 expect(s.events).toEqual(['admit','orders','target:salary_type','target:component_amount','persist','persist']);
 expect(s.checkpoint).toEqual(before);expect(s.state.targets).toEqual([expect.objectContaining({case_id:s.job.case_id,source_sha256:s.checkpoint.input_sha256,subject:{kind:'salary_type',page:1}}),
  expect.objectContaining({subject:{kind:'component_amount',component:s.component}})]);
});
it('refuses a foreign case before consulting authority or creating a target',async()=>{
 const s=setup();s.checkpoint.case_id=randomUUID();await expect(s.run()).rejects.toThrow('TRANSCRIPTION_CASE_MISMATCH');
 expect(s.events).toEqual([]);expect(ports.buildTarget).not.toHaveBeenCalled();
});
it.each(['other-month','mismatch','missing-month'] as const)('does not open requests for %s input',async change=>{
 const s=setup();if(change==='other-month')s.checkpoint.expected_month='2026-07';if(change==='mismatch')s.checkpoint.period_mismatch=true;
 if(change==='missing-month'){const {expected_month,...missing}=s.checkpoint;void expected_month;await expect(openSavedTranscriptionRequests(s.context,s.job,missing)).rejects.toThrow();}
 else expect(await s.run()).toEqual([]);
 expect(s.events).toEqual([]);expect(ports.buildTarget).not.toHaveBeenCalled();
});
it.each(['no-order','other-month','other-topic','split-month-and-topic'] as const)('does not borrow an entitlement from %s',async change=>{
 const s=setup();
 if(change==='no-order')s.state.orders=[];
 if(change==='other-month')s.order.from=s.order.to='2026-07-01';
 if(change==='other-topic')s.order.topics=['pension'];
 if(change==='split-month-and-topic')s.state.orders=[{...s.order,topics:['pension']},{...s.order,id:randomUUID(),from:'2026-07-01',to:'2026-07-01'}];
 expect(await s.run()).toEqual([]);expect(s.events).toEqual(['admit','orders']);expect(ports.buildTarget).not.toHaveBeenCalled();
});
it('accepts a full paid period covering June only through its own minimum-wage scope',async()=>{
 const s=setup();s.order.kind='full';s.order.from='2026-01-01';s.order.to='2026-12-01';expect(await s.run()).toHaveLength(2);
 expect(ports.orders).toHaveBeenCalledExactlyOnceWith(s.context,s.job);
});
it.each(['SAVED_ORDER_ENTITLEMENT_REQUIRED','SAVED_ORDER_SCOPE'])('propagates %s without manufacturing a scoped target',async code=>{
 const s=setup();ports.orders.mockRejectedValueOnce(Error(code));await expect(s.run()).rejects.toThrow(code);expect(s.state.queries).toEqual([]);expect(ports.buildTarget).not.toHaveBeenCalled();
});
it('stops at a refused machine/source admission',async()=>{
 const s=setup();ports.admit.mockRejectedValueOnce(Error('SAVED_WORKER_SCOPE_FORBIDDEN'));
 await expect(s.run()).rejects.toThrow('SAVED_WORKER_SCOPE_FORBIDDEN');expect(ports.orders).not.toHaveBeenCalled();expect(s.state.queries).toEqual([]);
});
it.each(['salary_type','base_monthly_salary'] as const)('opens no paired completion when %s already exists, including an unresolved value',async field=>{
 for(const normalized_value of [null,field==='salary_type'?'hourly':{currency:'ILS',minor_units:330000}]){
  const s=setup();s.checkpoint.run.result.final_extraction.fields=[{field,normalized_value}];
  expect(await s.run()).toEqual([]);expect(ports.buildTarget).not.toHaveBeenCalled();expect(s.state.queries).toEqual([]);
 }
});
it('opens nothing when both candidates already exist',async()=>{
 const s=setup();s.checkpoint.run.result.final_extraction.fields=[{field:'salary_type'},{field:'base_monthly_salary'}];expect(await s.run()).toEqual([]);expect(ports.buildTarget).not.toHaveBeenCalled();
});
it.each([0,2])('does not select a component when the table has %s rows',async count=>{
 const s=setup();
 s.checkpoint.run.result.final_extraction.additional_components=count===0?[]:[s.component,{...s.component,component_id:randomUUID()}];
 expect(await s.run()).toEqual([]);expect(ports.buildTarget).not.toHaveBeenCalled();
});
it.each(['TRANSCRIPTION_PERIOD_UNSUPPORTED','TRANSCRIPTION_SINGLE_PAGE_RECEIPT_REQUIRED','TRANSCRIPTION_EXTRACTION_UNSUPPORTED','TRANSCRIPTION_COMPONENT_UNSUPPORTED','TRANSCRIPTION_COMPONENT_TOTAL_CONFLICT'])('preserves unresolved evidence on %s without claiming a question was saved',async code=>{
 const s=setup();ports.buildTarget.mockImplementation(()=>{throw Error(code);});expect(await s.run()).toEqual([]);expect(s.state.queries).toEqual([]);
});
it.each(['TRANSCRIPTION_SOURCE_MISMATCH','TRANSCRIPTION_PROVIDER_READINGS_FORBIDDEN','PROVIDER_RECEIPT_HASH_MISMATCH'])('does not silently swallow integrity failure %s',async code=>{
 const s=setup();ports.buildTarget.mockImplementation(()=>{throw Error(code);});await expect(s.run()).rejects.toThrow(code);expect(s.state.queries).toEqual([]);
});
it('propagates the locked DB refusal so the caller transaction can roll back question writes',async()=>{
 const s=setup();s.context.client.query=vi.fn().mockRejectedValue(Error('TRANSCRIPTION_SOURCE_OR_SCOPE_CHANGED'));
 await expect(s.run()).rejects.toThrow('TRANSCRIPTION_SOURCE_OR_SCOPE_CHANGED');expect(ports.buildTarget).toHaveBeenCalledTimes(2);
});
it('writes neither question if the second target is unsupported after the first was prepared',async()=>{
 const s=setup(),build=ports.buildTarget.getMockImplementation()!;
 ports.buildTarget.mockImplementation(input=>{if(input.subject.kind==='component_amount')throw Error('TRANSCRIPTION_COMPONENT_UNSUPPORTED');return build(input);});
 expect(await s.run()).toEqual([]);expect(ports.buildTarget).toHaveBeenCalledTimes(2);
 expect(s.events).toEqual(['admit','orders','target:salary_type']);expect(s.state.queries).toEqual([]);
});
it('does not treat a closed existing target as a newly opened request',async()=>{
 const s=setup(),id=randomUUID();s.state.acks=[null,id];expect(await s.run()).toEqual([id]);expect(s.state.queries).toHaveLength(2);
});
it.each([undefined,'invalid-id'])('refuses malformed opener acknowledgement %s',async id=>{
 const s=setup();s.state.acks=[id];await expect(s.run()).rejects.toThrow();
});
