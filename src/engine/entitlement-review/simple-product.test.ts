import {convalescenceFixture,obligationsFixture} from './final-branch.fixture.ts';
import {describe,it,expect} from 'vitest';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {documentReviewInputSchema} from '../document-review/contracts.ts';
import {runDocumentReview,applyDocumentReviewAnswer,replayDocumentReview} from '../document-review/service.ts';
import type {DocumentReviewSource} from '../document-review/calculations.ts';
import {travelFixture,minimumFixture,vacationFixture} from './product-branch.fixture.ts';
import {composeEntitlementReview} from './compose.ts';
import {enableTypedEntitlementPersonalFacts} from './typed-product-facts.ts';
import {parseReviewCompletionInput} from '../document-review/completions.ts';
import {minimumWageEntitlementInputSchema} from './minimum-wage/contracts.ts';
import {convalescenceEntitlementInputSchema} from './convalescence/contracts.ts';
import {assertEntitlementSourcePacket} from './source-admission.ts';
import {entitlementLegalDocuments} from './legal-documents.ts';
import {convalescenceDeclaredChronologyOperand} from './convalescence/resolve.ts';
import {documentReviewCalculationInputSchema} from '../document-review/calculations.ts';
import {unresolvedDeclaredPeriod} from './convalescence/product-facts.ts';
const caseId='11111111-1111-4111-8111-111111111111';
function product(topic:'travel'|'minimum_wage'|'vacation'|'convalescence'|'obligations',candidate:ReturnType<typeof travelFixture>|ReturnType<typeof minimumFixture>|ReturnType<typeof vacationFixture>|ReturnType<typeof convalescenceFixture>|ReturnType<typeof obligationsFixture>){
 const e=structuredClone(candidate);e.case_id=caseId;e.source_manifest=e.source_manifest.map(s=>({...s,case_id:s.kind==='legal_source'?null:caseId}));
 const sources:DocumentReviewSource[]=[];function visit(v:unknown){if(!v||typeof v!=='object')return;if('reading_receipt_sha256'in v)sources.push(v as DocumentReviewSource);for(const x of Object.values(v))visit(x);}visit(e);
 const documents=e.source_manifest.filter(s=>s.kind==='case_document').map(s=>({case_id:caseId,document_id:s.document_id,version_id:s.version_id,file_sha256:s.file_sha256,page_count:s.page_count,kind:'payslip',label:'Synthetic source fixture; no client',period:e.period,reading_origin:'ai_document_review',reading_sha256:sources.find(c=>c.document_id===s.document_id)!.reading_receipt_sha256}));
 return documentReviewInputSchema.parse({schema_version:'document-review-product-v1',case_id:caseId,period:e.period,purchased_scope:{order_id:'synthetic.order',receipt_sha256:'f'.repeat(64),topics:['minimum_wage','working_time','rest_day','pension','travel','convalescence','vacation','bonuses','contract'],origin:'legacy_paid_receipt'},documents,checks:[],coverage_gaps:[],
  completion_input:{case_id:caseId,period:e.period,documents:documents.map(d=>({pin:{case_id:caseId,document_id:d.document_id,version_id:d.version_id,source_sha256:d.file_sha256},kind:d.kind,review:'complete',period:e.period})),needs:[],evidence:[]},
  entitlement_evidence:{schema_version:'entitlement-source-evidence-v1',case_id:caseId,order_id:'synthetic.order',receipt_sha256:'f'.repeat(64),period:e.period,[topic]:e}});
}
describe('additional entitlement branches through ordinary composition and result replay',()=>{
 it.each(['travel','minimum_wage','vacation','convalescence','obligations'] as const)('%s selects its pinned compiled branch and retains nine purchased topics',topic=>{
  const input=product(topic,topic==='travel'?travelFixture():topic==='minimum_wage'?minimumFixture():topic==='convalescence'?convalescenceFixture():topic==='obligations'?obligationsFixture():vacationFixture()),prepared=composeEntitlementReview(input),r=runDocumentReview(prepared,'ordinary.'+topic);
  expect(r.checks.length).toBeGreaterThan(0);expect(r.checks.every(c=>c.topic===(topic==='obligations'?'bonuses':topic)&&c.calculation.state==='calculated')).toBe(true);
  expect(r.purchased_scope.topics).toHaveLength(9);expect(r.input.entitlement_composition?.selections.some(s=>s.topic===(topic==='obligations'?'bonuses':topic))).toBe(true);expect(replayDocumentReview(r)).toEqual(r);
  if(topic==='convalescence')expect(r.checks.find(c=>c.calculation.difference)?.calculation.difference).toMatchObject({minor_units:12875});
  if(topic==='obligations')expect(r.checks.find(c=>c.calculation.difference)?.calculation.difference).toMatchObject({minor_units:5000});
  if(topic==='travel')expect(r.checks.find(c=>c.calculation.difference)?.calculation.difference).toMatchObject({minor_units:1000});
  if(topic==='minimum_wage')expect(r.checks[0].calculation.difference).toMatchObject({minor_units:24000});
  if(topic==='vacation')expect(r.checks.find(c=>c.check_id.endsWith('annual.prorated'))?.calculation.expected).toMatchObject({value:6,unit:'calendar_days'});
 });
 it('keeps Hebrew choice receipts and normalized travel facts separate across correction and unknown',()=>{
  const raw=travelFixture();raw.facts.employer_transport={...raw.facts.employer_transport,state:'unknown',value:null};
  const prepared=composeEntitlementReview(product('travel',raw)),before=runDocumentReview(prepared,'before');
  const request=before.completions.customer_requests.find(r=>r.target.value_mapping?.entries.some(e=>e.value==='both'))!;expect(request).toBeDefined();
  const actor={case_id:caseId,identity_id:'22222222-2222-4222-8222-222222222222'},answer={request_id:'33333333-3333-4333-8333-333333333333',revision:1,answered_at:'2026-09-12T12:00:00Z',state:'provided' as const,value:'אין הסעה'};
  const next=applyDocumentReviewAnswer(prepared,{request,actor,answer}),r=runDocumentReview(next.input,'after');
  expect(r.checks.every(c=>c.calculation.state==='calculated')).toBe(true);expect(next.input.answer_history[0].receipt.value).toBe('אין הסעה');
  expect(next.input.entitlement_composition?.evidence.travel).toMatchObject({facts:{employer_transport:{value:'none',basis:'customer_declaration'}}});
  expect(canonicalSha256(next.input.entitlement_evidence)).toBe(canonicalSha256(prepared.entitlement_evidence));
  const unknown=applyDocumentReviewAnswer(next.input,{request,actor,answer:{...answer,revision:2,answered_at:'2026-09-12T12:01:00Z',value:'לא ידוע'}});
  expect(runDocumentReview(unknown.input,'unknown').checks).toHaveLength(0);expect(unknown.input.answer_history).toHaveLength(2);
 });
});

