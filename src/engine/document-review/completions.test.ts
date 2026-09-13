import {describe,expect,it} from 'vitest';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {generateReviewCompletions,parseReviewCompletionInput,resolveReviewCompletion,reviewCompletionSchema,reviewEvidenceSchema,
 type ReviewCompletionInput,type ReviewCompletionNeed,type ReviewEvidence,type ReviewSourcePin} from './completions.ts';

// Only synthetic identifiers and values; no customer source or questionnaire is
// loaded into tests or public fixtures.
const caseId='11111111-1111-4111-8111-111111111111',foreign='22222222-2222-4222-8222-222222222222';
const identity='33333333-3333-4333-8333-333333333333',requestId='44444444-4444-4444-8444-444444444444';
const period={from:'2026-06-01',to:'2026-06-30'};
const pin:ReviewSourcePin={case_id:caseId,document_id:'synthetic-payslip',version_id:'observed-v1',source_sha256:'a'.repeat(64)};
function need(overrides:Partial<ReviewCompletionNeed>={}):ReviewCompletionNeed{
 return {fact_key:'work.break_free',kind:'factual',reason:'unknown',required_evidence_kind:'customer_declaration',
  question:'האם בזמן ההפסקה יכולת לצאת ולהיות פנוי מעבודה?',answer_kind:'boolean',source_pins:[pin],
  dependent_check_ids:['overtime.daily'],general_question:false,...overrides};
}
function input(needs:ReviewCompletionNeed[]=[need()]):ReviewCompletionInput{
 return {case_id:caseId,period,documents:[{pin,kind:'payslip',period,review:'complete'}],needs,evidence:[]};
}
function evidence(overrides:Partial<ReviewEvidence>={}):ReviewEvidence{
 return {evidence_id:'synthetic-questionnaire.break',case_id:caseId,fact_key:'work.break_free',period,origin:'questionnaire',
  state:'declared',value:false,source_pins:[],source_reviewed:true,...overrides};
}
function answer(current:ReviewCompletionInput,overrides:Partial<Parameters<typeof resolveReviewCompletion>[0]['answer']>={}){
 const request=generateReviewCompletions({...current,previous_answers:[]}).customer_requests[0];
 return resolveReviewCompletion({request,current,actor:{case_id:caseId,identity_id:identity},
  answer:{request_id:requestId,revision:1,answered_at:'2026-09-11T12:00:00Z',state:'provided',value:false,...overrides}});
}

