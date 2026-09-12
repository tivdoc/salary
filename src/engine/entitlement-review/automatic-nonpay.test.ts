import {describe,it,expect} from 'vitest';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {buildSyntheticCaseFixture} from '../case-analysis/synthetic-fixtures.ts';
import type {StoredCaseInputSnapshot} from '../case-analysis/contracts.ts';
import {rawDocumentObservationSchema,type RawDocumentObservation} from '../extraction/document-evidence/contracts.ts';
import {normalizeDocumentEvidence} from '../extraction/document-evidence/normalization.ts';
import {createDocumentEvidenceReadingTarget,resolveDocumentEvidenceReading} from '../extraction/document-evidence/reading.ts';
import {savedNonPayslipEvidenceSchema,type SavedNonPayslipEvidence} from '../extraction/document-evidence/snapshot.ts';
import {documentReviewInputSchema,type DocumentReviewInput} from '../document-review/contracts.ts';
import {attachNonPayslipInventory} from '../document-review/non-payslip.ts';
import {attachAutomaticNonPayslipEvidence} from './automatic-nonpay.ts';
import {workingTimeEntitlementInputSchema,resolveWorkingTimeEntitlement} from './working-time/index.ts';
import {obligationsEntitlementInputSchema,resolveExplicitObligations,OBLIGATION_ASSESSMENTS} from './obligations/index.ts';
import {calculateDocumentReview} from '../document-review/calculations.ts';
import {composeEntitlementReview} from './compose.ts';
import {runDocumentReview,applyDocumentReviewAnswer,replayDocumentReview} from '../document-review/service.ts';
import {entitlementSourceReadingDependencies} from './product-source-dependencies.ts';

const uuid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const period={from:'2026-06-01',to:'2026-06-30'};
const observation=(semantic:RawDocumentObservation['semantic'],value_kind:RawDocumentObservation['value_kind'],raw_value:string|null,unit:RawDocumentObservation['unit']=null,row='r1')=>rawDocumentObservationSchema.parse({
 block_id:'synthetic.block',row_id:row,cell_id:semantic,semantic,value_kind,raw_value,source_label:semantic,unit,page:1,locator:`synthetic.${row}.${semantic}`,text_fragment:`Synthetic ${semantic}: ${raw_value}`,state:raw_value===null?'missing':'present',confidence:1,warnings:[]});
