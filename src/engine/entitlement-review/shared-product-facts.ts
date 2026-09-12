import {canonicalSha256} from '../rule-runtime/canonical.ts';
import type {DocumentReviewInput} from '../document-review/contracts.ts';
import type {DocumentReviewSource} from '../document-review/calculations.ts';
import {generateReviewCompletions,parseReviewCompletionInput,resolveReviewCompletion,reviewDeclaredAnswerValue,type ReviewCompletion,type ReviewCompletionNeed} from '../document-review/completions.ts';
import type {EntitlementEvidence} from './contracts.ts';
import type {EntitlementAnswerTarget,EntitlementBranchReview} from './branch-contract.ts';
import {pensionProductReview} from './pension-product.ts';
import {simpleEntitlementProduct} from './simple-product.ts';
import {minimumWageEntitlementInputSchema} from './minimum-wage/contracts.ts';
import {pensionEntitlementInputSchema} from './pension/contracts.ts';
import {travelEntitlementInputSchema} from './travel/contracts.ts';
import {SHARED_PERSONAL_FACTS_POLICY,SHARED_PERSONAL_FACTS_TRAVEL_POLICY,sharedPersonalFactsManifestSchema,type SharedPersonalFactManifest} from './shared-product-fact-contracts.ts';

export {SHARED_PERSONAL_FACTS_POLICY,SHARED_PERSONAL_FACTS_TRAVEL_POLICY} from './shared-product-fact-contracts.ts';
type Branch='minimum_wage'|'pension'|'travel';
type Key='birth_date'|'employment_relationship'|'workplace_sector';
type Fact={state:string;value:unknown;source:DocumentReviewSource|null};
type Alias={branch:Branch;key:Key;path:string;fact:Fact;fact_key:string;need:ReviewCompletionNeed|undefined;request:ReviewCompletion|undefined;ids:string[]};
const same=(a:unknown,b:unknown)=>canonicalSha256(a)===canonicalSha256(b);
const keys:Key[]=['birth_date','employment_relationship','workplace_sector'];
const order:Branch[]=['minimum_wage','pension'];
const enabled=(e:EntitlementEvidence)=>e.shared_personal_facts_policy===SHARED_PERSONAL_FACTS_POLICY||e.shared_personal_facts_policy===SHARED_PERSONAL_FACTS_TRAVEL_POLICY;
const hashSource=(source:DocumentReviewSource)=>canonicalSha256(source);
const sorted=<T extends string>(values:readonly T[])=>[...new Set(values)].sort();

/** Explicitly called only for a newly prepared source packet. */
export function enableSharedPersonalFacts(candidate:EntitlementEvidence,policy:NonNullable<EntitlementEvidence['shared_personal_facts_policy']>=SHARED_PERSONAL_FACTS_POLICY):EntitlementEvidence{return {...candidate,shared_personal_facts_policy:policy};}
function branchInput(e:EntitlementEvidence,branch:Branch){return branch==='pension'?pensionEntitlementInputSchema.parse(e.pension):branch==='travel'?travelEntitlementInputSchema.parse(e.travel):minimumWageEntitlementInputSchema.parse(e.minimum_wage);}
function branchReview(input:DocumentReviewInput,e:EntitlementEvidence,branch:Branch){return branch==='pension'?pensionProductReview(input,e.pension):simpleEntitlementProduct(input,branch,e[branch]);}
function needsBody(request:ReviewCompletion):ReviewCompletionNeed{
 const {schema_version:_,case_id:__,period:___,target_sha256:____,...body}=request.target;void _;void __;void ___;void ____;
 return {...body,dependent_check_ids:[...request.dependent_check_ids],general_question:false};
}
function requestFor(input:DocumentReviewInput,need:ReviewCompletionNeed){const c=parseReviewCompletionInput(input.completion_input);
 return generateReviewCompletions({...c,needs:[need],evidence:[],previous_answers:[]}).customer_requests[0];}
function pinsCurrent(input:DocumentReviewInput,request:ReviewCompletion){return request.target.case_id===input.case_id&&same(request.target.period,input.period)
 &&request.target.source_pins.every(p=>input.documents.some(d=>d.case_id===p.case_id&&d.document_id===p.document_id&&d.version_id===p.version_id&&d.file_sha256===p.source_sha256));}
