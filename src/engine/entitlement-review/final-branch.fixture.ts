import type {DocumentReviewSource,DocumentReviewOperand} from '../document-review/calculations.ts';
import {CONVALESCENCE_APPLICABILITY,type ConvalescenceEntitlementInput} from './convalescence/index.ts';
import {obligationTextSha256,obligationsEntitlementInputSchema,OBLIGATION_ASSESSMENTS,type ObligationsEntitlementInput} from './obligations/index.ts';
// Explicit synthetic source packets shared by product-path tests; not client data.
export function convalescenceFixture(){
const source:DocumentReviewSource={document_id:'synthetic.service',version_id:'v1',file_sha256:'a'.repeat(64),page:1,locator:'Synthetic employment and payment record',label:'Synthetic evidence',reading:'ai_document_review',reading_receipt_sha256:'b'.repeat(64)};
const fact=<T>(value:T)=>({state:'observed' as const,value,source});
const money=(value:string|null):DocumentReviewOperand=>({id:'recorded.havraa',observation_id:'synthetic.havraa.amount',state:value===null?'missing':'observed',printed_value:value,representation:'money_ils',quantity_unit:null,precision:'source_exact',source});
function fixture():ConvalescenceEntitlementInput{
 const coverage={from:'2025-06-01',to:'2026-05-31'};
 return {schema_version:'convalescence-entitlement-input-v1',catalog_version:'1.0.0',case_id:'synthetic.case',run_id:'synthetic.run',check_prefix:'convalescence.synthetic',period:{from:'2026-06-01',to:'2026-06-30'},evaluated_at:'2026-09-12T00:00:00Z',
  source_manifest:[{document_id:source.document_id,version_id:source.version_id,file_sha256:source.file_sha256,page_count:1,kind:'case_document',case_id:'synthetic.case'}],
  population:fact('adult_private_general_21_59'),employment_start:fact('2025-06-01'),qualifying_service:fact('continuous_no_excluded_absence'),payment_coverage:fact(coverage),benefit_year:fact(2026),due_date:fact('2026-06-30'),
  segments:[{id:'segment.full',period:fact(coverage),fte:fact('0.5')}],recorded:money('1000'),recorded_coverage:fact(coverage),recorded_inventory:fact('complete_allocated'),
  applicability:Object.entries(CONVALESCENCE_APPLICABILITY).map(([decision_id,explanation])=>({decision_id,state:'accepted',basis:'ai_source_assessment',explanation:'Synthetic assessment only. '+explanation,sources:[source],valid_until:null}))};
}
return fixture();
}
export function obligationsFixture(){
const sha='d'.repeat(64),source={document_id:'synthetic-agreement',version_id:'synthetic-agreement.v1',file_sha256:sha,page:1,locator:'Synthetic promise clause 1',label:'Synthetic explicit agreement; not a real customer',reading:'ai_document_review' as const,reading_receipt_sha256:sha};
function input():ObligationsEntitlementInput{
 const text='Synthetic example only: a 500.00 ILS bonus is payable for June 2026 if the specified project is completed.';
 const amount:DocumentReviewOperand={id:'promise',observation_id:'synthetic.promise',state:'observed',printed_value:'500.00',representation:'money_ils',quantity_unit:null,precision:'printed_precision',source};
 const recorded={...amount,id:'paid',observation_id:'synthetic.payment',printed_value:'450.00',source:{...source,locator:'Synthetic payment record row 1'}};
 return obligationsEntitlementInputSchema.parse({schema_version:'obligations-entitlement-input-v1',catalog_id:'il.review.explicit_obligations.2026',catalog_version:'1.0.0',case_id:'synthetic-case',run_id:'synthetic-run',check_prefix:'synthetic.obligation',period:{from:'2026-06-01',to:'2026-06-30'},evaluated_at:'2026-09-12T00:00:00Z',purchased_topics:['contract','bonuses'],source_manifest:[{document_id:source.document_id,version_id:source.version_id,file_sha256:sha,page_count:1,kind:'case_document',case_id:'synthetic-case'}],
  obligations:[{obligation_id:'project.payment',topic:'bonuses',title:'תגמול סינתטי עבור השלמת פרויקט',clause:{source,text,text_sha256:obligationTextSha256(text),effective_period:{from:'2026-01-01',to:'2026-12-31'}},payment_period:{from:'2026-06-01',to:'2026-06-30'},promise:{kind:'fixed',amount},conditions_mode:'all',conditions:[{condition_id:'project.completed',description:'האם הפרויקט הסינתטי שנקבע בסעיף הושלם בתקופה?',fact:{state:'known',value:true,source:{...source,locator:'Synthetic project completion record'},basis:'identified_document_reading'}}],assessments:Object.keys(OBLIGATION_ASSESSMENTS).map(decision_id=>({decision_id,state:'accepted',basis:'ai_source_assessment',explanation:'Explicit synthetic assessment only; no human approval',sources:[source],valid_until:null})),scenario:'established_only',recorded:{payment_id:'project.payment.recorded',amount:recorded,payment_period:{from:'2026-06-01',to:'2026-06-30'},scope_assessment:{decision_id:'obligation.recorded_scope',state:'accepted',basis:'ai_source_assessment',explanation:'Synthetic payment record explicitly names this obligation and period',sources:[source,recorded.source],valid_until:null}}}]});
}
return input();
}
