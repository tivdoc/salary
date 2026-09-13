import {beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
const mocks=vi.hoisted(()=>({lock:vi.fn(),load:vi.fn(),current:vi.fn(),orders:vi.fn(),review:vi.fn()}));
vi.mock('../processing/saved-real-ai-service-configuration',()=>({loadSavedRealAiServiceConfiguration:mocks.load,assertSavedRealAiServiceCurrent:mocks.current}));
vi.mock('../processing/source-dispatch',async original=>({...await original<typeof import('../processing/source-dispatch')>(),lockCurrentSource:mocks.lock}));
vi.mock('../processing/saved-order-scope',async original=>({...await original<typeof import('../processing/saved-order-scope')>(),readSavedOrders:mocks.orders}));
vi.mock('../processing/document-review-key',async original=>({...await original<typeof import('../processing/document-review-key')>(),resolveSavedDocumentReviewKey:mocks.review}));
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {nineTopicRuntimeSource,runtimeFixture} from '@/engine/ai-release-runtime/runtime.fixture';
import {runAiReleaseRuntime,type AiReleaseRuntimeResult} from '@/engine/ai-release-runtime/runtime';
import {documentReviewInputSchema,type DocumentReviewInput} from '@/engine/document-review/contracts';
import {travelEntitlementInputSchema} from '@/engine/entitlement-review/travel';
import {minimumWageEntitlementInputSchema} from '@/engine/entitlement-review/minimum-wage';
import {workingTimeEntitlementInputSchema} from '@/engine/entitlement-review/working-time';
import {convalescenceEntitlementInputSchema} from '@/engine/entitlement-review/convalescence';
import {vacationEntitlementInputSchema} from '@/engine/entitlement-review/vacation';
import {createCaseAnalysisAiRelease,CASE_ANALYSIS_AI_RELEASE_CODE_VERSION} from '@/engine/case-analysis/contracts';
import type {AnalysisResultBundle,CaseAnalysisCommand} from '@/engine/wave3/contracts';
import {encodeReport} from '@/server/platform/persistence/postgres/analysis/validation';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {renderAiReleaseBundle,AI_RELEASE_REPORT_TEMPLATE} from '../reports/ai-release-report';
import {savedOrderSchema} from '../processing/saved-order-scope';
import type {SourceJob} from '../processing/source-dispatch';
import {priceSavedBasis,priceSavedReleaseBasis,createReleasePriceQuote,RELEASE_PRICING_BASIS_VERSION} from './pricing';
import {RELEASE_PURCHASE_TOPICS} from './purchase-topics';
import {obligationsEntitlementInputSchema,obligationTextSha256} from '@/engine/entitlement-review/obligations/contracts';
import {createSavedReleasePricingBasisReader,mapSavedReleasePricingBasis} from './saved-release-pricing-basis';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const hash=canonicalSha256({private_synthetic_pricing_test:true});
function source(topics:DocumentReviewInput['purchased_scope']['topics']=['minimum_wage']){
 const raw=nineTopicRuntimeSource(),replacements=new Map(raw.documents.map((d,i)=>[d.version_id,id(100+i)]));
 const result=documentReviewInputSchema.parse(JSON.parse(JSON.stringify(raw,(_key,v)=>typeof v==='string'?(replacements.get(v)??v):v)));
 result.purchased_scope={...result.purchased_scope,topics,order_id:id(2),origin:'saved_order'};
 const evidence=result.entitlement_evidence!;evidence.order_id=id(2);
 for(const key of ['pension','working_time','travel','minimum_wage','vacation','convalescence','obligations'] as const){
  if(key==='obligations'? !topics.some(t=>t==='bonuses'||t==='contract'):key==='working_time'? !topics.some(t=>t==='working_time'||t==='rest_day'):!topics.includes(key))delete evidence[key];
 }
 if(evidence.obligations){const o=obligationsEntitlementInputSchema.parse(evidence.obligations);o.purchased_topics=topics.filter((t):t is 'contract'|'bonuses'=>t==='contract'||t==='bonuses');evidence.obligations=o;}
 if(evidence.minimum_wage){const m=minimumWageEntitlementInputSchema.parse(evidence.minimum_wage);m.components[0].amount.printed_value='3000.00';evidence.minimum_wage=m;}
 if(evidence.working_time){
  const w=workingTimeEntitlementInputSchema.array().parse(evidence.working_time)[0];w.calculation_policy='working-time-separated-expected-v2';
  if(!topics.includes('rest_day')){const rest=w.workdays[6];rest.inventory.value='no_work';rest.intervals=[];rest.recorded_pay=null;}evidence.working_time=[w];
 }
 return result;
}
function findingRows(r:AiReleaseRuntimeResult){return r.findings.map((f,i)=>({id:id(200+i),finding_receipt_sha256:f.sha256,calculation_payload:f,
 source_fact_references:{schema_version:'ai-release-fact-references-v1' as const,canonical_facts_snapshot_sha256:r.current_scope.facts_sha256,
  source_input_sha256:r.current_scope.input_sha256,parameter_manifest_sha256:f.family_parameter_manifest_sha256!,source_operands:f.source_operands}}));}
function mapped(s=source()){
 const r=runAiReleaseRuntime(runtimeFixture(s)),input={result:r,identityId:id(1),analysisVersion:r.analysis_run_id,factsSha256:r.current_scope.facts_sha256,findings:findingRows(r)};
 let reason:string|undefined;const basis=mapSavedReleasePricingBasis({...input,onUnavailable:value=>{reason=value;}});
 return {r,input,basis,reason};
}
function withLeavePay(s=source(['vacation']),mode:'hourly_quarter'|'monthly_maintained_wage'='hourly_quarter'){
 const v=vacationEntitlementInputSchema.parse(s.entitlement_evidence!.vacation),original=v.seniority_year!;
 const money=(name:string,value:string)=>({...original,id:name,observation_id:name,printed_value:value,representation:'money_ils' as const,quantity_unit:null,
  source:{...original.source,locator:name}});
 const common={leave_period:{from:'2026-06-01',to:'2026-06-05'},wage:money('vacation.wage',mode==='hourly_quarter'?'9000.00':'500.00'),recorded:money('vacation.paid','100.00')};
 v.leave_pay=mode==='hourly_quarter'?{mode,...common,quarter_period:{from:'2026-03-01',to:'2026-05-31'},
  leave_calendar_days:{...original,id:'vacation.days',observation_id:'vacation.days',printed_value:'5',quantity_unit:'calendar_days'}}:{mode,...common};
 s.entitlement_evidence!.vacation=v;return s;
}

describe('v1.1 supported comparison pricing, separate from legal debt',()=>{
 it('prices an exact 540 ILS minimum-wage comparison at the existing 99 ILS tier',()=>{
  const f=mapped();expect(f.basis).toMatchObject({checked_months:['2026-06'],checked_topics:['minimum_wage'],components:[{economic_key:'ordinary_wage',amount:54000,direction:'employer_owes'}]});
  expect(priceSavedBasis(f.basis)).toMatchObject({state:'eligible',basis_minor:54000,total_minor:9900});
  expect(f.r).toMatchObject({verified_debt:false,legal_debt_total:null,combined_amount:null,actual_transfer_proven:false});
  expect(f.basis?.components[0].evidence_ids).toEqual([source().documents.find(d=>d.document_id==='synthetic.payslip')!.version_id]);
 });
 it('counts a travel expected/comparison twin only once and leaves below-threshold pricing explicit',()=>{
  const f=mapped(source(['travel']));expect(f.basis?.components).toHaveLength(1);expect(f.basis?.components[0].amount).toBe(1000);
  expect(priceSavedBasis(f.basis)).toEqual({state:'no_upgrade',basis_minor:1000,reason:'below_threshold'});
 });
 it('adds separately classified wage and travel rows, preserving actual checked coverage',()=>{
  const f=mapped(source(['minimum_wage','travel']));expect(f.basis?.components).toHaveLength(2);
  expect(priceSavedBasis(f.basis)).toMatchObject({state:'eligible',basis_minor:55000});
 });
 it.each([null,'unknown','conflict','unreadable'] as const)('never turns missing or %s recorded travel into zero',state=>{
  const s=source(['travel']),t=travelEntitlementInputSchema.parse(s.entitlement_evidence!.travel);
  if(state===null)t.recorded=null;else t.recorded!.state=state;s.entitlement_evidence!.travel=t;
  expect(mapped(s).basis).toBeNull();
 });
 it('keeps expected-only pension deposits out of the commercial basis',()=>{expect(mapped(source(['pension'])).basis).toBeNull();});
 it('keeps missing contract payment coverage explicit instead of silently shrinking it',()=>{expect(mapped(source(['minimum_wage','contract'])).basis).toBeNull();});
 it('does not resolve a negative comparison as a credit or offset',()=>{
  const s=source(['travel']),t=travelEntitlementInputSchema.parse(s.entitlement_evidence!.travel);t.recorded!.printed_value='250.00';s.entitlement_evidence!.travel=t;
  expect(mapped(s).basis).toBeNull();
 });
 it('allows a true zero comparison without inferring a missing payment',()=>{
  const s=source(['travel']),t=travelEntitlementInputSchema.parse(s.entitlement_evidence!.travel);t.recorded!.printed_value='200.00';s.entitlement_evidence!.travel=t;
  expect(mapped(s).basis?.components[0]).toMatchObject({amount:0,direction:'none'});
 });
 it('rejects reused physical payment source even when check and observation IDs differ',()=>{
  const s=source(['minimum_wage','travel']),t=travelEntitlementInputSchema.parse(s.entitlement_evidence!.travel),m=minimumWageEntitlementInputSchema.parse(s.entitlement_evidence!.minimum_wage);
  t.recorded!.source=m.components[0].amount.source;t.source_manifest.push(...m.source_manifest);s.entitlement_evidence!.travel=t;
  expect(mapped(s).basis).toBeNull();
 });
 it('refuses a conditional assessment without promoting its exact arithmetic',()=>{
  const s=source(['travel']),t=travelEntitlementInputSchema.parse(s.entitlement_evidence!.travel);
  const decision=t.applicability.find(d=>d.decision_id==='travel.general_coverage')!;
  decision.state='unknown';t.conditional_assumptions=[{decision_id:'travel.general_coverage',explanation:'Synthetic unresolved applicability'}];s.entitlement_evidence!.travel=t;
  expect(mapped(s).basis).toBeNull();
 });
 it('rejects changed persisted finding amount, source-facts pin and duplicate receipts',()=>{
  const f=mapped(),row=f.input.findings[0];
  expect(()=>mapSavedReleasePricingBasis({...f.input,findings:[{...row,calculation_payload:{...row.calculation_payload,verified_debt:true}}]})).toThrow('PRICING_FINDING_RECEIPT_MISMATCH');
  expect(()=>mapSavedReleasePricingBasis({...f.input,factsSha256:hash})).toThrow('PRICING_FINDING_RECEIPT_MISMATCH');
  expect(()=>mapSavedReleasePricingBasis({...f.input,findings:[row,row]})).toThrow('PRICING_FINDING_SET_MISMATCH');
 });
 it('requires an executor-issued result, not a copied JSON claim',()=>{
  const f=mapped();expect(()=>mapSavedReleasePricingBasis({...f.input,result:structuredClone(f.r)})).toThrow('AI_RUNTIME_FACTORY_RESULT_REQUIRED');
 });
 it('prices each actual full workday once, including daily/weekly allocation without adding expected twins',()=>{
  const f=mapped(source(['working_time']));expect(f.basis?.components).toHaveLength(6);
  expect(f.basis?.components.map(c=>c.economic_key)).toEqual(['07','08','09','10','11','12'].map(day=>`workday:2026-06-${day}`));
  // Independent oracle: 58 worked hours at 40 ILS = 2320 recorded. The source
  // week has 42 ordinary + 12 at125% + 4 at150% = 2520 expected; gap 200 ILS.
  expect(priceSavedBasis(f.basis)).toEqual({state:'no_upgrade',basis_minor:20000,reason:'below_threshold'});
  expect(f.r.findings.filter(c=>c.topic==='working_time')).toHaveLength(12);
 });
 it('uses a source-supported workday gap with a true zero monthly minimum-wage comparison',()=>{
  const s=source(['minimum_wage','working_time']),m=minimumWageEntitlementInputSchema.parse(s.entitlement_evidence!.minimum_wage),w=workingTimeEntitlementInputSchema.array().parse(s.entitlement_evidence!.working_time)[0];
  m.components[0].amount.printed_value='3540.00';w.workdays[0].recorded_pay!.printed_value='0.00';s.entitlement_evidence!.minimum_wage=m;s.entitlement_evidence!.working_time=[w];
  const f=mapped(s);expect(f.basis?.checked_topics).toEqual(['minimum_wage','working_time']);expect(priceSavedBasis(f.basis)).toMatchObject({state:'eligible',basis_minor:60000,total_minor:9900});
  expect(f.r.verified_debt).toBe(false);
 });
 it('does not add positive minimum-wage and workday gaps without a cross-topic economic allocation',()=>{
  const f=mapped(source(['minimum_wage','working_time']));expect(f.basis).toBeNull();expect(f.reason).toBe('pricing_cross_topic_allocation_unavailable');
 });
 it('preserves exact zero workday comparisons',()=>{
  const s=source(['working_time']),w=workingTimeEntitlementInputSchema.array().parse(s.entitlement_evidence!.working_time)[0];
  for(const day of w.workdays.slice(0,6))day.recorded_pay!.printed_value='420.00';
  s.entitlement_evidence!.working_time=[w];const f=mapped(s);expect(f.basis?.components.every(c=>c.amount===0&&c.direction==='none')).toBe(true);
  expect(priceSavedBasis(f.basis)).toMatchObject({state:'no_upgrade',basis_minor:0});
 });
 it('uses actual payroll hours×rate allocations while permitting a common rate across distinct days',()=>{
  const s=source(['working_time']),w=workingTimeEntitlementInputSchema.array().parse(s.entitlement_evidence!.working_time)[0];
  for(const day of w.workdays.filter(d=>d.recorded_pay)){
   const original=day.recorded_pay!;day.recorded_pay=null;
   day.payroll_allocations=[{id:'allocation.'+day.id,hours:{...day.intervals[0].printed_duration,id:'paid.hours.'+day.id,observation_id:'paid.hours.'+day.id,source:{...original.source,locator:'paid.hours.'+day.id}},hourly_rate:w.regular_hourly_wage,percentage:null}];
  }
  s.entitlement_evidence!.working_time=[w];expect(priceSavedBasis(mapped(s).basis)).toMatchObject({state:'no_upgrade',basis_minor:20000});
 });
 it('refuses duplicate source payments or alternative checks for the same workday',()=>{
  const s=source(['working_time']),w=workingTimeEntitlementInputSchema.array().parse(s.entitlement_evidence!.working_time)[0];
  w.workdays[1].recorded_pay=structuredClone(w.workdays[0].recorded_pay);s.entitlement_evidence!.working_time=[w];expect(mapped(s).basis).toBeNull();
  const alternative=source(['working_time']),one=workingTimeEntitlementInputSchema.array().parse(alternative.entitlement_evidence!.working_time)[0];
  const two=structuredClone(one);two.check_id_prefix='working.alternative';alternative.entitlement_evidence!.working_time=[one,two];
  const f=mapped(alternative);expect(f.basis).toBeNull();expect(f.reason).toBe('pricing_comparison_alternatives');
 });
 it('distinguishes conditional workday calculations from unsupported software branches',()=>{
  const s=source(['working_time']),w=workingTimeEntitlementInputSchema.array().parse(s.entitlement_evidence!.working_time)[0];
  w.applicability.find(d=>d.decision_id==='wt.regular_wage')!.state='unknown';w.conditional_assumptions=[{decision_id:'wt.regular_wage',explanation:'Synthetic unresolved regular wage scope'}];s.entitlement_evidence!.working_time=[w];
  const f=mapped(s);expect(f.basis).toBeNull();expect(f.reason).toBe('pricing_comparison_conditional');
 });
 it('does not add unpurchased rest-day compensation or hide incomplete payment allocation',()=>{
  const ordinary=mapped(source(['working_time']));expect(ordinary.basis?.checked_topics).toEqual(['working_time']);
  const s=source(['working_time']),w=workingTimeEntitlementInputSchema.array().parse(s.entitlement_evidence!.working_time)[0];w.workdays[0].recorded_pay=null;w.workdays[0].payment_allocation={state:'missing',source:null,value:null};s.entitlement_evidence!.working_time=[w];
  const missing=mapped(s);expect(missing.basis).toBeNull();expect(missing.reason).toBe('pricing_comparison_incomplete');
 });
 it('prices only the due convalescence comparison, once for the identified accrual coverage',()=>{
  const f=mapped(source(['convalescence']));
  // First completed year: 5 days ×451.50 ILS ×half-time =1128.75;
  // the complete source-allocated payment is1000 ILS, leaving128.75.
  expect(f.basis).toMatchObject({checked_months:['2026-06'],checked_topics:['convalescence'],components:[{economic_key:'convalescence_payment',amount:12875}]});
  expect(f.basis?.components).toHaveLength(1);expect(f.r.findings).toHaveLength(2);
  expect(priceSavedBasis(f.basis)).toEqual({state:'no_upgrade',basis_minor:12875,reason:'below_threshold'});
 });
 it('preserves a genuine zero convalescence comparison',()=>{
  const s=source(['convalescence']),c=convalescenceEntitlementInputSchema.parse(s.entitlement_evidence!.convalescence);
  c.recorded!.printed_value='1128.75';s.entitlement_evidence!.convalescence=c;
  expect(mapped(s).basis?.components[0]).toMatchObject({amount:0,direction:'none'});
 });
 it.each(['missing_payment','partial_inventory','other_coverage','due_unknown','due_other_month'] as const)('refuses convalescence %s without treating accrual as cash',missing=>{
  // A separate valid travel branch keeps this runtime fixture's legal receipt
  // present even when the convalescence due-date guard emits no calculation.
  const s=source(['convalescence','travel']),c=convalescenceEntitlementInputSchema.parse(s.entitlement_evidence!.convalescence);
  if(missing==='missing_payment')c.recorded=null;
  if(missing==='partial_inventory')c.recorded_inventory.value='partial';
  if(missing==='other_coverage')c.recorded_coverage.value={from:'2026-01-01',to:'2026-05-31'};
  if(missing==='due_unknown')c.due_date.state='unknown';
  if(missing==='due_other_month')c.due_date.value='2026-07-01';
  s.entitlement_evidence!.convalescence=c;const f=mapped(s);
  expect(f.basis).toBeNull();expect(f.reason).toBe('pricing_comparison_incomplete');
 });
 it.each(['hourly_quarter','monthly_maintained_wage'] as const)('prices actual %s leave pay without cashing annual calendar days',mode=>{
  const f=mapped(withLeavePay(undefined,mode));
  // Hourly: 9000×5/90=500 ILS. Monthly: explicitly scoped500 ILS.
  // Both subtract an identified100 ILS payment; annual quota16/prorated6
  // calendar days remain checked outputs and add no commercial amount.
  expect(f.basis?.components).toHaveLength(1);expect(f.basis?.components[0]).toMatchObject({economic_key:'vacation_payment',amount:40000});
  expect(f.r.checks.filter(c=>c.topic==='vacation'&&c.expected?.kind==='integer')).toHaveLength(2);
  expect(priceSavedBasis(f.basis)).toEqual({state:'no_upgrade',basis_minor:40000,reason:'below_threshold'});
  expect(f.r).toMatchObject({verified_debt:false,legal_debt_total:null,combined_amount:null});
 });
 it('does not price vacation day entitlement without actual leave pay',()=>{
  const f=mapped(source(['vacation']));expect(f.basis).toBeNull();expect(f.reason).toBe('pricing_comparison_incomplete');
 });
 it.each(['recorded','annual_basis'] as const)('does not skip unresolved vacation %s while pricing known pay',field=>{
  const s=withLeavePay(),v=vacationEntitlementInputSchema.parse(s.entitlement_evidence!.vacation);
  if(field==='recorded')v.leave_pay!.recorded=null;else v.annual_basis=null;s.entitlement_evidence!.vacation=v;
  const f=mapped(s);expect(f.basis).toBeNull();expect(f.reason).toBe('pricing_comparison_incomplete');
 });
 it('keeps an exact zero leave-pay comparison and refuses overpayment offsets',()=>{
  const s=withLeavePay(),v=vacationEntitlementInputSchema.parse(s.entitlement_evidence!.vacation);
  v.leave_pay!.recorded!.printed_value='500.00';s.entitlement_evidence!.vacation=v;
  expect(mapped(s).basis?.components[0]).toMatchObject({amount:0,direction:'none'});
  const negative=withLeavePay(),pay=vacationEntitlementInputSchema.parse(negative.entitlement_evidence!.vacation);
  pay.leave_pay!.recorded!.printed_value='501.00';negative.entitlement_evidence!.vacation=pay;expect(mapped(negative).basis).toBeNull();
 });
 it.each(['convalescence','vacation'] as const)('does not promote conditional %s arithmetic or forged receipt provenance',topic=>{
  const s=topic==='vacation'?withLeavePay():source([topic]);
  const packet=topic==='vacation'?vacationEntitlementInputSchema.parse(s.entitlement_evidence!.vacation):convalescenceEntitlementInputSchema.parse(s.entitlement_evidence!.convalescence);
  const decision=packet.applicability[0];decision.state='unknown';
  packet.conditional_assumptions=[{decision_id:decision.decision_id,explanation:'Synthetic unresolved applicability'}];s.entitlement_evidence![topic]=packet;
  expect(mapped(s).basis).toBeNull();
  const f=mapped(topic==='vacation'?withLeavePay():source([topic])),rows=structuredClone(f.input.findings);
  rows[0].source_fact_references.source_input_sha256=hash;
  expect(()=>mapSavedReleasePricingBasis({...f.input,findings:rows})).toThrow('PRICING_FINDING_RECEIPT_MISMATCH');
  expect(()=>mapSavedReleasePricingBasis({...f.input,result:structuredClone(f.r)})).toThrow('AI_RUNTIME_FACTORY_RESULT_REQUIRED');
 });
 it.each(['minimum_wage','working_time'] as const)('refuses positive leave pay plus %s without an economic allocation',topic=>{
  const f=mapped(withLeavePay(source([topic,'vacation'])));
  expect(f.basis).toBeNull();expect(f.reason).toBe('pricing_cross_topic_allocation_unavailable');
 });
 it('combines separately allocated convalescence and leave payments but rejects reuse of their physical source',()=>{
  const s=withLeavePay(source(['convalescence','vacation'])),f=mapped(s);
  expect(f.basis?.checked_topics).toEqual(['convalescence','vacation']);
  expect(priceSavedBasis(f.basis)).toMatchObject({state:'eligible',basis_minor:52875,total_minor:9900});
  const c=convalescenceEntitlementInputSchema.parse(s.entitlement_evidence!.convalescence),v=vacationEntitlementInputSchema.parse(s.entitlement_evidence!.vacation);
  v.leave_pay!.recorded!.source={...v.leave_pay!.recorded!.source,locator:c.recorded!.source.locator};
  s.entitlement_evidence!.vacation=v;const overlap=mapped(s);
  expect(overlap.basis).toBeNull();expect(overlap.reason).toBe('pricing_payment_source_overlap');
 });
});

function seam(){
 const s=source(),runtime=runtimeFixture(s),scope=runtime.assessment_input.current.scope;
 const envelope=createCaseAnalysisAiRelease(runtime,{engine_case_revision:7,source_journal:{case_id:s.case_id,input_revision:scope.input_revision,input_sha256:scope.input_sha256}});
 const body:Omit<AnalysisResultBundle,'result_sha256'>={schema_version:'tivdoc-analysis-result-bundle-v0.6.0',analysis_run_id:runtime.analysis_run_id,case_id:s.case_id,case_revision:7,
  period:{start_date:s.period.from,end_date:s.period.to},as_of:'2026-09-12',document_snapshot_sha256:hash,extraction_snapshot_sha256:hash,declared_fact_snapshot_sha256:hash,
  facts_snapshot_sha256:scope.facts_sha256,facts:[],rule_inputs:[],catalog_sha256:hash,known_subtotal:null,coverage_complete:false,
  topic_results:[{topic:'minimum_wage',status:'blocked_missing_facts',blockers:['synthetic outer catalog'],rule_input_sha256:null,amount:null,trace:null,legal_readiness:null}],document_review:envelope.result.review,ai_release:envelope};
 const bundle={...body,result_sha256:canonicalSha256(body)},report=renderAiReleaseBundle(bundle,id(3)),key='synthetic-current-pricing-review';
 const command:CaseAnalysisCommand={case_id:s.case_id,case_revision:7,document_review_sha256:canonicalSha256(s),document_snapshot_id:id(4),document_snapshot_sha256:hash,
  extraction_snapshot_id:id(5),extraction_snapshot_sha256:hash,declared_fact_snapshot_id:id(6),declared_fact_snapshot_sha256:hash,
  period:body.period,as_of:body.as_of,requested_topics:['minimum_wage'],sector:'synthetic',population:scope.population,mode:'real',idempotency_key:key};
 const job:SourceJob={schema_version:'saved-case-work-v1',case_id:s.case_id,revision:scope.input_revision,input_sha256:scope.input_sha256,mode:'draft',processing_profile:'qualified_ai_v1',authority_dependency_sha256:scope.authority_dependency_sha256};
 const order=savedOrderSchema.parse({id:id(2),kind:'initial',from:'2026-06-01',to:'2026-06-01',topics:['minimum_wage'],offer_sha256:s.purchased_scope.receipt_sha256});
 const row={analysis_run_id:bundle.analysis_run_id,command,command_sha256:canonicalSha256(command),result_sha256:bundle.result_sha256,report_sha256:report.report_sha256,
  artifacts:encodeReport(report),findings:findingRows(envelope.result),completion:{bundle,report:encodeReport(report),dependencies:{code_version:CASE_ANALYSIS_AI_RELEASE_CODE_VERSION,template_version:AI_RELEASE_REPORT_TEMPLATE}}};
 mocks.lock.mockResolvedValue(undefined);mocks.load.mockResolvedValue({identity_id:id(1),profile_sha256:hash});mocks.current.mockImplementation(value=>value);
 mocks.orders.mockResolvedValue([order]);mocks.review.mockResolvedValue({key,review:s,reviewSha256:canonicalSha256(s)});
 const query=vi.fn(async()=>({row_count:1,rows:[row]})),context:PostgresTransactionContext={client:{query},transaction_id:'synthetic-pricing-only'};
 return {job,row,query,context,order,bundle,run:()=>createSavedReleasePricingBasisReader(job)(context,{caseId:job.case_id,identityId:id(1),inputSha256:job.input_sha256})};
}
describe('current authenticated worker pricing reader',()=>{
 beforeEach(()=>vi.clearAllMocks());
 it('binds the completed current run, report bytes, purchase and stored findings',async()=>{
  const f=seam();expect(await f.run()).toMatchObject({components:[{amount:54000}]});
  expect(mocks.load).toHaveBeenCalledWith(f.context,f.job);expect(mocks.current).toHaveBeenCalledOnce();
  const q=f.query.mock.calls[0];expect(q).toBeDefined();
 });
 it('fails closed on current source or REAL enrollment failure before reading any results',async()=>{
  const f=seam();mocks.lock.mockRejectedValueOnce(Error('ANALYSIS_INPUT_SUPERSEDED'));await expect(f.run()).rejects.toThrow('ANALYSIS_INPUT_SUPERSEDED');expect(f.query).not.toHaveBeenCalled();
  mocks.load.mockRejectedValueOnce(Error('REAL_SERVICE_PROCESSING_REVOKED'));await expect(f.run()).rejects.toThrow('REAL_SERVICE_PROCESSING_REVOKED');expect(f.query).not.toHaveBeenCalled();
 });
 it('rejects foreign identity before inspecting paid scopes',async()=>{
  const f=seam();mocks.load.mockResolvedValue({identity_id:id(999),profile_sha256:hash});await expect(f.run()).rejects.toThrow('PRICING_IDENTITY_SCOPE');expect(mocks.orders).not.toHaveBeenCalled();
 });
 it('does not select arbitrarily between two initial orders',async()=>{
  const f=seam();mocks.orders.mockResolvedValue([f.order,{...f.order,id:id(99)}]);expect(await f.run()).toBeNull();expect(f.query).not.toHaveBeenCalled();
 });
 it('does not use a completed result for a different current reading key',async()=>{
  const f=seam();mocks.review.mockResolvedValue({key:'new-current-reading',reviewSha256:hash});await expect(f.run()).rejects.toThrow('PRICING_COMPLETED_RECEIPT_SCOPE');
 });
 it('rejects tampered stored report bytes',async()=>{
  const f=seam();f.row.artifacts={...f.row.artifacts,html_base64:Buffer.from('changed private synthetic bytes').toString('base64')};await expect(f.run()).rejects.toThrow('REPORT_HASH_BINDING_INVALID');
 });
 it('retries identical saved receipts without adding a second component',async()=>{
  const f=seam(),first=await f.run(),second=await f.run();expect(second).toEqual(first);expect(second?.components).toHaveLength(1);
 });
});

function obligationSource(topic:'contract'|'bonuses',linear=false){
 // The existing authority fixture needs a legal-source family. Its separately
 // purchased travel comparison is complete and exactly zero, never inferred.
 const s=source([topic,'travel']),travel=travelEntitlementInputSchema.parse(s.entitlement_evidence!.travel);travel.recorded!.printed_value='200.00';s.entitlement_evidence!.travel=travel;
 const o=obligationsEntitlementInputSchema.parse(s.entitlement_evidence!.obligations);
 const originalPayment=structuredClone(o.obligations[0].recorded!);
 o.obligations=o.obligations.filter(item=>item.topic===topic);o.purchased_topics=[topic];
 const selected=o.obligations[0];selected.recorded=originalPayment;
 selected.recorded.amount.printed_value='0.00';
 selected.recorded.scope_assessment.sources=[selected.clause.source,selected.recorded.amount.source];
 if(linear){
  const amount=selected.promise.kind==='fixed'?selected.promise.amount!:null;if(!amount)throw Error('fixture');
  selected.clause.text='Synthetic clause: pay 250.00 ILS per completed unit in June 2026.';selected.clause.text_sha256=obligationTextSha256(selected.clause.text);
  selected.promise={kind:'linear',rate:{...amount,printed_value:'250.00'},quantity:{...amount,id:'completed.units',observation_id:'completed.units',printed_value:'2',representation:'integer',quantity_unit:'count',source:{...amount.source,locator:'Synthetic completed units'}},quantity_unit:'count'};
 }
 s.entitlement_evidence!.obligations=o;return s;
}
describe('versioned nine-topic saved pricing coverage',()=>{
 it.each(['rest_day','contract','bonuses'] as const)('quotes all nine purchased topics from actually calculated %s evidence only',topic=>{
  const s=topic==='rest_day'?source([topic]):obligationSource(topic);
  if(topic==='rest_day'){
   const w=workingTimeEntitlementInputSchema.array().parse(s.entitlement_evidence!.working_time)[0];w.workdays[6].recorded_pay!.printed_value='0.00';s.entitlement_evidence!.working_time=[w];
  }
  const f=mapped(s);expect(f.reason).toBeUndefined();expect(f.basis).toMatchObject({schema_version:RELEASE_PRICING_BASIS_VERSION,checked_topics:topic==='rest_day'?[topic]:[topic,'travel'].sort()});
  expect(f.basis?.components).toHaveLength(topic==='rest_day'?1:2);expect(f.r.verified_debt).toBe(false);expect(f.r.legal_debt_total).toBeNull();
  if(!f.basis)throw Error('fixture did not produce an admitted basis');
  const quote=createReleasePriceQuote({basis:f.basis,caseId:f.r.case_id,identityId:id(1),from:'2026-06',to:'2026-06',topics:RELEASE_PURCHASE_TOPICS,
   credit:{order_id:id(2),case_id:f.r.case_id,identity_id:id(1),verified:true,paid_minor:999,already_consumed:false},now:new Date('2026-09-13T00:00:00Z')});
  // Rest day: 8 hours at40 ILS, after58 weekly hours => 2×175% +6×200%=620.
  expect(quote).toMatchObject({state:'eligible',basis_schema_version:RELEASE_PRICING_BASIS_VERSION,checked_topics:topic==='rest_day'?[topic]:[topic,'travel'].sort(),purchased_topics:RELEASE_PURCHASE_TOPICS,basis_minor:topic==='rest_day'?62000:50000,total_minor:9900,credit_minor:999,balance_minor:8901});
  expect(priceSavedBasis(f.basis).state).toBe('amount_unknown');
 });
 it.each(['contract','bonuses'] as const)('uses the actual linear %s rule pair once',topic=>{
  const f=mapped(obligationSource(topic,true));expect(f.basis?.components).toHaveLength(2);expect(priceSavedReleaseBasis(f.basis)).toMatchObject({state:'eligible',basis_minor:50000});
 });
 it.each(['missing','unknown','conflict','unreadable','conditional','negative','other_period'] as const)('does not price an obligation with %s evidence',defect=>{
  const s=obligationSource('bonuses'),o=obligationsEntitlementInputSchema.parse(s.entitlement_evidence!.obligations),one=o.obligations[0];
  if(defect==='missing')one.recorded=null;
  else if(defect==='conditional'){one.conditions[0].fact.state='unknown';one.conditions[0].fact.value=null;one.scenario='if_conditions_fulfilled';}
  else if(defect==='negative')one.recorded!.amount.printed_value='600.00';
  else if(defect==='other_period')one.recorded!.payment_period={from:'2026-05-01',to:'2026-05-31'};
  else one.recorded!.amount.state=defect;
  s.entitlement_evidence!.obligations=o;expect(mapped(s).basis).toBeNull();
 });
 it('does not interpret distinct obligation payment cells as independent positive awards',()=>{
  const s=obligationSource('bonuses'),other=obligationSource('contract');s.purchased_scope.topics=['contract','bonuses','travel'];
  const o=obligationsEntitlementInputSchema.parse(s.entitlement_evidence!.obligations),contract=obligationsEntitlementInputSchema.parse(other.entitlement_evidence!.obligations).obligations[0];
  contract.recorded!.payment_id='contract.separate.payment';contract.recorded!.amount.observation_id='contract.separate.payment';contract.recorded!.amount.source.locator='Synthetic separate payment cell2';
  contract.recorded!.scope_assessment.sources=[contract.clause.source,contract.recorded!.amount.source];o.obligations.push(contract);o.purchased_topics=['contract','bonuses'];s.entitlement_evidence!.obligations=o;
  const f=mapped(s);expect(f.basis).toBeNull();expect(f.reason).toBe('pricing_cross_topic_allocation_unavailable');
 });
 it('retains rest-day/monthly wage overlap refusal even with distinct payment cells',()=>{
  const f=mapped(source(['rest_day','minimum_wage']));expect(f.basis).toBeNull();expect(f.reason).toBe('pricing_cross_topic_allocation_unavailable');
 });
 it('preserves legacy basis bytes for the six existing families',()=>{
  const f=mapped();expect(f.basis).not.toHaveProperty('schema_version');expect(priceSavedBasis(f.basis)).toEqual(priceSavedReleaseBasis(f.basis));
 });
});