it('a sourced condition answer changes only its obligation and preserves a nonmonetary outcome',()=>{
 const e=obligationsFixture();e.obligations[0].conditions[0].fact={...e.obligations[0].conditions[0].fact,state:'unknown',value:null};
 const prepared=composeEntitlementReview(product('obligations',e)),before=runDocumentReview(prepared,'condition.before');
 const request=before.completions.customer_requests.find(r=>r.target.answer_kind==='boolean')!;expect(request).toBeDefined();
 const actor={case_id:caseId,identity_id:'22222222-2222-4222-8222-222222222222'};
 const answer={request_id:'33333333-3333-4333-8333-333333333333',revision:1,answered_at:'2026-09-12T12:00:00Z',state:'provided' as const,value:false};
 const no=applyDocumentReviewAnswer(prepared,{request,actor,answer}),r=runDocumentReview(no.input,'condition.no');
 expect(r.checks).toHaveLength(0);expect(r.input.entitlement_composition?.nonmonetary_outcomes).toMatchObject([{state:'condition_not_fulfilled'}]);
 expect(r.completions.customer_requests).toHaveLength(0);expect(replayDocumentReview(r)).toEqual(r);
 const yes=applyDocumentReviewAnswer(no.input,{request,actor,answer:{...answer,revision:2,value:true}}),changed=runDocumentReview(yes.input,'condition.yes');
 expect(changed.checks).toHaveLength(2);expect(changed.checks.every(c=>c.calculation.state==='calculated')).toBe(true);
 expect(changed.input.answer_history).toHaveLength(2);expect(changed.input.entitlement_composition?.nonmonetary_outcomes).toBeUndefined();
 expect(canonicalSha256(changed.input.entitlement_evidence)).toBe(canonicalSha256(prepared.entitlement_evidence));
});