function inventory(input:DocumentReviewInput,e:EntitlementEvidence):Alias[]{const aliases:Alias[]=[];
 for(const branch of e.shared_personal_facts_policy===SHARED_PERSONAL_FACTS_TRAVEL_POLICY?[...order,'travel' as const]:order){if(e[branch]===undefined)continue;const b=branchInput(e,branch);if(!b.product_facts)continue;
  const part=branchReview(input,e,branch),pins=input.documents.filter(d=>b.source_manifest.some(m=>m.kind==='case_document'&&m.document_id===d.document_id)).map(d=>({case_id:d.case_id,document_id:d.document_id,version_id:d.version_id,source_sha256:d.file_sha256}));
  for(const key of keys){if(!(key in b.product_facts))continue;const path='product_facts.'+key;
   const fact_key=branch==='pension'?`entitlement.pension.${canonicalSha256({period:input.period,pins,path}).slice(0,32)}`
    :`entitlement.${branch}.${canonicalSha256({period:input.period,pins,path,key:'personal.'+path}).slice(0,28)}`;
   const need=part.needs.find(n=>n.fact_key===fact_key),fact=Reflect.get(b.product_facts,key) as Fact;
   aliases.push({branch,key,path,fact,fact_key,need,request:need?requestFor(input,need):undefined,
    ids:need?[...need.dependent_check_ids]:sorted([...part.checks.map(c=>c.check_id),...part.gaps.map(g=>g.check_id)])});
  }
 }return aliases;
}
function originalAnswer(input:DocumentReviewInput,h:DocumentReviewInput['answer_history'][number]){
 if(!pinsCurrent(input,h.request)||h.request.target.required_evidence_kind!=='customer_declaration')return null;
 const completion=parseReviewCompletionInput(input.completion_input),r=h.receipt;
 const admitted=resolveReviewCompletion({request:h.request,current:{...completion,needs:[needsBody(h.request)]},actor:{case_id:input.case_id,identity_id:r.identity_id},
  answer:{request_id:r.request_id,revision:r.answer_revision,answered_at:r.answered_at,state:r.state,value:r.value}});
 if(admitted.state==='stale'||admitted.requires_source_verification||admitted.receipt.answer_sha256!==r.answer_sha256)return null;
 const value=r.state==='provided'?reviewDeclaredAnswerValue(h.request.target,r.value):null;
 const state=r.state==='conflicted'||admitted.blocked&&r.state==='provided'?'conflict':r.state==='provided'&&value!==null?'provided':'unknown';
 const source:DocumentReviewSource={document_id:r.request_id,version_id:`${r.request_id}:${r.answer_revision}`,file_sha256:r.answer_sha256,page:1,locator:h.request.target.fact_key,
  label:h.request.target.question,reading:'customer_declaration',reading_receipt_sha256:r.answer_sha256};
 return {h,value,state,source};
}
function observedSourceCurrent(input:DocumentReviewInput,f:Fact){return f.state==='observed'&&f.value!==null&&f.source?.reading==='identified_document_reading'
 &&input.documents.some(d=>d.case_id===input.case_id&&d.document_id===f.source!.document_id&&d.version_id===f.source!.version_id&&d.file_sha256===f.source!.file_sha256
  &&d.page_count!==null&&f.source!.page>=1&&f.source!.page<=d.page_count&&[d.reading_sha256,...(d.accepted_reading_sha256??[])].includes(f.source!.reading_receipt_sha256));}
type ResolvedGroup={receipt:SharedPersonalFactManifest['groups'][number];aliases:Alias[];need:ReviewCompletionNeed|null;fact:Fact|null;canonical:ReviewCompletion|null};

/** Reconstruct from raw typed slots and the immutable current answer journal.
 * No receipt is re-signed or assigned a new target to make reuse possible. */
