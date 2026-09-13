import {describe,it,expect} from 'vitest';
import {fixture,uuid} from './product-flow.fixture.ts';
import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {buildSyntheticCaseFixture} from '../../case-analysis/synthetic-fixtures.ts';
import {normalizeMoney} from '../../extraction/normalization.ts';
import {normalizedPayslipExtractionSchema} from '../../extraction/payslip.ts';
import {payslipMachineExtractionSha256} from '../../extraction/reading-resolution.ts';
import {reviewInputFromPayslips,PAYSLIP_REVIEW_POLICY} from '../../document-review/payslip-adapter.ts';
import {calculateDocumentReview,documentReviewCalculationInputSchema} from '../../document-review/calculations.ts';
import {resolveExplicitObligations,OBLIGATION_ASSESSMENTS} from './index.ts';
import {obligationsProductReview} from '../obligations-product.ts';
import {attachObligationPaymentLinks,createObligationPaymentLinkTarget,obligationPaymentOperands,obligationPaymentLinkTargets,parseObligationPaymentLinkReading,resolveObligationPaymentLinkReading} from './payment-link.ts';
import {documentEvidenceSourceTranscriptionTarget,resolveDocumentEvidenceSourceReading} from '../../extraction/document-evidence/source-transcription.ts';
import {obligationTextSha256} from './contracts.ts';

/** Source amount is read through the ordinary payroll adapter; no review
 * operand, finding or comparison is manufactured by this fixture. */
