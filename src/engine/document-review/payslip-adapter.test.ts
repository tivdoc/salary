import {randomUUID} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {buildSyntheticCaseFixture} from '../case-analysis/synthetic-fixtures.ts';
import type {NormalizedCandidateField,NormalizedPayslipExtraction} from '../extraction/payslip.ts';
import {normalizeMoney,normalizeDecimal,normalizePercentage} from '../extraction/normalization.ts';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {documentFieldTarget,DOCUMENT_FIELD_CONFIRMATION_ANSWERS} from '../../server/product/reports/document-field-confirmation.ts';
import {savedDocumentFieldReadings} from '../../server/product/processing/saved-field-readings.ts';
import {documentReviewInputSchema} from './contracts.ts';
import {runDocumentReview,applyDocumentReviewAnswer} from './service.ts';
import {reviewInputFromPayslips,PAYSLIP_REVIEW_POLICY,PAYSLIP_FINANCIAL_SOURCE_POLICY,PAYSLIP_FINANCIAL_SOURCE_FACT,type PayslipFinancialSourceProof} from './payslip-adapter.ts';
import {payslipMachineExtraction,payslipMachineExtractionSha256,normalizeSourceTranscriptionValue} from '../extraction/reading-resolution.ts';
import {customerSourceTranscriptionSchema,sourceTranscriptionSubjectSchema,type SourceTranscriptionSubject} from '../extraction/customer-reading.ts';
import {documentReviewReadingDependencies,parseDocumentReviewSourceLocator,deferredDocumentReviewRowPriceOperands} from './source-dependencies.ts';
import {parseReviewCompletionInput} from './completions.ts';
import type {DocumentReviewCalculationInput} from './calculations.ts';
import {reviewFieldRequestsNotRequired} from '../../server/product/reports/review-field-coverage.ts';

