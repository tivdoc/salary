import {describe,it,expect} from 'vitest';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {nineTopicRuntimeSource} from '../ai-release-runtime/runtime.fixture.ts';
import type {DocumentReviewInput} from '../document-review/contracts.ts';
import {documentReviewCalculationInputSchema} from '../document-review/calculations.ts';
import {parseReviewCompletionInput,type ReviewCompletion} from '../document-review/completions.ts';
import {applyDocumentReviewAnswer,runDocumentReview,replayDocumentReview} from '../document-review/service.ts';
import {composeEntitlementReview} from '../entitlement-review/compose.ts';
import {typedEntitlementQuestions} from '../entitlement-review/typed-product-facts.ts';
import {convalescenceEntitlementInputSchema} from '../entitlement-review/convalescence/contracts.ts';
import {convalescencePersonalFacts,convalescenceCaseFactsSchema} from '../entitlement-review/convalescence/product-facts.ts';
import {enableConvalescenceCaseFacts,replayConvalescenceCaseFacts,convalescenceCaseConsumed,evaluateConvalescenceCaseRecipe} from '../entitlement-review/convalescence/product-decisions.ts';
import {resolveConvalescenceEntitlement} from '../entitlement-review/convalescence/resolve.ts';
import {assertEntitlementSourcePacket} from '../entitlement-review/source-admission.ts';
import {entitlementLegalDocuments} from '../entitlement-review/legal-documents.ts';
import {AI_RELEASE_DECISION_RECIPES} from './catalog.ts';
import {applyAiReleaseDecisionRecipes} from './apply.ts';
import {aiReleaseDecisionInputSchema,aiReleaseDecisionMethodSchema,type AiReleaseDecisionMethod} from './contracts.ts';

const at='2026-09-12T12:00:00Z',identity='22222222-2222-4222-8222-222222222222';
const caseIds=['cv.benefit_year','cv.qualifying_service','cv.due_date','cv.allocation'];
const methodIds=['cv.rate_2026','cv.proration','cv.rounding'];
const v2Ids=['cv.population','cv.legal_source_chain','cv.arrangement_scope'];
const missing={state:'missing' as const,value:null,source:null};
function method(id:string):AiReleaseDecisionMethod{const r=AI_RELEASE_DECISION_RECIPES.find(r=>r.decision_id===id)!;return {recipe_id:r.recipe_id,recipe_version:r.recipe_version,recipe_sha256:r.recipe_sha256,source_policy_sha256:r.source_policy_sha256,
 interpretation_receipt_sha256:canonicalSha256({synthetic_cv_method:id}),source_receipts:r.legal_sources.map(s=>({source_version_id:s.version_id,artifact_sha256:s.file_sha256,receipt_sha256:canonicalSha256({synthetic_source:s.version_id})})),issued_at:'2026-09-12T00:00:00Z',expires_at:'2026-09-13T00:00:00Z'};}
function raw(v2=false){const i=nineTopicRuntimeSource();let c=convalescenceEntitlementInputSchema.parse(i.entitlement_evidence!.convalescence);
 c.product_facts=convalescencePersonalFacts();c.applicability=c.applicability.filter(d=>!caseIds.includes(d.decision_id)&&!methodIds.includes(d.decision_id));
 const source={...c.recorded!.source,reading:'identified_document_reading' as const};c.recorded!.source=source;c.recorded_coverage.source=source;c.recorded_inventory.source=source;
 if(v2){c=enableConvalescenceCaseFacts(c);c.population={...missing};c.applicability=c.applicability.filter(d=>d.decision_id!=='cv.population');}
 const manifests=new Set(c.source_manifest.map(s=>s.document_id));i.documents=i.documents.filter(d=>manifests.has(d.document_id)).map(d=>({...d,kind:'contract' as const}));
 const completion=parseReviewCompletionInput(i.completion_input);i.completion_input={...completion,documents:completion.documents.filter(d=>manifests.has(d.pin.document_id))};
 i.entitlement_evidence={schema_version:'entitlement-source-evidence-v1',case_id:i.case_id,order_id:i.purchased_scope.order_id,receipt_sha256:i.purchased_scope.receipt_sha256,period:i.period,convalescence:c};return i;
}
function question(i:DocumentReviewInput,path:string){const c=convalescenceEntitlementInputSchema.parse(i.entitlement_composition?.evidence.convalescence??i.entitlement_evidence!.convalescence),q=typedEntitlementQuestions('convalescence',c).find(q=>q.path===path);expect(q).toBeDefined();
 const r=runDocumentReview(i,'synthetic.question').completions.customer_requests.find(r=>r.target.question===q!.question);expect(r).toBeDefined();return r!;}
