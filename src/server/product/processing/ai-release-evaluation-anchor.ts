import {canonicalSha256,deepFreeze} from '@/engine/rule-runtime/canonical';
import type {AiReleaseConfiguration,OwnerEngineeringConfiguration} from './ai-release-configuration';

export const AI_RELEASE_BOUND_EVIDENCE_ANCHOR='bound-evidence-anchor-v1' as const;
type Dependency={kind:string;id:string;sha256:string;issued_at:string;expires_at:string};
export type AiReleaseEvaluationAnchor={schema_version:typeof AI_RELEASE_BOUND_EVIDENCE_ANCHOR;configuration_sha256:string;source_created_at:string;
 evaluated_at:string;dependencies:readonly Dependency[];sha256:string};
const time=(value:string)=>{const n=Date.parse(value);if(!Number.isFinite(n))throw Error('AI_RELEASE_ANCHOR_TIME');return n;};
function exact<T>(values:readonly T[],predicate:(value:T)=>boolean):T{
 const found=values.filter(predicate);if(found.length!==1)throw Error('AI_RELEASE_ANCHOR_EVIDENCE_BINDING');return found[0];
}
/** Called only after compiled configuration verification and authenticated SQL
 * context binding. This derives a clock, not an admission. Live expiry and
 * revocation remain the existing per-branch evaluator's responsibility. */
export function savedAiEvaluationAnchor(configuration:AiReleaseConfiguration|OwnerEngineeringConfiguration,sourceCreatedAt:string,liveAt:string):
 {evaluated_at:string;evaluation_anchor?:AiReleaseEvaluationAnchor}{
 const base=Math.max(time(sourceCreatedAt),time(configuration.policy.issued_at),time(configuration.registry.issued_at));
 if(configuration.evaluation_anchor_policy===undefined)return {evaluated_at:new Date(base).toISOString()};
 if(configuration.evaluation_anchor_policy!==AI_RELEASE_BOUND_EVIDENCE_ANCHOR)throw Error('AI_RELEASE_ANCHOR_POLICY');
 const dependencies=new Map<string,Dependency>();
 const add=(kind:string,id:string,sha256:string,value:{issued_at:string;expires_at:string})=>{
  if(time(value.issued_at)>=time(value.expires_at))throw Error('AI_RELEASE_ANCHOR_WINDOW');
  const entry={kind,id,sha256,issued_at:value.issued_at,expires_at:value.expires_at},key=kind+':'+sha256;
  if(dependencies.has(key)&&canonicalSha256(dependencies.get(key))!==canonicalSha256(entry))throw Error('AI_RELEASE_ANCHOR_EVIDENCE_BINDING');
  dependencies.set(key,entry);
 };
 add('policy',configuration.policy.policy_id,configuration.policy.sha256,configuration.policy);
 add('registry',configuration.registry.registry_id,configuration.registry.sha256,configuration.registry);
 const reviewed=(kind:string,value:AiReleaseConfiguration['source_receipts'][number]|AiReleaseConfiguration['interpretation_receipts'][number])=>{
  add(kind,value.receipt_id,value.sha256,value);
  const actor=exact(configuration.registry.reviewers,r=>r.actor_id===value.reviewer_id&&r.actor_version===value.reviewer_version);
  add('reviewer',actor.actor_id+':'+actor.actor_version,canonicalSha256(actor),actor);
 };
 const interpretations=new Set<string>();
 for(const branch of configuration.policy.branches){
  for(const sha of branch.source_receipt_sha256s)reviewed('source',exact(configuration.source_receipts,r=>r.sha256===sha));
  const interpretation=exact(configuration.interpretation_receipts,r=>r.sha256===branch.interpretation_receipt_sha256);
  if(interpretation.branch_id!==branch.branch_id)throw Error('AI_RELEASE_ANCHOR_EVIDENCE_BINDING');
  reviewed('interpretation',interpretation);interpretations.add(interpretation.sha256);
  for(const sha of branch.test_receipt_sha256s){
   const test=exact(configuration.test_receipts,r=>r.sha256===sha);
   if(test.branch_id!==branch.branch_id||test.interpretation_receipt_sha256!==interpretation.sha256)throw Error('AI_RELEASE_ANCHOR_EVIDENCE_BINDING');
   // The assembler takes this issuance from its hash-bound measured results,
   // never from the operator's requested policy start.
   add('test',test.receipt_id,test.sha256,test);
  }
 }
 for(const method of configuration.methods??[]){
  if(!interpretations.has(method.interpretation_receipt_sha256))continue;
  for(const ref of method.source_receipts)exact(configuration.source_receipts,r=>r.sha256===ref.receipt_sha256&&r.source_version_id===ref.source_version_id&&r.artifact_sha256===ref.artifact_sha256);
  add('method',method.recipe_id,canonicalSha256(method),method);
 }
 const selected=[...dependencies.values()].sort((a,b)=>(a.kind+':'+a.id+':'+a.sha256).localeCompare(b.kind+':'+b.id+':'+b.sha256,'en'));
 const anchor=Math.max(base,...selected.map(d=>time(d.issued_at)));
 if(anchor>time(liveAt))throw Error('AI_RELEASE_ANCHOR_FUTURE');
 const evaluated_at=new Date(anchor).toISOString(),body={schema_version:AI_RELEASE_BOUND_EVIDENCE_ANCHOR,configuration_sha256:configuration.sha256,
  source_created_at:sourceCreatedAt,evaluated_at,dependencies:selected};
 return deepFreeze({evaluated_at,evaluation_anchor:{...body,sha256:canonicalSha256(body)}});
}
/** Absent means the historical identity has exactly its original fields. */
export function aiEvaluationAnchorDependency(anchor:ReturnType<typeof savedAiEvaluationAnchor>){
 return anchor.evaluation_anchor?{evaluation_anchor_policy:anchor.evaluation_anchor.schema_version,evaluation_anchor_sha256:anchor.evaluation_anchor.sha256}:{};
}
