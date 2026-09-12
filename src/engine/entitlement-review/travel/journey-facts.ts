import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import type {DocumentReviewInput} from '../../document-review/contracts.ts';
import {parseReviewCompletionInput,resolveReviewCompletion,reviewDeclaredAnswerValue} from '../../document-review/completions.ts';
import {travelEntitlementInputSchema,type TravelEntitlementInput} from './contracts.ts';
import {TRAVEL_JOURNEY_FACTS_POLICY} from './product-facts.ts';

export function travelJourneyFactKey(review:DocumentReviewInput,input:TravelEntitlementInput){
 const pins=review.documents.filter(d=>input.source_manifest.some(m=>m.kind==='case_document'&&m.document_id===d.document_id)).map(d=>({case_id:d.case_id,document_id:d.document_id,version_id:d.version_id,source_sha256:d.file_sha256}));
 const path='product_facts.actual_commute_days';return `entitlement.travel.${canonicalSha256({period:review.period,pins,path,key:'personal.'+path}).slice(0,28)}`;
}
/** Count of actual arrivals is a declared fact. This does not identify a fare,
 * authenticate a ticket inventory or infer attendance from paid days. */
export function materializeTravelJourneyFacts(candidate:TravelEntitlementInput,original:TravelEntitlementInput,review:DocumentReviewInput){
 const input=travelEntitlementInputSchema.parse(candidate),raw=travelEntitlementInputSchema.parse(original),result=structuredClone(input);
 if(raw.product_facts?.schema_version!==TRAVEL_JOURNEY_FACTS_POLICY)return result;
 if(raw.case_id!==review.case_id||input.case_id!==review.case_id||canonicalSha256(raw.period)!==canonicalSha256(review.period)||canonicalSha256(input.period)!==canonicalSha256(review.period))throw Error('TRAVEL_JOURNEY_SCOPE');
 // Never replace an independently sourced count with this optional declaration.
 if(raw.commute_days!==null)return result;
 result.commute_days=null;const p=input.product_facts;if(p?.schema_version!==TRAVEL_JOURNEY_FACTS_POLICY)throw Error('TRAVEL_JOURNEY_POLICY');
 const f=p.actual_commute_days;if(f.state!=='declared'||f.value===null)return result;
 const key=travelJourneyFactKey(review,input),history=review.answer_history.filter(h=>h.request.target.fact_key===key).sort((a,b)=>b.receipt.answer_revision-a.receipt.answer_revision),h=history[0];
 if(!h||h.receipt.state!=='provided'||f.source?.reading!=='customer_declaration'||f.source.reading_receipt_sha256!==h.receipt.answer_sha256)throw Error('TRAVEL_JOURNEY_ANSWER_TARGET');
 const r=h.receipt,resolution=resolveReviewCompletion({request:h.request,current:parseReviewCompletionInput(review.completion_input),actor:{case_id:review.case_id,identity_id:r.identity_id},answer:{request_id:r.request_id,revision:r.answer_revision,answered_at:r.answered_at,state:r.state,value:r.value}});
 if(resolution.state==='stale'||resolution.requires_source_verification||resolution.blocked||resolution.receipt.answer_sha256!==r.answer_sha256||h.request.target.value_validation?.format!=='calendar_days'||reviewDeclaredAnswerValue(h.request.target,r.value)!==f.value)throw Error('TRAVEL_JOURNEY_CURRENT_ANSWER');
 result.commute_days={id:'travel.actual_commute_days',observation_id:'declared.arrivals:'+r.answer_sha256,state:'declared',printed_value:String(f.value),representation:'decimal_quantity',quantity_unit:'days',precision:'source_exact',source:f.source};
 return result;
}
