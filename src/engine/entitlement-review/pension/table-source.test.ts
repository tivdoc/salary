import {describe,it,expect} from 'vitest';
import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {fixture} from '../compose.fixture.ts';
import {productFlowFixture,clause,uuid} from '../working-time/product-flow.fixture.ts';
import {rawDocumentObservationSchema,type RawDocumentObservation} from '../../extraction/document-evidence/contracts.ts';
import {createDocumentEvidenceReadingTarget,resolveDocumentEvidenceReading} from '../../extraction/document-evidence/reading.ts';
import {nonPayslipEffectiveReadingSha} from '../../document-review/non-payslip.ts';
import {pensionEntitlementInputSchema} from './contracts.ts';
import {pensionProductFacts,pensionProductFactQuestions,evaluatePensionCaseRecipe} from './product-facts.ts';
import {emptyPensionSourceFacts,PENSION_STATUTORY_FLOOR_POLICY} from './source-fact-contracts.ts';
import {attachPensionSourceFacts,assertPensionSourceFacts} from './source-facts.ts';
import {entitlementSourceReadingDependencies} from '../product-source-dependencies.ts';
import {composeEntitlementReview} from '../compose.ts';
import {runDocumentReview,applyDocumentReviewAnswer} from '../../document-review/service.ts';
import {parseReviewCompletionInput} from '../../document-review/completions.ts';
import {pensionLegalSource,resolvePensionEntitlement} from './index.ts';

// Synthetic structural example: intentionally different from the retained
// customer's rates. Expected association is handwritten, never sum-selected.
const cell=(row:string|null,column:string,raw:string|null,kind:'label'|'percentage'='label'):RawDocumentObservation=>rawDocumentObservationSchema.parse({
 ...clause(raw??'',row??'header'),row_id:row,cell_id:column,semantic:kind==='label'?'source_label':'percentage',value_kind:kind==='label'?'text':'percentage',
 raw_value:raw,unit:kind==='label'?null:'percent',state:raw===null?'missing':'present',source_label:'Synthetic source cell',locator:`table/${row}/${column}`});
const rows=()=>[cell(null,'employee','אחוז הפרשה של העובד'),cell(null,'employer','אחוז הפרשה של המעביד'),
 cell('pension','label','פנסיה'),cell('severance','label','פיצויים'),cell('pension','employee','7.25%','percentage'),
 cell('pension','employer','8.50%','percentage'),cell('severance','employer','9%','percentage'),cell('severance','employee',null,'percentage')];
function sample(observations=rows()){
 const f=productFlowFixture(observations),old=fixture();let record=f.record;
 const input=pensionEntitlementInputSchema.parse({...old.pension,case_id:f.document.case_id,product_facts:pensionProductFacts({tables:true}),source_facts:emptyPensionSourceFacts({tables:true}),calculation_policy:PENSION_STATUTORY_FLOOR_POLICY,
  source_manifest:old.pension.source_manifest.map(s=>({...s,case_id:f.document.case_id})),applicability:[...old.pension.applicability.filter(d=>d.decision_id!=='pension.no_better_arrangement'),
   {decision_id:'pension.statutory_floor',state:'accepted',basis:'ai_source_assessment',explanation:'Explicit synthetic fixture floor assessment, not customer authority',sources:[pensionLegalSource('order2011',4,'section 6'),pensionLegalSource('order2016',1,'section 2')],valid_until:null}]});
 const review=()=>{const r=f.review(),completion=parseReviewCompletionInput(r.completion_input),priorCompletion=parseReviewCompletionInput(old.input.completion_input);return {...r,purchased_scope:{...r.purchased_scope,topics:['pension' as const]},non_payslip_evidence:[record],
  completion_input:{...completion,documents:[...completion.documents,...priorCompletion.documents.map(d=>({...d,pin:{...d.pin,case_id:f.document.case_id}}))]},
  documents:[...r.documents.map(d=>d.document_id===f.document.document_id?{...d,reading_sha256:nonPayslipEffectiveReadingSha(record)}:d),...old.input.documents.map(d=>({...d,case_id:f.document.case_id}))]};};
 const answer=(row:string|null,column:string,value:unknown={action:'confirm'})=>{
  const o=f.extraction.observations.find(o=>o.original.row_id===row&&o.original.cell_id===column)!;
  const target=createDocumentEvidenceReadingTarget({normalized:f.extraction,productDocumentId:record.product_document_id,checkpointSha256:record.checkpoint_result_sha256!,policyVersion:'saved-document-evidence-v1',month:'2026-06',observationId:o.observation_id});
  const prior=record.readings.find(r=>r.target.observation.observation_id===o.observation_id),r=resolveDocumentEvidenceReading({target,currentTarget:target,caseId:input.case_id,answer:value,requestId:uuid(100+f.extraction.observations.indexOf(o)),answerRevision:(prior?.answer_revision??0)+1,identityId:uuid(300),answeredAt:'2026-07-02T00:00:00Z'});
  if(r.state!=='current')throw Error('Synthetic current reading');record={...record,readings:[...record.readings.filter(r=>r.target.observation.observation_id!==o.observation_id),r.reading]};
 };
 const identify=()=>f.extraction.observations.filter(o=>o.original.state==='present').forEach(o=>answer(o.original.row_id,o.original.cell_id));
 const packet=()=>{const r=review(),p=attachPensionSourceFacts(input,r).input;return {...r,entitlement_evidence:{schema_version:'entitlement-source-evidence-v1' as const,case_id:p.case_id,order_id:r.purchased_scope.order_id,receipt_sha256:r.purchased_scope.receipt_sha256,period:p.period,pension:p}};};
 return {input,review,answer,identify,packet,extraction:f.extraction};
}

