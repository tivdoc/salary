import {describe,it,expect} from 'vitest';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {documentReviewInputSchema,type DocumentReviewInput} from '../document-review/contracts.ts';
import {documentReviewCalculationInputSchema,type DocumentReviewSource} from '../document-review/calculations.ts';
import {applyDocumentReviewAnswer,runDocumentReview,replayDocumentReview} from '../document-review/service.ts';
import {composeEntitlementReview} from '../entitlement-review/compose.ts';
import {minimumFixture} from '../entitlement-review/product-branch.fixture.ts';
import {minimumWageEntitlementInputSchema} from '../entitlement-review/minimum-wage/contracts.ts';
import {minimumWageCaseFactsSchema,minimumWagePersonalFacts} from '../entitlement-review/minimum-wage/product-facts.ts';
import {AI_RELEASE_DECISION_RECIPES} from './catalog.ts';
import {applyAiReleaseDecisionRecipes} from './apply.ts';
import {evaluateMinimumWageCaseRecipe} from './minimum-wage-case.ts';
import type {AiReleaseDecisionMethod} from './contracts.ts';

const h=(v:unknown)=>canonicalSha256({synthetic:v}),caseId='11111111-1111-4111-8111-111111111111',rowId='33333333-3333-4333-8333-333333333333';
const at='2026-09-12T12:00:00Z',missing={state:'missing' as const,value:null,source:null};
const expectedFacts={birth_date:'1990-04-15',salary_basis:'hourly',employment_relationship:'employee',workplace_sector:'private',adapted_wage_approval:false,special_wage_arrangement:false,weekly_schedule_hours:'42'};
function source(amount='3300',answered=true){
 const m=minimumFixture();m.case_id=caseId;m.applicability=[];m.method=missing;m.population=missing;m.employment=missing;m.monthly_coverage=missing;
 const citation=(field:string):DocumentReviewSource=>({...m.components[0].amount.source,reading:'identified_document_reading',
  locator:JSON.stringify({schema_version:'document-review-source-locator-v2',field,candidate_ids:['synthetic.'+field],candidate_sha256:[h(field)],raw_values:[field]})});
 const amountSource={...citation('base'),locator:JSON.stringify({schema_version:'document-review-source-locator-v2',component_ids:[rowId],cell:'amount',original_component_sha256:[h('row')],raw_values:[amount]})};
 m.source_manifest=m.source_manifest.map(p=>({...p,case_id:caseId}));
 m.components=[{id:'synthetic.base',amount:{...m.components[0].amount,observation_id:rowId+':amount',printed_value:amount,source:amountSource},
  classification:{state:'observed',value:'base_salary',source:amountSource},period:{state:'observed',value:m.period,source:amountSource}}];
 m.ordinary_hours={...m.ordinary_hours!,source:citation('regular_hours')};m.ordinary_hours_period={state:'observed',value:m.period,source:citation('salary_period')};
 m.eligible_pay_inventory={state:'unknown',value:'unknown',source:amountSource};
 m.product_facts=minimumWagePersonalFacts();
 if(answered)m.product_facts=minimumWageCaseFactsSchema.parse({...m.product_facts,...Object.fromEntries(Object.entries(expectedFacts).map(([k,value])=>[k,{state:'observed',value,source:citation(k)}]))});
 const documents=m.source_manifest.map(p=>({case_id:caseId,document_id:p.document_id,version_id:p.version_id,file_sha256:p.file_sha256,page_count:p.page_count,kind:'payslip',label:'Synthetic salary input',period:m.period,reading_origin:'ai_document_review',reading_sha256:amountSource.reading_receipt_sha256}));
 const inventory={schema_version:'printed-earnings-inventory-v1',document_id:amountSource.document_id,version_id:amountSource.version_id,reading_sha256:amountSource.reading_receipt_sha256,
  populated_component_ids:[rowId],unresolved_blank_component_ids:[],excluded_deduction_component_ids:[],inventory_complete:true,disjoint_components:true,payable_completeness_assessed:false};
 const calculation=documentReviewCalculationInputSchema.parse({schema_version:'document-review-calculation-input-v1',case_id:caseId,run_id:'synthetic-source-run',check_id:'synthetic.printed',period:m.period,evaluated_at:at,
  source_manifest:m.source_manifest,operands:[{...m.components[0].amount,id:'amount.0'},{...m.components[0].amount,id:'gross',observation_id:'gross',source:citation('gross_salary')}],
  operation:{kind:'reconciliation',add_refs:['amount.0'],subtract_refs:[],recorded_ref:'gross',inventory_complete:true,inventory_basis:'printed-earnings-inventory-v1:'+canonicalSha256(inventory),disjoint_components:true,overlap_basis:'One exact source component once.'}});
 return documentReviewInputSchema.parse({schema_version:'document-review-product-v1',case_id:caseId,period:m.period,
  purchased_scope:{order_id:'synthetic.order',receipt_sha256:h('receipt'),topics:['minimum_wage'],origin:'saved_order'},documents,
  checks:[{check_id:'synthetic.printed',topic:'minimum_wage',title:'Synthetic printed inventory',explanation:'Source arithmetic only.',calculation,printed_inventory:inventory}],coverage_gaps:[],
  completion_input:{case_id:caseId,period:m.period,documents:documents.map(d=>({pin:{case_id:caseId,document_id:d.document_id,version_id:d.version_id,source_sha256:d.file_sha256},kind:'payslip',review:'complete',period:m.period})),needs:[],evidence:[]},
  entitlement_evidence:{schema_version:'entitlement-source-evidence-v1',case_id:caseId,order_id:'synthetic.order',receipt_sha256:h('receipt'),period:m.period,minimum_wage:m}});
}
function method(id:string):AiReleaseDecisionMethod{const r=AI_RELEASE_DECISION_RECIPES.find(r=>r.decision_id===id)!;return {recipe_id:r.recipe_id,recipe_version:'1',recipe_sha256:r.recipe_sha256,source_policy_sha256:r.source_policy_sha256,
 interpretation_receipt_sha256:h('synthetic interpretation'),source_receipts:r.legal_sources.map(s=>({source_version_id:s.version_id,artifact_sha256:s.file_sha256,receipt_sha256:h(s.version_id)})),issued_at:'2026-09-12T00:00:00Z',expires_at:'2026-09-13T00:00:00Z'};}