describe('opt-in typed personal facts through authenticated answer composition',()=>{
 const actor={case_id:caseId,identity_id:'22222222-2222-4222-8222-222222222222'};
 const missing={state:'missing' as const,value:null,source:null};
 function enabled(topic:'minimum_wage'|'convalescence',e:ReturnType<typeof minimumFixture>|ReturnType<typeof convalescenceFixture>){
  const input=product(topic,e);return composeEntitlementReview({...input,entitlement_evidence:enableTypedEntitlementPersonalFacts(input.entitlement_evidence!)});
 }
 function requestAt(input:ReturnType<typeof enabled>,path:string){
  const key=input.entitlement_composition!.generated_fact_keys.find(k=>parseReviewCompletionInput(input.completion_input).needs.some(n=>n.fact_key===k&&n.kind==='factual'&&n.required_evidence_kind==='customer_declaration'
   &&k===`entitlement.${path.startsWith('mw:')?'minimum_wage':'convalescence'}.${canonicalSha256({period:input.period,pins:input.documents.filter(d=>d.kind!=='other').map(d=>({case_id:d.case_id,document_id:d.document_id,version_id:d.version_id,source_sha256:d.file_sha256})),path:path.slice(3),key:'personal.'+path.slice(3)}).slice(0,28)}`));
  // Find by the actual branch-generated input path, without relying on display
  // order or source labels. Existing resolver paths use their existing key.
  const needles=runDocumentReview(input,'request.lookup').completions.customer_requests;
  if(key)return needles.find(r=>r.target.fact_key===key)!;
  const field=path.slice(3),topic=path.startsWith('mw:')?'minimum_wage':'convalescence';
  const pins=input.documents.filter(d=>d.kind!=='other').map(d=>({case_id:d.case_id,document_id:d.document_id,version_id:d.version_id,source_sha256:d.file_sha256}));
  const hash=canonicalSha256({period:input.period,pins,path:field,key:(topic==='minimum_wage'?'mw.':'cv.')+field}).slice(0,28);
  return needles.find(r=>r.target.fact_key===`entitlement.${topic}.${hash}`)!;
 }
 let idCounter=20;
 function answer(input:ReturnType<typeof enabled>,path:string,value:string,state:'provided'|'unknown'='provided'){
  const request=requestAt(input,path);expect(request,`missing request ${path}`).toBeDefined();
  const request_id=`33333333-3333-4333-8333-${String(++idCounter).padStart(12,'0')}`;
  const result=applyDocumentReviewAnswer(input,{request,actor,answer:{request_id,revision:1,answered_at:'2026-09-12T12:00:00Z',state,value:state==='provided'?value:null}});
  expect(result.resolution.state).not.toBe('stale');return {input:result.input,request,request_id};
 }
 it('records actual salary basis and birth date without choosing an employment-law formula',()=>{
  const e=minimumFixture();e.employment=missing;e.population=missing;e.applicability=[];
  const prepared=enabled('minimum_wage',e),sourceHash=canonicalSha256(prepared.entitlement_evidence);
  const first=answer(prepared,'mw:product_facts.birth_date','1990-04-15');
  const next=answer(first.input,'mw:product_facts.salary_basis','לפי שעות עבודה');
  const effective=minimumWageEntitlementInputSchema.parse(next.input.entitlement_composition!.evidence.minimum_wage);
  expect(effective.product_facts).toMatchObject({birth_date:{state:'declared',value:'1990-04-15'},salary_basis:{state:'declared',value:'hourly'}});
  expect(effective.employment).toEqual(missing);expect(effective.population).toEqual(missing);expect(effective.applicability).toEqual([]);
  expect(runDocumentReview(next.input,'facts.only').checks).toHaveLength(0);
  expect(canonicalSha256(next.input.entitlement_evidence)).toBe(sourceHash);
  expect(next.input.answer_history.map(h=>h.receipt.value)).toEqual(['1990-04-15','לפי שעות עבודה']);
 });
 it('creates only the declared segment count, derives two-date periods, and consumes FTE without observed promotion',()=>{
  const e=convalescenceFixture();e.payment_coverage=missing;e.segments=[];e.applicability=[];
  const prepared=enabled('convalescence',e),sourceHash=canonicalSha256(prepared.entitlement_evidence);
  let input=answer(prepared,'cv:product_facts.segment_count','1').input;
  for(const [path,value]of [['payment_from','2025-06-01'],['payment_to','2026-05-31'],['segments.0.from','2025-06-01'],['segments.0.to','2026-05-31'],['segments.0.fte','0.5']])input=answer(input,'cv:product_facts.'+path,value).input;
  const effective=convalescenceEntitlementInputSchema.parse(input.entitlement_composition!.evidence.convalescence);
  expect(effective.segments).toHaveLength(1);expect(effective.segments[0]).toMatchObject({id:'declared.segment.1',fte:{state:'declared',value:'0.5'},period:{state:'declared',value:{from:'2025-06-01',to:'2026-05-31'}}});
  expect(effective.payment_coverage).toMatchObject({state:'declared',value:{from:'2025-06-01',to:'2026-05-31'},source:{reading:'customer_declaration'}});
  expect(JSON.parse(effective.payment_coverage.source!.locator)).toHaveProperty('inputs_sha256');
  expect(effective.applicability).toEqual([]);const report=runDocumentReview(input,'facts.complete');
  expect(report.checks).toHaveLength(2);expect(report.checks.every(c=>c.calculation.state==='blocked')).toBe(true);
  expect(report.completions.customer_requests).toHaveLength(0);expect(report.completions.internal_tasks.some(t=>t.kind==='legal_research')).toBe(true);
  expect(input.answer_history).toHaveLength(6);expect(canonicalSha256(input.entitlement_evidence)).toBe(sourceHash);expect(replayDocumentReview(report)).toEqual(report);
  const tampered=structuredClone(input.entitlement_composition!.evidence),p=convalescenceEntitlementInputSchema.parse(tampered.convalescence);p.payment_coverage.value!.to='2026-05-30';tampered.convalescence=p;
  expect(()=>assertEntitlementSourcePacket(input,tampered,entitlementLegalDocuments(caseId,['convalescence']))).toThrow('ENTITLEMENT_DECLARED_PERIOD_CHANGED');
 });
 it('unknown count stays missing; no segment or payment is invented',()=>{
  const e=convalescenceFixture();e.payment_coverage=missing;e.segments=[];
  const input=enabled('convalescence',e),next=answer(input,'cv:product_facts.segment_count','', 'unknown');
  const p=convalescenceEntitlementInputSchema.parse(next.input.entitlement_composition!.evidence.convalescence);
  expect(p.segments).toEqual([]);expect(p.product_facts!.segment_count).toMatchObject({state:'unknown',value:null});
  expect(runDocumentReview(next.input,'unknown.count').completions.customer_requests.some(r=>r.target.fact_key===next.request.target.fact_key)).toBe(false);
 });
 it('preserves reversed dates as conflict and an unknown correction as unknown, with both receipts retained',()=>{
  const e=convalescenceFixture();e.payment_coverage=missing;
  let input=enabled('convalescence',e);input=answer(input,'cv:product_facts.payment_from','2026-05-31').input;
  const end=answer(input,'cv:product_facts.payment_to','2025-06-01');input=end.input;
  expect(convalescenceEntitlementInputSchema.parse(input.entitlement_composition!.evidence.convalescence).payment_coverage).toEqual({state:'conflict',value:null,source:null});
  expect(runDocumentReview(input,'period.conflict').checks).toEqual([]);
  const next=applyDocumentReviewAnswer(input,{request:end.request,actor,answer:{request_id:end.request_id,revision:2,answered_at:'2026-09-12T12:01:00Z',state:'unknown',value:null}});
  expect(convalescenceEntitlementInputSchema.parse(next.input.entitlement_composition!.evidence.convalescence).payment_coverage).toEqual({state:'unknown',value:null,source:null});
  expect(next.input.answer_history).toHaveLength(3);
  expect(unresolvedDeclaredPeriod({...missing,state:'unreadable'},missing)).toEqual({state:'unreadable',value:null,source:null});
 });
 it('recomputes a sourced expected amount after FTE correction and preserves paired-date/unknown history',()=>{
  const e=convalescenceFixture();e.payment_coverage=missing;e.segments=[];
  const prepared=enabled('convalescence',e);let input=answer(prepared,'cv:product_facts.segment_count','1').input;
  for(const [path,value]of [['payment_from','2025-06-01'],['payment_to','2026-05-31'],['segments.0.from','2025-06-01'],['segments.0.to','2026-05-31']])input=answer(input,'cv:product_facts.'+path,value).input;
  const completed=answer(input,'cv:product_facts.segments.0.fte','0.5');input=completed.input;
  const report=runDocumentReview(input,'synthetic.known.policy');expect(report.checks[0].calculation.expected).toMatchObject({minor_units:112875});
  const calc=documentReviewCalculationInputSchema.parse(input.checks[0].calculation),day=calc.operands.find(o=>o.id==='slice.0.calendar_days')!;
  const packet=input.entitlement_composition!.evidence.convalescence;
  expect(day.printed_value).toBe('365');expect(convalescenceDeclaredChronologyOperand(packet,input.checks[0].check_id,day)).toBe(true);
  expect(convalescenceDeclaredChronologyOperand(packet,input.checks[0].check_id,{...day,printed_value:'366'})).toBe(false);
  const year=calc.operands.find(o=>o.id==='slice.0.year')!;
  expect(convalescenceDeclaredChronologyOperand(packet,input.checks[0].check_id,{...year,printed_value:'2'})).toBe(false);
  expect(convalescenceDeclaredChronologyOperand(packet,input.checks[0].check_id,{...day,source:{...day.source,document_id:'foreign.receipt'}})).toBe(false);
  const wrong=structuredClone(input),wc=documentReviewCalculationInputSchema.parse(wrong.checks[0].calculation);wc.operands.find(o=>o.id===day.id)!.printed_value='366';wrong.checks[0].calculation=wc;
  expect(()=>runDocumentReview(wrong,'tampered.days')).toThrow('ENTITLEMENT_COMPOSITION_REPLAY');
  const correction={request:completed.request,actor,answer:{request_id:completed.request_id,revision:2,answered_at:'2026-09-12T12:01:00Z',state:'provided' as const,value:'0.75'}};
  const corrected=applyDocumentReviewAnswer(input,correction),next=runDocumentReview(corrected.input,'fte.corrected');
  expect(next.checks[0].calculation.expected).toMatchObject({minor_units:169313});expect(corrected.input.answer_history).toHaveLength(7);
  const retry=applyDocumentReviewAnswer(corrected.input,correction);expect(retry.input).toEqual(corrected.input);
  const unknown=applyDocumentReviewAnswer(corrected.input,{...correction,answer:{...correction.answer,revision:3,state:'unknown',value:null}});
  expect(runDocumentReview(unknown.input,'fte.unknown').checks).toHaveLength(0);expect(unknown.input.answer_history).toHaveLength(8);
  expect(convalescenceEntitlementInputSchema.parse(unknown.input.entitlement_composition!.evidence.convalescence).segments[0].fte).toMatchObject({state:'unknown',value:null});
  expect(canonicalSha256(unknown.input.entitlement_evidence)).toBe(canonicalSha256(prepared.entitlement_evidence));
 });
 it('rejects foreign actors and leaves a changed source or period answer stale',()=>{
  const e=convalescenceFixture();e.benefit_year=missing;
  const input=enabled('convalescence',e),request=requestAt(input,'cv:benefit_year');expect(request).toBeDefined();
  const supplied={request_id:'33333333-3333-4333-8333-333333333333',revision:1,answered_at:'2026-09-12T12:00:00Z',state:'provided' as const,value:'2026'};
  expect(()=>applyDocumentReviewAnswer(input,{request,actor:{...actor,case_id:'44444444-4444-4444-8444-444444444444'},answer:supplied})).toThrow('REVIEW_COMPLETION_CASE_MISMATCH');
  const completion=parseReviewCompletionInput(input.completion_input),foreignSource={...input,completion_input:{...completion,documents:completion.documents.map(d=>({...d,pin:{...d.pin,version_id:'replaced.version'}}))}};
  expect(applyDocumentReviewAnswer(foreignSource,{request,actor,answer:supplied}).resolution.state).toBe('stale');
  const period={from:'2026-07-01',to:'2026-07-31'},later={...input,completion_input:{...completion,period}};
  expect(applyDocumentReviewAnswer(later,{request,actor,answer:supplied}).resolution.state).toBe('stale');
  const next=applyDocumentReviewAnswer(input,{request,actor,answer:supplied});
  expect(convalescenceEntitlementInputSchema.parse(next.input.entitlement_composition!.evidence.convalescence).benefit_year).toMatchObject({state:'declared',value:2026});
  expect(next.input.answer_history[0].receipt.value).toBe('2026');
 });
 it.each(['2026.5','1899','2101','26','שנה זו'])('rejects invalid year %s before saving an answer',value=>{
  const e=convalescenceFixture();e.benefit_year=missing;
  const input=enabled('convalescence',e),request=requestAt(input,'cv:benefit_year');
  expect(()=>applyDocumentReviewAnswer(input,{request,actor,answer:{request_id:'33333333-3333-4333-8333-333333333333',revision:1,answered_at:'2026-09-12T12:00:00Z',state:'provided',value}})).toThrow('REVIEW_COMPLETION_ANSWER_INVALID');
 });
 it.each(['0','1.1','75%','0.123456789','לא מספר'])('rejects invalid FTE %s before a receipt is created',value=>{
  const e=convalescenceFixture();e.segments[0].fte=missing;
  const input=enabled('convalescence',e),request=requestAt(input,'cv:segments.0.fte');expect(request).toBeDefined();
  expect(()=>applyDocumentReviewAnswer(input,{request,actor,answer:{request_id:'33333333-3333-4333-8333-333333333333',revision:1,answered_at:'2026-09-12T12:00:00Z',state:'provided',value}})).toThrow('REVIEW_COMPLETION_ANSWER_INVALID');
  expect(input.answer_history).toEqual([]);
 });
});