type Mutable<T>={-readonly [K in keyof T]:T[K]};
function fixture(){
 const f=buildSyntheticCaseFixture({fixture_id:'synthetic-normal-document-adapter',mode:'real'}),d={...structuredClone(f.stored.documents[0])},e={...structuredClone(f.stored.extractions[0]),fields:f.stored.extractions[0].fields.map(field=>({...structuredClone(field)}))};
 const period={from:'2026-06-01',to:'2026-06-30'};d.document_period={start_date:period.from,end_date:period.to};e.extracted_at='2026-07-02T12:00:00.000Z';
 const p=e.fields.find(f=>f.field==='salary_period')!;
 if(p.field!=='salary_period')throw Error('synthetic period');
 p.normalized_value={year:2026,month:6,start_date:period.from,end_date:period.to};p.raw_value='06/2026';
 e.fields=[p];e.additional_components=[];e.earnings_components_complete=false;
 const money=(field:NormalizedCandidateField['field'],raw:string,confidence=1)=>{
  const candidate={candidate_id:randomUUID(),field,raw_value:raw,normalized_value:normalizeMoney(raw),confidence,source:{document_id:d.document_id,page:1,text_fragment:`${field}: ${raw}`},extraction_method:'fixture',warning_flags:[]} as Mutable<NormalizedCandidateField>;
  e.fields.push(candidate);return candidate;
 };
 const row=(semantic_kind:NormalizedPayslipExtraction['additional_components'][number]['semantic_kind']='hourly_base',quantity='2',rate='50.00',amount='100.00',percentage:string|null=null)=>{
  const r:NormalizedPayslipExtraction['additional_components'][number]={component_id:randomUUID(),source_label:'שכר סינתטי',normalized_label:'synthetic.pay',semantic_kind,quantity_raw:quantity,rate_raw:rate,percentage_raw:percentage,amount_raw:amount,
   quantity:normalizeDecimal(quantity),rate:normalizeMoney(rate),percentage:percentage===null?null:normalizePercentage(percentage),amount:normalizeMoney(amount),confidence:1,
   source:{document_id:d.document_id,page:1,text_fragment:'Synthetic unique row quantity and unit price'},extraction_method:'fixture',warning_flags:[],normalization_warnings:[]};
  e.additional_components.push(r);return r;
 };
 const build=(financial_source_proofs?:readonly PayslipFinancialSourceProof[],extra:Partial<Pick<Parameters<typeof reviewInputFromPayslips>[0],'review_policy'|'retained_unresolved_fields'>>={},
  topics:Parameters<typeof reviewInputFromPayslips>[0]['purchased_scope']['topics']=['minimum_wage','working_time','pension','travel','convalescence','bonuses'])=>reviewInputFromPayslips({financial_source_proofs,...extra,case_id:d.case_id,period,purchased_scope:{order_id:'synthetic-paid-order',receipt_sha256:'a'.repeat(64),origin:'saved_order',topics},snapshot:{...f.stored,documents:[d],extractions:[e]}});
 const run=()=>runDocumentReview(documentReviewInputSchema.parse(build()),'synthetic-normal-review-run');
 const identify=(candidates:NormalizedCandidateField[],includeDeductions=false)=>{
  const {customer_readings:_,...machine}=e;void _;
  const checkpoint={schema_version:'tivdoc-saved-extraction-v1',case_id:d.case_id,product_document_id:randomUUID(),version_id:d.document_id,input_sha256:d.content_sha256,expected_month:'2026-06',period_mismatch:false,result_sha256:canonicalSha256({final_extraction:machine}),run:{result:{final_extraction:machine}}};
  const answers=candidates.filter(c=>includeDeductions||c.field!=='total_deductions').map(c=>{const target=documentFieldTarget({checkpoint,policyVersion:'synthetic-adapter-reading-v1',candidateId:c.candidate_id});return {id:randomUUID(),case_id:d.case_id,scope_month:'2026-06',code:`document_field:${target.target_sha256}`,answer_kind:'choice',answer:DOCUMENT_FIELD_CONFIRMATION_ANSWERS[0],answer_revision:1,answer_identity_id:randomUUID(),answer_created_at:'2026-07-03T12:00:00Z',field_target:target};});
  e.customer_readings=[...savedDocumentFieldReadings({caseId:d.case_id,month:'2026-06',policyVersion:'synthetic-adapter-reading-v1',journal:{answers},checkpoint})];
 };
 const totals=(confidence=1)=>[money('gross_salary','100.00',confidence),money('total_deductions','10.00'),money('net_salary','90.00',confidence)];
 return {d,e,p,build,run,money,row,identify,totals};
}
function financialFixture(){
 const f=fixture(),cells=[f.p,...f.totals(.94)];
 for(const c of cells)c.source={...c.source,text_fragment:`Synthetic current ${c.field}: ${c.raw_value}`,source_scope:{period_kind:'current',fund_kind:'unknown',column_label:'חודש נוכחי'}};
 const proof=():PayslipFinancialSourceProof=>{
  const {customer_readings:ignored,...original}=f.e;void ignored;
  return {policy_version:PAYSLIP_FINANCIAL_SOURCE_POLICY,case_id:f.d.case_id,document_id:f.d.document_id,source_sha256:f.d.content_sha256,
   normalized_extraction_sha256:canonicalSha256(original),provider_receipt_sha256:'b'.repeat(64),source_page_count:f.e.quality_metrics!.page_count,complete_original_source:true};
 };
 return {...f,cells,proof,confirm:()=>f.identify(cells,true)};
}
it('uses an identified printed grand total after excluding two immutable subtotals, never reclassifying corrected numbers',()=>{
 const f=fixture(),gross=f.money('gross_salary','100.00'),net=f.money('net_salary','80.00'),secondGross=f.money('gross_salary','100.00'),secondNet=f.money('net_salary','80.00');
 const subtotals=['ניכויי חובה','ניכויי חובה-מסים'].map(label=>{const c=f.money('total_deductions','8.00');c.source.text_fragment=`${label}: 8.00`;return c;});
 const machine=payslipMachineExtraction(f.e),before=canonicalSha256(machine),checkpointResult={final_extraction:machine,first_pass:{normalized_extraction:machine}},resultSha=canonicalSha256(checkpointResult);
 const retained={case_id:f.d.case_id,document_id:f.d.document_id,source_sha256:f.d.content_sha256,checkpoint_result_sha256:resultSha,
  checkpoint_result:checkpointResult,final_extraction_sha256:before,first_pass:machine};
 const checkpoint={schema_version:'tivdoc-saved-extraction-v1',case_id:f.d.case_id,product_document_id:randomUUID(),version_id:f.d.document_id,input_sha256:f.d.content_sha256,
  expected_month:'2026-06',period_mismatch:false,result_sha256:resultSha,run:{result:checkpointResult}};
 const oldRequests=subtotals.map(c=>{const target=documentFieldTarget({checkpoint,policyVersion:'synthetic-grand-total',candidateId:c.candidate_id});return {
  request_id:randomUUID(),code:`document_field:${target.target_sha256}`,target,source_current:true,answered_at:null,expires_at:'2026-08-01T00:00:00Z'};});
 f.identify([f.p,gross,net,secondGross,secondNet,...subtotals],true);
 const subtotalReading=f.e.customer_readings!.find(r=>r.candidate_id===subtotals[0].candidate_id)!;
 subtotalReading.correction={schema_version:'document-field-correction-v1',raw_value:'9.00',normalized_value:{currency:'ILS',minor_units:900},verification_sha256:'c'.repeat(64)};
 const build=()=>f.build(undefined,{review_policy:PAYSLIP_REVIEW_POLICY,retained_unresolved_fields:[retained]},['minimum_wage']);
 const initial=runDocumentReview(documentReviewInputSchema.parse(build()),'synthetic.grand.total.before');
 expect(initial.input.source_semantic_derivations?.[0].excluded_candidates).toHaveLength(2);
 expect(initial.checks.find(c=>c.check_id.endsWith('.gross.net'))?.calculation.state).toBe('blocked');
 expect(documentReviewReadingDependencies({review:initial,document_id:f.d.document_id,extraction:f.e}).source_transcriptions)
  .toContainEqual({subject:{kind:'grand_total',page:1},check_ids:['document.0.gross.net']});
 expect(reviewFieldRequestsNotRequired({review:initial,fieldRequests:oldRequests,nowMs:Date.parse('2026-07-04T00:00:00Z')})).toHaveLength(2);
 const foreign=oldRequests.map(r=>({...r,target:{...r.target,extraction_result_sha256:'f'.repeat(64)}}));
 // Rehashed, well-formed foreign checkpoint still cannot borrow this derivation.
 for(const r of foreign){const {target_sha256:ignored,...body}=r.target;void ignored;r.target.target_sha256=canonicalSha256(body);r.code=`document_field:${r.target.target_sha256}`;}
 expect(reviewFieldRequestsNotRequired({review:initial,fieldRequests:foreign,nowMs:Date.parse('2026-07-04T00:00:00Z')})).toEqual([]);
 const subject:SourceTranscriptionSubject={kind:'grand_total',page:1,meaning:'document_total_deductions',first_pass_extraction_sha256:before};
 const raw=JSON.stringify({schema_version:'grand-total-source-value-v1',amount:'20.00',label:'סך הניכויים',locator:'טבלה סינתטית, שורת סך'});
 f.e.source_reading_context={checkpoint_result_sha256:resultSha,first_pass:machine};
 f.e.customer_source_transcriptions=[customerSourceTranscriptionSchema.parse({schema_version:'document-source-transcription-reading-v1',actor_kind:'customer',case_id:f.d.case_id,document_id:f.d.document_id,
  source_sha256:f.d.content_sha256,normalized_extraction_sha256:before,extraction_result_sha256:resultSha,target_sha256:'e'.repeat(64),subject,month:'2026-06',request_id:randomUUID(),answer_revision:1,identity_id:randomUUID(),confirmed_at:'2026-07-03T12:00:00Z',
  transcription:{raw_value:raw,normalized_value:normalizeSourceTranscriptionValue(subject,raw)!,verification_sha256:'f'.repeat(64)}})];
 const review=runDocumentReview(documentReviewInputSchema.parse(build()),'synthetic.grand.total.after');
 expect(review.checks.find(c=>c.check_id.endsWith('.gross.net'))?.calculation.input.operands.map(o=>({id:o.id,state:o.state,value:o.printed_value}))).toEqual([
  {id:'gross',state:'observed',value:'100.00'},{id:'deductions',state:'observed',value:'20.00'},{id:'net',state:'observed',value:'80.00'}]);
 expect(review.checks.find(c=>c.check_id.endsWith('.gross.net'))?.calculation).toMatchObject({state:'calculated',expected:{minor_units:8000},difference:{minor_units:0}});
 expect(review.legal_debt_total).toBeNull();expect(payslipMachineExtractionSha256(f.e)).toBe(before);
 expect(canonicalSha256(checkpointResult)).toBe(resultSha);expect(f.e.fields.filter(c=>c.field==='total_deductions')).toEqual(subtotals);
 expect(parseReviewCompletionInput(review.input.completion_input).documents.every(d=>d.review==='partial'&&!d.review_completed_fact_keys?.includes(PAYSLIP_FINANCIAL_SOURCE_FACT))).toBe(true);
 const readings=structuredClone(f.e.customer_readings!),transcriptions=structuredClone(f.e.customer_source_transcriptions);
 const blocked=()=>expect(runDocumentReview(build(),'synthetic.grand.total.negative').checks.find(c=>c.check_id.endsWith('.gross.net'))?.calculation.state).toBe('blocked');
 f.e.customer_readings=readings.filter(r=>r.candidate_id!==secondGross.candidate_id);blocked();
 f.e.customer_readings=structuredClone(readings);
 f.e.customer_readings.find(r=>r.candidate_id===secondGross.candidate_id)!.correction={schema_version:'document-field-correction-v1',raw_value:'101.00',normalized_value:{currency:'ILS',minor_units:10100},verification_sha256:'c'.repeat(64)};blocked();
 f.e.customer_readings=structuredClone(readings);
 for(const reading of f.e.customer_readings.filter(r=>r.candidate_id===gross.candidate_id||r.candidate_id===secondGross.candidate_id))
  reading.correction={schema_version:'document-field-correction-v1',raw_value:'250000.00',normalized_value:{currency:'ILS',minor_units:25000000},verification_sha256:'c'.repeat(64)};
 blocked();f.e.customer_readings=readings;f.e.customer_source_transcriptions=[];blocked();f.e.customer_source_transcriptions=transcriptions;
});
function populatedEarningsFixture(){
 const f=fixture();f.e.earnings_components_complete=true;
 const rows=[f.row('hourly_base','3','30.00','90.00'),f.row('travel','2','5.00','10.00'),f.row('bonus','1','7.00','7.00')];
 rows.forEach((r,i)=>{r.source_label=`שורת בדיקה ${i+1}`;r.source={...r.source,text_fragment:r.source_label,source_scope:{period_kind:'current',fund_kind:'unknown',column_label:'סכום'}};r.confidence=.94;});
 const gross=f.money('gross_salary','107.00'),deduction=f.row('deduction','1','8.00','8.00');deduction.source.text_fragment='Synthetic deduction';
 // A pension relationship problem must not gate the independent earnings sum.
 f.money('pension_employee_contribution','4.00',.94);f.money('pension_base','90.00',.94);
 const identifyRows=(cells:readonly ('quantity'|'rate'|'amount')[]=['quantity','rate','amount'])=>{
  const hash=payslipMachineExtractionSha256(f.e);
  f.e.customer_row_readings=rows.flatMap(r=>cells.map(cell=>({schema_version:'document-row-cell-reading-v1' as const,actor_kind:'customer' as const,
   case_id:f.d.case_id,document_id:f.d.document_id,component_id:r.component_id,cell,source_sha256:f.d.content_sha256,normalized_extraction_sha256:hash,
   original_component_sha256:canonicalSha256(r),extraction_result_sha256:'d'.repeat(64),target_sha256:canonicalSha256([r.component_id,cell]),month:'2026-06',request_id:randomUUID(),answer_revision:1,identity_id:randomUUID(),confirmed_at:'2026-07-03T12:00:00Z'})));
 };
 const review=()=>runDocumentReview(f.build(undefined,{review_policy:PAYSLIP_REVIEW_POLICY}),'synthetic.rows.new');
 return {...f,rows,gross,identifyRows,review};
}

