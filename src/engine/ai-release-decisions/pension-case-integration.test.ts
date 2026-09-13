import {describe,it,expect} from 'vitest';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {fixture,actor} from '../entitlement-review/compose.fixture.ts';
import {pensionEntitlementInputSchema} from '../entitlement-review/pension/contracts.ts';
import {pensionProductFacts,pensionCaseConsumed,evaluatePensionCaseRecipe} from '../entitlement-review/pension/product-facts.ts';
import {pensionRecordedFixture} from '../entitlement-review/pension/recorded-fixture.ts';
import {documentReviewCalculationInputSchema} from '../document-review/calculations.ts';
import {composeEntitlementReview} from '../entitlement-review/compose.ts';
import {applyDocumentReviewAnswer,runDocumentReview,replayDocumentReview} from '../document-review/service.ts';
import {AI_RELEASE_DECISION_RECIPES} from './catalog.ts';
import {applyAiReleaseDecisionRecipes} from './apply.ts';
import type {AiReleaseDecisionMethod} from './contracts.ts';

const at='2026-09-12T12:00:00Z';
function method(id:string):AiReleaseDecisionMethod{const r=AI_RELEASE_DECISION_RECIPES.find(r=>r.recipe_id==='ai-case.'+id)!;return {recipe_id:r.recipe_id,recipe_version:'1',recipe_sha256:r.recipe_sha256,source_policy_sha256:r.source_policy_sha256,
 interpretation_receipt_sha256:canonicalSha256({synthetic:'method'}),source_receipts:r.legal_sources.map(s=>({source_version_id:s.version_id,artifact_sha256:s.file_sha256,receipt_sha256:canonicalSha256({synthetic:s.version_id})})),issued_at:'2026-09-12T00:00:00Z',expires_at:'2026-09-13T00:00:00Z'};}
function base(omitFund=false){const f=fixture();f.pension.product_facts=pensionProductFacts();for(const key of ['aged_21_or_more','under_60'] as const)f.pension.facts[key]={state:'missing',value:null,source:null,basis:'ai_source_assessment'};
 f.pension.applicability=f.pension.applicability.filter(d=>d.decision_id!=='pension.general_coverage'&&(!omitFund||d.decision_id!=='pension.pension_fund'));f.input.entitlement_evidence!.pension=f.pension;return composeEntitlementReview(f.input);}
function request(input:ReturnType<typeof base>,key:string){const pins=input.documents.filter(d=>d.kind==='payslip').map(d=>({case_id:d.case_id,document_id:d.document_id,version_id:d.version_id,source_sha256:d.file_sha256}));
 const fact_key=`entitlement.pension.${canonicalSha256({period:input.period,pins,path:'product_facts.'+key}).slice(0,32)}`;
 return runDocumentReview(input,'synthetic-lookup').completions.customer_requests.find(r=>r.target.fact_key===fact_key)!;}
function answered(omitFund=false){let source=base(omitFund);const values=[['birth_date','1990-04-15'],['employment_relationship','שכיר או שכירה'],['workplace_sector','המגזר הפרטי']];
 for(const [index,[key,value]]of values.entries()){const r=request(source,key);expect(r).toBeDefined();source=applyDocumentReviewAnswer(source,{request:r,actor,answer:{request_id:`55555555-5555-4555-8555-${String(index+1).padStart(12,'0')}`,revision:1,answered_at:at,state:'provided',value}}).input;}
 return source;}