function answer(i:DocumentReviewInput,r:ReviewCompletion,value:string|null,index:number,revision=1){return applyDocumentReviewAnswer(i,{request:r,actor:{case_id:i.case_id,identity_id:identity},answer:{request_id:`55555555-5555-4555-8555-${String(index).padStart(12,'0')}`,revision,answered_at:at,state:value===null?'unknown':'provided',value}}).input;}
const apply=(source:DocumentReviewInput,ids=[...caseIds,...methodIds])=>applyAiReleaseDecisionRecipes({source,methods:ids.map(method),at});
function personalAnswered(i=raw(true)){let s=composeEntitlementReview(i);for(const [n,[path,value]]of [['birth_date','1990-06-15'],['employment_relationship','כשכיר/ה'],['workplace_sector','מעסיק פרטי'],['public_wage_linked','לא']].entries())s=answer(s,question(s,'product_facts.'+path),value,100+n);return s;}

describe('convalescence case recipes through ordinary typed completions and replay',()=>{
 it('uses the corrected due-date provision through ordinary composition and replay',()=>{
  const next=AI_RELEASE_DECISION_RECIPES.find(r=>r.recipe_id==='ai-case.cv.due_date.source-provision-v2')!;
  const methods=[...caseIds,...methodIds].map(id=>{
   const old=method(id);return id==='cv.due_date'?{...old,recipe_id:next.recipe_id,recipe_sha256:next.recipe_sha256}:old;
  });
  const old=runDocumentReview(apply(raw()).source,'synthetic.cv.old-locator');
  const applied=applyAiReleaseDecisionRecipes({source:raw(),methods,at});
  expect(applied.unresolved).toEqual([]);
  expect(applied.receipts.find(r=>r.recipe_id===next.recipe_id)?.decision.sources[0].locator).toContain('5(ד)');
  const result=runDocumentReview(applied.source,'synthetic.cv.correct-locator');
  expect(result.checks.map(c=>({id:c.check_id,expected:c.calculation.expected,recorded:c.calculation.recorded,difference:c.calculation.difference})))
   .toEqual(old.checks.map(c=>({id:c.check_id,expected:c.calculation.expected,recorded:c.calculation.recorded,difference:c.calculation.difference})));
  expect(replayDocumentReview(result)).toEqual(result);
 });
 it('bounds the nine-topic method inventory at 64 and preserves historical descriptor bytes',()=>{
  const m=method('cv.benefit_year'),source=raw();expect(aiReleaseDecisionMethodSchema.parse(m)).toEqual(m);
  expect(aiReleaseDecisionInputSchema.safeParse({source,methods:Array.from({length:64},()=>m),at}).success).toBe(true);
  expect(aiReleaseDecisionInputSchema.safeParse({source,methods:Array.from({length:65},()=>m),at}).success).toBe(false);
 });
 it.each([['1000.00',12875],['1128.75',0],['1200.00',-7125]] as const)('computes independent first-year half-FTE expected 1128.75 and signed comparison for %s',(recorded,difference)=>{
  const i=raw(),c=convalescenceEntitlementInputSchema.parse(i.entitlement_evidence!.convalescence);c.recorded!.printed_value=recorded;c.benefit_year={...missing};c.due_date={...missing};c.segments[0].fte={...missing};i.entitlement_evidence!.convalescence=c;
  let s=composeEntitlementReview(i);for(const [n,[path,value]]of [['benefit_year','2026'],['due_date','2026-06-30'],['segments.0.fte','0.5']].entries())s=answer(s,question(s,path),value,n+1);
  const before=canonicalSha256(s.answer_history),a=apply(s),r=runDocumentReview(a.source,'synthetic.cv.normal');
  expect(a.receipts).toHaveLength(7);expect(a.unresolved).toEqual([]);expect(r.checks.find(c=>c.check_id.endsWith('.expected'))?.calculation.expected).toMatchObject({minor_units:112875});
  expect(r.checks.find(c=>c.check_id.endsWith('.comparison'))?.calculation.difference).toMatchObject({minor_units:difference});
  expect(canonicalSha256(a.source.answer_history)).toBe(before);expect(replayDocumentReview(r)).toEqual(r);
  const effective=convalescenceEntitlementInputSchema.parse(a.source.entitlement_composition!.evidence.convalescence);
  expect(effective.benefit_year).toMatchObject({state:'declared',value:2026});
  for(const receipt of a.receipts.filter(r=>r.recipe_id.startsWith('ai-case.cv.')))expect(receipt.consumed).toEqual(convalescenceCaseConsumed(effective,evaluateConvalescenceCaseRecipe(receipt.decision_id,effective,a.source).consumed_paths));
 });
 it('keeps a corrected or unknown due-date receipt in history and stales only consumed case decisions',()=>{
  const i=raw(),c=convalescenceEntitlementInputSchema.parse(i.entitlement_evidence!.convalescence);c.due_date={...missing};i.entitlement_evidence!.convalescence=c;
  const start=composeEntitlementReview(i),q=question(start,'due_date'),s=answer(start,q,'2026-06-30',1),a=apply(s),u=answer(a.source,q,null,1,2);
  const effective=convalescenceEntitlementInputSchema.parse(u.entitlement_composition!.evidence.convalescence);
  expect(effective.due_date.state).toBe('unknown');expect(effective.applicability.find(d=>d.decision_id==='cv.due_date')?.state).toBe('stale');
  expect(effective.applicability.find(d=>d.decision_id==='cv.benefit_year')?.state).toBe('accepted');expect(u.answer_history).toHaveLength(2);
  const corrected=answer(u,q,'2026-06-29',1,3);expect(corrected.answer_history).toHaveLength(3);
  expect(convalescenceEntitlementInputSchema.parse(corrected.entitlement_composition!.evidence.convalescence).applicability.find(d=>d.decision_id==='cv.due_date')?.state).toBe('stale');
 });
 it('retains expected calculation when recorded allocation is absent, without treating absence as zero',()=>{
  const i=raw(),c=convalescenceEntitlementInputSchema.parse(i.entitlement_evidence!.convalescence);c.recorded=null;i.entitlement_evidence!.convalescence=c;
  const a=apply(i),r=runDocumentReview(a.source,'synthetic.cv.expected-only');expect(a.unresolved).toContainEqual(expect.objectContaining({decision_id:'cv.allocation',reason:'recorded:identified_amount_required'}));
  expect(r.checks).toHaveLength(1);expect(r.checks[0].calculation.expected).toMatchObject({minor_units:112875});expect(r.checks[0].calculation.recorded).toBeNull();
 });
 it('keeps method expiry, explicit unknown decisions and prior-year scope blocked',()=>{
  const i=raw(),expired=method('cv.benefit_year');expired.expires_at=at;
  expect(applyAiReleaseDecisionRecipes({source:structuredClone(i),methods:[expired],at}).unresolved).toContainEqual(expect.objectContaining({reason:'method_not_current'}));
  const c=convalescenceEntitlementInputSchema.parse(i.entitlement_evidence!.convalescence);c.applicability.push({decision_id:'cv.benefit_year',state:'unknown',basis:'ai_source_assessment',explanation:'Synthetic deliberately unresolved',sources:[],valid_until:null});i.entitlement_evidence!.convalescence=c;
  expect(apply(structuredClone(i)).unresolved).toContainEqual(expect.objectContaining({decision_id:'cv.benefit_year',reason:'existing_decision_preserved'}));
  c.applicability=[];c.benefit_year.value=2025;i.entitlement_evidence!.convalescence=c;expect(apply(i).unresolved).toContainEqual(expect.objectContaining({decision_id:'cv.benefit_year',reason:'benefit_year:unsupported_or_prior_year'}));
 });
 it('derives v2 population from authenticated factual answers, never changes the original missing classification',()=>{
  const s=personalAnswered(),a=apply(s,[...v2Ids,...caseIds,...methodIds]),c=convalescenceEntitlementInputSchema.parse(a.source.entitlement_composition!.evidence.convalescence),r=runDocumentReview(a.source,'synthetic.cv.v2');
  expect(a.receipts).toHaveLength(10);expect(a.unresolved).toEqual([]);expect(c.population).toMatchObject({state:'derived',value:'adult_private_general_21_59'});
  expect(convalescenceEntitlementInputSchema.parse(a.source.entitlement_evidence!.convalescence).population.state).toBe('missing');
  expect(r.checks.find(c=>c.check_id.endsWith('.comparison'))?.calculation.difference).toMatchObject({minor_units:12875});expect(replayDocumentReview(r)).toEqual(r);
  const ids=documentReviewCalculationInputSchema.parse(resolveConvalescenceEntitlement(c).checks[0].calculation).operation;expect(ids.kind).toBe('candidate_rule');if(ids.kind==='candidate_rule'){expect(ids.required_decision_ids).toContain('cv.legal_source_chain');expect(ids.required_decision_ids).toContain('cv.arrangement_scope');expect(ids.required_decision_ids).not.toContain('cv.source_chain');}
 });
 it('does not turn false awareness or law-only source-chain evidence into positive arrangement evidence',()=>{
  const i=raw(true),c=convalescenceEntitlementInputSchema.parse(i.entitlement_evidence!.convalescence);c.applicability=[];i.entitlement_evidence!.convalescence=c;
  let s=personalAnswered(i);s=answer(s,question(s,'product_facts.special_terms_known'),'לא ידוע לי על תנאים מיוחדים',110);
  const a=apply(s,[...v2Ids,...caseIds,...methodIds]),r=runDocumentReview(a.source,'synthetic.cv.arrangement-missing');
  expect(a.receipts.some(r=>r.decision_id==='cv.legal_source_chain')).toBe(true);expect(a.receipts.some(r=>r.decision_id==='cv.arrangement_scope')).toBe(false);
  expect(a.unresolved).toContainEqual(expect.objectContaining({decision_id:'cv.arrangement_scope',reason:'arrangement:current_positive_contract_classification_required'}));expect(r.checks.every(c=>c.calculation.state==='blocked')).toBe(true);
  const j=raw(true);j.documents=j.documents.map(d=>({...d,kind:'payslip'}));expect(apply(personalAnswered(j),['cv.arrangement_scope']).unresolved).toContainEqual(expect.objectContaining({reason:'arrangement:identified_contract_classification_source_required'}));
 });
 it('rejects foreign reading receipts, mutated consumed values and a forged derived population',()=>{
  const s=personalAnswered(),a=apply(s,[...v2Ids,...caseIds,...methodIds]),effective=convalescenceEntitlementInputSchema.parse(a.source.entitlement_composition!.evidence.convalescence),original=convalescenceEntitlementInputSchema.parse(a.source.entitlement_evidence!.convalescence);
  const borrowedPacket=structuredClone(s.entitlement_composition!.evidence),borrowed=convalescenceEntitlementInputSchema.parse(borrowedPacket.convalescence),borrowedFacts=convalescenceCaseFactsSchema.parse(borrowed.product_facts);
  borrowedFacts.special_terms_known=structuredClone(borrowedFacts.public_wage_linked);borrowed.product_facts=borrowedFacts;borrowedPacket.convalescence=borrowed;
  expect(()=>assertEntitlementSourcePacket(s,borrowedPacket,entitlementLegalDocuments(s.case_id,['convalescence']))).toThrow('ENTITLEMENT_PERSONAL_ANSWER_TARGET');
  const changed=structuredClone(effective),p=convalescenceCaseFactsSchema.parse(changed.product_facts);p.public_wage_linked.value=true;changed.product_facts=p;
  const replayed=replayConvalescenceCaseFacts(changed,original,a.source);expect(replayed.population.state).toBe('missing');expect(replayed.applicability.find(d=>d.decision_id==='cv.population')?.state).toBe('stale');
  expect(()=>resolveConvalescenceEntitlement(changed)).toThrow('CV_DERIVED_POPULATION_REPLAY');
  const forged=structuredClone(effective);forged.population.derivation!.inputs_sha256='f'.repeat(64);expect(()=>resolveConvalescenceEntitlement(forged)).toThrow('CV_DERIVED_POPULATION_REPLAY');
  const packet=structuredClone(a.source.entitlement_composition!.evidence),foreign=convalescenceEntitlementInputSchema.parse(packet.convalescence),facts=convalescenceCaseFactsSchema.parse(foreign.product_facts);facts.birth_date.source={...facts.birth_date.source!,version_id:'foreign:1'};foreign.product_facts=facts;packet.convalescence=foreign;
  expect(()=>assertEntitlementSourcePacket(a.source,packet,entitlementLegalDocuments(s.case_id,['convalescence']))).toThrow();
 });
 it('preserves deliberately unknown sector and v1 packets without adding an opt-in policy',()=>{
  const s=personalAnswered(),c=convalescenceEntitlementInputSchema.parse(s.entitlement_composition!.evidence.convalescence),p=convalescenceCaseFactsSchema.parse(c.product_facts);p.workplace_sector={state:'unknown',value:null,source:null};p.employment_category={state:'observed',value:'private',source:c.employment_start.source};c.product_facts=p;
  expect(evaluateConvalescenceCaseRecipe('cv.population',c,s)).toMatchObject({allowed:false,reason:'product_facts.workplace_sector:unknown'});
  const i=raw(),before=canonicalSha256(i);expect(applyAiReleaseDecisionRecipes({source:i,methods:[],at}).source).toBe(i);expect(canonicalSha256(i)).toBe(before);expect(convalescenceEntitlementInputSchema.parse(composeEntitlementReview(i).entitlement_composition!.evidence.convalescence).source_gates_policy).toBeUndefined();
 });
});