describe('grounded pension table source mapping',()=>{
 it('preserves the prior source-facts shape and output when table opt-in is absent',()=>{
  const f=sample();f.input.source_facts=emptyPensionSourceFacts();delete f.input.product_facts!.contract_terms_changed;
  const before=canonicalSha256(resolvePensionEntitlement(f.input)),r=attachPensionSourceFacts(f.input,f.review());
  expect(r.input.source_facts).toEqual(emptyPensionSourceFacts());expect(r.reading_dependencies).toEqual([]);expect(canonicalSha256(resolvePensionEntitlement(r.input))).toBe(before);
 });
 it('selects seven actual nonempty observation IDs, without a blank-cell request or confidence promotion',()=>{
  const f=sample(),r=attachPensionSourceFacts(f.input,f.review());expect(r.input.source_facts?.arrangement_table?.state).toBe('unknown');
  const expected=f.extraction.observations.filter(o=>o.original.state==='present').map(o=>o.observation_id).sort();
  expect([...r.reading_dependencies[0].observation_ids].sort()).toEqual(expected);expect([...entitlementSourceReadingDependencies(f.packet())[0].observation_ids].sort()).toEqual(expected);
  expect(pensionProductFactQuestions(r.input).some(q=>q.path==='product_facts.contract_terms_changed')).toBe(false);
 });
 it('identifies exact rates while preserving unknown product, wage composition and current period',()=>{
  const f=sample();f.identify();const r=attachPensionSourceFacts(f.input,f.review()).input;
  expect(r.source_facts?.arrangement_table).toMatchObject({state:'observed',value:{employee_percent:'7.25',employer_percent:'8.5',severance_percent:'9',product:'unspecified_pension_product',period:null,temporal_association:'unresolved'}});
  expect(r.source_facts?.arrangement.state).toBe('missing');expect(evaluatePensionCaseRecipe('pension.pension_fund',r,f.review()).allowed).toBe(false);expect(evaluatePensionCaseRecipe('pension.pensionable_wage',r,f.review()).allowed).toBe(false);
  expect(r.pensionable_wage).toEqual(f.input.pensionable_wage);expect(r.recorded).toEqual([]);expect(()=>assertPensionSourceFacts(r,f.review())).not.toThrow();
 });
 it.each(['unknown','unreadable'] as const)('preserves %s without reopening that source cell; correction can resume',(state)=>{
  const f=sample();f.identify();f.answer('pension','employee',{action:state});let r=attachPensionSourceFacts(f.input,f.review());
  expect(r.input.source_facts?.arrangement_table?.state).toBe(state);expect(r.reading_dependencies).toEqual([]);
  f.answer('pension','employee',{action:'correct',corrected_raw_value:'7.25%',basis:'Synthetic source reread'});r=attachPensionSourceFacts(f.input,f.review());expect(r.input.source_facts?.arrangement_table?.state).toBe('observed');
 });
 it('rejects stale receipts and corrects only the exact cell, not the independent wage operand',()=>{
  const f=sample();f.identify();const prior=attachPensionSourceFacts(f.input,f.review()).input;
  f.answer('pension','employee',{action:'correct',corrected_raw_value:'7.75%',basis:'Synthetic different printed rate'});
  expect(()=>assertPensionSourceFacts(prior,f.review())).toThrow('PENSION_SOURCE_FACT_REPLAY');const current=attachPensionSourceFacts(prior,f.review()).input;
  expect(current.source_facts?.arrangement_table?.value?.employee_percent).toBe('7.75');expect(current.pensionable_wage).toEqual(prior.pensionable_wage);
 });
 it('does not infer a row or column after a label correction removes its required identity',()=>{
  const f=sample();f.identify();f.answer('pension','label',{action:'correct',corrected_raw_value:'קרן השתלמות',basis:'Synthetic classification correction'});
  expect(attachPensionSourceFacts(f.input,f.review()).input.source_facts?.arrangement_table?.state).toBe('conflict');
 });
 it('retains exact fractional and zero source rates, and blocks an out-of-range reading without crashing the report',()=>{
  const f=sample();f.identify();
  for(const rate of ['7.12345%','0%','101%']){
   f.answer('pension','employee',{action:'correct',corrected_raw_value:rate,basis:'Synthetic precision/boundary source reading'});
   const table=attachPensionSourceFacts(f.input,f.review()).input.source_facts?.arrangement_table;
   expect(table?.state).toBe(rate==='101%'?'conflict':'observed');if(rate!=='101%')expect(table?.value?.employee_percent).toBe(rate.slice(0,-1));
  }
 });
 it('does not collapse duplicate blocks or same-valued duplicate cells',()=>{
  for(const duplicate of [rows().map(o=>({...o,block_id:'another.table'})),[rows()[4]]]){
   const f=sample([...rows(),...duplicate]);expect(attachPensionSourceFacts(f.input,f.review()).input.source_facts?.arrangement_table?.state).toBe('conflict');
  }
 });
 it('requires exact structural headers instead of binding nearby or cross-block percentage cells',()=>{
  const f=sample(rows().map(o=>o.row_id==='pension'&&o.cell_id==='employee'?{...o,block_id:'another.table'}:o));
  expect(attachPensionSourceFacts(f.input,f.review()).input.source_facts?.arrangement_table?.state).toBe('conflict');
 });
 it('reads source dates as dates; a 2020-only interval is not current 2026 evidence',()=>{
  const dated=(from:string,to:string)=>[...rows(),{...clause(from,'from'),semantic:'effective_from' as const,value_kind:'iso_date' as const},{...clause(to,'to'),semantic:'effective_to' as const,value_kind:'iso_date' as const}];
  for(const [from,to,expected]of [['2026-01-01','2026-12-31','identified_source_dates'],['2020-01-01','2020-12-31','conflict']] as const){const f=sample(dated(from,to));f.identify();const r=attachPensionSourceFacts(f.input,f.review()).input;
   expect(r.source_facts?.arrangement_table?.value?.temporal_association).toBe(expected);expect(pensionProductFactQuestions(r).some(q=>q.path==='product_facts.contract_terms_changed')).toBe(expected!=='identified_source_dates');}
 });
 it('ordinary identified answer links currentness only; unknown/change preserve one tracked fact and leave expected money independent',()=>{
  const f=sample();f.identify();const prepared=composeEntitlementReview(f.packet()),before=runDocumentReview(prepared,'before'),request=before.completions.customer_requests.find(r=>r.target.question.includes('האם נמסר או סוכם שינוי'))!;
  expect(before.checks.map(c=>c.calculation.expected)).toEqual([30000,32500,30000].map(minor_units=>({kind:'money',currency:'ILS',minor_units})));
  expect(request).toBeDefined();expect(request.dependent_check_ids).toEqual([`${f.input.check_prefix}.complete_arrangement`]);
  const actor={case_id:f.input.case_id,identity_id:uuid(300)},answer=(value:string|null,state:'provided'|'unknown',revision:number)=>({request_id:uuid(900),revision,answered_at:'2026-09-12T00:00:00Z',state,value});
  const linked=applyDocumentReviewAnswer(prepared,{request,actor,answer:answer('לא נמסר ולא סוכם שינוי','provided',1)}),after=runDocumentReview(linked.input,'after');
  const p=pensionEntitlementInputSchema.parse(after.input.entitlement_composition?.evidence.pension);
  expect(p.source_facts?.arrangement_table?.value).toMatchObject({period:f.input.period,temporal_association:'declared_no_change'});expect(p.product_facts?.contract_terms_changed).toMatchObject({state:'declared',value:false,source:{reading:'customer_declaration'}});
  expect(after.checks.map(c=>c.calculation.expected)).toEqual(before.checks.map(c=>c.calculation.expected));expect(p.source_facts?.arrangement.state).toBe('missing');
  const unknown=applyDocumentReviewAnswer(linked.input,{request,actor,answer:answer(null,'unknown',2)}),unknownRun=runDocumentReview(unknown.input,'unknown');
  expect(pensionEntitlementInputSchema.parse(unknownRun.input.entitlement_composition?.evidence.pension).source_facts?.arrangement_table?.value?.temporal_association).toBe('unknown');
  expect(unknownRun.completions.customer_requests.filter(r=>r.target.fact_key===request.target.fact_key)).toHaveLength(0);
  expect(unknownRun.input.answer_history.filter(h=>h.request.target.fact_key===request.target.fact_key)).toHaveLength(2);
  expect(unknownRun.completions.suppressed.filter(r=>r.fact_key===request.target.fact_key)).toHaveLength(1);
  const changed=applyDocumentReviewAnswer(unknown.input,{request,actor,answer:answer('נמסר או סוכם שינוי','provided',3)}),changedRun=runDocumentReview(changed.input,'changed');
  expect(pensionEntitlementInputSchema.parse(changedRun.input.entitlement_composition?.evidence.pension).source_facts?.arrangement_table?.value?.temporal_association).toBe('change_reported');
  expect(changedRun.coverage_gaps.some(g=>g.next_step.includes('נדרש מקור התנאים המעודכנים'))).toBe(true);
 });
});