const methods=()=>['mw.method','mw.rounding','mw.allocation','mw.eligible_components','mw.ordinary_scope','mw.population'].map(method);
const apply=(s=source())=>applyAiReleaseDecisionRecipes({source:s,methods:methods(),at});
const branch=(s:DocumentReviewInput)=>minimumWageEntitlementInputSchema.parse(s.entitlement_evidence!.minimum_wage);
function fact(s:DocumentReviewInput,key:keyof typeof expectedFacts,change:object){const m=branch(s),p=minimumWageCaseFactsSchema.parse(m.product_facts);Object.assign(p[key],change);m.product_facts=p;s.entitlement_evidence!.minimum_wage=m;}

describe('fact-backed minimum wage case recipes with independent source and amount oracles',()=>{
 it.each([['3300',24000],['3540',0],['3700',-16000]] as const)('keeps signed comparison for recorded %s and does not choose the higher formula', (amount,difference)=>{
  const s=source(amount),before=canonicalSha256(s),a=apply(s),r=runDocumentReview(a.source,'synthetic-mw-normal'),result=r.checks.find(c=>c.check_id==='minimum.synthetic')!.calculation;
  expect(a.receipts).toHaveLength(6);expect(result).toMatchObject({state:'calculated',expected:{minor_units:354000},recorded:{minor_units:Number(amount)*100},difference:{minor_units:difference},real_activation_allowed:false,human_attestation:null});
  expect(branch(a.source).method).toEqual(missing);expect(a.source.entitlement_composition?.evidence.minimum_wage).toMatchObject({method:{state:'derived',value:'published_hourly_182'},population:{state:'derived',value:'adult_general'}});
  expect(r.input.checks[0].printed_inventory?.payable_completeness_assessed).toBe(false);expect(canonicalSha256(s)).toBe(before);expect(replayDocumentReview(r)).toEqual(r);
  expect(apply(s)).toEqual(a);
 });
 it.each([['employment_relationship','self_employed'],['workplace_sector','public'],['adapted_wage_approval',true],['special_wage_arrangement',true],['birth_date','2005-06-02'],['birth_date','1966-06-30']] as const)('keeps unsupported or special %s outside the branch', (key,value)=>{
  const s=source();fact(s,key,{value});const a=apply(s);expect(a.receipts.some(r=>r.decision_id==='mw.population')).toBe(false);expect(a.unresolved.some(r=>r.decision_id==='mw.population')).toBe(true);
  expect(runDocumentReview(a.source,'unsupported').checks.some(c=>c.check_id==='minimum.synthetic'&&c.calculation.state==='calculated')).toBe(false);
 });
 it.each(['missing','unknown','conflict','unreadable'] as const)('preserves %s facts without default coverage',state=>{
  const s=source();fact(s,'employment_relationship',{state,value:null});const a=apply(s);expect(a.unresolved).toContainEqual({branch:'minimum_wage',branch_index:null,decision_id:'mw.population',reason:'employment_relationship:'+state});
 });
 it('does not silently infer hours, monthly scope, other schedules, or legal source inventory',()=>{
  for(const modify of [(s:DocumentReviewInput)=>fact(s,'salary_basis',{value:'monthly'}),(s:DocumentReviewInput)=>fact(s,'weekly_schedule_hours',{value:'other'}),
   (s:DocumentReviewInput)=>{const m=branch(s);m.ordinary_hours!.source.locator='Total attendance, not regular hours';s.entitlement_evidence!.minimum_wage=m;},
   (s:DocumentReviewInput)=>{const m=branch(s);m.ordinary_hours_period.value={from:'2026-05-01',to:'2026-05-31'};s.entitlement_evidence!.minimum_wage=m;}]){
   const s=source();modify(s);expect(apply(s).receipts.some(r=>r.decision_id==='mw.ordinary_scope')).toBe(false);
  }
 });
 it('rejects missing/conflicting source cells and blank or extra components even when a subtotal matches',()=>{
  const s=source(),m=branch(s);m.components[0].classification.state='unknown';s.entitlement_evidence!.minimum_wage=m;
  expect(apply(s).unresolved.some(r=>r.reason==='explicit_base_source_classification_required')).toBe(true);
  for(const change of [{unresolved_blank_component_ids:['44444444-4444-4444-8444-444444444444']},{inventory_complete:false},{populated_component_ids:[rowId,'44444444-4444-4444-8444-444444444444']}]){
   const s=source();Object.assign(s.checks[0].printed_inventory!,change);const c=documentReviewCalculationInputSchema.parse(s.checks[0].calculation);if(c.operation.kind==='reconciliation'){c.operation.inventory_basis='printed-earnings-inventory-v1:'+canonicalSha256(s.checks[0].printed_inventory);c.operation.inventory_complete=s.checks[0].printed_inventory!.inventory_complete;}s.checks[0].calculation=c;
   expect(apply(s).receipts.some(r=>r.decision_id==='mw.eligible_components')).toBe(false);
  }
 });
 it('requires exact source IDs/hash/receipt and independently reconciles the printed inventory',()=>{
  const s=source(),m=branch(s);m.ordinary_hours!.source.file_sha256=h('foreign');s.entitlement_evidence!.minimum_wage=m;expect(()=>apply(s)).toThrow('ENTITLEMENT_READING_SOURCE_BINDING');
  const mismatch=source(),c=documentReviewCalculationInputSchema.parse(mismatch.checks[0].calculation);c.operands[1].printed_value='3301';mismatch.checks[0].calculation=c;
  expect(apply(mismatch).unresolved.some(r=>r.reason==='printed_inventory_does_not_reconcile')).toBe(true);
  const foreign=source();foreign.case_id='22222222-2222-4222-8222-222222222222';expect(evaluateMinimumWageCaseRecipe('mw.population',branch(foreign),foreign).reason).toBe('case_period_mismatch');
 });
 it('rejects a derived-fact hash or value supplied by the caller and preserves raw unknown method',()=>{
  const a=apply(),changed=structuredClone(a.source),m=branch(changed);m.population={state:'derived',value:'adult_general',source:AI_RELEASE_DECISION_RECIPES.find(r=>r.decision_id==='mw.population')!.legal_sources[0],derivation:{schema_version:'minimum-wage-derived-fact-v1',binding_sha256:h('fake'),inputs_sha256:h('fake')}};changed.entitlement_evidence!.minimum_wage=m;
  expect(()=>composeEntitlementReview(changed)).toThrow('ENTITLEMENT_SELECTION_SCOPE');
  changed.entitlement_composition=undefined;expect(()=>composeEntitlementReview(changed)).toThrow('MW_CASE_RAW_DERIVED_FACT');
  const s=source(),b=branch(s);b.method={state:'unknown',value:null,source:b.ordinary_hours!.source};s.entitlement_evidence!.minimum_wage=b;
  expect(apply(s).unresolved.some(r=>r.reason==='method_state_preserved')).toBe(true);
 });
 it('uses normal typed answers and retains unknown/correction history without promoting a declaration to a document reading',()=>{
  let current=composeEntitlementReview(source('3300',false));const actor={case_id:caseId,identity_id:'22222222-2222-4222-8222-222222222222'};
  const values=['1990-04-15','לפי שעות עבודה','כשכיר/ה','מעסיק פרטי','לא','לא','42 שעות בשבוע'];
  let relationship:ReturnType<typeof runDocumentReview>['completions']['customer_requests'][number]|undefined;let relationshipId='';
  for(const [i,key]of Object.keys(expectedFacts).entries()){
   const factKey=`entitlement.minimum_wage.${canonicalSha256({period:current.period,pins:current.documents.filter(d=>d.kind==='payslip').map(d=>({case_id:d.case_id,document_id:d.document_id,version_id:d.version_id,source_sha256:d.file_sha256})),path:'product_facts.'+key,key:'personal.product_facts.'+key}).slice(0,28)}`;
   const request=runDocumentReview(current,'get-'+i).completions.customer_requests.find(r=>r.target.fact_key===factKey)!;expect(request).toBeDefined();
   const request_id=`55555555-5555-4555-8555-${String(i+1).padStart(12,'0')}`;
   current=applyDocumentReviewAnswer(current,{request,actor,answer:{request_id,revision:1,answered_at:at,state:'provided',value:values[i]}}).input;
   if(key==='employment_relationship'){relationship=request;relationshipId=request_id;}
  }
  expect(current.answer_history).toHaveLength(7);const a=apply(current),review=runDocumentReview(a.source,'typed');
  const swapped=structuredClone(current),raw=branch(swapped),effective=minimumWageEntitlementInputSchema.parse(current.entitlement_composition!.evidence.minimum_wage);
  raw.product_facts=minimumWageCaseFactsSchema.parse(effective.product_facts);raw.source_manifest=effective.source_manifest;
  raw.product_facts.adapted_wage_approval.source=raw.product_facts.special_wage_arrangement.source;
  swapped.entitlement_evidence!.minimum_wage=raw;swapped.entitlement_composition=undefined;
  expect(()=>composeEntitlementReview(swapped)).toThrow('ENTITLEMENT_PERSONAL_ANSWER_TARGET');
  expect(review.checks.find(c=>c.check_id==='minimum.synthetic')!.calculation.state).toBe('calculated');
  expect(minimumWageEntitlementInputSchema.parse(a.source.entitlement_composition!.evidence.minimum_wage).product_facts?.birth_date).toMatchObject({state:'declared',source:{reading:'customer_declaration'}});
  const changed=applyDocumentReviewAnswer(a.source,{request:relationship!,actor,answer:{request_id:relationshipId,revision:2,answered_at:'2026-09-12T12:01:00Z',state:'unknown',value:null}}).input;
  expect(changed.answer_history).toHaveLength(8);expect(runDocumentReview(changed,'unknown').checks.some(c=>c.check_id==='minimum.synthetic'&&c.calculation.state==='calculated')).toBe(false);
  expect(minimumWageEntitlementInputSchema.parse(changed.entitlement_composition!.evidence.minimum_wage).applicability.find(d=>d.decision_id==='mw.population')?.state).toBe('stale');
  const corrected=applyDocumentReviewAnswer(changed,{request:relationship!,actor,answer:{request_id:relationshipId,revision:3,answered_at:'2026-09-12T12:02:00Z',state:'provided',value:'כשכיר/ה'}}).input;
  expect(corrected.answer_history).toHaveLength(9);expect(runDocumentReview(corrected,'supported-correction').checks.some(c=>c.check_id==='minimum.synthetic'&&c.calculation.state==='calculated')).toBe(false);
  expect(minimumWageEntitlementInputSchema.parse(corrected.entitlement_composition!.evidence.minimum_wage).applicability.find(d=>d.decision_id==='mw.population')?.state).toBe('stale');
  expect(()=>applyDocumentReviewAnswer(current,{request:relationship!,actor:{...actor,case_id:'99999999-9999-4999-8999-999999999999'},answer:{request_id:relationshipId,revision:2,answered_at:at,state:'provided',value:'כשכיר/ה'}})).toThrow();
 });
});
