import {describe,it,expect,vi} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {materializeTravelTariffSource} from '@/engine/entitlement-review/travel/tariff-source';
import {travelFloorFixture} from '@/engine/entitlement-review/travel/floor.fixture';
import {resolveTravelEntitlement} from '@/engine/entitlement-review/travel';
import {calculateDocumentReview} from '@/engine/document-review/calculations';
import {documentTravelTariffTarget,documentTravelTariffTargetSchema,documentTravelTariffQuestion,documentTravelTariffDisplay,
 resolveDocumentTravelTariffVerification,DOCUMENT_TRAVEL_TARIFF_POLICY,type DocumentTravelTariffSource} from './document-travel-tariff';
import {documentReadingTargetSchema,documentReadingTargetForCheckpoint} from './document-field-confirmation';
import {validateRequestAnswer} from './request-answer';
import {validateSavedReadingAnswer} from './validate-reading-answer';
import {validateDocumentReadingAnswerForTarget,resolveDocumentReadingVerification,materializeDocumentVerification} from './reading-verification';
import type {CaseAccessDb} from '../case-access/db';
vi.mock('server-only',()=>({}));
const id=(n:number)=>`11111111-1111-4111-8111-${String(n).padStart(12,'0')}`;
const source:DocumentTravelTariffSource={document:{case_id:'11111111-1111-4111-8111-111111111111',document_id:id(2),version_id:id(3),file_sha256:'a'.repeat(64),
 page_count:3,month:'2026-06',document_type:'other',evidence_purpose:'travel_tariff',purpose_sha256:'b'.repeat(64)},group:{page:2,locator:'Synthetic route fare table'}};
const subjects=['context','daily_fare','ticket_inventory','monthly_pass_cost'] as const;
function target(subject:typeof subjects[number]='daily_fare'){return documentTravelTariffTarget({source,subject});}
function wire(subject:typeof subjects[number]='daily_fare',value:unknown='9.50'){
 return {schema_version:'document-field-answer-v3',action:'correct',structured_value:{kind:'travel_tariff',subject,value,basis:{page:2,locator:'Synthetic exact table cell',text:'Synthetic explicitly printed source'}}};
}
function input(subject:typeof subjects[number]='daily_fare',value:unknown='9.50'){
 return {target:target(subject),source,caseId:source.document.case_id,month:source.document.month,policyVersion:DOCUMENT_TRAVEL_TARIFF_POLICY,
 requestId:id(10+subjects.indexOf(subject)),answerRevision:1,identityId:id(8),answeredAt:'2026-09-12T12:00:00Z',answer:JSON.stringify(wire(subject,value))};
}
function reseal<T extends {target_sha256:string}>(target:T){const {target_sha256,...body}=target;void target_sha256;return {...body,target_sha256:canonicalSha256(body)};}