function setup(raw='450.00',identified=true,changeMachine?:(machine:ReturnType<typeof normalizedPayslipExtractionSchema.parse>)=>void){
 const f=fixture();f.identify();const initial=f.run(),review=initial.review,old=buildSyntheticCaseFixture({fixture_id:'synthetic-obligation-payment-payroll',mode:'real'});
 const id=uuid(600),caseId=review.case_id,period=review.period;
 const document={...old.stored.documents[0],case_id:caseId,document_id:id,storage_path:`cases/${caseId}/documents/${id}/original.pdf`,document_period:{start_date:period.from,end_date:period.to}};
 const source={document_id:id,page:1,text_fragment:'Synthetic bonus payment source row',source_scope:{period_kind:'current' as const,fund_kind:'unknown' as const,column_label:'Current amount'}};
 const row={component_id:uuid(601),source_label:'בונוס סינתטי',normalized_label:'synthetic.bonus',semantic_kind:'bonus',quantity_raw:'1',rate_raw:raw,percentage_raw:null,amount_raw:raw,
  quantity:'1',rate:normalizeMoney(raw),percentage:null,amount:normalizeMoney(raw),confidence:1,source,extraction_method:'fixture',warning_flags:[],normalization_warnings:[]};
 const p=old.stored.extractions[0].fields.find(p=>p.field==='salary_period')!;
 const machine=normalizedPayslipExtractionSchema.parse({...old.stored.extractions[0],document_id:id,extracted_at:'2026-07-02T00:00:00Z',
  fields:[{...p,source,raw_value:'06/2026',normalized_value:{year:2026,month:6,start_date:period.from,end_date:period.to}}],additional_components:[row],earnings_components_complete:false});
 changeMachine?.(machine);
 const extraction=normalizedPayslipExtractionSchema.parse({...machine,...(identified?{customer_row_readings:[{schema_version:'document-row-cell-reading-v1',actor_kind:'customer',case_id:caseId,document_id:id,
  component_id:row.component_id,cell:'amount',source_sha256:document.content_sha256,normalized_extraction_sha256:payslipMachineExtractionSha256(machine),original_component_sha256:canonicalSha256(machine.additional_components[0]),
  extraction_result_sha256:'d'.repeat(64),target_sha256:'e'.repeat(64),month:'2026-06',request_id:uuid(602),answer_revision:1,identity_id:uuid(603),confirmed_at:'2026-07-03T00:00:00Z'}]}:{})});
 const payroll=reviewInputFromPayslips({case_id:caseId,period,purchased_scope:review.purchased_scope,review_policy:PAYSLIP_REVIEW_POLICY,snapshot:{...old.stored,documents:[document],extractions:[extraction]}});
 const merged={...review,documents:[...review.documents,...payroll.documents],checks:[...payroll.checks]};
 const input={...initial.input,obligations:initial.input.obligations.map(o=>{const {product_facts,...original}=o;void product_facts;return {...original,assessments:Object.keys(OBLIGATION_ASSESSMENTS).map(decision_id=>({decision_id,state:'accepted' as const,basis:'ai_source_assessment' as const,explanation:'Explicitly synthetic source assessment for this arithmetic fixture',sources:[o.clause.source],valid_until:null}))};})};
 const targets=()=>obligationPaymentLinkTargets({review:merged,obligation:input.obligations[0],payrollSources:[{version_id:id,product_document_id:uuid(604),checkpoint_sha256:'d'.repeat(64),policy_version:'synthetic-payment-v1'}]});
 const reading=(action:unknown={action:'correct',value:{relationship:'same_obligation',basis:{page:1,locator:'Synthetic payment reference',text:'Synthetic explicit reference from this payment to the selected clause'}}},revision=1,requestId=uuid(605))=>{
  const target=targets()[0],r=resolveObligationPaymentLinkReading({target,currentTarget:target,caseId,requestId,answerRevision:revision,identityId:uuid(603),answeredAt:'2026-07-03T00:00:00Z',answer:action});
  if(r.state!=='current')throw Error('SYNTHETIC_PAYMENT_READING');return r.reading;
 };
 const admitted=()=>{const linked=attachObligationPaymentLinks(input,merged,[reading()]),o=linked.obligations[0];if(!o.recorded)throw Error('SYNTHETIC_PAYMENT_LINK');
  o.recorded.scope_assessment={decision_id:'obligation.recorded_scope',state:'accepted',basis:'ai_source_assessment',explanation:'Separately admitted synthetic payment scope; never inferred from the link answer',sources:[o.clause.source,o.recorded.amount.source],valid_until:null};return linked;};
 return {review:merged,input,targets,reading,admitted};
}
const calculations=(input:Parameters<typeof resolveExplicitObligations>[0])=>resolveExplicitObligations(input).checks.map(c=>calculateDocumentReview(c.calculation));
describe('ordinary obligation payment links',()=>{
 it('accepts only the exact current transcribed clause receipt, independently of the retained provider receipt',()=>{
  const f=setup(),o=f.input.obligations[0],review={...f.review,purchased_scope:{...f.review.purchased_scope,order_id:uuid(800)}};
  const d=review.documents.find(d=>d.kind==='contract')!,source={case_id:review.case_id,product_document_id:uuid(30),version_id:d.version_id,source_sha256:d.file_sha256,
   document_kind:'contract' as const,document_month:null,page_count:d.page_count!,reading_dependencies:[]};
  const target=documentEvidenceSourceTranscriptionTarget({source,purchase:review.purchased_scope,month:'2026-06',page:null});
  const text='המעסיק ישלם לעובד 500 ש״ח בכל חודש מיום 2026-01-01 ועד יום 2026-12-31.';
  const resolved=resolveDocumentEvidenceSourceReading({target,currentSource:source,currentPurchase:review.purchased_scope,caseId:review.case_id,month:'2026-06',requestId:uuid(801),answerRevision:1,identityId:uuid(802),answeredAt:'2026-07-03T00:00:00Z',
   answer:{schema_version:'document-evidence-source-answer-v2',action:'correct',value:{page:1,raw_value:text,locator:'Synthetic full clause'}}});
  if(resolved.state!=='current')throw Error('SYNTHETIC_CURRENT_TRANSCRIPTION');
  const current={...review,document_source_transcriptions:[resolved.reading]},obligation={...o,clause:{...o.clause,text,text_sha256:obligationTextSha256(text),source:{...o.clause.source,reading_receipt_sha256:resolved.reading.verification_sha256}}};
  const pairs=(r:typeof current= current)=>obligationPaymentLinkTargets({review:r,obligation,payrollSources:[{version_id:uuid(600),product_document_id:uuid(604),checkpoint_sha256:'d'.repeat(64),policy_version:'synthetic-payment-v1'}]});
  expect(pairs()).toHaveLength(1);expect(d.reading_sha256).not.toBe(resolved.reading.verification_sha256);
  expect(()=>pairs({...current,document_source_transcriptions:[]})).toThrow('OBLIGATION_PAYMENT_CLAUSE_SCOPE');
  expect(()=>pairs({...current,documents:current.documents.map(x=>x.kind==='contract'?{...x,accepted_reading_sha256:[resolved.reading.verification_sha256]}:x),document_source_transcriptions:[]})).toThrow('OBLIGATION_PAYMENT_CLAUSE_SCOPE');
  expect(()=>pairs({...current,purchased_scope:{...current.purchased_scope,receipt_sha256:'9'.repeat(64)}})).toThrow('OBLIGATION_PAYMENT_CLAUSE_SCOPE');
  const oldText=obligation.clause.text_sha256;obligation.clause.text_sha256='8'.repeat(64);expect(()=>pairs()).toThrow('OBLIGATION_PAYMENT_CLAUSE_SCOPE');obligation.clause.text_sha256=oldText;
 });
 it('selects an identified ordinary payroll amount and does not authorize allocation from its link',()=>{
  const f=setup(),before=canonicalSha256(f.input),linked=attachObligationPaymentLinks(f.input,f.review,[f.reading()]);
  expect(f.targets()).toHaveLength(1);expect(linked.obligations[0].recorded).toMatchObject({amount:{printed_value:'450.00'},scope_assessment:{state:'missing'}});
  const values=calculations(linked);expect(values[0]).toMatchObject({state:'calculated',expected:{minor_units:50000}});expect(values[1].state).toBe('blocked');
  expect(canonicalSha256(f.input)).toBe(before);
 });
 it.each([['450.00',5000],['500.00',0],['550.00',-5000]] as const)('compares %s only with separately admitted exact source scope', (raw,difference)=>{
  const f=setup(raw),linked=attachObligationPaymentLinks(f.admitted(),f.review,[f.reading()]),values=calculations(linked);
  expect(values[1]).toMatchObject({state:'calculated',expected:{minor_units:50000},recorded:{minor_units:Number(raw)*100},difference:{minor_units:difference}});
 });
 it.each(['unknown','unreadable'] as const)('keeps independent expected after %s replaces the link',action=>{
  const f=setup(),linked=attachObligationPaymentLinks(f.admitted(),f.review,[f.reading(),f.reading({action},2)]);
  expect(linked.obligations[0].recorded).toBeNull();expect(calculations(linked)).toHaveLength(1);expect(calculations(linked)[0].state).toBe('calculated');
 });
 it('uses an ordinary observed provider amount without relabeling its provenance or approving allocation',()=>{
  const f=setup('450.00',false),amounts=obligationPaymentOperands(f.review),target=f.targets()[0];
  expect(amounts).toHaveLength(1);expect(amounts[0]).toMatchObject({state:'observed',printed_value:'450.00',source:{reading:'provider_extraction'}});
  expect(target.amount).toEqual(amounts[0]);expect(target.clause.source.reading).toBe('identified_document_reading');
  const linked=attachObligationPaymentLinks(f.input,f.review,[f.reading()]);
  expect(linked.obligations[0].recorded).toMatchObject({amount:{source:amounts[0].source},scope_assessment:{state:'missing'}});
  expect(calculations(linked)[0]).toMatchObject({state:'calculated',expected:{minor_units:50000}});expect(calculations(linked)[1].state).toBe('blocked');
 });
 it.each(['unknown','conflict','unreadable'] as const)('does not promote an ordinary provider amount in state %s',state=>{
  const f=setup('450.00',false,machine=>{
   const row=machine.additional_components[0];
   if(state==='unknown')row.confidence=.94;
   if(state==='unreadable')row.amount=normalizeMoney('440.00');
   if(state==='conflict')machine.additional_components.push({...row,component_id:uuid(607),amount_raw:'440.00',amount:normalizeMoney('440.00')});
  });
  const amounts=f.review.checks.flatMap(check=>{const c=documentReviewCalculationInputSchema.safeParse(check.calculation);return c.success?c.data.operands.filter(a=>a.observation_id===`${uuid(601)}:amount`):[];});
  expect(amounts.length).toBeGreaterThan(0);expect(amounts.every(a=>a.state===state&&a.source.reading==='provider_extraction')).toBe(true);
  expect(obligationPaymentOperands(f.review)).toEqual([]);expect(f.targets()).toEqual([]);
 });
 it('rejects stale source, clause, month and forged history',()=>{
  const f=setup(),r=f.reading();expect(()=>parseObligationPaymentLinkReading({...r,answer_revision:2})).toThrow('OBLIGATION_PAYMENT_READING_REPLAY');
  const changed={...f.review,documents:f.review.documents.map(d=>d.kind==='payslip'?{...d,reading_sha256:'f'.repeat(64)}:d)};
  expect(attachObligationPaymentLinks(f.admitted(),changed,[r]).obligations[0].recorded).toBeNull();
  const target=r.target,{target_sha256,...body}=target;expect(target_sha256).toMatch(/^[a-f0-9]{64}$/u);
  const currentBody={...body,checkpoint_sha256:'f'.repeat(64)};
  expect(resolveObligationPaymentLinkReading({target,currentTarget:{...currentBody,target_sha256:canonicalSha256(currentBody)},caseId:f.review.case_id,requestId:r.request_id,answerRevision:1,identityId:r.identity_id,answeredAt:r.answered_at,answer:r.answer}).state).toBe('stale');
 });
 it('does not reuse a source allocation assessment that cites another payment',()=>{
  const f=setup(),input=f.admitted();input.obligations[0].recorded!.scope_assessment.sources=[input.obligations[0].clause.source];
  expect(attachObligationPaymentLinks(input,f.review,[f.reading()]).obligations[0].recorded!.scope_assessment.state).toBe('missing');
 });
 it('does not reuse an accepted allocation for a different period',()=>{
  const f=setup(),input=f.admitted();input.obligations[0].recorded!.payment_period={from:'2026-05-01',to:'2026-05-31'};
  expect(attachObligationPaymentLinks(input,f.review,[f.reading()]).obligations[0].recorded!.scope_assessment.state).toBe('missing');
 });
 it('invalidates a prior link after an ordinary payment-cell correction while keeping the promise',()=>{
  const before=setup('450.00'),after=setup('440.00'),old=before.reading();
  const stale=attachObligationPaymentLinks(before.admitted(),after.review,[old]);
  expect(stale.obligations[0].recorded).toBeNull();expect(calculations(stale)[0]).toMatchObject({state:'calculated',expected:{minor_units:50000}});
  const linked=attachObligationPaymentLinks(before.admitted(),after.review,[after.reading()]);
  expect(linked.obligations[0].recorded).toMatchObject({amount:{printed_value:'440.00'},scope_assessment:{state:'missing'}});
 });
 it('retains both expected amounts but rejects the same payment linked to two different clauses',()=>{
  const f=setup(),first=f.input.obligations[0],second=structuredClone(first);
  second.obligation_id='synthetic.second';second.clause.source.locator='Synthetic second source clause';
  if(second.promise.kind==='fixed'&&second.promise.amount)second.promise.amount.source=second.clause.source;
  second.assessments=second.assessments.map(a=>({...a,sources:[second.clause.source]}));
  const input={...f.input,obligations:[first,second]},r=f.reading(),t=r.target;
  const target=createObligationPaymentLinkTarget({review:f.review,obligation:second,observationId:t.amount.observation_id,versionId:t.version_id,productDocumentId:t.product_document_id,checkpointSha256:t.checkpoint_sha256,policyVersion:t.policy_version});
  const next=resolveObligationPaymentLinkReading({target,currentTarget:target,caseId:f.review.case_id,requestId:uuid(606),answerRevision:1,identityId:r.identity_id,answeredAt:r.answered_at,answer:r.answer});
  if(next.state!=='current')throw Error('SYNTHETIC_SECOND_PAYMENT_LINK');
  const linked=attachObligationPaymentLinks(input,f.review,[r,next.reading]),resolved=resolveExplicitObligations(linked);
  expect(resolved.checks).toHaveLength(2);expect(resolved.gaps.filter(g=>g.dependency_id==='obligation.payment_duplicate')).toHaveLength(2);
  for(const calculation of calculations(linked))expect(calculation).toMatchObject({state:'calculated',expected:{minor_units:50000}});
 });
 it('exposes the missing source-scope dependency through the ordinary branch',()=>{
  const f=setup(),review={...f.review,obligation_payment_link_readings:[f.reading()]},r=obligationsProductReview(review,f.input);
  expect(r.needs.find(n=>n.question.includes('השיוך'))?.kind).toBe('legal');expect(r.checks).toHaveLength(2);
 });
 it('retains different-obligation history without a comparison',()=>{
  const f=setup(),r=f.reading({action:'correct',value:{relationship:'different_obligation',basis:{page:1,locator:'Synthetic other clause',text:'Payment identifies a different clause'}}});
  expect(attachObligationPaymentLinks(f.input,f.review,[r]).obligations[0].recorded).toBeNull();
 });
});
