import {describe,it,expect} from 'vitest';
import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {composeEntitlementReview} from '../compose.ts';
import {applyDocumentReviewAnswer,runDocumentReview,replayDocumentReview} from '../../document-review/service.ts';
import type {DocumentReviewInput} from '../../document-review/contracts.ts';
import {obligationsEntitlementInputSchema} from './contracts.ts';
import {obligationProductFactKey,type ObligationProductFactKey} from './product-facts.ts';
import {enableObligationCasePolicy,replayObligationProductFacts} from './case-replay.ts';
import {OBLIGATIONS_LEGAL_MANIFEST,OBLIGATIONS_POLICY_SHA256} from './policy.ts';
import {OBLIGATIONS_SOURCE_REVIEW_SHA256} from './source-policy.ts';
import {fixture,uuid} from './product-flow.fixture.ts';
import {AI_RELEASE_DECISION_RECIPES} from '../../ai-release-decisions/catalog.ts';
import {applyAiReleaseDecisionRecipes} from '../../ai-release-decisions/apply.ts';
import type {AiReleaseDecisionMethod} from '../../ai-release-decisions/contracts.ts';

const at='2026-09-12T12:00:00Z',ids=['clause_interpretation','agreement_binding','payment_scope','complete_conditions','rounding'];
const branch=(source:DocumentReviewInput)=>obligationsEntitlementInputSchema.parse(source.entitlement_composition?.evidence.obligations??source.entitlement_evidence!.obligations);
function method(id:string):AiReleaseDecisionMethod{const r=AI_RELEASE_DECISION_RECIPES.find(r=>r.recipe_id==='ai-case.obligation.'+id);if(!r)throw Error('OBLIGATION_TEST_RECIPE');
 return {recipe_id:r.recipe_id,recipe_version:r.recipe_version,recipe_sha256:r.recipe_sha256,source_policy_sha256:r.source_policy_sha256,
  interpretation_receipt_sha256:canonicalSha256({synthetic:id}),source_receipts:r.legal_sources.map(s=>({source_version_id:s.version_id,artifact_sha256:s.file_sha256,receipt_sha256:canonicalSha256({synthetic:s.version_id})})),issued_at:'2026-09-12T00:00:00Z',expires_at:'2026-09-13T00:00:00Z'};}
function base(options:Parameters<typeof fixture>[0]={}){const f=fixture(options);f.identify();const {review,input}=f.run();
 return composeEntitlementReview({...review,entitlement_evidence:{...review.entitlement_evidence!,obligations:enableObligationCasePolicy(input)}});}
function question(source:DocumentReviewInput,key:ObligationProductFactKey){const e=branch(source),o=e.obligations[0],factKey=obligationProductFactKey(e,o,key);
 const q=runDocumentReview(source,'synthetic.obligation.question').completions.customer_requests.find(r=>r.target.fact_key===factKey);if(!q)throw Error('OBLIGATION_TEST_QUESTION '+key);return q;}
function answer(source:DocumentReviewInput,key:ObligationProductFactKey,value:string|null,n:number,revision=1,request=question(source,key)){
 return applyDocumentReviewAnswer(source,{request,actor:{case_id:source.case_id,identity_id:uuid(300)},answer:{request_id:uuid(400+n),revision,answered_at:at,state:value===null?'unknown':'provided',value:value==='כן'?true:value==='לא'?false:value}}).input;}
function answered(initial=base()){let source=initial;
 for(const [n,[key,value]]of ([['agreement_used_for_employment','כן'],['agreement_made_or_renewed_on','2026-02-01'],['changes_or_side_terms','לא'],['employer_disputes_term','לא']] as const).entries())source=answer(source,key,value,n);
 return source;}