describe('document review completion planning',()=>{
 it('accepts exact clock time only and never infers a date or accepts 24:00',()=>{
  const current=input([need({answer_kind:'text',value_validation:{schema_version:'document-review-value-validation-v1',format:'clock_time'}})]);
  for(const value of ['00:00','09:05','23:59'])expect(answer(current,{value}).state).toBe('provided');
  for(const value of ['24:00','9:05','12:60','2026-06-01T12:00','12:00Z',' 12:00','12:00 '])expect(()=>answer(current,{value})).toThrow('REVIEW_COMPLETION_ANSWER_INVALID');
 });
 it('deduplicates one fact across checks and keeps the target stable across dependency/input ordering changes',()=>{
  const a=generateReviewCompletions(input([need(),need({dependent_check_ids:['weekly_rest.break','overtime.daily']})]));
  const b=generateReviewCompletions(input([need({dependent_check_ids:['weekly_rest.break']}),need()]));
  expect(a).toEqual(b);expect(a.customer_requests).toHaveLength(1);
  expect(a.customer_requests[0].dependent_check_ids).toEqual(['overtime.daily','weekly_rest.break']);
  expect(a.customer_requests[0].target.target_sha256).toBe(generateReviewCompletions(input()).customer_requests[0].target.target_sha256);
  expect(a.customer_requests[0].target).not.toHaveProperty('dependent_check_ids');
  expect(a.customer_requests[0].target).not.toHaveProperty('analysis_run_id');
 });
 it('does not ask again for a reviewed false or zero answer with genuine dated scope',()=>{
  for(const actual of [false,0]){
   const i={...input(),evidence:[evidence({value:actual})]};
   expect(generateReviewCompletions(i).customer_requests).toHaveLength(0);
   expect(generateReviewCompletions(i).suppressed[0]).toMatchObject({reason:'already_known',state:'satisfied'});
  }
 });
 it('retains legacy questionnaire scope as unknown and suppresses only a repeated general declaration question',()=>{
  const old=evidence({period:null});
  const general={...input([need({general_question:true})]),evidence:[old]};
  const p=generateReviewCompletions(general);
  expect(p.suppressed[0]).toMatchObject({reason:'legacy_declaration_already_reviewed',state:'provided'});
  expect(old.period).toBeNull();
  expect(generateReviewCompletions({...general,needs:[need()]}).customer_requests).toHaveLength(1);
  expect(generateReviewCompletions({...general,evidence:[{...old,source_reviewed:false}]}).customer_requests).toHaveLength(1);
  expect(generateReviewCompletions({...general,needs:[need({general_question:true,required_evidence_kind:'observed_reading'})]}).customer_requests).toHaveLength(1);
 });
 it('does not turn a present observation or derived ratio into an actual-transfer confirmation',()=>{
  const n=need({fact_key:'pension.received',required_evidence_kind:'actual_transfer',question:'האם יש אסמכתה לקליטת ההפקדה?',
   answer_kind:'document',dependent_check_ids:['pension.actual_transfer']});
  for(const e of [evidence({fact_key:n.fact_key,origin:'document',state:'observed',value:6,source_pins:[pin]}),
   evidence({fact_key:n.fact_key,origin:'derived',state:'derived',value:6,source_pins:[pin]}),
   evidence({fact_key:n.fact_key,value:true})]){
   const p=generateReviewCompletions({...input([n]),evidence:[e]});
   expect(p.customer_requests).toHaveLength(1);
   expect(p.customer_requests[0].dependent_check_ids).toEqual(['pension.actual_transfer']);
  }
  const p=generateReviewCompletions({...input([n]),evidence:[evidence({fact_key:n.fact_key,origin:'transfer_receipt',state:'observed',value:'accepted',source_pins:[pin]})]});
  expect(p.customer_requests).toHaveLength(0);
 });
 it('refuses to label a customer declaration or calculation as an observed source',()=>{
  expect(()=>reviewEvidenceSchema.parse(evidence({origin:'derived',state:'observed',source_pins:[pin]}))).toThrow();
  expect(()=>reviewEvidenceSchema.parse(evidence({origin:'answer',state:'observed',source_pins:[pin]}))).toThrow();
 });
 it('routes source research and ownership to internal tasks without a customer question',()=>{
  const p=generateReviewCompletions(input([need({kind:'legal',fact_key:'law.rate',dependent_check_ids:['pension.legal_rate']}),
   need({kind:'ownership',fact_key:'case.owner',dependent_check_ids:['delivery.owner_scope']})]));
  expect(p.customer_requests).toHaveLength(0);
  expect(p.internal_tasks.map(t=>t.kind).sort()).toEqual(['legal_research','ownership']);
 });
 it('uses an already-reviewed document and checks a known unreviewed source before asking for another upload',()=>{
  const n=need({kind:'document',document_kind:'payslip',required_evidence_kind:'document',answer_kind:'document'});
  expect(generateReviewCompletions(input([n])).suppressed[0].reason).toBe('existing_document');
  const p=generateReviewCompletions({...input([n]),documents:[{pin,kind:'payslip',period,review:'not_reviewed'}]});
  expect(p.customer_requests).toHaveLength(0);expect(p.internal_tasks[0].kind).toBe('review_existing_source');
 });
 it('keeps a scoped financial-source review separate from historical full-payslip completion',()=>{
  const n=need({kind:'document',document_kind:'payslip',required_evidence_kind:'document',answer_kind:'document',fact_key:'payslip.full'});
  const scoped:ReviewCompletionInput={...input([n]),documents:[{pin,kind:'payslip',period,review:'partial',review_completed_fact_keys:['payslip.financial_source']}],
   evidence:[evidence({fact_key:'payslip.financial_source',origin:'document',state:'observed',source_pins:[pin],value:'Four identified source cells with physical page receipt'})]};
  expect(generateReviewCompletions(scoped).customer_requests[0].target.fact_key).toBe('payslip.full');
  const narrow=generateReviewCompletions({...scoped,needs:[{...n,fact_key:'payslip.financial_source'}]});
  expect(narrow.customer_requests).toHaveLength(0);expect(narrow.suppressed[0].reason).toBe('already_known');
  expect(()=>parseReviewCompletionInput({...scoped,documents:[{...scoped.documents[0],review_completed_fact_keys:['payslip.full']}]})).toThrow();
  expect(()=>generateReviewCompletions({...scoped,documents:[{...scoped.documents[0],review:'unreadable'}]})).toThrow();
 });
 it('never substitutes a generic other PDF for the dedicated travel tariff source',()=>{
  const n=need({fact_key:'travel.tariff_source',kind:'document',document_kind:'other',required_evidence_kind:'document',answer_kind:'document',reason:'missing'});
  for(const review of ['complete','not_reviewed'] as const){
   const current:ReviewCompletionInput={...input([n]),documents:[{pin,kind:'other',period,review}]};
   expect(generateReviewCompletions(current).customer_requests).toHaveLength(1);
   const legacy=generateReviewCompletions({...current,needs:[{...n,fact_key:'legacy.other_source'}]});
   expect(legacy.customer_requests).toHaveLength(0);
   expect(review==='complete'?legacy.suppressed[0].reason:legacy.internal_tasks[0].kind).toBe(review==='complete'?'existing_document':'review_existing_source');
  }
  const verified:ReviewCompletionInput={...input([n]),documents:[{pin,kind:'other',period:null,review:'partial'}],
   evidence:[evidence({fact_key:n.fact_key,origin:'document',state:'observed',value:'Exact identified route context',source_pins:[pin]})]};
  expect(generateReviewCompletions(verified).suppressed[0]).toMatchObject({reason:'already_known',state:'satisfied'});
  expect(generateReviewCompletions({...verified,evidence:[{...verified.evidence[0],state:'unknown',value:null}]}).customer_requests).toHaveLength(1);
 });
 it('does not mistake a prior-month payslip for the missing month or assign scope to an undated contract',()=>{
  const n=need({kind:'document',document_kind:'payslip',required_evidence_kind:'document',answer_kind:'document'});
  expect(generateReviewCompletions({...input([n]),documents:[{pin,kind:'payslip',period:{from:'2026-05-01',to:'2026-05-31'},review:'complete'}]}).customer_requests).toHaveLength(1);
  const p=generateReviewCompletions({...input([n]),documents:[{pin,kind:'payslip',period:null,review:'complete'}]});
  expect(p.customer_requests).toHaveLength(0);expect(p.internal_tasks[0].kind).toBe('review_existing_source');
 });
 it('asks for missing financial content when the file is an attendance document, and an improved copy for clipped content',()=>{
  const n=need({kind:'document',document_kind:'payslip',required_evidence_kind:'document',answer_kind:'document'});
  expect(generateReviewCompletions({...input([n]),documents:[{pin,kind:'attendance',period,review:'complete'}]}).customer_requests).toHaveLength(1);
  const p=generateReviewCompletions({...input([{...n,reason:'unreadable'}]),documents:[{pin,kind:'payslip',period,review:'partial'}]});
  expect(p.customer_requests[0].target.reason).toBe('unreadable');
 });
 it('keeps unknown, contradictory and stale observations separate from known values',()=>{
  for(const state of ['unknown','conflicted','stale'] as const)
   expect(generateReviewCompletions({...input(),evidence:[evidence({state,value:null})]}).customer_requests).toHaveLength(1);
  expect(generateReviewCompletions({...input(),evidence:[evidence(),evidence({evidence_id:'other-reading',value:true})]}).customer_requests).toHaveLength(1);
  expect(generateReviewCompletions({...input([need({reason:'conflicted'})]),evidence:[evidence()]}).customer_requests).toHaveLength(1);
 });
 it('rejects foreign source/evidence, stale pins and ambiguous versions rather than asking against the wrong object',()=>{
  expect(()=>generateReviewCompletions({...input(),evidence:[evidence({case_id:foreign})]})).toThrow('CASE_MISMATCH');
  expect(()=>generateReviewCompletions(input([need({source_pins:[{...pin,case_id:foreign}]})]))).toThrow('CASE_MISMATCH');
  expect(()=>generateReviewCompletions(input([need({source_pins:[{...pin,source_sha256:'b'.repeat(64)}]})]))).toThrow('SOURCE_STALE');
  expect(()=>generateReviewCompletions({...input(),documents:[...input().documents,...input().documents]})).toThrow('DOCUMENT_AMBIGUOUS');
 });
 it('refuses two different questions for the same semantic requirement',()=>{
  expect(()=>generateReviewCompletions(input([need(),need({question:'שאלה אחרת באותו נתון'})]))).toThrow('NEED_AMBIGUOUS');
 });
 it('parses unknown input strictly and prevents wrong target/code reuse',()=>{
  expect(parseReviewCompletionInput(input())).toEqual(input());
  expect(()=>parseReviewCompletionInput({...input(),customer_id:foreign})).toThrow();
  const r=generateReviewCompletions(input()).customer_requests[0];
  expect(()=>reviewCompletionSchema.parse({...r,target:{...r.target,question:'הוחלפה השאלה'}})).toThrow();
  expect(()=>reviewCompletionSchema.parse({...r,code:'document_review:'+'b'.repeat(64)})).toThrow();
 });
});