function priceOnlyRowFixture(){
 const f=fixture(),row=f.row('overtime_125','2','50.00','100.00');
 row.quantity_raw=null;row.quantity=null;row.amount_raw=null;row.amount=null;row.confidence=.94;
 row.source={...row.source,source_scope:{period_kind:'current',fund_kind:'unknown',column_label:'סכום'}};
 const input=()=>f.build(undefined,{review_policy:PAYSLIP_REVIEW_POLICY});
 return {...f,row,input};
}

describe('deferred price readings for a source row with no quantity or amount',()=>{
 it('keeps blank cells but asks about another source instead of requesting impossible numeric transcriptions, with legacy requests unchanged',()=>{
  const f=priceOnlyRowFixture(),original=canonicalSha256(f.e),input=f.input(),review=runDocumentReview(input,'synthetic.blank.price');
  const check=review.checks[0];
  expect(check.calculation).toMatchObject({state:'blocked',difference:null});
  expect(check.calculation.input.operands.map(o=>[o.id,o.state,o.printed_value])).toEqual([['rate','unknown','50.00'],['quantity','missing',null],['amount','missing',null]]);
  expect(review.completions.customer_requests).toHaveLength(1);
  expect(review.completions.customer_requests[0]).toMatchObject({target:{fact_key:`${check.check_id}.missing_basis`,kind:'factual',answer_kind:'text',required_evidence_kind:'observed_reading'},
   dependent_check_ids:[check.check_id,`${check.check_id}.blank_basis`]});
  expect(review.completions.customer_requests[0].target.question).toContain('אין צורך להעתיק מספר שאינו מופיע');
  expect(input.answer_bindings).toEqual([]);
  expect(review.coverage_gaps).toContainEqual(expect.objectContaining({check_id:`${check.check_id}.blank_basis`,kind:'missing_fact'}));
  const deps=documentReviewReadingDependencies({review,document_id:f.d.document_id,extraction:f.e});
  expect(deps.row_cells).toEqual([]);expect(deps.unmapped.filter(u=>u.reason==='blank_source')).toHaveLength(2);
  expect(f.build().answer_bindings.map(b=>b.operand_id).sort()).toEqual(['amount','quantity','rate']);
  expect(canonicalSha256(f.e)).toBe(original);
 });
 it.each(['unknown','provided'] as const)('does not treat a %s answer about another source as an observed reading',state=>{
  const f=priceOnlyRowFixture(),input=f.input(),before=runDocumentReview(input,'synthetic.blank.before');
  const request=before.completions.customer_requests.find(q=>q.target.fact_key.endsWith('.missing_basis'))!;
  const changed=applyDocumentReviewAnswer(input,{request,actor:{case_id:f.d.case_id,identity_id:randomUUID()},
   answer:{request_id:randomUUID(),revision:1,answered_at:'2026-07-03T12:00:00Z',state,value:state==='provided'?'קיים פירוט שעות נוסף מהמעסיק':null}});
  const after=runDocumentReview(changed.input,'synthetic.blank.answer');
  if(changed.resolution.state==='stale')throw Error('Synthetic answer unexpectedly stale');
  expect(changed.resolution.requires_source_verification).toBe(true);
  expect(after.checks[0].calculation.input.operands.find(o=>o.id==='quantity')?.state).toBe('missing');
  expect(documentReviewReadingDependencies({review:after,document_id:f.d.document_id,extraction:f.e}).row_cells).toEqual([]);
  expect(after.checks[0].calculation.state).toBe('blocked');
  expect(after.completions.customer_requests).toEqual([]);
  expect(after.completions.suppressed).toMatchObject([{target_sha256:request.target.target_sha256,reason:'previous_answer',state}]);
  expect(after.input.answer_history).toHaveLength(1);
  expect(Object.keys(after.completions.dependency_index)).toEqual([request.target.target_sha256]);
  const retry=runDocumentReview(changed.input,'synthetic.blank.answer.retry');
  expect(retry.completions).toEqual(after.completions);
  expect(retry.checks[0].calculation.state).toBe('blocked');
  if(state==='provided')expect(after.completions.internal_tasks.some(t=>t.kind==='review_existing_source')).toBe(true);
 });
 it('allows a new populated source to request its cells again without reusing any old reading',()=>{
  const f=priceOnlyRowFixture(),original=structuredClone(f.e),old=runDocumentReview(f.input(),'synthetic.blank.old');
  f.e.extraction_id=randomUUID();f.row.quantity_raw='2';f.row.quantity='2';f.row.amount_raw='100.00';f.row.amount=normalizeMoney('100.00');
  const next=runDocumentReview(f.input(),'synthetic.blank.replaced');
  expect(next.checks[0].calculation.state).toBe('blocked');
  expect(next.completions.customer_requests.map(q=>q.target.fact_key.split('.').at(-1)).sort()).toEqual(['amount','quantity','rate']);
  expect(documentReviewReadingDependencies({review:next,document_id:f.d.document_id,extraction:f.e}).row_cells.map(r=>r.cell).sort()).toEqual(['amount','quantity','rate']);
  expect(next.coverage_gaps.some(g=>g.check_id.endsWith('.blank_basis'))).toBe(false);
  expect(old.documents[0].reading_sha256).toBe(canonicalSha256(original));expect(next.documents[0].reading_sha256).not.toBe(old.documents[0].reading_sha256);
  expect(original.additional_components[0].quantity_raw).toBeNull();
 });
 it('does not permanently suppress the price when separately admitted declaration operands become available',()=>{
  const f=priceOnlyRowFixture(),sourceInput=f.input(),legacy=f.build(),completion=parseReviewCompletionInput(legacy.completion_input);
  // Explicit synthetic declaration contract, distinct from the adapter's
  // observed-reading requests. No product policy is changed by this fixture.
  const numericBindings=legacy.answer_bindings.filter(b=>b.operand_id==='quantity'||b.operand_id==='amount');
  let input:ReturnType<typeof f.input>={...sourceInput,answer_bindings:numericBindings,
   completion_input:{...completion,needs:completion.needs.filter(n=>numericBindings.some(b=>b.fact_key===n.fact_key)).map(n=>({...n,required_evidence_kind:'customer_declaration' as const}))}};
  for(const [cell,value] of [['quantity','2'],['amount','100.00']] as const){
   const review=runDocumentReview(input,`synthetic.declared.${cell}`),request=review.completions.customer_requests.find(q=>q.target.fact_key.endsWith(`.${cell}`))!;
   input=applyDocumentReviewAnswer(input,{request,actor:{case_id:f.d.case_id,identity_id:randomUUID()},answer:{request_id:randomUUID(),revision:1,answered_at:'2026-07-03T12:00:00Z',state:'provided',value:Number(value)}}).input;
  }
  const result=runDocumentReview(input,'synthetic.declared.ready'),calculation=result.checks[0].calculation.input;
  expect(calculation.operands.filter(o=>o.id!=='rate').every(o=>o.state==='declared'&&o.source.reading==='customer_declaration')).toBe(true);
  expect(deferredDocumentReviewRowPriceOperands(calculation,f.e).size).toBe(0);
  expect(documentReviewReadingDependencies({review:result,document_id:f.d.document_id,extraction:f.e}).row_cells).toMatchObject([{component_id:f.row.component_id,cell:'rate'}]);
  expect(f.e.additional_components[0].quantity_raw).toBeNull();expect(f.e.additional_components[0].amount_raw).toBeNull();
 });
});