const apply=(source:DocumentReviewInput,selected=ids)=>applyAiReleaseDecisionRecipes({source,methods:selected.map(method),at});
describe('ordinary contract/bonus source, factual journal and five AI case recipes',()=>{
 it.each([{options:{},minor:50000},{options:{linear:true},minor:10000},{options:{bonus:true},minor:50000}])('computes an independently specified expected amount $minor without a recorded payment',({options,minor})=>{
  const s=answered(base(options)),history=canonicalSha256(s.answer_history),a=apply(s),r=runDocumentReview(a.source,'synthetic.obligation.normal');
  expect(a.unresolved).toEqual([]);expect(a.receipts).toHaveLength(5);expect(r.checks).toHaveLength(1);
  expect(r.checks[0].calculation).toMatchObject({state:'calculated',expected:{minor_units:minor},recorded:null,difference:null});
  expect(a.source.answer_history).toHaveLength(4);expect(canonicalSha256(a.source.answer_history)).toBe(history);expect(replayDocumentReview(r)).toEqual(r);
  expect(obligationsEntitlementInputSchema.parse(a.source.entitlement_evidence!.obligations).obligations[0].product_facts?.agreement_used_for_employment.state).toBe('missing');
  expect(branch(a.source).obligations[0].assessments.every(d=>d.basis==='ai_source_assessment'&&d.sources.some(s=>s.reading==='source_research'))).toBe(true);
  expect(a.source.entitlement_composition!.selections.every(s=>s.source_policy_sha256===OBLIGATIONS_SOURCE_REVIEW_SHA256)).toBe(true);
 },15000);
 it('makes only three supportable decisions when agreement and condition statements are absent',()=>{
  const a=apply(answered(base({agreement:false,inventory:false}))),r=runDocumentReview(a.source,'synthetic.obligation.partial');
  expect(a.receipts.map(r=>r.decision_id)).toEqual(['obligation.clause_interpretation','obligation.payment_scope','obligation.rounding']);
  expect(a.unresolved.map(r=>r.decision_id)).toEqual(['obligation.agreement_binding','obligation.complete_conditions']);
  expect(r.checks[0].calculation.state).toBe('blocked');expect(r.checks[0].calculation.expected).toBeNull();
 });
 it('stales only context-dependent decisions after unknown and supported factual correction, preserving history',()=>{
  const initial=base(),q=question(initial,'agreement_made_or_renewed_on'),a=apply(answered(initial));
  const unknown=answer(a.source,'agreement_made_or_renewed_on',null,1,2,q),e=branch(unknown);
  expect(e.obligations[0].assessments.find(d=>d.decision_id==='obligation.clause_interpretation')?.state).toBe('stale');
  expect(e.obligations[0].assessments.find(d=>d.decision_id==='obligation.agreement_binding')?.state).toBe('stale');
  expect(e.obligations[0].assessments.filter(d=>['obligation.payment_scope','obligation.complete_conditions','obligation.rounding'].includes(d.decision_id)).every(d=>d.state==='accepted')).toBe(true);
  const corrected=answer(unknown,'agreement_made_or_renewed_on','2026-02-02',1,3,q);
  expect(corrected.answer_history).toHaveLength(6);expect(branch(corrected).obligations[0].assessments.find(d=>d.decision_id==='obligation.clause_interpretation')?.state).toBe('stale');
  expect(runDocumentReview(corrected,'synthetic.obligation.corrected').checks[0].calculation.state).toBe('blocked');
 });
 it('does not treat a known dispute or side agreement as a binding source approval',()=>{
  const initial=base(),q=question(initial,'employer_disputes_term'),s=answer(answered(initial),'employer_disputes_term','כן',3,2,q),a=apply(s);
  expect(a.unresolved).toEqual(expect.arrayContaining([expect.objectContaining({decision_id:'obligation.agreement_binding',reason:'agreement_context_adverse.employer_disputes_term'})]));
  expect(runDocumentReview(a.source,'synthetic.obligation.disputed').checks[0].calculation.state).toBe('blocked');
 });
 it('rejects expired, forged and duplicate method pins while retaining explicit unknown assessments',()=>{
  const s=answered(),expired={...method('payment_scope'),expires_at:at};
  expect(applyAiReleaseDecisionRecipes({source:s,methods:[expired],at}).unresolved[0].reason).toBe('method_not_current');
  const forged={...method('payment_scope'),recipe_sha256:'f'.repeat(64)};expect(applyAiReleaseDecisionRecipes({source:s,methods:[forged],at}).unresolved[0].reason).toBe('method_pin_mismatch');
  expect(applyAiReleaseDecisionRecipes({source:s,methods:[method('payment_scope'),method('payment_scope')],at}).receipts).toEqual([]);
  const f=fixture();f.identify();const initial=f.run(),raw=enableObligationCasePolicy(initial.input);
  raw.obligations[0].assessments=[{decision_id:'obligation.payment_scope',state:'unknown',basis:'ai_source_assessment',explanation:'Synthetic deliberately unresolved',sources:[],valid_until:null}];
  const fresh=composeEntitlementReview({...initial.review,entitlement_evidence:{...initial.review.entitlement_evidence!,obligations:raw}});
  const own=apply(answered(fresh),['payment_scope']);
  expect(own.receipts).toEqual([]);expect(own.unresolved[0].reason).toBe('existing_decision_preserved');
 });
 it('checks exact obligation binding identity and leaves legacy policy/absence bytes unchanged',()=>{
  const a=apply(answered()),raw=obligationsEntitlementInputSchema.parse(a.source.entitlement_evidence!.obligations),effective=branch(a.source),bad=structuredClone(raw);
  const binding=bad.obligations[0].case_recipe_bindings![0];binding.obligation_id='another.clause';const {binding_sha256,...body}=binding;expect(binding_sha256).toMatch(/^[a-f0-9]{64}$/u);binding.binding_sha256=canonicalSha256(body);
  expect(()=>replayObligationProductFacts({...effective,obligations:effective.obligations.map(o=>({...o,case_recipe_bindings:bad.obligations[0].case_recipe_bindings}))},bad,a.source)).toThrow('OBLIGATION_REPLAY_BINDING_ID');
  const f=fixture();f.identify();const historical=f.run().review,before=canonicalSha256(historical);
  expect(applyAiReleaseDecisionRecipes({source:historical,methods:[],at}).source).toBe(historical);expect(canonicalSha256(historical)).toBe(before);
  expect(composeEntitlementReview(historical).entitlement_composition!.selections.every(s=>s.source_policy_sha256===OBLIGATIONS_POLICY_SHA256)).toBe(true);expect(OBLIGATIONS_LEGAL_MANIFEST).toEqual([]);
  expect(apply(historical).receipts).toEqual([]);
 });
});