function groups(input:DocumentReviewInput,e:EntitlementEvidence):ResolvedGroup[]{
 if(!enabled(e))return [];
 const all=inventory(input,e),out:ResolvedGroup[]=[];
 for(const key of keys){const aliases=all.filter(a=>a.key===key),needed=aliases.filter(a=>a.request);
  const recognized=input.answer_history.filter(h=>aliases.some(a=>a.fact_key===h.request.target.fact_key));
  const latest=[...new Map(recognized.map(h=>[h.receipt.request_id,recognized.filter(r=>r.receipt.request_id===h.receipt.request_id).sort((a,b)=>b.receipt.answer_revision-a.receipt.answer_revision)[0]])).values()];
  const answers=latest.map(h=>originalAnswer(input,h)).filter(a=>a!==null).sort((a,b)=>a.h.receipt.request_id.localeCompare(b.h.receipt.request_id));
  const unknown=answers.filter(a=>a.state!=='provided'),chosen=unknown[0]??answers[0];
  const observations=aliases.filter(a=>observedSourceCurrent(input,a.fact));
  const sourceValues=[...answers.filter(a=>a.state==='provided').map(a=>a.value),...observations.map(a=>a.fact.value)];
  const conflict=new Set(sourceValues.map(v=>canonicalSha256(v))).size>1||answers.some(a=>a.state==='conflict')||aliases.some(a=>a.fact.state==='conflict');
  if(!needed.length&&!conflict)continue;
  const rawUnknown=aliases.find(a=>a.fact.state==='unknown'),rawUnreadable=aliases.find(a=>a.fact.state==='unreadable');
  const rawBlocked=aliases.find(a=>a.fact.state==='conflict')??rawUnknown??rawUnreadable;
  const canonical=chosen?.h.request??needed[0]?.request??null,ids=sorted((needed.length?needed:aliases).flatMap(a=>a.ids));
  let state:ResolvedGroup['receipt']['state']=conflict?'conflict':rawUnknown||unknown.length?'unknown':rawUnreadable?'unreadable':sourceValues.length?'provided':'missing';
  const observation=observations[0];let fact:Fact|null=null;
  if(rawBlocked)fact={state,value:null,source:rawBlocked.fact.source};
  else if(chosen)fact={state:state==='provided'?'declared':state,value:state==='provided'?chosen.value:null,source:chosen.source};
  else if(observation)fact={state:state==='provided'?'observed':state,value:state==='provided'?observation.fact.value:null,source:observation.fact.source};
  if(state==='provided'&&!fact){state='missing';fact=null;}
  const origin:ResolvedGroup['receipt']['origin']=rawBlocked?(rawBlocked.fact.source?{kind:'source_fact',branch:rawBlocked.branch,input_path:rawBlocked.path,fact_sha256:canonicalSha256(rawBlocked.fact),source_sha256:hashSource(rawBlocked.fact.source)}:{kind:'none'}):chosen?{kind:'answer',request_id:chosen.h.receipt.request_id,target_sha256:chosen.h.request.target.target_sha256,answer_sha256:chosen.h.receipt.answer_sha256,source_sha256:hashSource(chosen.source)}
   :observation?{kind:'source_fact',branch:observation.branch,input_path:observation.path,fact_sha256:canonicalSha256(observation.fact),source_sha256:hashSource(observation.fact.source!)}:{kind:'none'};
  const body={schema_version:'shared-personal-fact-group-v1' as const,policy_version:e.shared_personal_facts_policy!,case_id:input.case_id,period:input.period,fact:key,
   canonical_fact_key:canonical?.target.fact_key??'shared.personal.'+canonicalSha256({case_id:input.case_id,period:input.period,key}).slice(0,32),canonical_target_sha256:canonical?.target.target_sha256??null,state,origin,value_sha256:fact?.value===null||!fact?null:canonicalSha256(fact.value),
   source_sha256s:sorted([...answers.map(a=>hashSource(a.source)),...observations.map(a=>hashSource(a.fact.source!)),...(rawBlocked?.fact.source?[hashSource(rawBlocked.fact.source)]:[])]),
   current_source_pins_sha256:canonicalSha256(input.documents.map(d=>({case_id:d.case_id,document_id:d.document_id,version_id:d.version_id,source_sha256:d.file_sha256}))),
   aliases:aliases.map(a=>({branch:a.branch,input_path:a.path,original_fact_sha256:canonicalSha256(a.fact),fact_key:a.fact_key,target_sha256:a.request?.target.target_sha256??null,dependent_check_ids:a.ids})),
   historical_target_sha256s:sorted(recognized.map(h=>h.request.target.target_sha256))};
  // A compatible observed source already answers this factual question. An
  // existing answer retains its exact body so unknown/history/correction work.
  const need=canonical&&!rawBlocked&&!(origin.kind==='source_fact'&&state==='provided')?{...needsBody(canonical),dependent_check_ids:ids}:null;
  out.push({receipt:{...body,group_sha256:canonicalSha256(body)},aliases,need,fact,canonical});
 }return out;
}
export function sharedPersonalFactManifest(input:DocumentReviewInput,e:EntitlementEvidence){
 if(!enabled(e))return undefined;
 const body={policy_version:e.shared_personal_facts_policy!,groups:groups(input,e).map(g=>g.receipt)};
 return sharedPersonalFactsManifestSchema.parse({...body,manifest_sha256:canonicalSha256(body)});
}
export function projectSharedPersonalFactNeeds(input:DocumentReviewInput,e:EntitlementEvidence,part:EntitlementBranchReview):EntitlementBranchReview{
 if(!enabled(e))return part;
 const plan=groups(input,e),keys=new Set(plan.flatMap(g=>g.aliases.map(a=>a.fact_key)));
 // Alias slots are filled by the authenticated shared materializer, not by
 // pretending that a receipt's original fact_key named another field.
 return {...part,needs:[...part.needs.filter(n=>!keys.has(n.fact_key)),...plan.flatMap(g=>g.need?[g.need]:[])],answer_targets:part.answer_targets.filter(t=>!keys.has(t.fact_key))};
}
export function materializeSharedPersonalFacts(input:DocumentReviewInput,original:EntitlementEvidence,effective:EntitlementEvidence):EntitlementEvidence{
 if(!enabled(original))return effective;
 const result=structuredClone(effective);
 for(const group of groups(input,original))if(group.fact)for(const alias of group.aliases){
  const b=branchInput(result,alias.branch);if(!b.product_facts)continue;
  // Preserve compatible existing observations. Conflicts remain visible in
  // the raw source and become an explicit blocked effective state.
  const old=Reflect.get(b.product_facts,alias.key) as Fact;
  if(old.state==='observed'&&group.fact.state==='declared'&&same(old.value,group.fact.value))continue;
  Reflect.set(b.product_facts,alias.key,structuredClone(group.fact));
  const s=group.fact.source;
  if(s){const origin=input.documents.find(d=>d.document_id===s.document_id&&d.version_id===s.version_id);
   b.source_manifest=b.source_manifest.filter(p=>p.document_id!==s.document_id);
   b.source_manifest.push({document_id:s.document_id,version_id:s.version_id,file_sha256:s.file_sha256,page_count:origin?.page_count??1,kind:s.reading==='customer_declaration'?'customer_answer':'case_document',case_id:input.case_id});}
  result[alias.branch]=b;
 }
 return result;
}
/** Used only in the narrow personal-fact source fence. */
export function sharedPersonalAliasFact(input:DocumentReviewInput,packet:EntitlementEvidence,path:string,fact:unknown):boolean{
 const original=input.entitlement_evidence;if(!original||!enabled(original))return false;
 const group=groups(input,original).find(g=>g.aliases.some(a=>`${a.branch}.${a.path}`===path));
 if(!group?.fact)return false;
 const expected=materializeSharedPersonalFacts(input,original,original),match=/^(minimum_wage|pension|travel)\.product_facts\.([a-z_]+)$/u.exec(path);if(!match)return false;
 const b=branchInput(expected,match[1] as Branch),actual=branchInput(packet,match[1] as Branch);
 return !!b.product_facts&&!!actual.product_facts&&same(Reflect.get(b.product_facts,match[2]),fact);
}
/** A historical answer's saved dependency list is immutable. Only a current
 * reconstructed alias can extend its use to another exact dependent check. */