describe('versioned printed earnings and exact dependency consumers',()=>{
 it('fills a missing source period only from the confirmed saved reading, preserving purchase uncertainty and legacy output',()=>{
  const f=financialFixture();f.d.document_period=null;f.p.confidence=.94;
  const pending=f.build([f.proof()],{review_policy:PAYSLIP_REVIEW_POLICY});
  expect(pending.documents[0].period).toBeNull();expect(pending.checks).toEqual([]);
  f.confirm();const original=canonicalSha256(f.e),input=f.build([f.proof()],{review_policy:PAYSLIP_REVIEW_POLICY});
  const purchasePeriod={schema_version:'document-review-purchase-period-v1' as const,state:'missing' as const,periods:[],receipt_sha256:input.purchased_scope.receipt_sha256};
  const review=runDocumentReview({...input,purchased_scope:{...input.purchased_scope,purchase_period_evidence:purchasePeriod}},'synthetic.source.period');
  expect(review.documents[0]).toMatchObject({period:{from:'2026-06-01',to:'2026-06-30'},reading_sha256:original,file_sha256:f.d.content_sha256,version_id:f.d.document_id});
  expect(review.coverage_inventory?.source_periods[0].period).toEqual({from:'2026-06-01',to:'2026-06-30'});
  expect(review.coverage_inventory?.purchase_period_evidence).toEqual(purchasePeriod);
  expect(f.build([f.proof()]).documents[0].period).toBeNull();
  expect(f.d.document_period).toBeNull();expect(canonicalSha256(f.e)).toBe(original);
 });
 it.each(['conflict','outside_review'] as const)('does not fill source period from %s candidates',reason=>{
  const f=fixture();f.d.document_period=null;
  if(f.p.field!=='salary_period')throw Error('Synthetic period type');
  const other={...structuredClone(f.p),candidate_id:randomUUID(),raw_value:'05/2026',normalized_value:{year:2026,month:5,start_date:'2026-05-01',end_date:'2026-05-31'}};
  if(reason==='conflict')f.e.fields.push(other);else f.e.fields=[other];
  const input=f.build(undefined,{review_policy:PAYSLIP_REVIEW_POLICY});
  expect(input.documents[0].period).toBeNull();expect(input.checks).toEqual([]);
  expect(input.coverage_gaps.some(g=>g.check_id==='document.0.period')).toBe(true);
 });
 it('keeps aggregate earnings blocked when a required component is outside purchased topics and opens no unsupported row or scalar alias',()=>{
  const f=populatedEarningsFixture(),travel=f.rows[1],scalar=f.money('travel_amount',travel.amount_raw!,.94);
  scalar.source={...travel.source,text_fragment:`${travel.source_label}: ${travel.amount_raw}`};
  const original=canonicalSha256(f.e),limited=f.build(undefined,{review_policy:PAYSLIP_REVIEW_POLICY},['minimum_wage']),review=runDocumentReview(limited,'synthetic.limited.scope');
  expect(review.checks.find(c=>c.check_id.endsWith('.earnings.printed'))?.calculation.state).toBe('blocked');
  expect(review.coverage_gaps).toContainEqual(expect.objectContaining({check_id:'document.0.earnings.printed.scope',kind:'missing_rule'}));
  expect(review.completions.customer_requests.some(q=>q.dependent_check_ids.includes('document.0.earnings.printed'))).toBe(false);
  const deps=documentReviewReadingDependencies({review,document_id:f.d.document_id,extraction:f.e});
  expect(deps.row_cells.every(r=>r.component_id===f.rows[0].component_id)).toBe(true);
  expect(deps.scalar_fields.some(r=>r.candidate_id===scalar.candidate_id)).toBe(false);
  expect(review.purchased_scope.topics).toEqual(['minimum_wage']);expect(canonicalSha256(f.e)).toBe(original);
  f.identifyRows();const covered=f.review();
  expect(covered.checks.find(c=>c.check_id.endsWith('.earnings.printed'))?.calculation).toMatchObject({state:'calculated',difference:{minor_units:0}});
  expect(covered.coverage_gaps.some(g=>g.check_id.endsWith('.earnings.printed.scope'))).toBe(false);
 });
 it('retains read deduction rows and a precise grouping gap without guessing subtotal membership',()=>{
  const f=fixture();f.totals();f.row('deduction','1','4.00','4.00');f.row('deduction','1','6.00','6.00');
  const before=canonicalSha256(f.e),review=runDocumentReview(f.build(undefined,{review_policy:PAYSLIP_REVIEW_POLICY}),'synthetic.deductions.grouping');
  expect(review.checks.find(c=>c.check_id.endsWith('.gross.net'))?.calculation).toMatchObject({state:'calculated',difference:{minor_units:0}});
  expect(review.coverage_gaps).toContainEqual(expect.objectContaining({check_id:'document.0.deductions.grouping',kind:'missing_fact'}));
  expect(review.checks.some(c=>c.check_id.includes('deductions.grouping'))).toBe(false);
  expect(review.completions.customer_requests).toEqual([]);expect(canonicalSha256(f.e)).toBe(before);
  expect(f.build().coverage_gaps.some(g=>g.check_id.includes('deductions.grouping'))).toBe(false);
 });
 it('uses only identified amount cells for a printed earnings reconciliation independently of pension and blank OT',()=>{
  const f=populatedEarningsFixture(),blank=f.row('overtime_125','1','37.50','37.50');
  blank.quantity_raw=null;blank.quantity=null;blank.amount_raw=null;blank.amount=null;blank.confidence=.94;
  blank.source={...blank.source,text_fragment:'Synthetic blank OT',source_scope:{period_kind:'current',fund_kind:'unknown',column_label:'סכום'}};
  f.identifyRows(['amount']);const original=canonicalSha256(f.e),result=f.review(),sum=result.checks.find(c=>c.check_id.endsWith('.earnings.printed'))!;
  expect(sum.calculation).toMatchObject({state:'calculated',expected:{minor_units:10700},recorded:{minor_units:10700},difference:{minor_units:0}});
  expect(sum.printed_inventory).toMatchObject({payable_completeness_assessed:false,unresolved_blank_component_ids:[blank.component_id]});
  expect(sum.explanation).toContain('לא נחשבו כאפס');expect(result.checks.find(c=>c.title.includes('פנסיה'))?.calculation.state).toBe('blocked');
  expect(result.checks.filter(c=>c.calculation.input.operation.kind==='product').every(c=>c.calculation.state==='blocked')).toBe(true);
  expect(result.legal_debt_total).toBeNull();expect(canonicalSha256(f.e)).toBe(original);
  const deps=documentReviewReadingDependencies({review:result,document_id:f.d.document_id,extraction:f.e});
  expect(deps.row_cells.filter(c=>f.rows.some(r=>r.component_id===c.component_id)).every(c=>c.cell!=='amount')).toBe(true);
  expect(deps.unmapped.some(c=>c.reason==='blank_source')).toBe(true);
 });
 it('shows an independent one-agora arithmetic difference and preserves exact source operands',()=>{
  const f=populatedEarningsFixture();f.gross.raw_value='107.01';f.gross.normalized_value=normalizeMoney('107.01');f.identifyRows();
  expect(f.review().checks.find(c=>c.check_id.endsWith('.earnings.printed'))?.calculation).toMatchObject({state:'calculated',expected:{minor_units:10700},difference:{minor_units:-1}});
 });
 it.each(['missing_amount_with_quantity','unknown_semantic','conflicting_duplicate','partial_inventory','wrong_period_scope'])(
  'does not silently omit %s to make earnings balance',reason=>{
   const f=populatedEarningsFixture();
   if(reason==='missing_amount_with_quantity'){f.rows[1].amount_raw=null;f.rows[1].amount=null;}
   if(reason==='unknown_semantic')f.row('unknown','1','2.00','2.00');
   if(reason==='conflicting_duplicate')f.e.additional_components.push({...structuredClone(f.rows[1]),component_id:randomUUID(),amount_raw:'11.00',amount:normalizeMoney('11.00')});
   if(reason==='partial_inventory')f.e.earnings_components_complete=false;
   if(reason==='wrong_period_scope')f.rows[1].source.source_scope!.period_kind='cumulative';
   f.identifyRows();if(reason==='missing_amount_with_quantity')f.e.customer_row_readings=f.e.customer_row_readings!.filter(r=>!(r.component_id===f.rows[1].component_id&&r.cell==='amount'));
   expect(f.review().checks.find(c=>c.check_id.endsWith('.earnings.printed'))?.calculation.state).toBe('blocked');
  });
 it('rejects edited source and inventory metadata, and leaves scalar v1 locators out of the v2 mapper',()=>{
  const f=populatedEarningsFixture(),result=f.review(),input=f.build(undefined,{review_policy:PAYSLIP_REVIEW_POLICY}),sum=input.checks.find(c=>c.check_id.endsWith('.earnings.printed'))!;
  sum.printed_inventory={...sum.printed_inventory!,unresolved_blank_component_ids:[randomUUID()]};
  expect(()=>runDocumentReview(input,'tampered')).toThrow('REVIEW_PRINTED_INVENTORY_BINDING');
  expect(()=>documentReviewReadingDependencies({review:result,document_id:f.d.document_id,extraction:{...f.e,warnings:['changed']}})).toThrow('REVIEW_DEPENDENCY_EXTRACTION_BINDING');
  const locator=parseDocumentReviewSourceLocator(result.checks.find(c=>c.calculation.input.operation.kind==='product')!.calculation.input.operands[0].source.locator);
  expect(locator).toMatchObject({schema_version:'document-review-source-locator-v2',cell:'rate',component_ids:[f.rows[0].component_id]});
  expect(parseDocumentReviewSourceLocator(JSON.stringify({component_ids:[f.rows[0].component_id]}))).toBeNull();
 });
 it('reuses an exactly mapped scalar target for a row cell while retaining its row identity',()=>{
  const f=populatedEarningsFixture(),row=f.rows[1],amount=f.money('travel_amount',row.amount_raw!,.94);
  amount.source={...row.source,text_fragment:`${row.source_label}: ${row.amount_raw}`};
  const result=f.review(),deps=documentReviewReadingDependencies({review:result,document_id:f.d.document_id,extraction:f.e});
  expect(deps.scalar_fields.find(c=>c.candidate_id===amount.candidate_id)?.check_ids).toContain('document.0.earnings.printed');
  expect(deps.row_cells.some(c=>c.component_id===row.component_id&&c.cell==='amount')).toBe(false);
  const check=result.checks.find(c=>c.title===`בדיקת שורה — ${row.source_label}`)!;
  const locator=parseDocumentReviewSourceLocator(check.calculation.input.operands.find(o=>o.id==='amount')!.source.locator);
  expect(locator).toMatchObject({component_ids:[row.component_id],cell:'amount',mapped_candidate:{candidate_id:amount.candidate_id,candidate_sha256:canonicalSha256(amount)}});
  amount.source={...amount.source,text_fragment:'Synthetic unrelated amount source'};
  const updated=f.review(),separate=documentReviewReadingDependencies({review:updated,document_id:f.d.document_id,extraction:f.e});
  expect(separate.row_cells.some(c=>c.component_id===row.component_id&&c.cell==='amount')).toBe(true);
 });
 it('retains original first-pass balance numbers without guessing days, hours or a financial fact',()=>{
  const f=fixture(),first={...structuredClone(f.e),extraction_id:randomUUID()},balance:NormalizedCandidateField={candidate_id:randomUUID(),field:'vacation_balance',raw_value:'12.30',normalized_value:null,
   confidence:.94,source:{document_id:f.d.document_id,page:1,text_fragment:'יתרה חדשה: 12.30'},extraction_method:'fixture',warning_flags:['normalization_failed']};
  first.fields.push(balance);
  const checkpoint_result={first_pass:{normalized_extraction:first},final_extraction:payslipMachineExtraction(f.e)};
  const retained={case_id:f.d.case_id,document_id:f.d.document_id,source_sha256:f.d.content_sha256,checkpoint_result_sha256:canonicalSha256(checkpoint_result),checkpoint_result,final_extraction_sha256:payslipMachineExtractionSha256(f.e),first_pass:first};
  const input=f.build(undefined,{review_policy:PAYSLIP_REVIEW_POLICY,retained_unresolved_fields:[retained]});
  const review=runDocumentReview(input,'synthetic.balance.inventory');
  expect(review.coverage_inventory?.unresolved_source_observations[0]).toMatchObject({raw_value:'12.30',unit:null,field:'vacation_balance'});
  expect(review.checks).toHaveLength(0);expect(f.e.fields.some(c=>c.field==='vacation_balance')).toBe(false);
  expect(()=>f.build(undefined,{review_policy:PAYSLIP_REVIEW_POLICY,retained_unresolved_fields:[{...retained,final_extraction_sha256:'f'.repeat(64)}]})).toThrow('DOCUMENT_REVIEW_RETAINED_SOURCE_BINDING');
  expect(first.extraction_id).not.toBe(f.e.extraction_id);
  for(const changed of [{case_id:randomUUID()},{source_sha256:'f'.repeat(64)},{checkpoint_result_sha256:'f'.repeat(64)},
   {first_pass:{...first,extraction_id:randomUUID()}},{checkpoint_result:{...checkpoint_result,final_extraction:{...f.e,extraction_id:randomUUID()}}}]){
   expect(()=>f.build(undefined,{review_policy:PAYSLIP_REVIEW_POLICY,retained_unresolved_fields:[{...retained,...changed}]})).toThrow('DOCUMENT_REVIEW_RETAINED_SOURCE_BINDING');
  }
 });
 it('compares separately scoped net and final payable only after their own identified source receipts',()=>{
  const f=fixture();f.money('net_salary','80.00');
  const observation=(scope:'voluntary_deduction'|'final_payable',field:'total_deductions'|'net_salary',raw_value:string)=>({scope,policy_version:'payslip-explicit-source-scope-v1' as const,source_label:scope,
   candidate:{candidate_id:randomUUID(),field,raw_value,confidence:.94,source:{document_id:f.d.document_id,page:1,text_fragment:`${scope}: ${raw_value}`,source_scope:{period_kind:'current' as const,fund_kind:'unknown' as const,column_label:null}},extraction_method:'fixture' as const,warning_flags:[]}});
  f.e.source_scope_observations=[observation('voluntary_deduction','total_deductions','10.00'),observation('final_payable','net_salary','70.00')];
  const run=()=>runDocumentReview(f.build(undefined,{review_policy:PAYSLIP_REVIEW_POLICY}),'synthetic.scopes');
  const blocked=run(),deps=documentReviewReadingDependencies({review:blocked,document_id:f.d.document_id,extraction:f.e});
  expect(blocked.checks.find(c=>c.check_id.endsWith('.net.final'))?.calculation.state).toBe('blocked');expect(deps.scope_fields).toHaveLength(2);
  f.e.customer_scope_readings=f.e.source_scope_observations.map(o=>({schema_version:'document-source-scope-reading-v1' as const,actor_kind:'customer' as const,
   case_id:f.d.case_id,document_id:f.d.document_id,candidate_id:o.candidate.candidate_id,source_sha256:f.d.content_sha256,normalized_extraction_sha256:payslipMachineExtractionSha256(f.e),
   original_observation_sha256:canonicalSha256(o),extraction_result_sha256:'d'.repeat(64),target_sha256:canonicalSha256(o),month:'2026-06',request_id:randomUUID(),answer_revision:1,identity_id:randomUUID(),confirmed_at:'2026-07-03T12:00:00Z'}));
  expect(run().checks.find(c=>c.check_id.endsWith('.net.final'))?.calculation).toMatchObject({state:'calculated',expected:{minor_units:7000},difference:{minor_units:0}});
  expect(f.e.fields.some(c=>c.field==='total_deductions')).toBe(false);
  f.e.customer_scope_readings[0]={...f.e.customer_scope_readings[0],original_observation_sha256:'f'.repeat(64)};
  expect(run).toThrow('DOCUMENT_SCOPE_READING_BINDING_MISMATCH');
 });
 it('compares an explicitly transcribed reported total with the row quantity without turning it into paid hours',()=>{
  const f=populatedEarningsFixture(),machine=payslipMachineExtraction(f.e),before=canonicalSha256(machine);f.identifyRows();
  const initial=f.review(),deps=documentReviewReadingDependencies({review:initial,document_id:f.d.document_id,extraction:f.e});
  expect(initial.checks.find(c=>c.check_id.endsWith('.hours.row.reported_total'))?.calculation.state).toBe('blocked');
  expect(deps.source_transcriptions).toContainEqual({subject:{kind:'reported_work_hours',page:1},check_ids:['document.0.hours.row.reported_total']});
  const resultSha=canonicalSha256({final_extraction:machine,first_pass:{normalized_extraction:machine}}),subject:SourceTranscriptionSubject={kind:'reported_work_hours',page:1,meaning:'document_reported_total_hours'};
  f.e.source_reading_context={checkpoint_result_sha256:resultSha,first_pass:machine};
  f.e.customer_source_transcriptions=[customerSourceTranscriptionSchema.parse({schema_version:'document-source-transcription-reading-v1',actor_kind:'customer',case_id:f.d.case_id,document_id:f.d.document_id,
   source_sha256:f.d.content_sha256,normalized_extraction_sha256:before,extraction_result_sha256:resultSha,target_sha256:'e'.repeat(64),subject,month:'2026-06',request_id:randomUUID(),answer_revision:1,identity_id:randomUUID(),confirmed_at:'2026-07-03T12:00:00Z',
   transcription:{raw_value:'4.25',normalized_value:normalizeSourceTranscriptionValue(subject,'4.25')!,verification_sha256:'f'.repeat(64)}})];
  const result=f.review(),comparison=result.checks.find(c=>c.check_id.endsWith('.hours.row.reported_total'))!;
  expect(comparison.calculation).toMatchObject({state:'calculated',difference:{kind:'rational',numerator:'-5',denominator:'4'},input:{operation:{interpretation:'different_source_representations'}}});
  expect(comparison.explanation).toContain('אינו שעות שלא שולמו');expect(result.legal_debt_total).toBeNull();expect(payslipMachineExtractionSha256(f.e)).toBe(before);
  expect(f.e.fields.some(c=>c.field==='regular_hours')).toBe(false);
 });
 it('records a balance-unit reading without confirming its AI-read amount or constructing a balance calculation',()=>{
  const f=fixture(),machine=payslipMachineExtraction(f.e),first=structuredClone(machine),candidate:NormalizedCandidateField={candidate_id:randomUUID(),field:'sick_balance',raw_value:'9.40',normalized_value:null,
   confidence:.94,source:{document_id:f.d.document_id,page:1,text_fragment:'יתרה חדשה: 9.40'},extraction_method:'fixture',warning_flags:['normalization_failed']};first.fields.push(candidate);
  const resultSha=canonicalSha256({final_extraction:machine,first_pass:{normalized_extraction:first}}),subject=sourceTranscriptionSubjectSchema.parse({kind:'balance_unit',original_candidate:candidate,first_pass_extraction_sha256:canonicalSha256(first)});
  f.e.source_reading_context={checkpoint_result_sha256:resultSha,first_pass:first};
  f.e.customer_source_transcriptions=[customerSourceTranscriptionSchema.parse({schema_version:'document-source-transcription-reading-v1',actor_kind:'customer',case_id:f.d.case_id,document_id:f.d.document_id,
   source_sha256:f.d.content_sha256,normalized_extraction_sha256:canonicalSha256(machine),extraction_result_sha256:resultSha,target_sha256:'e'.repeat(64),subject,month:'2026-06',request_id:randomUUID(),answer_revision:1,identity_id:randomUUID(),confirmed_at:'2026-07-03T12:00:00Z',
   transcription:{raw_value:'שעות',normalized_value:normalizeSourceTranscriptionValue(subject,'שעות')!,verification_sha256:'f'.repeat(64)}})];
  const retained={case_id:f.d.case_id,document_id:f.d.document_id,source_sha256:f.d.content_sha256,checkpoint_result_sha256:resultSha,
   checkpoint_result:{final_extraction:machine,first_pass:{normalized_extraction:first}},final_extraction_sha256:canonicalSha256(machine),first_pass:first};
  const input=f.build(undefined,{review_policy:PAYSLIP_REVIEW_POLICY,retained_unresolved_fields:[retained]}),review=runDocumentReview(input,'synthetic.balance.unit');
  expect(review.coverage_inventory?.source_balance_observations).toMatchObject([{raw_value:'9.40',unit:'hours',amount_verified:false,reading_status:'identified_unit_reading'}]);
  expect(review.coverage_inventory?.unresolved_source_observations).toEqual([]);expect(review.checks).toHaveLength(0);expect(candidate.normalized_value).toBeNull();
  expect(payslipMachineExtractionSha256(f.e)).toBe(canonicalSha256(machine));
 });
});
describe('narrow requested financial source receipt',()=>{
 it('accepts four identified current cells and physical source proof without marking the whole payslip reviewed',()=>{
  const f=financialFixture();f.confirm();const original=structuredClone(f.e),input=documentReviewInputSchema.parse(f.build([f.proof()]));
  const completion=input.completion_input as {documents:{review:string;review_completed_fact_keys:string[]}[];evidence:{fact_key:string;value:string}[]};
  expect(completion.documents[0]).toMatchObject({review:'partial',review_completed_fact_keys:[PAYSLIP_FINANCIAL_SOURCE_FACT]});
  expect(completion.evidence).toHaveLength(1);expect(completion.evidence[0].fact_key).toBe(PAYSLIP_FINANCIAL_SOURCE_FACT);
  expect(JSON.parse(completion.evidence[0].value).cells).toHaveLength(4);
  expect(f.e).toEqual(original);expect(f.e.earnings_components_complete).toBe(false);expect(f.e.fields.some(c=>c.field==='pension_base')).toBe(false);
 });
 it.each(['no_physical_proof','no_readings','missing_cell','one_unconfirmed','unknown_scope','cumulative_scope','cropped','partial','foreign_period','conflict'])(
  'does not emit positive source evidence for %s',kind=>{
   const f=financialFixture();
   if(kind==='missing_cell')f.e.fields=f.e.fields.filter(c=>c.field!=='total_deductions');
   if(kind==='unknown_scope'||kind==='cumulative_scope')f.cells[1].source.source_scope!.period_kind=kind==='unknown_scope'?'unknown':'cumulative';
   if(kind==='cropped')f.e.warnings.push('cropped_content');
   if(kind==='partial')f.e.status='partial';
   if(kind==='foreign_period')f.d.document_period={start_date:'2026-05-01',end_date:'2026-05-31'};
   if(kind==='conflict')f.money('gross_salary','110.00');
   if(kind!=='no_readings')f.identify(f.e.fields, true);
   if(kind==='one_unconfirmed')f.e.customer_readings=f.e.customer_readings!.filter(r=>r.candidate_id!==f.cells[2].candidate_id);
   const input=f.build(kind==='no_physical_proof'?undefined:[f.proof()]);
   const completion=input.completion_input as {documents:{review_completed_fact_keys?:string[]}[];evidence:unknown[]};
   expect(completion.evidence).toEqual([]);expect(completion.documents[0].review_completed_fact_keys).toBeUndefined();
  });
 it.each(['source','case','receipt_binding','page_count'])( 'rejects altered physical proof %s',kind=>{
  const f=financialFixture();f.confirm();const proof={...f.proof()};
  if(kind==='source')proof.source_sha256='f'.repeat(64);
  if(kind==='case')proof.case_id=randomUUID();
  if(kind==='receipt_binding')proof.normalized_extraction_sha256='e'.repeat(64);
  if(kind==='page_count')proof.source_page_count++;
  expect(()=>f.build([proof])).toThrow('DOCUMENT_REVIEW_FINANCIAL_SOURCE_PROOF_BINDING');
 });
});

