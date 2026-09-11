import {expect,it} from 'vitest';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {DOCUMENT_REVIEW_COVERAGE_POLICY,documentReviewInputSchema} from './contracts.ts';
import {attachDocumentReviewCoverage} from './coverage.ts';
import {parseReviewCompletionInput} from './completions.ts';
import {projectDocumentReviewMonth} from './monthly-projection.ts';
import {runDocumentReview} from './service.ts';

const caseId='11111111-1111-4111-8111-111111111111',period={from:'2026-05-20',to:'2026-06-30'};
function fixture(){
 const source={document_id:'synthetic.attendance',version_id:'synthetic.v1',file_sha256:'a'.repeat(64),page:1,locator:'Synthetic table',label:'מסמך בדיקה סינתטי',reading:'ai_document_review',reading_receipt_sha256:'b'.repeat(64)};
 const pin={case_id:caseId,document_id:source.document_id,version_id:source.version_id,source_sha256:source.file_sha256};
 const check=(id:string,from:string,to:string)=>({check_id:id,topic:'working_time',title:'כפל נתונים סינתטי',explanation:'בדיקת חשבון בלבד.',calculation:{schema_version:'document-review-calculation-input-v1',case_id:caseId,run_id:'synthetic.source',check_id:id,period:{from,to},evaluated_at:'2026-09-11T00:00:00Z',
  source_manifest:[{case_id:caseId,document_id:source.document_id,version_id:source.version_id,file_sha256:source.file_sha256,page_count:1,kind:'case_document'}],remittance_status:'missing',
  operands:[{id:'rate',observation_id:id+'.rate',state:'observed',printed_value:'40.00',representation:'money_ils',quantity_unit:null,precision:'source_exact',source},
   {id:'hours',observation_id:id+'.hours',state:'observed',printed_value:'3',representation:'decimal_quantity',quantity_unit:'hours',precision:'source_exact',source},
   {id:'paid',observation_id:id+'.paid',state:'observed',printed_value:'100.00',representation:'money_ils',quantity_unit:null,precision:'source_exact',source}],
  operation:{kind:'product',money_ref:'rate',factor_refs:['hours'],recorded_ref:'paid',rounding:'half_up',rounding_basis:'Synthetic accounting oracle'}}});
 return documentReviewInputSchema.parse({schema_version:'document-review-product-v1',case_id:caseId,period,
  purchased_scope:{order_id:'synthetic.order',receipt_sha256:'c'.repeat(64),topics:['working_time'],origin:'saved_order'},
  documents:[{case_id:caseId,document_id:source.document_id,version_id:source.version_id,file_sha256:source.file_sha256,page_count:1,kind:'attendance',label:source.label,period,reading_origin:'ai_document_review',reading_sha256:source.reading_receipt_sha256}],
  checks:[check('june.day','2026-06-07','2026-06-07'),check('may.day','2026-05-20','2026-05-20'),check('whole.window',period.from,period.to)],
  completion_input:{case_id:caseId,period,documents:[{pin,kind:'attendance',period,review:'complete'}],evidence:[{evidence_id:'broad.period',case_id:caseId,fact_key:'work.context',period,origin:'questionnaire',state:'declared',value:'Context for the entire broad window',source_pins:[pin],source_reviewed:true}],
   needs:[{fact_key:'work.context',kind:'factual',reason:'unknown',required_evidence_kind:'customer_declaration',question:'איזה הקשר חל?',answer_kind:'text',source_pins:[pin],dependent_check_ids:['june.day','may.day','whole.window'],general_question:false},
    {fact_key:'excluded.context',kind:'factual',reason:'unknown',required_evidence_kind:'customer_declaration',question:'הקשר מחוץ לחודש?',answer_kind:'text',source_pins:[pin],dependent_check_ids:['whole.window'],general_question:false}]}});
}
it('retains whole-June calculations and source bytes without prorating a May–June window',()=>{
 const source=fixture(),before=canonicalSha256(source),{input,receipt}=projectDocumentReviewMonth(source,'2026-06');
 expect(input.period).toEqual({from:'2026-06-01',to:'2026-06-30'});expect(input.checks).toEqual([source.checks[0]]);expect(input.documents).toEqual(source.documents);
 expect(receipt.excluded_checks.map(c=>[c.check_id,c.reason])).toEqual([['may.day','outside_month'],['whole.window','cross_month']]);
 expect(receipt.proration_performed).toBe(false);expect(receipt.source_input_sha256).toBe(before);expect(canonicalSha256(source)).toBe(before);
 expect(input.coverage_gaps).toHaveLength(2);expect(input.coverage_gaps.every(g=>g.detail.includes('לא בוצעה חלוקה יחסית'))).toBe(true);
 const calculation=runDocumentReview(input,'synthetic.monthly').checks[0].calculation;
 expect(calculation.expected).toEqual({kind:'money',currency:'ILS',minor_units:12000});
});
it('filters excluded dependencies and does not reuse broad-period evidence to suppress monthly questions',()=>{
 const {input}=projectDocumentReviewMonth(fixture(),'2026-06'),completion=parseReviewCompletionInput(input.completion_input);
 expect(completion.needs).toHaveLength(1);expect(completion.needs[0].dependent_check_ids).toEqual(['june.day']);expect(completion.evidence).toEqual([]);
 expect(runDocumentReview(input,'synthetic.monthly').completions.customer_requests).toHaveLength(1);
});
it('does not rewrite identified history or project a foreign calendar month',()=>{
 const source=fixture(),completion=parseReviewCompletionInput(source.completion_input);
 expect(()=>projectDocumentReviewMonth(source,'2026-07')).toThrow('REVIEW_MONTH_NO_SOURCE_OVERLAP');
 expect(()=>projectDocumentReviewMonth(source,'2026-13')).toThrow();
 expect(()=>projectDocumentReviewMonth({...source,completion_input:{...completion,evidence:completion.evidence.map(e=>({...e,origin:'answer'}))}},'2026-06')).toThrow('REVIEW_MONTH_IDENTIFIED_HISTORY');
});
it('keeps already monthly input bytes when every check is in scope and no completion is excluded',()=>{
 const projected=projectDocumentReviewMonth(fixture(),'2026-06').input;
 const repeat=projectDocumentReviewMonth(projected,'2026-06');expect(repeat.input).toEqual(projected);expect(repeat.receipt.excluded_checks).toEqual([]);
});
it('keeps nine purchased topics, missing original purchase period and 24 unprorated exclusions in ordinary coverage',()=>{
 const original=fixture(),source=documentReviewInputSchema.parse({...original,purchased_scope:{...original.purchased_scope,origin:'legacy_paid_receipt',
  topics:['minimum_wage','working_time','pension','travel','convalescence','vacation','sick_leave','rest_day','bonuses']},
  checks:[original.checks[0],...Array.from({length:24},(_,i)=>{
   const check=structuredClone(original.checks[i===23?1:2]),calculation=check.calculation as Record<string,unknown>;
   const id=`excluded.${i}`;return {...check,check_id:id,calculation:{...calculation,check_id:id}};
  })],completion_input:{...parseReviewCompletionInput(original.completion_input),needs:[],evidence:[]}});
 const before=canonicalSha256(source),admitted=attachDocumentReviewCoverage(source,{schema_version:'document-review-purchase-period-v1',receipt_sha256:source.purchased_scope.receipt_sha256,state:'missing',periods:[]});
 const {input}=projectDocumentReviewMonth(admitted,'2026-06');const result=runDocumentReview(input,'synthetic.coverage.run'),coverage=result.coverage_inventory!;
 expect(coverage.purchased_topics).toHaveLength(9);expect(coverage.topics).toHaveLength(9);expect(coverage.topics.filter(t=>t.coverage==='not_evaluated')).toHaveLength(8);
 expect(coverage.purchase_period_evidence).toMatchObject({state:'missing',periods:[]});expect(coverage.source_periods[0].period).toEqual(period);
 expect(coverage.period_projection?.excluded_checks).toHaveLength(24);expect(coverage.period_projection?.proration_performed).toBe(false);
 expect(result.checks).toHaveLength(1);expect(result.checks[0].calculation.expected).toMatchObject({minor_units:12000});expect(coverage.legal_coverage_complete).toBe(false);
 expect(canonicalSha256(source)).toBe(before);expect(projectDocumentReviewMonth(input,'2026-06').input).toEqual(input);
});
it('preserves old result bytes without opt-in and rejects changed projection, purchase receipt or an in-scope excluded period',()=>{
 const source=fixture(),old=runDocumentReview(source,'legacy.run');expect(old.coverage_inventory).toBeUndefined();
 expect(runDocumentReview(documentReviewInputSchema.parse(source),'legacy.run')).toEqual(old);
 const {input}=projectDocumentReviewMonth(source,'2026-06',{coveragePolicy:DOCUMENT_REVIEW_COVERAGE_POLICY});
 expect(()=>runDocumentReview({...input,period_projection:{...input.period_projection!,projection_sha256:'f'.repeat(64)}},'changed')).toThrow('REVIEW_PROJECTION_BINDING');
 const {projection_sha256:_,...body}=input.period_projection!;void _;
 const changed={...body,excluded_checks:body.excluded_checks.map((c,i)=>i?c:{...c,period:input.period})};
 expect(()=>runDocumentReview({...input,period_projection:{...changed,projection_sha256:canonicalSha256(changed)}},'changed')).toThrow('REVIEW_PROJECTION_EXCLUDED_SCOPE');
 expect(()=>attachDocumentReviewCoverage(source,{schema_version:'document-review-purchase-period-v1',receipt_sha256:'f'.repeat(64),state:'missing',periods:[]})).toThrow();
});