export function sharedPersonalAnswerCoversCheck(input:DocumentReviewInput,answerSha:string,checkId:string){
 const e=input.entitlement_evidence;if(!e||!enabled(e))return false;
 return groups(input,e).some(g=>g.receipt.origin.kind==='answer'&&g.receipt.origin.answer_sha256===answerSha&&g.receipt.aliases.some(a=>a.dependent_check_ids.includes(checkId)));
}
export function sharedPersonalCanonicalTargets(input:DocumentReviewInput){const e=input.entitlement_evidence;return e&&enabled(e)?groups(input,e).flatMap(g=>g.canonical?[g.canonical]:[]):[];}
export function sharedPersonalAnswerIsCurrent(input:DocumentReviewInput,answerSha:string){const e=input.entitlement_evidence;
 if(!e||!enabled(e))return false;
 const h=input.answer_history.find(h=>h.receipt.answer_sha256===answerSha);if(!h||input.answer_history.some(n=>n.receipt.request_id===h.receipt.request_id&&n.receipt.answer_revision>h.receipt.answer_revision))return false;
 return inventory(input,e).some(a=>a.fact_key===h.request.target.fact_key)&&originalAnswer(input,h)!==null;
}
export function assertSharedPersonalMaterialization(input:DocumentReviewInput,packet:EntitlementEvidence){const original=input.entitlement_evidence;
 if(!original||!enabled(original)||same(original,packet))return;
 const expected=materializeSharedPersonalFacts(input,original,original);
 for(const group of groups(input,original))if(group.fact)for(const alias of group.aliases){
  const actual=branchInput(packet,alias.branch),wanted=branchInput(expected,alias.branch);
  if(!actual.product_facts||!wanted.product_facts||!same(Reflect.get(actual.product_facts,alias.key),Reflect.get(wanted.product_facts,alias.key)))throw Error('SHARED_PERSONAL_FACT_REPLAY');
 }
}
export type SharedPersonalAnswerTarget=EntitlementAnswerTarget;
