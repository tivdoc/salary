import {describe,it,expect} from 'vitest';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {nineTopicRuntimeSource} from '../ai-release-runtime/runtime.fixture.ts';
import {documentReviewInputSchema,type DocumentReviewInput} from '../document-review/contracts.ts';
import {generateReviewCompletions,parseReviewCompletionInput,type ReviewCompletion} from '../document-review/completions.ts';
import {runDocumentReview,applyDocumentReviewAnswer,replayDocumentReview} from '../document-review/service.ts';
import {composeEntitlementReview} from './compose.ts';
import {assertEntitlementSourcePacket} from './source-admission.ts';
import {entitlementLegalDocuments} from './legal-documents.ts';
import {minimumWageEntitlementInputSchema} from './minimum-wage/contracts.ts';
import {minimumWagePersonalFacts,minimumWageCaseFactsSchema} from './minimum-wage/product-facts.ts';
import {pensionEntitlementInputSchema} from './pension/contracts.ts';
import {pensionProductFacts} from './pension/product-facts.ts';
import {enableSharedPersonalFacts,sharedPersonalAnswerCoversCheck} from './shared-product-facts.ts';
import {applyAiReleaseDecisionRecipes} from '../ai-release-decisions/apply.ts';
import {AI_RELEASE_DECISION_RECIPES} from '../ai-release-decisions/catalog.ts';
import type {AiReleaseDecisionMethod} from '../ai-release-decisions/contracts.ts';

const at='2026-09-12T12:00:00Z',identity='22222222-2222-4222-8222-222222222222';
function raw(shared=true){const input=nineTopicRuntimeSource(),e=input.entitlement_evidence!,m=minimumWageEntitlementInputSchema.parse(e.minimum_wage),p=pensionEntitlementInputSchema.parse(e.pension);
 m.product_facts=minimumWagePersonalFacts();m.population={state:'missing',value:null,source:null};m.employment={state:'missing',value:null,source:null};
 p.product_facts=pensionProductFacts();for(const key of ['aged_21_or_more','under_60'] as const)p.facts[key]={state:'missing',value:null,source:null,basis:'ai_source_assessment'};
 p.applicability=p.applicability.filter(d=>d.decision_id!=='pension.general_coverage');
 const ids=new Set([...m.source_manifest,...p.source_manifest].map(s=>s.document_id));input.documents=input.documents.filter(d=>ids.has(d.document_id));
 input.completion_input={...parseReviewCompletionInput(input.completion_input),documents:parseReviewCompletionInput(input.completion_input).documents.filter(d=>ids.has(d.pin.document_id))};
 const packet={schema_version:'entitlement-source-evidence-v1' as const,case_id:input.case_id,order_id:input.purchased_scope.order_id,receipt_sha256:input.purchased_scope.receipt_sha256,period:input.period,minimum_wage:m,pension:p};
 input.entitlement_evidence=shared?enableSharedPersonalFacts(packet):packet;return input;
}
function enable(input:DocumentReviewInput){const prior=input.entitlement_composition,checks=new Set(prior?.selections.flatMap(s=>s.generated_check_ids)),gaps=new Set(prior?.selections.flatMap(s=>s.generated_gap_ids)),facts=new Set(prior?.generated_fact_keys);
 return composeEntitlementReview({...input,entitlement_evidence:enableSharedPersonalFacts(input.entitlement_evidence!),entitlement_composition:undefined,
  checks:input.checks.filter(c=>!checks.has(c.check_id)),coverage_gaps:input.coverage_gaps.filter(g=>!gaps.has(g.check_id)),answer_bindings:input.answer_bindings.filter(b=>!checks.has(b.check_id)),
  completion_input:{...parseReviewCompletionInput(input.completion_input),needs:parseReviewCompletionInput(input.completion_input).needs.filter(n=>!facts.has(n.fact_key))}});}