describe('saved extraction to ordinary source review',()=>{
 it('admits each exact mapped row cell separately and never confirms its siblings or a different source label',()=>{
  const f=fixture(),row=f.row();row.confidence=.94;row.source.text_fragment=row.source_label;
  const rate=f.money('hourly_rate',row.rate_raw!,.94),amount=f.money('base_monthly_salary',row.amount_raw!,.94);
  const quantity:NormalizedCandidateField={...structuredClone(rate),candidate_id:randomUUID(),field:'regular_hours',raw_value:row.quantity_raw!,normalized_value:{amount:row.quantity!,unit:'hours_per_month'}};
  f.e.fields.push(quantity);
  for(const candidate of [rate,amount,quantity])candidate.source.text_fragment=`${row.source_label}: ${candidate.raw_value}`;
  f.identify([rate]);let result=f.run().checks.find(c=>c.check_id.includes('.row.'))!.calculation;
  expect(result.state).toBe('blocked');expect(result.input.operands.map(o=>o.state)).toEqual(['observed','unknown','unknown']);
  f.identify([rate,amount,quantity]);result=f.run().checks.find(c=>c.check_id.includes('.row.'))!.calculation;
  expect(result.state).toBe('calculated');expect(result.difference).toMatchObject({minor_units:0});
  expect(result.input.operands.every(o=>o.source.reading==='identified_document_reading')).toBe(true);expect(row.confidence).toBe(.94);
  const headerRate={...structuredClone(rate),candidate_id:randomUUID(),source:{...rate.source,text_fragment:`תעריף שעה: ${rate.raw_value}`}};
  f.e.fields.push(headerRate);f.identify([rate,headerRate,amount,quantity]);
  expect(f.run().checks.find(c=>c.check_id.includes('.row.'))!.calculation.state).toBe('calculated');
  // A new saved source hash and genuine reading still cannot turn a different
  // labeled scalar into this row's quantity merely because the number agrees.
  quantity.source.text_fragment=`תווית אחרת: ${quantity.raw_value}`;f.identify([rate,headerRate,amount,quantity]);
  result=f.run().checks.find(c=>c.check_id.includes('.row.'))!.calculation;
  expect(result.state).toBe('blocked');expect(result.input.operands.find(o=>o.id==='quantity')?.state).toBe('unknown');
 });
 it('uses a separately identified corrected cell through the normal engine while preserving provider observations',()=>{
  const f=fixture(),fields=f.totals(.94),gross=fields[0];gross.raw_value='99.00';gross.normalized_value=normalizeMoney('99.00');
  f.identify(fields);const reading=f.e.customer_readings!.find(r=>r.candidate_id===gross.candidate_id)!;
  reading.correction={schema_version:'document-field-correction-v1',raw_value:'100.00',normalized_value:normalizeMoney('100.00'),verification_sha256:'e'.repeat(64)};
  const before=structuredClone(f.e),result=f.run(),check=result.checks[0].calculation;
  expect(check.state).toBe('calculated');expect(check.difference).toMatchObject({minor_units:0});
  expect(check.input.operands[0]).toMatchObject({printed_value:'100.00',source:{reading:'identified_document_reading'}});
  expect(gross).toMatchObject({raw_value:'99.00',confidence:.94,normalized_value:{minor_units:9900}});expect(f.e).toEqual(before);
  f.e.customer_readings=f.e.customer_readings!.filter(r=>r.candidate_id!==gross.candidate_id);
  expect(f.run().checks[0].calculation.state).toBe('blocked');expect(gross.raw_value).toBe('99.00');
 });
 it('keeps the corrected scalar and its exact copied row cell consistent without changing the saved row',()=>{
  const f=fixture(),row=f.row('hourly_base','2','50.00','99.00');row.confidence=.94;row.source.text_fragment=row.source_label;
  const amount=f.money('base_monthly_salary','99.00',.94),rate=f.money('hourly_rate','50.00',.94);
  const quantity:NormalizedCandidateField={...structuredClone(rate),candidate_id:randomUUID(),field:'regular_hours',raw_value:'2',normalized_value:{amount:'2',unit:'hours_per_month'}};f.e.fields.push(quantity);
  for(const c of [amount,rate,quantity])c.source.text_fragment=`${row.source_label}: ${c.raw_value}`;
  f.identify([amount,rate,quantity]);const r=f.e.customer_readings!.find(r=>r.candidate_id===amount.candidate_id)!;
  r.correction={schema_version:'document-field-correction-v1',raw_value:'100.00',normalized_value:normalizeMoney('100.00'),verification_sha256:'a'.repeat(64)};
  const original=structuredClone(f.e),result=f.run().checks.find(c=>c.check_id.includes('.row.'))!.calculation;
  expect(result.state).toBe('calculated');expect(result.difference).toMatchObject({minor_units:0});
  expect(result.input.operands.find(o=>o.id==='amount')).toMatchObject({printed_value:'100.00',source:{reading:'identified_document_reading'}});
  expect(result.input.operands.find(o=>o.id==='amount')?.source.locator).toContain('99.00');expect(f.e).toEqual(original);expect(row.amount?.minor_units).toBe(9900);
 });
 it.each(['value','currency','month'] as const)('rejects a forged corrected %s instead of trusting the proposed normalized value',kind=>{
  const f=fixture(),fields=f.totals(.94);f.identify(fields);const r=f.e.customer_readings![0];
  r.correction={schema_version:'document-field-correction-v1',raw_value:kind==='currency'?'USD 100':'100.00',normalized_value:kind==='value'?normalizeMoney('900.00'):normalizeMoney('100.00'),verification_sha256:'e'.repeat(64)};
  if(kind==='month')r.month='2026-07';
  expect(f.build).toThrow(/DOCUMENT_READING_(?:CORRECTION_INVALID|BINDING_MISMATCH)/u);
 });
 it('uses canonical identified .94 readings without modifying source confidence or identity',()=>{
  const f=fixture(),fields=f.totals(.94);expect(f.run().checks[0].calculation.state).toBe('blocked');
  f.identify(fields);const original=canonicalSha256(f.e),r=f.run(),c=r.checks[0].calculation;
  expect(c.state).toBe('calculated');expect(c.difference).toMatchObject({minor_units:0});
  expect(c.input.operands[0].observation_id).toBe(fields[0].candidate_id);expect(c.input.operands[0].source.reading_receipt_sha256).toBe(original);
  expect(c.input.operands[0].source.locator).toContain('100.00');expect(fields[0].confidence).toBe(.94);expect(canonicalSha256(f.e)).toBe(original);
  expect(r.publication_authority).toBe(false);expect(c.legal_requirement_status).toBe('not_determined');
 });
 it('does not turn confidence alone into a verified reading',()=>{
  const f=fixture();f.totals(.94);const r=f.run();expect(r.checks[0].calculation.state).toBe('blocked');expect(r.completions.customer_requests.length).toBeGreaterThan(0);
  expect(f.build().answer_bindings).toHaveLength(2);
 });
 it('accepts only independently identified agreeing scalar observations',()=>{
  const f=fixture(),fields=f.totals(.94),duplicate={...structuredClone(fields[0]),candidate_id:randomUUID()};f.e.fields.push(duplicate);f.identify([...fields,duplicate]);
  const calculation=f.run().checks[0].calculation;expect(calculation.state).toBe('calculated');expect(calculation.input.operands[0].source.locator).toContain(duplicate.candidate_id);
 });
 it.each(['source','candidate','extraction'] as const)('rejects altered identified %s bindings',kind=>{
  const f=fixture();f.identify(f.totals(.94));const r=f.e.customer_readings![0];
  if(kind==='source')r.source_sha256='f'.repeat(64);if(kind==='candidate')r.candidate_sha256='f'.repeat(64);if(kind==='extraction')r.normalized_extraction_sha256='f'.repeat(64);
  expect(f.build).toThrow('DOCUMENT_READING_BINDING_MISMATCH');
 });
 it('keeps contradictory observed values blocked even when both have identified readings',()=>{
  const f=fixture(),fields=f.totals(.94),conflict=f.money('gross_salary','110.00',.94);f.identify([...fields,conflict]);
  const calculation=f.run().checks[0].calculation;expect(calculation).toMatchObject({state:'blocked',difference:null});expect(calculation.input.operands[0].state).toBe('conflict');
 });
 it.each(['currency','raw mapping','low quality','failed'] as const)('blocks %s instead of returning financial zero',kind=>{
  const f=fixture(),fields=f.totals();if(kind==='currency'&&fields[0].field==='gross_salary'&&fields[0].normalized_value)fields[0].normalized_value.currency='XTS';
  if(kind==='raw mapping')fields[0].raw_value='1000.00';if(kind==='low quality')f.e.document_quality_confidence=.5;if(kind==='failed')f.e.status='failed';
  const r=f.run();expect(r.checks.every(c=>c.calculation.state==='blocked')).toBe(true);expect(r.checks.every(c=>c.calculation.difference===null)).toBe(true);
 });
 it('does not let identified readings discharge low document quality',()=>{
  const f=fixture(),fields=f.totals(.94);f.e.document_quality_confidence=.5;f.identify([...fields,f.p]);
  expect(f.run().checks[0].calculation.state).toBe('blocked');
 });
 it('rejects a foreign candidate source rather than repinning it to the current file',()=>{
  const f=fixture();f.totals()[0].source.document_id=randomUUID();expect(f.build).toThrow('DOCUMENT_REVIEW_EXTRACTION_IDENTITY');
 });
 it('keeps non-payslip inventory and a targeted financial source gap without calculations',()=>{
  const f=fixture();f.totals();f.e.detected_document_type='unknown';const r=f.run();
  expect(r.documents[0].kind).toBe('other');expect(r.checks).toHaveLength(0);expect(r.coverage_gaps[0].kind).toBe('missing_source');
 });
 it('refuses period mismatch rather than silently assigning the requested month',()=>{
  const f=fixture();f.totals();if(f.p.field==='salary_period'&&f.p.normalized_value){f.p.normalized_value.month=7;f.p.normalized_value.start_date='2026-07-01';f.p.normalized_value.end_date='2026-07-31';}
  const r=f.run();expect(r.checks).toHaveLength(0);expect(r.coverage_gaps[0].check_id).toContain('period');
 });
});
describe('bounded source rows through the existing RuleSpec runtime',()=>{
 it('computes a located source row and labels a discrepancy arithmetic only',()=>{
  const f=fixture();f.row('hourly_base','2','50.00','99.99');const r=f.run(),c=r.checks[0].calculation;
  expect(c.state).toBe('calculated');expect(c.expected).toMatchObject({minor_units:10000});expect(c.difference).toMatchObject({minor_units:1});expect(c.claim).toBe('document_arithmetic');
  expect(r.legal_debt_total).toBeNull();expect(c.input.operands[0].source.label).toContain('שכר סינתטי');
 });
 it('does not multiply an already-priced OT unit rate again',()=>{
  const f=fixture();f.money('hourly_rate','60.00');f.row('overtime_125','2','75.00','150.00','125%');
  const c=f.run().checks[0].calculation;expect(c.state).toBe('calculated');expect(c.expected).toMatchObject({minor_units:15000});expect(c.input.operation).toMatchObject({factor_refs:['quantity']});
 });
 it('applies an explicit displayed percentage only to an identified matching base rate',()=>{
  const f=fixture();f.money('hourly_rate','60.00');f.row('overtime_125','2','60.00','150.00','125%');
  const c=f.run().checks[0].calculation;expect(c.expected).toMatchObject({minor_units:15000});expect(c.input.operation).toMatchObject({factor_refs:['quantity','percentage']});
 });
 it('deduplicates the same physical source row while preserving observation IDs',()=>{
  const f=fixture(),r=f.row(),copy={...structuredClone(r),component_id:randomUUID()};f.e.additional_components.push(copy);
  const result=f.run();expect(result.checks).toHaveLength(1);expect(result.checks[0].calculation.input.operands[0].source.locator).toContain(copy.component_id);
 });
 it('retains rows on different pages and never constructs an unproven aggregate',()=>{
  const f=fixture(),r=f.row(),copy={...structuredClone(r),component_id:randomUUID(),source:{...r.source,page:2}};f.e.additional_components.push(copy);
  expect(f.run().checks).toHaveLength(2);expect(f.run().checks.every(c=>c.calculation.input.operation.kind==='product')).toBe(true);
 });
 it('blocks conflicting observations of the same row without selecting a convenient amount',()=>{
  const f=fixture(),r=f.row(),copy={...structuredClone(r),component_id:randomUUID(),amount_raw:'101.00',amount:normalizeMoney('101.00')};f.e.additional_components.push(copy);
  const checks=f.run().checks;expect(checks).toHaveLength(1);expect(checks[0].calculation.state).toBe('blocked');expect(checks[0].calculation.input.operands.every(o=>o.state==='conflict')).toBe(true);
 });
 it.each(['blank quantity','XTS','wrong mapping','confidence','warning'] as const)('keeps %s row as explicit completion rather than success',kind=>{
  const f=fixture(),r=f.row();if(kind==='blank quantity'){r.quantity_raw=null;r.quantity=null;}if(kind==='XTS'&&r.rate)r.rate.currency='XTS';if(kind==='wrong mapping')r.quantity='3';if(kind==='confidence')r.confidence=.94;if(kind==='warning')r.warning_flags=['ocr_ambiguous'];
  expect(f.run().checks[0].calculation.state).toBe('blocked');expect(f.run().completions.customer_requests.length).toBeGreaterThan(0);
 });
 it('does not calculate an unknown row semantic or invent absent operands',()=>{
  const f=fixture();f.row('unknown');expect(f.run().checks).toHaveLength(0);
 });
});
describe('pension ratios need a supported base/component relationship',()=>{
 it('requests numbers only after their structural pension relationship exists, preserving the blocked source and gap otherwise',()=>{
  const f=fixture(),base=f.money('pension_base','5000.00',.94),amount=f.money('pension_employee_contribution','300.00',.94);
  const run=()=>runDocumentReview(f.build(undefined,{review_policy:PAYSLIP_REVIEW_POLICY}),'synthetic.relationship');
  const before=run(),original=canonicalSha256(f.e),deps=documentReviewReadingDependencies({review:before,document_id:f.d.document_id,extraction:f.e});
  expect(before.checks[0].calculation).toMatchObject({state:'blocked',input:{operation:{same_period_and_base:false}}});
  expect(before.coverage_gaps.some(g=>g.check_id.endsWith('.relationship'))).toBe(true);
  expect(before.input.completion_input).toMatchObject({needs:[]});expect(deps.scalar_fields).toEqual([]);expect(deps.scope_fields).toEqual([]);
  expect(canonicalSha256(f.e)).toBe(original);
  base.source.text_fragment=amount.source.text_fragment='pension base 5000.00; employee pension contribution 300.00';
  const related=run(),readyDeps=documentReviewReadingDependencies({review:related,document_id:f.d.document_id,extraction:f.e});
  expect(related.checks[0].calculation).toMatchObject({state:'blocked',input:{operation:{same_period_and_base:true}}});
  expect(related.completions.customer_requests).toHaveLength(2);expect(readyDeps.scalar_fields).toHaveLength(2);
  expect(related.coverage_gaps.some(g=>g.check_id.endsWith('.relationship'))).toBe(false);
 });
 it('blocks arbitrary normalized labels without a source relationship',()=>{
  const f=fixture();f.money('pension_base','5000.00');f.money('pension_employee_contribution','300.00');
  expect(f.run().checks[0].calculation.state).toBe('blocked');expect(f.run().coverage_gaps[0].check_id).toContain('relationship');
 });
 it('computes 6% only when the source explicitly connects the base and contribution',()=>{
  const f=fixture(),b=f.money('pension_base','5000.00'),c=f.money('pension_employee_contribution','300.00');
  b.source.text_fragment=c.source.text_fragment='pension base 5000.00; employee pension contribution 300.00';
  const r=f.run().checks[0].calculation;expect(r.state).toBe('calculated');expect(r.observed_ratio).toMatchObject({numerator:'3',denominator:'50'});expect(r.remittance_status).toBe('not_assessed');
 });
 it('refuses a study fund relabelled as pension',()=>{
  const f=fixture(),b=f.money('pension_base','5000.00'),c=f.money('pension_employee_contribution','300.00');b.source.text_fragment=c.source.text_fragment='pension base 5000.00 study fund 300.00';
  const op=(f.build().checks[0].calculation as DocumentReviewCalculationInput).operation;expect(op).toMatchObject({kind:'observed_ratio',same_period_and_base:false});
 });
});