const attendance=()=>[
 observation('row_date','iso_date','2026-06-07'),observation('entry_time','clock_time','08:00'),observation('exit_time','clock_time','17:00'),observation('reported_duration','duration_hhmm','09:00','hours'),
 observation('period_start','iso_date','2026-06-01',null,'header'),observation('period_end','iso_date','2026-06-30',null,'header'),
];
const contract=(linear=false)=>[
 observation('clause_text','text',linear?'המעסיק ישלם לעובד 12.50 ש״ח לכל משמרת בחודש.':'המעסיק ישלם לעובד 500 ש״ח בכל חודש.'),
 observation(linear?'rate':'amount','money',linear?'12.50':'500','ILS'),
 observation('effective_from','iso_date','2026-01-01'),observation('effective_to','iso_date','2026-12-31'),
 ...(linear?[{...observation('quantity','decimal','8','count'),source_label:'משמרות שבוצעו'},observation('period_start','iso_date','2026-06-01'),observation('period_end','iso_date','2026-06-30')]:[]),
];
function fixture(kind:'attendance'|'contract'='attendance',observations=kind==='attendance'?attendance():contract()){
 const old=buildSyntheticCaseFixture({fixture_id:'automatic-nonpay-synthetic',mode:'real'});
 const document={...old.stored.documents[0],document_type:kind,document_period:null,created_at:'2026-07-01T00:00:00Z'};
 const extraction=normalizeDocumentEvidence({document,physicalPageCount:1,raw:{schema_version:'document-evidence-provider-v1',detected_document_type:kind,page_count:1,pages:[{page:1,coverage:'complete',missing_regions:[]}],observations,warnings:[]}});
 let record:SavedNonPayslipEvidence=savedNonPayslipEvidenceSchema.parse({document,product_document_id:uuid(30),checkpoint_result_sha256:'c'.repeat(64),provider_receipt_sha256:'b'.repeat(64),extraction,failure_code:null,readings:[]});
 const snapshot=():StoredCaseInputSnapshot=>({...old.stored,documents:[document],extractions:[],non_payslip_evidence:[record]});
 const input=(topics:DocumentReviewInput['purchased_scope']['topics']=kind==='attendance'?['working_time','rest_day']:['contract','bonuses'])=>attachNonPayslipInventory(documentReviewInputSchema.parse({schema_version:'document-review-product-v1',case_id:document.case_id,period,purchased_scope:{order_id:'synthetic.order',receipt_sha256:'a'.repeat(64),topics,origin:'saved_order'},
  documents:[{case_id:document.case_id,document_id:document.document_id,version_id:document.document_id,file_sha256:document.content_sha256,page_count:null,kind,label:'Synthetic saved document',period:null,reading_origin:'source_inventory',reading_sha256:'d'.repeat(64)}],checks:[],completion_input:{case_id:document.case_id,period,documents:[],needs:[],evidence:[]}}),snapshot());
 const answer=(semantic:RawDocumentObservation['semantic'],action:unknown={action:'confirm'},row?:string)=>{
  const observations=extraction.observations.filter(o=>o.original.semantic===semantic&&(row===undefined||o.original.row_id===row));
  for(const o of observations){
   const target=createDocumentEvidenceReadingTarget({normalized:extraction,productDocumentId:record.product_document_id,checkpointSha256:record.checkpoint_result_sha256!,policyVersion:'saved-document-evidence-v1',month:'2026-06',observationId:o.observation_id});
   const prior=record.readings.find(r=>r.target.observation.observation_id===o.observation_id);
   const r=resolveDocumentEvidenceReading({target,currentTarget:target,caseId:document.case_id,answer:action,requestId:uuid(100+extraction.observations.indexOf(o)),answerRevision:(prior?.answer_revision??0)+1,identityId:uuid(300),answeredAt:'2026-07-02T00:00:00Z'});
   if(r.state!=='current')throw Error('Synthetic current target');record={...record,readings:[...record.readings.filter(x=>x.target.observation.observation_id!==o.observation_id),r.reading]};
  }
 };
 const identify=()=>{for(const o of extraction.observations)answer(o.original.semantic,{action:'confirm'},o.original.row_id??undefined);};
 const run=()=>attachAutomaticNonPayslipEvidence(input(),snapshot());
 return {document,extraction,input,snapshot,answer,identify,run,get record(){return record;}};
}
const weeks=(input:DocumentReviewInput)=>(input.entitlement_evidence?.working_time as unknown[]??[]).map(v=>workingTimeEntitlementInputSchema.parse(v));
const obligations=(input:DocumentReviewInput)=>obligationsEntitlementInputSchema.parse(input.entitlement_evidence!.obligations);
describe('automatic ordinary non-payslip source evidence',()=>{
 it('merges exact source cells across checks and refuses stale or foreign checkpoint dependencies',()=>{
  const f=fixture(),r=f.run(),first=r.reading_dependencies[0];
  expect(first).toBeDefined();
  const merged=entitlementSourceReadingDependencies(r.input,[first,{...first,dependent_check_ids:['additional.same.source.check']}]);
  expect(merged).toHaveLength(1);expect(merged[0].observation_ids).toEqual(first.observation_ids);
  expect(merged[0].dependent_check_ids).toContain('additional.same.source.check');
  for(const altered of [{...first,checkpoint_sha256:'f'.repeat(64)},{...first,version_id:uuid(999)},{...first,observation_ids:['invented.cell']}])
   expect(()=>entitlementSourceReadingDependencies(r.input,[altered])).toThrow('ENTITLEMENT_SOURCE_DEPENDENCY_BINDING');
 });
 it('retains confidence-one candidates and returns only real dependent observation IDs',()=>{
  const f=fixture(),before=canonicalSha256(f.snapshot()),r=f.run();expect(weeks(r.input)).toEqual([]);expect(r.reading_dependencies[0].observation_ids).toEqual(expect.arrayContaining(f.extraction.observations.map(o=>o.observation_id)));
  expect(canonicalSha256(f.snapshot())).toBe(before);expect(r.input.non_payslip_evidence![0].extraction?.observations.every(o=>o.state==='candidate')).toBe(true);
 });
 it('maps four identified same-row cells to ordinary week facts, not worked time or payment',()=>{
  const f=fixture();f.identify();const r=f.run(),w=weeks(r.input)[0];expect(r.reading_dependencies).toEqual([]);
  expect(w).toMatchObject({week_start:'2026-06-07',week_inventory:{state:'missing'},arrangement:{state:'missing'},rest_window:{state:'missing'},regular_hourly_wage:{state:'missing'},applicability:[],mode:'source_classified'});
  expect(w.workdays[0]).toMatchObject({date:'2026-06-07',inventory:{state:'missing'},recorded_pay:null,intervals:[{start_at:'2026-06-07T08:00:00+03:00',end_at:'2026-06-07T17:00:00+03:00',classification:{state:'missing'},printed_duration:{printed_value:'09:00',state:'observed',source:{reading:'identified_document_reading'}}}]});
  expect(resolveWorkingTimeEntitlement(w).checks).toEqual([]);expect(()=>composeEntitlementReview(r.input)).not.toThrow();
 });
 it('does not reopen an unknown reading or invent a clock/date',()=>{
  const f=fixture();f.answer('row_date',{action:'unknown'});const r=f.run();expect(weeks(r.input)).toEqual([]);const dateId=f.extraction.observations[0].observation_id;expect(r.reading_dependencies[0].observation_ids).not.toContain(dateId);
 });
 it('offers a factual inventory choice, keeps incomplete blocked and reports a no-work declaration conflict without losing intervals',()=>{
  const f=fixture();f.identify();const w=weeks(f.run().input)[0],day=w.workdays[0];
  expect(resolveWorkingTimeEntitlement(w).missing.find(m=>m.fact_key.startsWith('wt.inventory.'))).toMatchObject({customer_declaration_allowed:true,answer_kind:'choice',options:['complete_work','no_work','incomplete']});
  day.inventory={...day.inventory,state:'declared',value:'incomplete'};expect(resolveWorkingTimeEntitlement(w).checks).toEqual([]);
  day.inventory={...day.inventory,value:'no_work'};const r=resolveWorkingTimeEntitlement(w);expect(r.checks).toEqual([]);expect(r.missing.some(m=>m.state==='conflict'&&m.fact_key.startsWith('wt.inventory_conflict.'))).toBe(true);expect(day.intervals).toHaveLength(1);
  day.inventory={...day.inventory,state:'observed'};expect(()=>resolveWorkingTimeEntitlement(w)).toThrow('WORKING_TIME_NO_WORK_HAS_INTERVALS');
 });
 it('accepts corrected source duration with changed receipt while retaining original observations',()=>{
  const f=fixture();f.identify();const first=f.run();f.answer('exit_time',{action:'correct',corrected_raw_value:'18:00',basis:'Synthetic correction from exact source'});f.answer('reported_duration',{action:'correct',corrected_raw_value:'10:00',basis:'Synthetic correction from exact source'});
  const next=f.run();expect(weeks(next.input)[0].workdays[0].intervals[0].printed_duration.printed_value).toBe('10:00');expect(next.input.documents[0].reading_sha256).not.toBe(first.input.documents[0].reading_sha256);expect(f.extraction.observations.find(o=>o.original.semantic==='reported_duration')?.original.raw_value).toBe('09:00');
 });
 it('derives a unique overnight exit date only from matching identified clocks plus exact printed duration',()=>{
  const rows=attendance().map(o=>({...o,raw_value:o.semantic==='entry_time'?'22:00':o.semantic==='exit_time'?'08:00':o.semantic==='reported_duration'?'10:00':o.raw_value}));
  const f=fixture('attendance',rows);f.identify();expect(weeks(f.run().input)[0].workdays[0].intervals[0].end_at).toBe('2026-06-08T08:00:00+03:00');
  f.answer('reported_duration',{action:'correct',corrected_raw_value:'09:00',basis:'Synthetic mismatch retained'});const bad=f.run();expect(weeks(bad.input)[0].workdays[0].intervals).toEqual([]);expect(bad.input.coverage_gaps.some(g=>g.check_id.includes('clock_relation'))).toBe(true);
 });
 it('does not replace missing printed duration with a clock difference or blank break with zero',()=>{
  const f=fixture('attendance',[...attendance().filter(o=>o.semantic!=='reported_duration'),observation('break_duration','duration_hhmm',null,'hours')]);
  for(const o of f.extraction.observations.filter(o=>o.original.raw_value!==null))f.answer(o.original.semantic);
  expect(weeks(f.run().input)[0].workdays[0].intervals).toEqual([]);
 });
 it('keeps outside-month rows and cross-month shifts visible without asking unrelated clock cells',()=>{
  const f=fixture();f.answer('row_date',{action:'correct',corrected_raw_value:'2026-05-31',basis:'Synthetic source date'});const r=f.run();expect(weeks(r.input)).toEqual([]);expect(r.input.coverage_gaps.some(g=>g.check_id.includes('outside'))).toBe(true);expect(r.reading_dependencies[0].observation_ids).toHaveLength(2);
 });
 it('does not choose among duplicate/conflicting date cells',()=>{
  const rows=attendance(),f=fixture('attendance',[...rows,{...rows[0],raw_value:'2026-06-08'}]);expect(weeks(f.run().input)).toEqual([]);expect(f.run().reading_dependencies[0].observation_ids).not.toContain(f.extraction.observations[0].observation_id);
 });
 it('refuses changed journal, wrong source receipt and duplicate source versions',()=>{
  const f=fixture();f.identify();const input=f.input();expect(()=>attachAutomaticNonPayslipEvidence(input,{...f.snapshot(),non_payslip_evidence:[{...f.record,readings:[]}]})).toThrow('AUTOMATIC_NONPAY_SNAPSHOT_BINDING');
  const bad={...input,documents:input.documents.map(d=>({...d,reading_sha256:'0'.repeat(64)}))};expect(()=>attachAutomaticNonPayslipEvidence(bad,f.snapshot())).toThrow('AUTOMATIC_NONPAY_READING_BINDING');
  expect(()=>attachAutomaticNonPayslipEvidence({...input,non_payslip_evidence:[f.record,f.record]},f.snapshot())).toThrow('AUTOMATIC_NONPAY_DUPLICATE_DOCUMENT');
 });
 it('keeps existing immutable working-time packets and unpurchased topics unchanged',()=>{
  const f=fixture();f.identify();const r=f.run();expect(attachAutomaticNonPayslipEvidence(r.input,f.snapshot())).toEqual({input:r.input,reading_dependencies:[]});
  const input=f.input(['pension']);expect(attachAutomaticNonPayslipEvidence(input,f.snapshot()).input).toEqual(input);
 });
 it('does not turn a fully read free-form contract into a money promise',()=>{
  const f=fixture('contract',contract().map(o=>o.semantic==='clause_text'?{...o,raw_value:'המענק נתון לשיקול דעת המעסיק.'}:o));f.identify();const r=f.run();expect(r.input.entitlement_evidence?.obligations).toBeUndefined();expect(r.input.coverage_gaps.some(g=>g.kind==='missing_rule')).toBe(true);
 });
 it('maps a literal fixed monthly clause into the existing rule resolver without legal approval',()=>{
  const f=fixture('contract');f.identify();const r=f.run(),packet=obligations(r.input),o=packet.obligations[0];expect(o).toMatchObject({promise:{kind:'fixed',amount:{printed_value:'500.00'}},payment_period:period,assessments:[],recorded:null,scenario:'established_only'});
  expect(resolveExplicitObligations(packet).checks.map(c=>calculateDocumentReview(c.calculation)).every(c=>c.state==='blocked')).toBe(true);expect(()=>composeEntitlementReview(r.input)).not.toThrow();
  o.assessments=Object.keys(OBLIGATION_ASSESSMENTS).map(decision_id=>({decision_id,state:'accepted',basis:'ai_source_assessment',explanation:'Independent synthetic assessment, never produced by mapper',sources:[o.clause.source],valid_until:null}));
  expect(resolveExplicitObligations(packet).checks.map(c=>calculateDocumentReview(c.calculation)).every(c=>c.state==='blocked')).toBe(true);
  // The old resolver fixture is still readable; the new automatic packet
  // additionally requires its identified context, even with assessments.
  delete o.product_facts;
  expect(resolveExplicitObligations(packet).checks.map(c=>calculateDocumentReview(c.calculation))[0]).toMatchObject({state:'calculated',expected:{minor_units:50000}});
 });
 it('maps exact linear count and period; independent oracle 12.50 times 8 = 100.00',()=>{
  const f=fixture('contract',contract(true));f.identify();const packet=obligations(f.run().input),o=packet.obligations[0];expect(o.promise).toMatchObject({kind:'linear',rate:{printed_value:'12.50'},quantity:{printed_value:'8',quantity_unit:'count'}});
  o.assessments=Object.keys(OBLIGATION_ASSESSMENTS).map(decision_id=>({decision_id,state:'accepted',basis:'ai_source_assessment',explanation:'Independent synthetic source assessment',sources:[o.clause.source],valid_until:null}));
  delete o.product_facts; // Explicit historical resolver fixture, not product acceptance.
  expect(resolveExplicitObligations(packet).checks.map(c=>calculateDocumentReview(c.calculation))[0]).toMatchObject({state:'calculated',expected:{minor_units:10000}});
 });
 it.each(['quantity','period_start'] as const)('keeps linear quantity null without identified %s',field=>{
  const f=fixture('contract',contract(true));for(const o of f.extraction.observations)if(o.original.semantic!==field)f.answer(o.original.semantic);
  expect(obligations(f.run().input).obligations[0].promise).toMatchObject({kind:'linear',quantity:null});
 });
 it('does not treat a threshold or an unlabelled quantity as completed contractual units',()=>{
  const f=fixture('contract',contract(true).map(o=>o.semantic==='quantity'?{...o,source_label:'סף משמרות לקבלת בונוס'}:o));f.identify();expect(obligations(f.run().input).obligations[0].promise).toMatchObject({kind:'linear',quantity:null});
 });
 it('refuses amount mismatch, nearby different-row amount and partial validity without proration',()=>{
  for(const rows of [contract().map(o=>o.semantic==='amount'?{...o,raw_value:'501'}:o),contract().map(o=>o.semantic==='amount'?{...o,row_id:'other.row'}:o),contract().map(o=>o.semantic==='effective_from'?{...o,raw_value:'2026-06-15'}:o)]){
   const f=fixture('contract',rows);f.identify();expect(f.run().input.entitlement_evidence?.obligations).toBeUndefined();
  }
 });
 it('keeps conditions unresolved, no zero payment or automatic condition satisfaction',()=>{
  const f=fixture('contract',[...contract(),observation('condition_text','text','נדרשת השלמת הפרויקט.')]);f.identify();const o=obligations(f.run().input).obligations[0];expect(o.conditions).toMatchObject([{fact:{state:'unknown',value:null}}]);expect(o.recorded).toBeNull();expect(o.assessments).toEqual([]);
 });
 it('never copies an ordinary contract promise into an unpurchased bonus or vice versa',()=>{
  const f=fixture('contract');f.identify();const r=attachAutomaticNonPayslipEvidence(f.input(['bonuses']),f.snapshot());expect(r.input.entitlement_evidence?.obligations).toBeUndefined();
 });
 it('takes identified agreement context through ordinary completions without turning it into a binding decision',()=>{
  const f=fixture('contract');f.identify();const prepared=composeEntitlementReview(f.run().input),before=runDocumentReview(prepared,'contract.before');
  const requests=before.completions.customer_requests.filter(r=>r.target.fact_key.startsWith('entitlement.obligation-fact.'));
  expect(requests).toHaveLength(4);
  const request=requests.find(r=>r.target.question.includes('שימש לקביעת'))!;
  const actor={case_id:prepared.case_id,identity_id:uuid(990)};
  const answer={request_id:uuid(991),revision:1,answered_at:'2026-09-12T00:01:00Z',state:'provided' as const,value:true};
  const next=applyDocumentReviewAnswer(prepared,{request,actor,answer}),result=runDocumentReview(next.input,'contract.after');
  const effective=obligationsEntitlementInputSchema.parse(result.input.entitlement_composition!.evidence.obligations);
  expect(effective.obligations[0].product_facts!.agreement_used_for_employment).toMatchObject({state:'known',value:true,basis:'customer_declaration',source:{reading:'customer_declaration'}});
  expect(effective.obligations[0].assessments).toEqual([]);expect(result.checks.every(c=>c.calculation.state==='blocked')).toBe(true);
  expect(result.input.entitlement_evidence).toEqual(prepared.entitlement_evidence);expect(result.input.answer_history).toHaveLength(1);
  expect(applyDocumentReviewAnswer(next.input,{request,actor,answer}).input).toEqual(next.input);
  expect(replayDocumentReview(result)).toEqual(result);
  const corrected=applyDocumentReviewAnswer(next.input,{request,actor,answer:{...answer,revision:2,state:'unknown',value:null}});
  const changed=runDocumentReview(corrected.input,'contract.unknown');
  expect(obligationsEntitlementInputSchema.parse(changed.input.entitlement_composition!.evidence.obligations).obligations[0].product_facts!.agreement_used_for_employment).toMatchObject({state:'unknown',value:null});
  expect(changed.input.answer_history).toHaveLength(2);expect(changed.checks.every(c=>c.calculation.state==='blocked')).toBe(true);
  expect(()=>applyDocumentReviewAnswer(prepared,{request,actor:{...actor,case_id:'foreign'},answer})).toThrow();
 });
 it('does not ask irrelevant contract context after an identified unrelated agreement answer and validates the agreement date',()=>{
  const f=fixture('contract');f.identify();const prepared=composeEntitlementReview(f.run().input),before=runDocumentReview(prepared,'contract.context');
  const requests=before.completions.customer_requests.filter(r=>r.target.fact_key.startsWith('entitlement.obligation-fact.'));
  const actor={case_id:prepared.case_id,identity_id:uuid(990)},answer={request_id:uuid(992),revision:1,answered_at:'2026-09-12T00:01:00Z',state:'provided' as const,value:false};
  const date=requests.find(r=>r.target.value_validation?.format==='iso_date')!;
  expect(()=>applyDocumentReviewAnswer(prepared,{request:date,actor,answer:{...answer,value:'2026-02-30'}})).toThrow('REVIEW_COMPLETION_ANSWER_INVALID');
  const request=requests.find(r=>r.target.question.includes('שימש לקביעת'))!;
  const next=applyDocumentReviewAnswer(prepared,{request,actor,answer}),result=runDocumentReview(next.input,'contract.unrelated');
  expect(result.completions.customer_requests.filter(r=>r.target.fact_key.startsWith('entitlement.obligation-fact.'))).toHaveLength(0);
  expect(result.checks.every(c=>c.calculation.state==='blocked')).toBe(true);
 });
});