describe('protected ordinary travel tariff target and answer dispatch',()=>{
 it('wraps unchanged inner source identity with an independent exact document_field hash, without a provider checkpoint',()=>{
  const t=target();expect(documentReadingTargetSchema.parse(t)).toEqual(t);
  expect(t.target_sha256).not.toBe(t.tariff.target_sha256);expect(t).not.toHaveProperty('extraction_result_sha256');
  expect(t).toMatchObject({product_document_id:source.document.document_id,source_sha256:source.document.file_sha256,purpose_sha256:source.document.purpose_sha256});
  expect(documentReadingTargetForCheckpoint({target:t,currentCheckpoint:null,travelTariffSource:source})).toEqual(t);
  expect(()=>documentReadingTargetForCheckpoint({target:t,currentCheckpoint:{}})).toThrow('TRAVEL_TARIFF_PURPOSE_CONTEXT_REQUIRED');
  expect(documentTravelTariffQuestion(t).code).toBe('document_field:'+t.target_sha256);
  expect(documentTravelTariffDisplay(t)).toMatchObject({raw_value:null,tariff_context:{subject:'daily_fare',page:2},actions:['correct','unreadable','unknown']});
 });
 it.each(['case_id','product_document_id','version_id','source_sha256','month','purpose_sha256'] as const)('rejects resealed alias tampering: %s',field=>{
  const t=target(),changed={...t,[field]:field==='month'?'2026-07':field.endsWith('sha256')?'c'.repeat(64):id(99)};
  expect(()=>documentTravelTariffTargetSchema.parse(reseal(changed))).toThrow('TRAVEL_TARIFF_WRAPPER_SOURCE');
 });
 it('rejects inner or outer hash tampering, wrong document purpose/type and an unbound source page',()=>{
  const t=target();expect(()=>documentReadingTargetSchema.parse({...t,target_sha256:'c'.repeat(64)})).toThrow();
  expect(()=>documentReadingTargetSchema.parse(reseal({...t,tariff:{...t.tariff,target_sha256:'c'.repeat(64)}}))).toThrow();
  for(const document of [{...source.document,document_type:'contract'},{...source.document,evidence_purpose:'salary'}])
   expect(()=>documentTravelTariffTarget({source:{...source,document} as DocumentTravelTariffSource,subject:'context'})).toThrow();
  expect(()=>documentTravelTariffTarget({source:{...source,group:{...source.group,page:4}},subject:'context'})).toThrow();
 });
 it.each(['version','hash','purpose','group','month'] as const)('retains a stale answer without a reading when current %s changes',kind=>{
  const current=structuredClone(source);
  if(kind==='version')current.document.version_id=id(99);if(kind==='hash')current.document.file_sha256='c'.repeat(64);
  if(kind==='purpose')current.document.purpose_sha256='c'.repeat(64);if(kind==='group')current.group.locator='Different source group';
  if(kind==='month')current.document.month='2026-07';
  expect(resolveDocumentTravelTariffVerification({...input(),source:current})).toEqual({state:'stale'});
 });
 it('rebuilds source-only receipts from server actor/revision and preserves affirmative zero',()=>{
  const i=input('daily_fare','0'),r=resolveDocumentReadingVerification({...i,currentCheckpoint:null,travelTariffSource:source});
  expect(r.state).toBe('tariff_current');if(r.state!=='tariff_current')throw Error('TEST_CURRENT_TARIFF');
  expect(r.reading).toMatchObject({state:'identified',identity_id:i.identityId,answer_revision:1,value:{value:'0'}});
  expect(r.entry.target).toEqual(i.target.tariff);expect(materializeDocumentVerification(r,'not-an-extraction')).toMatchObject({kind:'travel_tariff',entry:r.entry});
  expect(()=>resolveDocumentTravelTariffVerification({...i,caseId:id(99)})).toThrow('REQUEST_FIELD_CASE_MISMATCH');
  expect(()=>resolveDocumentTravelTariffVerification({...i,identityId:''})).toThrow();
  expect(resolveDocumentTravelTariffVerification({...i,policyVersion:'legacy'})).toEqual({state:'stale'});
 });
 it.each(['unknown','unreadable'] as const)('keeps %s negative rather than converting it to a tariff or zero',action=>{
  const r=resolveDocumentTravelTariffVerification({...input(),answer:{schema_version:'document-field-answer-v3',action}});
  expect(r).toMatchObject({state:'tariff_current',reading:{state:action,value:null},entry:{answer:{action}}});
 });
 it('enforces typed target subjects/pages and forbids confirm, extra authority and generic numeric declarations',()=>{
  const t=target(),valid=wire(),request={code:'document_field:'+t.target_sha256,answer_kind:'choice' as const};
  expect(validateRequestAnswer(request,JSON.stringify(valid))).toBe(JSON.stringify(valid));
  expect(validateDocumentReadingAnswerForTarget(t,valid)).toEqual(valid);
  for(const answer of [wire('monthly_pass_cost'),{...valid,identity_id:id(8)},'9.50','כן, בדקתי במסמך והערך נכון',
   {...valid,action:'confirm'},{...valid,structured_value:{...valid.structured_value,basis:{...valid.structured_value.basis,page:1}}},
   wire('daily_fare','-1'),wire('daily_fare','NaN'),wire('daily_fare','1.234'),wire('daily_fare','')])
   expect(()=>validateDocumentReadingAnswerForTarget(t,answer)).toThrow('REQUEST_ANSWER_INVALID');
 });
 it('requires independently current purpose state from the protected lookup even for a self-consistent target',async()=>{
  let current:boolean|undefined=true,duplicate=false;const calls:string[]=[];
  const store:CaseAccessDb={provider:'fake',async rpc<T>(fn:string,args:Readonly<Record<string,unknown>>){calls.push(fn);expect(args).toEqual({target_case:source.document.case_id,target_identity:id(8)});
   const rows=fn==='case_request_field_reading_targets'?[{request_id:id(10),target:target()}]:current===undefined?[]:[{request_id:id(10),source_current:current},...(duplicate?[{request_id:id(10),source_current:true}]:[])];return rows as unknown as T[];}};
  const args={store,caseId:source.document.case_id,identityId:id(8),requestId:id(10),code:'document_field:'+target().target_sha256,answer:JSON.stringify(wire())};
  await expect(validateSavedReadingAnswer(args)).resolves.toBeUndefined();expect(calls).toEqual(['case_request_field_reading_targets','case_request_field_states']);
  for(const state of [false,undefined]){current=state;await expect(validateSavedReadingAnswer(args)).rejects.toThrow('REQUEST_FIELD_SOURCE_CHANGED');}
  current=true;duplicate=true;await expect(validateSavedReadingAnswer(args)).rejects.toThrow('REQUEST_FIELD_SOURCE_CHANGED');
  await expect(validateSavedReadingAnswer({...args,identityId:undefined})).rejects.toThrow('REQUEST_FIELD_FORBIDDEN');
  await expect(validateSavedReadingAnswer({...args,requestId:id(99)})).rejects.toThrow('REQUEST_FIELD_FORBIDDEN');
 });
 it('passes only reconstructed inner journal entries to the existing tariff materializer and RuleSpec branch',()=>{
  const values={context:{route_reference:'Synthetic route Z',discount_profile:'standard_adult',effective_period:{from:'2026-05-01',to:'2026-07-31'},directions:'both'},
   daily_fare:'9.50',ticket_inventory:{ticket_inventory:'complete',monthly_pass_availability:'available'},monthly_pass_cost:'159.00'};
  const journal=subjects.map(subject=>{const r=resolveDocumentTravelTariffVerification(input(subject,values[subject]));if(r.state!=='tariff_current')throw Error('TEST_READING_REQUIRED');return r.entry;});
  const travel=travelFloorFixture();travel.discounted_daily_fare=null;travel.monthly_pass_cost=null;travel.monthly_pass={state:'missing',value:null,source:null,basis:'ai_source_assessment'};
  const out=materializeTravelTariffSource({travel,current:source.document,group:source.group,journal});
  expect(out.dependencies.every(d=>d.answered)).toBe(true);expect(out.receipts).toHaveLength(4);
  const result=resolveTravelEntitlement(out.travel);expect(result.checks.length).toBeGreaterThan(0);
  const compared=result.checks.find(c=>c.check_id.endsWith('.comparison'));expect(compared).toBeDefined();
  expect(calculateDocumentReview(compared!.calculation)).toMatchObject({state:'calculated',expected:{minor_units:15900},difference:{minor_units:-3100}});
  expect(out.travel.discounted_daily_fare?.printed_value).toBe('9.50');expect(out.travel.monthly_pass_cost?.printed_value).toBe('159.00');
  expect(out.travel.fare_source_context?.association.state).toBe('observed');expect(out.travel.applicability.some(d=>d.decision_id==='travel.no_better_arrangement'&&d.state==='accepted')).toBe(false);
 });
});
