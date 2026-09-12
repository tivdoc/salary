import {sharedPersonalV3Fixture as raw} from './shared-product-facts-v3.fixture.ts';
import {describe,it,expect} from 'vitest';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {composeEntitlementReview} from './compose.ts';
import {enableSharedPersonalFacts,SHARED_PERSONAL_FACTS_TRAVEL_POLICY,sharedPersonalAnswerCoversCheck} from './shared-product-facts.ts';
import {minimumWageEntitlementInputSchema} from './minimum-wage/contracts.ts';
import {pensionEntitlementInputSchema} from './pension/contracts.ts';
import {pensionProductFactQuestions} from './pension/product-facts.ts';
import {travelEntitlementInputSchema} from './travel/contracts.ts';
import {convalescenceEntitlementInputSchema} from './convalescence/contracts.ts';
import {convalescenceCaseFactsSchema} from './convalescence/product-facts.ts';
import {vacationEntitlementInputSchema} from './vacation/contracts.ts';
import {workingTimeEntitlementInputSchema} from './working-time/contracts.ts';
import {applyDocumentReviewAnswer,runDocumentReview} from '../document-review/service.ts';
import {generateReviewCompletions,parseReviewCompletionInput,type ReviewCompletion} from '../document-review/completions.ts';
import {assertEntitlementSourcePacket} from './source-admission.ts';
import {entitlementLegalDocuments} from './legal-documents.ts';
import type {DocumentReviewInput} from '../document-review/contracts.ts';
const at='2026-09-12T12:00:00Z',identity='22222222-2222-4222-8222-222222222222';
function values(input:DocumentReviewInput){const e=input.entitlement_composition!.evidence;return [minimumWageEntitlementInputSchema.parse(e.minimum_wage).product_facts!,pensionEntitlementInputSchema.parse(e.pension).product_facts!,travelEntitlementInputSchema.parse(e.travel).product_facts!,convalescenceCaseFactsSchema.parse(convalescenceEntitlementInputSchema.parse(e.convalescence).product_facts),vacationEntitlementInputSchema.parse(e.vacation).product_facts!,...workingTimeEntitlementInputSchema.array().parse(e.working_time).map(w=>w.product_facts!)];}
function request(input:DocumentReviewInput,key:string){const g=input.entitlement_composition!.shared_personal_facts!.groups.find(g=>g.fact===key)!;return generateReviewCompletions({...parseReviewCompletionInput(input.completion_input),evidence:[],previous_answers:[]}).customer_requests.find(r=>r.target.target_sha256===g.canonical_target_sha256)!;}
function answer(input:DocumentReviewInput,r:ReviewCompletion,value:string|null,revision=1){return applyDocumentReviewAnswer(input,{request:r,actor:{case_id:input.case_id,identity_id:identity},answer:{request_id:'55555555-5555-4555-8555-000000000001',revision,answered_at:at,state:value===null?'unknown':'provided',value}}).input;}
describe('shared v3 exact personal facts across six families',()=>{
 it('retains known pension age evidence without inventing or requesting a pension birthday',()=>{
  const input=raw(),before=pensionEntitlementInputSchema.parse(input.entitlement_evidence!.pension),s=composeEntitlementReview(input),after=pensionEntitlementInputSchema.parse(s.entitlement_composition!.evidence.pension);
  expect(before.facts.aged_21_or_more).toMatchObject({state:'known',value:true});expect(before.facts.under_60).toMatchObject({state:'known',value:true});
  expect(pensionProductFactQuestions(before).some(q=>q.path==='product_facts.birth_date')).toBe(false);
  expect(after.facts.aged_21_or_more).toEqual(before.facts.aged_21_or_more);expect(after.facts.under_60).toEqual(before.facts.under_60);expect(after.product_facts!.birth_date).toEqual(before.product_facts!.birth_date);
 });
 it('opens exactly three shared actions when all seventeen recipient personal facts are actually missing',()=>{
  const input=raw(),p=pensionEntitlementInputSchema.parse(input.entitlement_evidence!.pension);
  p.facts.aged_21_or_more={state:'missing',value:null,source:null,basis:'ai_source_assessment'};p.facts.under_60={state:'missing',value:null,source:null,basis:'ai_source_assessment'};input.entitlement_evidence!.pension=p;
  expect(pensionProductFactQuestions(p).some(q=>q.path==='product_facts.birth_date')).toBe(true);
  const s=composeEntitlementReview(input),groups=s.entitlement_composition!.shared_personal_facts!.groups,aliases=groups.flatMap(g=>g.aliases.map(a=>a.fact_key)),keys=new Set(aliases);
  expect(aliases).toHaveLength(17);expect(values(s).every(f=>['birth_date','employment_relationship','workplace_sector'].every(key=>!(key in f)||Reflect.get(f,key).state==='missing'))).toBe(true);
  const requests=runDocumentReview(s,'shared.all-missing').completions.customer_requests.filter(r=>keys.has(r.target.fact_key));
  expect(requests).toHaveLength(3);expect(new Set(requests.map(r=>r.target.target_sha256))).toEqual(new Set(groups.map(g=>g.canonical_target_sha256)));expect(s.answer_history).toEqual([]);
 });
 it('opens three personal questions and preserves separate legal, wage and rest questions',()=>{const s=composeEntitlementReview(raw()),groups=s.entitlement_composition!.shared_personal_facts!.groups;expect(groups).toHaveLength(3);expect(groups.every(g=>g.aliases.length===(g.fact==='birth_date'?5:6)&&g.schema_version==='shared-personal-fact-group-v2')).toBe(true);expect(runDocumentReview(s,'shared.v3').completions.customer_requests.filter(r=>groups.some(g=>g.canonical_target_sha256===r.target.target_sha256))).toHaveLength(3);expect(groups.every(g=>g.aliases.every(a=>a.input_path==='product_facts.'+g.fact))).toBe(true);});
 it('records separate exact week indices while reusing one personal answer',()=>{
  const input=raw(),weeks=workingTimeEntitlementInputSchema.array().parse(input.entitlement_evidence!.working_time),second=structuredClone(weeks[0]);
  const shift=(value:unknown):void=>{if(!value||typeof value!=='object')return;for(const [key,item]of Object.entries(value)){if(['date','week_start','start_at','end_at'].includes(key)&&typeof item==='string'&&/^2026-06-\d{2}/u.test(item)){const date=new Date(Date.parse(item.slice(0,10)) + 7*86400000).toISOString().slice(0,10);Reflect.set(value,key,date+item.slice(10));}else shift(item);}};
  shift(second);second.check_id_prefix+='second';input.entitlement_evidence!.working_time=[weeks[0],second];
  const s=composeEntitlementReview(input),r=request(s,'birth_date'),next=answer(s,r,'1990-04-15'),group=next.entitlement_composition!.shared_personal_facts!.groups.find(g=>g.fact==='birth_date')!;
  expect(group.aliases).toHaveLength(6);expect(group.aliases.filter(a=>a.branch==='working_time').map(a=>'index'in a?a.index:null)).toEqual([0,1]);expect(values(next).filter(f=>'birth_date'in f).every(f=>Reflect.get(f,'birth_date').value==='1990-04-15')).toBe(true);expect(next.answer_history).toHaveLength(1);
 });
 it('one unchanged receipt supplies all six exact slots and an unknown correction blocks all',()=>{const initial=composeEntitlementReview(raw()),r=request(initial,'birth_date'),original=canonicalSha256(initial.entitlement_evidence),s=answer(initial,r,'1990-04-15');const facts=values(s).filter(f=>'birth_date'in f).map(f=>Reflect.get(f,'birth_date'));expect(facts.every(f=>canonicalSha256(f)===canonicalSha256(facts[0]))).toBe(true);expect(s.answer_history).toHaveLength(1);expect(canonicalSha256(s.entitlement_evidence)).toBe(original);expect(sharedPersonalAnswerCoversCheck(s,s.answer_history[0].receipt.answer_sha256,'unrelated.check')).toBe(false);const u=answer(s,r,null,2);expect(values(u).filter(f=>'birth_date'in f).every(f=>Reflect.get(f,'birth_date').state==='unknown')).toBe(true);expect(u.answer_history).toHaveLength(2);expect(u.answer_history[0]).toEqual(s.answer_history[0]);});
 it.each([['employment_relationship','כשכיר/ה','employee'],['workplace_sector','מפעל מוגן','protected_workshop']])('reuses exact %s enums without changing another factual classification',(key,label,expected)=>{
  const initial=composeEntitlementReview(raw()),r=request(initial,key),s=answer(initial,r,label);expect(values(s).every(f=>Reflect.get(f,key)?.value===expected)).toBe(true);const cv=convalescenceCaseFactsSchema.parse(convalescenceEntitlementInputSchema.parse(s.entitlement_composition!.evidence.convalescence).product_facts);expect(cv.employment_category.state).toBe('missing');expect(cv.public_wage_linked.state).toBe('missing');
 });
 it('rejects a changed alias value even when the original answer hash is retained',()=>{const s=answer(composeEntitlementReview(raw()),request(composeEntitlementReview(raw()),'birth_date'),'1990-04-15'),e=structuredClone(s.entitlement_composition!.evidence),v=vacationEntitlementInputSchema.parse(e.vacation);v.product_facts!.birth_date.value='1991-04-15';e.vacation=v;expect(()=>assertEntitlementSourcePacket(s,e,entitlementLegalDocuments(s.case_id,['minimum_wage','pension','travel','vacation','convalescence','working_time']))).toThrow('SHARED_PERSONAL_FACT_REPLAY');});
 it('reuses an already admitted provider source and preserves a conflicting source',()=>{
  const input=raw(),v=vacationEntitlementInputSchema.parse(input.entitlement_evidence!.vacation),source={...v.annual_basis!.employment_start.source!,reading:'provider_extraction' as const};v.product_facts!.birth_date={state:'observed',value:'1990-04-15',source};input.entitlement_evidence!.vacation=v;
  const s=composeEntitlementReview(input);const provided=s.entitlement_composition!.shared_personal_facts!.groups.find(g=>g.fact==='birth_date')!;expect(provided.aliases.map(a=>a.branch)).toEqual(['minimum_wage','convalescence','vacation']);expect(pensionEntitlementInputSchema.parse(s.entitlement_composition!.evidence.pension).product_facts!.birth_date.state).toBe('missing');expect(s.entitlement_composition!.shared_personal_facts!.groups.find(g=>g.fact==='birth_date')?.origin.kind).toBe('source_fact');expect(runDocumentReview(s,'shared.source').completions.customer_requests.filter(r=>r.target.question.includes('תאריך הלידה')).length).toBeGreaterThan(0);
  const cv=convalescenceEntitlementInputSchema.parse(input.entitlement_evidence!.convalescence),f=convalescenceCaseFactsSchema.parse(cv.product_facts);f.birth_date={state:'observed',value:'1991-04-15',source};cv.product_facts=f;if(!cv.source_manifest.some(m=>m.document_id===source.document_id&&m.version_id===source.version_id))cv.source_manifest.push(v.source_manifest[0]);input.entitlement_evidence!.convalescence=cv;
  const conflict=composeEntitlementReview(input);expect(values(conflict).filter(f=>'birth_date'in f).every(f=>Reflect.get(f,'birth_date').state==='conflict')).toBe(true);expect(conflict.answer_history).toEqual([]);
 });
 it('does not change historical v2 recipients or reinterpret CV employment categories',()=>{const a=raw();a.entitlement_evidence=enableSharedPersonalFacts(a.entitlement_evidence!,SHARED_PERSONAL_FACTS_TRAVEL_POLICY);const s=composeEntitlementReview(a);expect(s.entitlement_composition!.shared_personal_facts!.groups.every(g=>g.schema_version==='shared-personal-fact-group-v1'&&g.aliases.length===(g.fact==='birth_date'?2:3))).toBe(true);const cv=convalescenceEntitlementInputSchema.parse(s.entitlement_composition!.evidence.convalescence);expect(convalescenceCaseFactsSchema.parse(cv.product_facts).workplace_sector.state).toBe('missing');});
});
