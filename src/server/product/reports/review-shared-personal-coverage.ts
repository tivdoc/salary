import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {replayDocumentReview} from '@/engine/document-review/service';
import {reviewCompletionTargetSchema,type ReviewCompletionTarget} from '@/engine/document-review/completions';

export type SharedPersonalRequest=Readonly<{request_id:string;code:string;target:ReviewCompletionTarget;
 source_current:boolean;answered_at:string|null;expires_at:string}>;

/** Presentation only: retain every request and answer in the journal. An exact
 * replayed alias may point to its live canonical action; it is never answered
 * on the customer's behalf, and conflicts retain both correction routes. */
export function reviewSharedPersonalRequestProjection(input:{review:unknown;requests:readonly SharedPersonalRequest[];nowMs:number}){
 const review=replayDocumentReview(input.review),manifest=review.input.entitlement_composition?.shared_personal_facts;
 if(!manifest||!Number.isFinite(input.nowMs))return [];
 const pins=review.documents.map(d=>({case_id:d.case_id,document_id:d.document_id,version_id:d.version_id,source_sha256:d.file_sha256}));
 const matches:Array<{request_id:string;replacement_request_id:string}>=[];
 const current=input.requests.filter(r=>{
  const parsed=reviewCompletionTargetSchema.safeParse(r.target);if(!parsed.success)return false;
  const t=parsed.data,expires=Date.parse(r.expires_at);
  return r.source_current&&Number.isFinite(expires)&&expires>input.nowMs&&r.code===`document_review:${t.target_sha256}`
   &&t.case_id===review.case_id&&canonicalSha256(t.period)===canonicalSha256(review.period)
   &&t.kind==='factual'&&t.required_evidence_kind==='customer_declaration'&&t.source_pins.length>0
   &&t.source_pins.every(p=>pins.some(current=>canonicalSha256(p)===canonicalSha256(current)));
 });
 for(const g of manifest.groups){
  if(g.case_id!==review.case_id||canonicalSha256(g.period)!==canonicalSha256(review.period)
   ||g.current_source_pins_sha256!==canonicalSha256(pins)||g.state==='conflict'||!g.canonical_target_sha256)continue;
  const replacements=current.filter(r=>r.target.target_sha256===g.canonical_target_sha256&&r.target.fact_key===g.canonical_fact_key);
  if(replacements.length!==1)continue;
  const replacement=replacements[0];
  // A stored answer must be the same identified answer consumed by this run.
  // A response newer than the report prevents projection until the new run.
  if(g.origin.kind==='answer'?(replacement.request_id!==g.origin.request_id||replacement.answered_at===null):replacement.answered_at!==null)continue;
  const aliases=new Set([...g.aliases.flatMap(a=>a.target_sha256?[a.target_sha256]:[]),...g.historical_target_sha256s]);
  for(const r of current){
   if(r.request_id===replacement.request_id||r.answered_at!==null||!aliases.has(r.target.target_sha256)
    ||!g.aliases.some(a=>a.fact_key===r.target.fact_key))continue;
   matches.push({request_id:r.request_id,replacement_request_id:replacement.request_id});
  }
 }
 return matches;
}