describe('pension case recipes through normal factual questions and source admission',()=>{
 it('derives age from three authenticated facts while preserving raw history and all independent applicability',()=>{
  const initial=base(),questions=runDocumentReview(initial,'initial').completions.customer_requests;
  expect(questions.some(q=>q.target.answer_kind==='boolean'&&/גיל|21|60/u.test(q.target.question))).toBe(false);
  const s=answered(),a=applyAiReleaseDecisionRecipes({source:s,methods:[method('pension.general_coverage')],at}),r=runDocumentReview(a.source,'pension-typed-normal');
  expect(a.receipts).toHaveLength(1);expect(a.receipts[0].consumed.some(c=>c.path.endsWith('product_facts.birth_date'))).toBe(true);
  const effective=pensionEntitlementInputSchema.parse(a.source.entitlement_composition!.evidence.pension),raw=pensionEntitlementInputSchema.parse(a.source.entitlement_evidence!.pension);
  expect(effective.facts.aged_21_or_more).toMatchObject({state:'derived',value:true,basis:'ai_source_assessment'});expect(raw.facts.aged_21_or_more.state).toBe('missing');
  expect(effective.product_facts?.birth_date.state).toBe('declared');expect(a.source.answer_history).toHaveLength(3);
  expect(r.checks.filter(c=>c.calculation.state==='calculated')).toHaveLength(3);expect(r.checks.map(c=>c.calculation.expected)).toContainEqual({kind:'money',minor_units:32500,currency:'ILS'});
  expect(replayDocumentReview(r)).toEqual(r);
 });
 it('keeps unknown birthday and later supported correction blocked until a fresh fact-bound receipt',()=>{
  const s=answered(),a=applyAiReleaseDecisionRecipes({source:s,methods:[method('pension.general_coverage')],at}),r=request(base(),'birth_date');
  const unknown=applyDocumentReviewAnswer(a.source,{request:r,actor,answer:{request_id:'55555555-5555-4555-8555-000000000001',revision:2,answered_at:'2026-09-12T12:01:00Z',state:'unknown',value:null}}).input;
  expect(runDocumentReview(unknown,'unknown').checks.some(c=>c.calculation.state==='calculated')).toBe(false);expect(unknown.answer_history).toHaveLength(4);
  const corrected=applyDocumentReviewAnswer(unknown,{request:r,actor,answer:{request_id:'55555555-5555-4555-8555-000000000001',revision:3,answered_at:'2026-09-12T12:02:00Z',state:'provided',value:'1991-04-15'}}).input;
  expect(pensionEntitlementInputSchema.parse(corrected.entitlement_composition!.evidence.pension).applicability.find(d=>d.decision_id==='pension.general_coverage')?.state).toBe('stale');
  expect(runDocumentReview(corrected,'corrected').checks.some(c=>c.calculation.state==='calculated')).toBe(false);expect(corrected.answer_history).toHaveLength(5);
 });
 it('does not let a pension-fund customer choice certify an unread source product',()=>{
  const s=answered(true),r=request(s,'pension_product');expect(r).toBeDefined();const changed=applyDocumentReviewAnswer(s,{request:r,actor,answer:{request_id:'55555555-5555-4555-8555-000000000004',revision:1,answered_at:at,state:'provided',value:'קרן פנסיה'}}).input;
  const result=applyAiReleaseDecisionRecipes({source:changed,methods:[method('pension.pension_fund')],at});
  expect(result.receipts).toEqual([]);expect(result.unresolved[0].reason).toBe('identified_fund_source_missing');
 });
 it('pins the exact nested recorded relationship, not a null hash for an array path',()=>{
  const f=fixture(),r=pensionRecordedFixture('300.00'),caseId=r.case_id,citation=documentReviewCalculationInputSchema.shape.operands.element.shape.source;
  f.input.case_id=caseId;f.input.documents=f.input.documents.map(d=>({...d,case_id:caseId}));
  f.input.completion_input={case_id:caseId,period:f.input.period,documents:[],needs:[],evidence:[]};
  f.pension.case_id=caseId;f.pension.source_manifest=f.pension.source_manifest.map(m=>({...m,case_id:m.kind==='case_document'?caseId:m.case_id}));
  f.pension.source_manifest.push(...r.source_manifest);f.pension.recorded=[{share:'employee',relationship_check:r}];f.pension.applicability=f.pension.applicability.filter(d=>d.decision_id!=='pension.pension_fund');
  const readings:ReturnType<typeof citation.parse>[]=[];function visit(v:unknown):void{const found=citation.safeParse(v);if(found.success){readings.push(found.data);return;}if(v&&typeof v==='object')Object.values(v).forEach(visit);}visit(r);
  for(const m of r.source_manifest){if(m.kind!=='case_document')continue;const receiptShas=[...new Set(readings.filter(s=>s.document_id===m.document_id).map(s=>s.reading_receipt_sha256))];
   f.input.documents.push({case_id:caseId,document_id:m.document_id,version_id:m.version_id,file_sha256:m.file_sha256,page_count:m.page_count,kind:'payslip',label:'Synthetic identified pension relationship',period:f.input.period,reading_origin:'ai_document_review',reading_sha256:r.source_structure?.reading_sha256??receiptShas[0],accepted_reading_sha256:receiptShas});
  }
  f.input.entitlement_evidence={...f.input.entitlement_evidence!,case_id:caseId,pension:f.pension};
  const a=applyAiReleaseDecisionRecipes({source:f.input,methods:[method('pension.pension_fund')],at}),effective=pensionEntitlementInputSchema.parse(a.source.entitlement_composition!.evidence.pension);
  expect(a.receipts).toHaveLength(1);expect(a.receipts[0].consumed).toEqual(pensionCaseConsumed(effective,evaluatePensionCaseRecipe('pension.pension_fund',effective,a.source).consumed_paths));
  expect(a.receipts[0].consumed.find(c=>c.path.endsWith('recorded.0.relationship_check'))?.value_sha256).toBe(canonicalSha256(r));
  expect(effective.applicability.find(d=>d.decision_id==='pension.pension_fund')?.state).toBe('accepted');
 });
});