describe('source-bound completion answers',()=>{
 it('invalidates just consuming checks and preserves authenticated declaration provenance',()=>{
  const result=answer(input());
  expect(result).toMatchObject({state:'provided',blocked:false,requires_source_verification:false,invalidated_check_ids:['overtime.daily'],
   evidence:{origin:'answer',state:'declared',value:false,source_pins:[pin]},
   receipt:{case_id:caseId,identity_id:identity,request_id:requestId,answer_revision:1}});
  if(result.state==='stale')throw Error('unexpected stale');
  expect(result.evidence).not.toHaveProperty('human_verified');
  expect(result.evidence).not.toHaveProperty('legal_approval');
 });
 it('keeps unknown answers blocked and does not ask them again on an identical retry/restart',()=>{
  const result=answer(input(),{state:'unknown',value:null});
  expect(result).toMatchObject({state:'unknown',blocked:true,invalidated_check_ids:['overtime.daily']});
  if(result.state==='stale')throw Error('unexpected stale');
  const persisted=JSON.parse(JSON.stringify({...input(),previous_answers:[result.receipt]}));
  expect(generateReviewCompletions(persisted).suppressed[0]).toMatchObject({reason:'previous_answer',state:'unknown'});
  expect(generateReviewCompletions(persisted).customer_requests).toHaveLength(0);
  expect(answer(persisted,{state:'unknown',value:null}).invalidated_check_ids).toEqual([]);
 });
 it('does not turn text into deposit proof, an observed cell, or a resolution of conflicting source documents',()=>{
  for(const kind of ['actual_transfer','observed_reading'] as const){
   const i=input([need({required_evidence_kind:kind,answer_kind:'text'})]);
   expect(answer(i,{value:'כך מסר הלקוח'})).toMatchObject({state:'provided',blocked:true,requires_source_verification:true,evidence:{state:'declared'}});
  }
  expect(answer(input([need({reason:'conflicted'})]))).toMatchObject({state:'provided',blocked:true});
 });
 it.each(['observed_reading','document','actual_transfer'] as const)('retains internal verification after a provided %s answer without asking the customer again',kind=>{
  const requirement=need({required_evidence_kind:kind,answer_kind:kind==='document'?'document':'text',
   ...(kind==='document'?{kind:'document' as const,document_kind:'contract'}:{}),dependent_check_ids:['source.check','independent.consumer']});
  const current=input([requirement]),request=generateReviewCompletions(current).customer_requests[0];
  const result=answer(current,{value:'תשובה שנמסרה; טרם נבדקה מול המסמך'});
  expect(result).toMatchObject({state:'provided',blocked:true,requires_source_verification:true,evidence:{origin:'answer',state:'declared'}});
  if(result.state==='stale')throw Error('unexpected stale');
  const persisted=JSON.parse(JSON.stringify({...current,previous_answers:[result.receipt],evidence:[result.evidence]}));
  const plan=generateReviewCompletions(persisted);
  expect(plan.customer_requests).toEqual([]);
  expect(plan.suppressed).toEqual([{target_sha256:request.target.target_sha256,fact_key:requirement.fact_key,
   reason:'previous_answer',state:'provided',dependent_check_ids:['independent.consumer','source.check'],evidence_ids:[requestId]}]);
  expect(plan.internal_tasks).toEqual([{id:`review_internal:${request.target.target_sha256}`,kind:'review_existing_source',
   question:requirement.question,source_pins:[pin],dependent_check_ids:['independent.consumer','source.check']}]);
  expect(generateReviewCompletions(persisted)).toEqual(plan);
  expect(persisted.previous_answers[0]).toEqual(result.receipt);
 });
 it('keeps an unknown source-reading answer blocked without manufacturing a verification task or repeating the question',()=>{
  const current=input([need({required_evidence_kind:'observed_reading',answer_kind:'text'})]);
  const result=answer(current,{state:'unknown',value:null});
  expect(result).toMatchObject({state:'unknown',blocked:true,requires_source_verification:true});
  if(result.state==='stale')throw Error('unexpected stale');
  const plan=generateReviewCompletions({...current,previous_answers:[result.receipt],evidence:[result.evidence]});
  expect(plan.customer_requests).toEqual([]);expect(plan.internal_tasks).toEqual([]);
  expect(plan.suppressed[0]).toMatchObject({reason:'previous_answer',state:'unknown',evidence_ids:[requestId]});
 });
 it('refuses foreign actors and invalid answer shape',()=>{
  const i=input(),request=generateReviewCompletions(i).customer_requests[0];
  expect(()=>resolveReviewCompletion({request,current:i,actor:{case_id:foreign,identity_id:identity},
   answer:{request_id:requestId,revision:1,answered_at:'2026-09-11T12:00:00Z',state:'provided',value:false}})).toThrow('CASE_MISMATCH');
  expect(()=>answer(i,{value:'false'})).toThrow('ANSWER_INVALID');
  expect(()=>answer(i,{state:'unknown',value:0})).toThrow();
 });
 it('marks changed source or period stale and does not invalidate current unrelated checks',()=>{
  const i=input(),request=generateReviewCompletions(i).customer_requests[0];
  for(const current of [{...i,period:{from:'2026-07-01',to:'2026-07-31'}},
   {...i,documents:[{...i.documents[0],pin:{...pin,version_id:'observed-v2',source_sha256:'b'.repeat(64)}}]}]){
   expect(resolveReviewCompletion({request,current,actor:{case_id:caseId,identity_id:identity},
    answer:{request_id:requestId,revision:1,answered_at:'2026-09-11T12:00:00Z',state:'provided',value:false}}))
    .toEqual({state:'stale',blocked:true,invalidated_check_ids:[]});
  }
 });
 it('uses current check dependencies instead of a tampered or outdated submitted check list',()=>{
  const old=generateReviewCompletions(input()).customer_requests[0];
  const current=input([need({dependent_check_ids:['overtime.daily','weekly_rest.break']})]);
  const result=resolveReviewCompletion({request:{...old,dependent_check_ids:['unrelated.net']},current,actor:{case_id:caseId,identity_id:identity},
   answer:{request_id:requestId,revision:1,answered_at:'2026-09-11T12:00:00Z',state:'provided',value:false}});
  expect(result.invalidated_check_ids).toEqual(['overtime.daily','weekly_rest.break']);
 });
 it('rejects altered receipts, revision jumps, conflicting retries and a second request for the same target',()=>{
  const first=answer(input());if(first.state==='stale')throw Error('unexpected stale');
  const i={...input(),previous_answers:[first.receipt]};
  expect(()=>answer(i,{value:true})).toThrow('ANSWER_REVISION');
  expect(()=>answer(i,{revision:3,value:true})).toThrow('ANSWER_REVISION');
  expect(()=>answer(input(),{revision:2})).toThrow('ANSWER_REVISION');
  expect(()=>answer(i,{request_id:'55555555-5555-4555-8555-555555555555'})).toThrow('ANSWER_AMBIGUOUS');
  expect(()=>generateReviewCompletions({...i,previous_answers:[{...first.receipt,value:true}]})).toThrow();
  const second=answer(i,{revision:2,value:true,answered_at:'2026-09-11T12:01:00Z'});
  expect(second.invalidated_check_ids).toEqual(['overtime.daily']);
  expect(first.receipt.value).toBe(false);
 });
 it('validates enumerated choices and preserves the original hashed question',()=>{
  const i=input([need({answer_kind:'choice',options:['אפשר לצאת','צריך להישאר','משתנה לפי יום']})]);
  expect(()=>answer(i,{value:'תשובה לא קיימת'})).toThrow('ANSWER_INVALID');
  const r=answer(i,{value:'צריך להישאר'});expect(r.state).toBe('provided');
  const target=generateReviewCompletions(i).customer_requests[0].target;
  const {target_sha256,...body}=target;expect(canonicalSha256(body)).toBe(target_sha256);
 });
 it.each(['unknown','provided'] as const)('corrects a persisted %s answer with its evidence while retaining the target and only current dependent checks',state=>{
  const original=input(),request=generateReviewCompletions(original).customer_requests[0];
  const first=answer(original,{state,value:state==='provided'?false:null});
  if(first.state==='stale')throw Error('unexpected stale');
  const current={...original,needs:[need({dependent_check_ids:['overtime.daily','weekly_rest.break']})],
   previous_answers:[first.receipt],evidence:[first.evidence]};
  const corrected=resolveReviewCompletion({request,current,actor:{case_id:caseId,identity_id:identity},
   answer:{request_id:requestId,revision:2,answered_at:'2026-09-11T12:01:00Z',state:'provided',value:true}});
  expect(corrected).toMatchObject({state:'provided',blocked:false,invalidated_check_ids:['overtime.daily','weekly_rest.break'],
   receipt:{target_sha256:request.target.target_sha256,answer_revision:2,value:true}});
  expect(first.receipt.value).toBe(state==='provided'?false:null);
  if(corrected.state==='stale')throw Error('unexpected stale');
  const restarted={...current,previous_answers:[first.receipt,corrected.receipt],evidence:[first.evidence,corrected.evidence]};
  expect(resolveReviewCompletion({request,current:restarted,actor:{case_id:caseId,identity_id:identity},
   answer:{request_id:requestId,revision:2,answered_at:'2026-09-11T12:01:00Z',state:'provided',value:true}}).invalidated_check_ids).toEqual([]);
 });
 it('does not remove document conflicts, questionnaire answers, or unrelated answer evidence while correcting',()=>{
  const original=input(),request=generateReviewCompletions(original).customer_requests[0],first=answer(original);
  if(first.state==='stale')throw Error('unexpected stale');
  const correct=(external:ReviewEvidence)=>resolveReviewCompletion({request,
   current:{...original,previous_answers:[first.receipt],evidence:[first.evidence,external]},
   actor:{case_id:caseId,identity_id:identity},
   answer:{request_id:requestId,revision:2,answered_at:'2026-09-11T12:01:00Z',state:'provided',value:true}});
  expect(correct(evidence({origin:'document',state:'conflicted',value:null,source_pins:[pin]})))
   .toMatchObject({state:'provided',blocked:true,invalidated_check_ids:['overtime.daily']});
  expect(correct(evidence())).toEqual({state:'stale',blocked:true,invalidated_check_ids:[]});
  expect(correct(evidence({origin:'answer',evidence_id:'other-request-answer'})))
   .toEqual({state:'stale',blocked:true,invalidated_check_ids:[]});
  expect(correct({...first.evidence,value:true}))
   .toEqual({state:'stale',blocked:true,invalidated_check_ids:[]});
 });
});