function lookup(input:DocumentReviewInput,key:string,branch?:'minimum_wage'|'pension'){
 const manifest=input.entitlement_composition?.shared_personal_facts,group=manifest?.groups.find(g=>g.fact===key);
 let hash=group?.canonical_target_sha256;
 if(!hash&&branch){const e=branch==='pension'?pensionEntitlementInputSchema.parse(input.entitlement_evidence!.pension):minimumWageEntitlementInputSchema.parse(input.entitlement_evidence!.minimum_wage);
  const pins=input.documents.filter(d=>e.source_manifest.some(m=>m.kind==='case_document'&&m.document_id===d.document_id)).map(d=>({case_id:d.case_id,document_id:d.document_id,version_id:d.version_id,source_sha256:d.file_sha256})),path='product_facts.'+key;
  const factKey=branch==='pension'?`entitlement.pension.${canonicalSha256({period:input.period,pins,path}).slice(0,32)}`:`entitlement.minimum_wage.${canonicalSha256({period:input.period,pins,path,key:'personal.'+path}).slice(0,28)}`;
  hash=runDocumentReview(input,'lookup').completions.customer_requests.find(q=>q.target.fact_key===factKey)?.target.target_sha256;
 }
 const c=parseReviewCompletionInput(input.completion_input);
 const request=generateReviewCompletions({...c,evidence:[],previous_answers:[]}).customer_requests.find(r=>r.target.target_sha256===hash);
 expect(request).toBeDefined();return request!;
}
function answer(input:DocumentReviewInput,request:ReviewCompletion,value:string|null,number=1,revision=1){return applyDocumentReviewAnswer(input,{request,actor:{case_id:input.case_id,identity_id:identity},answer:{
 request_id:`55555555-5555-4555-8555-${String(number).padStart(12,'0')}`,revision,answered_at:at,state:value===null?'unknown':'provided',value}});}
function method():AiReleaseDecisionMethod{const r=AI_RELEASE_DECISION_RECIPES.find(r=>r.recipe_id==='ai-case.pension.general_coverage')!;return {recipe_id:r.recipe_id,recipe_version:'1',recipe_sha256:r.recipe_sha256,source_policy_sha256:r.source_policy_sha256,
 interpretation_receipt_sha256:canonicalSha256('synthetic method'),source_receipts:r.legal_sources.map(s=>({source_version_id:s.version_id,artifact_sha256:s.file_sha256,receipt_sha256:canonicalSha256(s.version_id)})),issued_at:'2026-09-12T00:00:00Z',expires_at:'2026-09-13T00:00:00Z'};}
function personal(input:DocumentReviewInput){const e=input.entitlement_composition!.evidence;return {mw:minimumWageEntitlementInputSchema.parse(e.minimum_wage).product_facts!,pension:pensionEntitlementInputSchema.parse(e.pension).product_facts!};}

