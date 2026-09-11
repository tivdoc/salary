import {describe,it,expect,vi} from 'vitest';
vi.mock('server-only',()=>({}));
import {CaseAnalysisService} from '@/engine/case-analysis/service';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {documentReviewInputSchema} from '@/engine/document-review/contracts';
import {runDocumentReview,applyDocumentReviewAnswer,compareDocumentReviewDependencies} from '@/engine/document-review/service';
import {June2026ReviewCatalog} from '@/engine/legal-operations/june2026-catalog';
import {InMemoryCaseAnalysisRepository} from '@/server/engine/case-analysis/in-memory-repository';
import {SavedAnalysisDraftBuilder,savedAnalysisId} from './saved-draft-report';
import {decodeBundle,decodeCommand} from '@/server/platform/persistence/postgres/analysis/validation';
import type {CaseAnalysisCommand} from '@/engine/wave3/contracts';
import {createHash} from 'node:crypto';
import {createRuleSpecPackage} from '@/engine/legal-operations/rulespec';
import {documentReviewCalculationInputSchema} from '@/engine/document-review/calculations';

const caseId='11111111-1111-4111-8111-111111111111',docId='22222222-2222-4222-8222-222222222222',sha='a'.repeat(64),reading='b'.repeat(64);
const period={from:'2026-06-01',to:'2026-06-30'};
function fixture(){
 const source={document_id:docId,version_id:docId,file_sha256:sha,page:1,locator:'synthetic earnings table',label:'שכר בדיקה',reading:'ai_document_review',reading_receipt_sha256:reading};
 const pin={case_id:caseId,document_id:docId,version_id:docId,source_sha256:sha};
 const operand=(id:string,printed_value:string,state='observed',representation='money_ils',quantity_unit:string|null=null)=>({id,observation_id:`synthetic.${id}`,state,printed_value,representation,quantity_unit,precision:'source_exact',source});
 const base={schema_version:'document-review-calculation-input-v1',case_id:caseId,run_id:'pending',period,evaluated_at:'2026-09-11T00:00:00Z',
  source_manifest:[{...pin,file_sha256:sha,source_sha256:undefined,page_count:1,kind:'case_document'}],remittance_status:'missing'};
 delete base.source_manifest[0].source_sha256;
 return documentReviewInputSchema.parse({schema_version:'document-review-product-v1',case_id:caseId,period,
  purchased_scope:{order_id:'synthetic-paid-order',receipt_sha256:'c'.repeat(64),topics:['minimum_wage','pension','working_time'],origin:'legacy_paid_receipt'},
  documents:[{case_id:caseId,document_id:docId,version_id:docId,file_sha256:sha,page_count:1,kind:'payslip',label:'תלוש בדיקה סינתטי',period,reading_origin:'ai_document_review',reading_sha256:reading}],
  checks:[{check_id:'pension.ratio',topic:'pension',title:'יחס ניכוי נצפה',explanation:'היחס מחושב מהסכומים המופיעים במסמך.',calculation:{...base,check_id:'pension.ratio',operands:[operand('contribution','120.00'),operand('base','2000.00')],operation:{kind:'observed_ratio',numerator_ref:'contribution',denominator_ref:'base',component_identity:'employee pension',same_period_and_base:true,basis:'Synthetic independent same-period oracle: 120 / 2000 = 0.06'}}},
   {check_id:'hours.product',topic:'working_time',title:'התאמת כמות ותשלום',explanation:'התאמה חשבונית לפי התעריף הרשום, בלי קביעת זכאות.',calculation:{...base,check_id:'hours.product',operands:[operand('rate','50.00'),{...operand('hours','0','missing','decimal_quantity','hours'),printed_value:null},operand('paid','400.00')],operation:{kind:'product',money_ref:'rate',factor_refs:['hours'],recorded_ref:'paid',rounding:'half_up',rounding_basis:'Explicit independent arithmetic candidate, not payroll policy'}}}],
  answer_bindings:[{fact_key:'hours.quantity',check_id:'hours.product',operand_id:'hours'}],
  completion_input:{case_id:caseId,period,documents:[{pin,kind:'payslip',review:'partial',period}],evidence:[],needs:[{fact_key:'hours.quantity',kind:'factual',reason:'missing',required_evidence_kind:'customer_declaration',question:'כמה שעות היו בתקופה המסומנת?',answer_kind:'number',source_pins:[pin],dependent_check_ids:['hours.product'],general_question:false}]}});
}
function candidateFixture(){
 const input=fixture(),calculation=documentReviewCalculationInputSchema.parse(input.checks[0].calculation),source=calculation.operands[0].source;
 const rule=createRuleSpecPackage({schema_version:'tivdoc-rulespec-v0.6.0',rule_spec_id:'synthetic.review.source.rule',rule_spec_version:'1.0.0',topic:'pension',catalog_boundary:'real_inactive',source_version_ids:[docId],effective_period:period,sectors:['synthetic'],populations:['synthetic'],
  facts:[{ref_id:'fact.base',value_kind:'money',unit:'currency.ils'}],parameters:[{ref_id:'parameter.rate',parameter_id:'synthetic.rate',parameter_version:'1.0.0',value_kind:'rational',unit:'ratio'}],
  nodes:[{node_id:'expected.contribution',operation:'money.scale',money_ref:'fact.base',rational_ref:'parameter.rate',rounding:'half_up'}],output_ref:'expected.contribution',golden_case_set_sha256:'d'.repeat(64),resource_policy:{max_steps:1,max_depth:1,max_aggregate_items:1,max_integer_digits:32}});
 const candidate=documentReviewCalculationInputSchema.parse({...calculation,operands:[calculation.operands[1],{...calculation.operands[0],id:'rate',printed_value:'6',representation:'percent',quantity_unit:'ratio'}],
  operation:{kind:'candidate_rule',rule,fact_bindings:[{ref_id:'fact.base',operand_id:'base'}],parameter_bindings:[{ref_id:'parameter.rate',operand_id:'rate'}],required_decision_ids:['source.scope'],
   decisions:[{decision_id:'source.scope',state:'accepted',basis:'ai_source_assessment',explanation:'Synthetic source-scoped assessment; no human authority',sources:[source],valid_until:null}],expected_output_ref:'expected.contribution',recorded_ref:null}});
 input.checks[0].calculation=candidate;
 if(candidate.operation.kind!=='candidate_rule')throw Error('synthetic candidate');
 return {input,calculation:candidate,decision:candidate.operation.decisions[0]};
}
async function harness(review:ReturnType<typeof fixture>,repository=new InMemoryCaseAnalysisRepository(),revision=1){
 const hash=canonicalSha256(review),empty=canonicalSha256([]);
 const stored={document_snapshot_id:`documents:${hash}`,document_snapshot_sha256:empty,documents:[],extraction_snapshot_id:`extractions:${hash}`,extraction_snapshot_sha256:empty,extractions:[],
  declared_fact_snapshot:{snapshot_id:`declarations:${hash}`,snapshot_sha256:empty,facts:[]},document_review_input:review};
 const command:CaseAnalysisCommand={case_id:caseId,case_revision:revision,document_snapshot_id:stored.document_snapshot_id,document_snapshot_sha256:empty,
  extraction_snapshot_id:stored.extraction_snapshot_id,extraction_snapshot_sha256:empty,declared_fact_snapshot_id:stored.declared_fact_snapshot.snapshot_id,declared_fact_snapshot_sha256:empty,
  document_review_sha256:hash,period:{start_date:period.from,end_date:period.to},as_of:'2026-09-11',requested_topics:['minimum_wage','pension','working_time'],sector:'unverified',population:'unverified',mode:'real',idempotency_key:`review:${revision}:${hash}`};
 const service=new CaseAnalysisService({clock:{now:()=> '2026-09-11T00:00:00Z'},ids:{derive:savedAnalysisId},hashes:{hashCanonical:canonicalSha256,hashBytes:b=>createHash('sha256').update(b).digest('hex')},
  snapshots:{async loadPinned(){return stored;}},repository,legalCatalog:new June2026ReviewCatalog(),executor:{async execute(){throw Error('REAL_AUTHORITY_MUST_STAY_CLOSED');}},
  reportBuilder:new SavedAnalysisDraftBuilder(),reportRegistration:{registerReport(){}},logs:{write(){}},templateVersion:'document-review-product-v1'});
 const bundle=await service.runCaseAnalysis(command);return {service,command,bundle,run:await service.getCompletedRun(bundle.analysis_run_id),repository};
}
describe('normal analysis with source-bound supplemental document review',()=>{
 it('computes independent arithmetic despite absent remittance/legal authority, persists and decodes the SAME result/report',async()=>{
  const s=await harness(fixture()),review=s.bundle.document_review!;
  expect(review.checks[0].calculation.observed_ratio).toEqual({kind:'rational',numerator:'3',denominator:'50',unit:'ratio'});
  expect(review.checks[1].calculation.state).toBe('blocked');expect(s.bundle.known_subtotal).toBeNull();
  expect(s.run?.stages).toHaveLength(7);expect(s.run?.dependencies?.code_version).toBe('case-analysis@0.6.7');
  expect(decodeCommand(s.command)).toEqual(s.command);expect(decodeBundle(s.bundle,s.command.requested_topics)).toEqual(s.bundle);
  expect(s.run?.report?.analysis_result_sha256).toBe(s.bundle.result_sha256);
  expect(Buffer.from(s.run!.report!.html).toString()).toContain('6%');expect(Buffer.from(s.run!.report!.html).toString()).not.toContain('REAL_AUTHORITY');
 });
 it('identified answer changes only dependent computation and creates a new historical run; unknown stays blocked',async()=>{
  const original=fixture(),first=await harness(original),request=first.bundle.document_review!.completions.customer_requests[0];
  const actor={case_id:caseId,identity_id:'33333333-3333-4333-8333-333333333333'},answer={request_id:'44444444-4444-4444-8444-444444444444',revision:1,answered_at:'2026-09-11T01:00:00Z',state:'provided' as const,value:10};
  const changed=applyDocumentReviewAnswer(original,{request,actor,answer});
  const second=await harness(changed.input,first.repository,2);
  expect(second.bundle.document_review!.checks[1].calculation.difference).toEqual({kind:'money',currency:'ILS',minor_units:10000});
  expect(compareDocumentReviewDependencies(first.bundle.document_review!,second.bundle.document_review!)).toMatchObject({unchanged:['pension.ratio'],changed:['hours.product']});
  expect(first.repository.completedCount()).toBe(2);expect(await first.service.replay(first.bundle.analysis_run_id)).toEqual(first.bundle);
  expect(changed.input.answer_history[0].original_checks[0].operands[1].state).toBe('missing');
  const unknown=applyDocumentReviewAnswer(original,{request,actor,answer:{...answer,state:'unknown',value:null}});
  expect(runDocumentReview(unknown.input,'unknown-run').checks[1].calculation.state).toBe('blocked');
 });
 it('provided → unknown → provided clears the old number, preserves observations and changes only its consumer',()=>{
  const original=fixture(),originalHash=canonicalSha256(original),before=runDocumentReview(original,'original-run'),request=before.completions.customer_requests[0];
  const actor={case_id:caseId,identity_id:'33333333-3333-4333-8333-333333333333'},request_id='44444444-4444-4444-8444-444444444444';
  const firstAnswer={request_id,revision:1,answered_at:'2026-09-11T01:00:00Z',state:'provided' as const,value:10};
  const first=applyDocumentReviewAnswer(original,{request,actor,answer:firstAnswer}),firstRun=runDocumentReview(first.input,'first-run');
  const unknownAnswer={request_id,revision:2,answered_at:'2026-09-11T02:00:00Z',state:'unknown' as const,value:null};
  const unknown=applyDocumentReviewAnswer(first.input,{request,actor,answer:unknownAnswer}),unknownRun=runDocumentReview(unknown.input,'unknown-run');
  expect(unknownRun.checks[1].calculation).toMatchObject({state:'blocked',expected:null,difference:null});
  expect(unknownRun.checks[1].calculation.input.operands[1]).toMatchObject({state:'unknown',printed_value:null});
  const lastAnswer={request_id,revision:3,answered_at:'2026-09-11T03:00:00Z',state:'provided' as const,value:8};
  const last=applyDocumentReviewAnswer(unknown.input,{request,actor,answer:lastAnswer}),lastRun=runDocumentReview(last.input,'last-run');
  expect(lastRun.checks[1].calculation.difference).toMatchObject({minor_units:0});
  for(const [old,current] of [[before,firstRun],[firstRun,unknownRun],[unknownRun,lastRun]])expect(compareDocumentReviewDependencies(old,current)).toMatchObject({unchanged:['pension.ratio'],changed:['hours.product']});
  expect(last.input.answer_history).toHaveLength(3);expect(last.input.answer_history.map(h=>h.original_checks[0].operands[1].printed_value)).toEqual([null,'10',null]);
  expect(canonicalSha256(original)).toBe(originalHash);expect(first.input.answer_history[0].original_checks[0].operands[1].source.document_id).toBe(docId);
  expect(canonicalSha256(applyDocumentReviewAnswer(last.input,{request,actor,answer:lastAnswer}).input)).toBe(canonicalSha256(last.input));
  const forged=structuredClone(unknown.input);forged.checks[1]=first.input.checks[1];
  expect(()=>runDocumentReview(forged,'stale-answer-run')).toThrow('REVIEW_COMPLETION_ANSWER_REVISION');
  const staleNumber=structuredClone(unknown.input),check=documentReviewCalculationInputSchema.parse(staleNumber.checks[1].calculation);check.operands[1].printed_value='10';staleNumber.checks[1].calculation=check;
  expect(()=>runDocumentReview(staleNumber,'stale-number-run')).toThrow('REVIEW_ANSWER_VALUE_MISMATCH');
 });
 it('keeps an independently conflicting observation blocked after a provided declaration',()=>{
  const original=fixture(),request=runDocumentReview(structuredClone(original),'original-run').completions.customer_requests[0];
  const completion=original.completion_input as {evidence:unknown[]};
  completion.evidence.push({evidence_id:'independent.hours.conflict',case_id:caseId,fact_key:'hours.quantity',period,origin:'document',state:'conflicted',value:null,
   source_pins:request.target.source_pins,source_reviewed:true});
  const changed=applyDocumentReviewAnswer(original,{request,actor:{case_id:caseId,identity_id:'33333333-3333-4333-8333-333333333333'},answer:{request_id:'44444444-4444-4444-8444-444444444444',revision:1,answered_at:'2026-09-11T01:00:00Z',state:'provided',value:8}});
  const result=runDocumentReview(changed.input,'conflicting-answer-run');
  expect(result.checks[1].calculation.state).toBe('blocked');expect(result.checks[1].calculation.input.operands[1]).toMatchObject({state:'conflict',printed_value:'8'});
 });
 it('does not treat an unverified document reading answer as an observed cell',()=>{
  const original=fixture(),completion=original.completion_input as {needs:{required_evidence_kind:string}[]};completion.needs[0].required_evidence_kind='observed_reading';
  const request=runDocumentReview(original,'reading-run').completions.customer_requests[0],changed=applyDocumentReviewAnswer(original,{request,actor:{case_id:caseId,identity_id:'33333333-3333-4333-8333-333333333333'},answer:{request_id:'44444444-4444-4444-8444-444444444444',revision:1,answered_at:'2026-09-11T01:00:00Z',state:'provided',value:8}});
  expect(changed.input.checks).toEqual(original.checks);expect(runDocumentReview(changed.input,'unverified-reading-run').checks[1].calculation.state).toBe('blocked');
 });
 it('admits only a packet-pinned reading receipt for an assessment source',()=>{
  const f=candidateFixture();expect(runDocumentReview(structuredClone(f.input),'candidate-run').checks[0].calculation.state).toBe('calculated');
  f.decision.sources[0].reading_receipt_sha256='e'.repeat(64);expect(()=>runDocumentReview(f.input,'altered-reading-run')).toThrow('REVIEW_READING_CHANGED');
  f.input.documents[0].accepted_reading_sha256=['e'.repeat(64)];expect(runDocumentReview(f.input,'accepted-reading-run').checks[0].calculation.state).toBe('calculated');
 });
 it.each(['version','hash','page','case'] as const)('refuses an assessment source with altered %s',change=>{
  const f=candidateFixture();if(change==='version')f.decision.sources[0].version_id='foreign-version';if(change==='hash')f.decision.sources[0].file_sha256='f'.repeat(64);if(change==='page')f.decision.sources[0].page=2;if(change==='case')f.calculation.source_manifest[0].case_id='55555555-5555-4555-8555-555555555555';
  expect(()=>runDocumentReview(f.input,'foreign-assessment-run')).toThrow(change==='case'?'DOCUMENT_REVIEW_FOREIGN_CASE':'DOCUMENT_REVIEW_SOURCE_BINDING');
 });
 it('does not use a legal-source manifest as a bypass around packet receipt admission',()=>{
  const f=candidateFixture(),source={...f.decision.sources[0],document_id:'synthetic-public-source',version_id:'synthetic-public-source-v1',reading:'source_research' as const};
  f.calculation.source_manifest.push({document_id:source.document_id,version_id:source.version_id,file_sha256:source.file_sha256,page_count:1,kind:'legal_source',case_id:null});f.decision.sources=[source];
  expect(()=>runDocumentReview(f.input,'unadmitted-public-source-run')).toThrow('REVIEW_CHECK_SOURCE_CHANGED');
 });
 it('refuses foreign source, stale reading, altered trace and unpurchased checks',async()=>{
  const f=fixture();expect(()=>runDocumentReview({...f,case_id:'55555555-5555-4555-8555-555555555555'},'test')).toThrow('REVIEW_DOCUMENT_SCOPE');
  expect(()=>runDocumentReview({...f,documents:[{...f.documents[0],reading_sha256:'f'.repeat(64)}]},'test')).toThrow('REVIEW_READING_CHANGED');
  expect(()=>runDocumentReview({...f,purchased_scope:{...f.purchased_scope,topics:['pension']}},'test')).toThrow('REVIEW_UNPURCHASED_CHECK');
  const s=await harness(f);const altered={...s.bundle,document_review:{...s.bundle.document_review!,checks:s.bundle.document_review!.checks.map((c,i)=>i===0?{...c,title:'altered'}:c)}};
  expect(()=>decodeBundle(altered,s.command.requested_topics)).toThrow();
 });
 it('retry and restart reuse exact historical artifacts, including a partial report',async()=>{
  const f=fixture(),first=await harness(f),second=await harness(f,first.repository);
  expect(second.run?.report).toEqual(first.run?.report);expect(first.repository.completedCount()).toBe(1);
  expect(await first.service.runCaseAnalysis(first.command)).toEqual(first.bundle);
 });
});