describe('shared personal facts use original scoped receipts, not copied answer values',()=>{
 it('offers three common questions for two branches and keeps distinct legal/source questions',()=>{
  const input=composeEntitlementReview(raw()),r=runDocumentReview(input,'shared.initial'),groups=input.entitlement_composition!.shared_personal_facts!.groups;
  expect(groups).toHaveLength(3);expect(groups.every(g=>g.aliases.length===2)).toBe(true);
  expect(r.completions.customer_requests.filter(q=>groups.some(g=>g.canonical_target_sha256===q.target.target_sha256))).toHaveLength(3);
  for(const g of groups)expect(r.completions.customer_requests.filter(q=>g.aliases.some(a=>a.target_sha256===q.target.target_sha256))).toHaveLength(1);
  expect(r.completions.internal_tasks.length).toBeGreaterThan(0);
 });
 it('one new answer serves both exact typed slots with unchanged source and receipt identity',()=>{
  let input=composeEntitlementReview(raw());const originalHash=canonicalSha256(input.entitlement_evidence);
  for(const [i,[key,value]]of [['birth_date','1990-04-15'],['employment_relationship','כשכיר/ה'],['workplace_sector','מעסיק פרטי']].entries())input=answer(input,lookup(input,key),value,i+1).input;
  const facts=personal(input);for(const key of ['birth_date','employment_relationship','workplace_sector'] as const){
   expect(Reflect.get(facts.mw,key)).toEqual(facts.pension[key]);expect(facts.pension[key].state).toBe('declared');expect(facts.pension[key].source?.reading).toBe('customer_declaration');}
  expect(input.answer_history).toHaveLength(3);expect(canonicalSha256(input.entitlement_evidence)).toBe(originalHash);
  expect(runDocumentReview(input,'after').completions.customer_requests.some(q=>input.entitlement_composition!.shared_personal_facts!.groups.some(g=>g.canonical_target_sha256===q.target.target_sha256))).toBe(false);
  const qualified=applyAiReleaseDecisionRecipes({source:input,methods:[method()],at}).source,r=runDocumentReview(qualified,'shared.pension');
  expect(r.checks.filter(c=>c.topic==='pension'&&c.calculation.state==='calculated')).toHaveLength(3);expect(replayDocumentReview(r)).toEqual(r);
 });
 it.each(['minimum_wage','pension'] as const)('reuses a pre-policy %s answer without re-signing its body or historical dependency list',branch=>{
  const old=composeEntitlementReview(raw(false)),originalRequest=lookup(old,'birth_date',branch),answered=answer(old,originalRequest,'1990-04-15').input;
  const before=canonicalSha256(answered.answer_history[0]),current=enable(answered),group=current.entitlement_composition!.shared_personal_facts!.groups.find(g=>g.fact==='birth_date')!;
  expect(group.canonical_target_sha256).toBe(originalRequest.target.target_sha256);expect(canonicalSha256(current.answer_history[0])).toBe(before);expect(personal(current).mw.birth_date).toEqual(personal(current).pension.birth_date);
  expect(runDocumentReview(current,'old.answer').completions.customer_requests.some(q=>q.target.fact_key===group.canonical_fact_key)).toBe(false);
  const invalidated=answer(current,originalRequest,null,1,2);expect(invalidated.resolution.invalidated_check_ids).toEqual(expect.arrayContaining(group.aliases.flatMap(a=>a.dependent_check_ids)));
  expect(personal(invalidated.input).mw.birth_date.state).toBe('unknown');expect(personal(invalidated.input).pension.birth_date.state).toBe('unknown');expect(invalidated.input.answer_history).toHaveLength(2);
  expect(invalidated.input.answer_history[0].request).toEqual(originalRequest);
 });
 it('admits the exact extra consumer for a legacy MW receipt and rejects unrelated check IDs',()=>{
  let input=composeEntitlementReview(raw(false));const old=lookup(input,'birth_date','minimum_wage');input=enable(answer(input,old,'1990-04-15').input);
  input=answer(input,lookup(input,'employment_relationship'),'כשכיר/ה',2).input;input=answer(input,lookup(input,'workplace_sector'),'מעסיק פרטי',3).input;
  const prepared=applyAiReleaseDecisionRecipes({source:input,methods:[method()],at}).source,r=runDocumentReview(prepared,'old.dep');
  const check=r.checks.find(c=>c.topic==='pension')!.check_id;expect(old.dependent_check_ids).not.toContain(check);
  expect(sharedPersonalAnswerCoversCheck(prepared,input.answer_history[0].receipt.answer_sha256,check)).toBe(true);
  expect(sharedPersonalAnswerCoversCheck(prepared,input.answer_history[0].receipt.answer_sha256,'unrelated.money')).toBe(false);
 });
 it('does not pick a winner among conflicting old answers and preserves both histories',()=>{
  let input=composeEntitlementReview(raw(false));input=answer(input,lookup(input,'birth_date','minimum_wage'),'1990-04-15',1).input;
  input=answer(input,lookup(input,'birth_date','pension'),'1991-04-15',2).input;const original=canonicalSha256(input.answer_history),shared=enable(input);
  expect(personal(shared).mw.birth_date.state).toBe('conflict');expect(personal(shared).pension.birth_date.state).toBe('conflict');
  expect(shared.entitlement_composition!.shared_personal_facts!.groups.find(g=>g.fact==='birth_date')?.state).toBe('conflict');expect(canonicalSha256(shared.answer_history)).toBe(original);
 });
 it('uses a matching identified source without a repeated question, but keeps source conflicts explicit',()=>{
  const input=raw(),m=minimumWageEntitlementInputSchema.parse(input.entitlement_evidence!.minimum_wage),p=pensionEntitlementInputSchema.parse(input.entitlement_evidence!.pension);
  m.product_facts=minimumWageCaseFactsSchema.parse(m.product_facts);m.product_facts.birth_date={state:'observed',value:'1990-04-15',source:{...m.ordinary_hours!.source,reading:'identified_document_reading'}};
  input.entitlement_evidence!.minimum_wage=m;const known=composeEntitlementReview(input);
  expect(personal(known).pension.birth_date).toEqual(m.product_facts.birth_date);expect(runDocumentReview(known,'observed').completions.customer_requests.some(r=>r.target.value_validation?.format==='iso_date')).toBe(false);
  p.product_facts!.birth_date={state:'observed',value:'1991-04-15',source:{...p.pensionable_wage!.source,reading:'identified_document_reading'}};input.entitlement_evidence!.pension=p;
  const conflict=composeEntitlementReview(input);expect(personal(conflict).mw.birth_date.state).toBe('conflict');expect(personal(conflict).pension.birth_date.state).toBe('conflict');
  expect(minimumWageEntitlementInputSchema.parse(conflict.entitlement_evidence!.minimum_wage).product_facts!.birth_date.value).toBe('1990-04-15');
 });
 it('rejects foreign actor, stale source, wrong period and forged alias value/hash',()=>{
  const initial=composeEntitlementReview(raw()),r=lookup(initial,'birth_date');
  expect(()=>applyDocumentReviewAnswer(initial,{request:r,actor:{case_id:'99999999-9999-4999-8999-999999999999',identity_id:identity},answer:{request_id:'55555555-5555-4555-8555-000000000001',revision:1,answered_at:at,state:'provided',value:'1990-04-15'}})).toThrow();
  const answered=answer(initial,r,'1990-04-15').input,changed=structuredClone(answered);changed.documents[0].version_id='foreign.version';expect(()=>composeEntitlementReview(changed)).toThrow();
  const wrong=structuredClone(answered);wrong.period={from:'2026-07-01',to:'2026-07-31'};expect(()=>composeEntitlementReview(wrong)).toThrow();
  const tamper=structuredClone(answered);tamper.entitlement_composition!.shared_personal_facts!.groups[0].group_sha256='f'.repeat(64);expect(()=>documentReviewInputSchema.parse(tamper)).toThrow();
  const packet=structuredClone(answered.entitlement_composition!.evidence),p=pensionEntitlementInputSchema.parse(packet.pension);p.product_facts!.birth_date.value='1991-04-15';packet.pension=p;
  expect(()=>assertEntitlementSourcePacket(answered,packet,entitlementLegalDocuments(answered.case_id,['minimum_wage','pension']))).toThrow('SHARED_PERSONAL_FACT_REPLAY');
 });
 it.each(['unknown','unreadable','conflict'] as const)('preserves an explicit raw %s across consumers without asking the same personal fact again',state=>{
  const input=raw(),m=minimumWageEntitlementInputSchema.parse(input.entitlement_evidence!.minimum_wage),p=pensionEntitlementInputSchema.parse(input.entitlement_evidence!.pension);
  m.product_facts!.birth_date={state,value:null,source:null};p.product_facts!.birth_date={state:'observed',value:'1990-04-15',source:{...p.pensionable_wage!.source,reading:'identified_document_reading'}};
  input.entitlement_evidence!.minimum_wage=m;input.entitlement_evidence!.pension=p;const original=canonicalSha256(input.entitlement_evidence),current=composeEntitlementReview(input);
  expect(personal(current).mw.birth_date).toEqual({state,value:null,source:null});expect(personal(current).pension.birth_date).toEqual({state,value:null,source:null});
  expect(canonicalSha256(current.entitlement_evidence)).toBe(original);expect(current.entitlement_composition!.shared_personal_facts!.groups.find(g=>g.fact==='birth_date')?.state).toBe(state);
  expect(runDocumentReview(current,'raw.blocked').completions.customer_requests.some(q=>q.target.value_validation?.format==='iso_date')).toBe(false);
 });
 it('preserves unmarked historical bytes and separate branch questions',()=>{
  const input=raw(false),first=composeEntitlementReview(input);expect(first.entitlement_composition?.shared_personal_facts).toBeUndefined();expect(composeEntitlementReview(first)).toEqual(first);
  const requests=runDocumentReview(first,'legacy').completions.customer_requests;expect(requests.filter(r=>r.target.value_validation?.format==='iso_date')).toHaveLength(2);
 });
});
