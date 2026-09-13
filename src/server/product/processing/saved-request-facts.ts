import {z} from 'zod';
import {canonicalFactSchema,type CanonicalFact} from '@/engine/facts/contracts';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {validateRequestAnswer} from '../reports/request-answer';
import {savedAnalysisId} from './saved-draft-report';
import {savedQuestionnaireFacts} from './saved-questionnaire';

type Input=Parameters<typeof savedQuestionnaireFacts>[0];
const sourceSchema=z.object({id:z.uuid(),case_id:z.uuid(),scope_month:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
 code:z.string(),answer_kind:z.string(),answer:z.string(),answer_revision:z.number().int().positive(),answer_created_at:z.string().datetime({offset:true})});
const definitions={
 schedule_unknown:{path:'work.days_per_week',kind:'choice',options:['5','6']},
 regular_day_hours_unknown:{path:'work.typical_hours_per_day',kind:'number',options:undefined},
} as const;

/** These two questions have explicit numeric meaning. Generic text, monetary
 * OCR confirmation and unknown historical periods stay evidence, not facts.
 * A correction selects its actual immutable answer revision, never new trust. */
export function savedRequestFacts(input:Input):readonly CanonicalFact[]{
 const {answers=[]}=z.object({answers:z.array(z.record(z.string(),z.unknown())).optional()}).parse(input.journal);
 const seen=new Set<string>(),facts:CanonicalFact[]=[];
 for(const answer of answers){
  if(typeof answer.id!=='string'||seen.has(answer.id))throw new Error('SAVED_REQUEST_ID_AMBIGUOUS');seen.add(answer.id);
  if(answer.case_id!==undefined&&answer.case_id!==input.caseId)throw new Error('SAVED_REQUEST_CASE_MISMATCH');
  if(answer.scope_month===undefined||answer.scope_month===null)continue;
  if(typeof answer.code!=='string'||!Object.hasOwn(definitions,answer.code))continue;
  const source=sourceSchema.parse(answer),definition=definitions[source.code as keyof typeof definitions];
  if(source.scope_month!==input.month)continue;
  if(source.answer_kind!==definition.kind)throw new Error('SAVED_REQUEST_KIND_MISMATCH');
  const value=validateRequestAnswer({code:source.code,answer_kind:definition.kind,options:definition.options?[...definition.options]:undefined},source.answer);
  facts.push(canonicalFactSchema.parse({fact_id:savedAnalysisId('saved-request-fact',canonicalSha256({case_id:input.caseId,revision:input.revision,input_sha256:input.inputSha256,request_id:source.id,answer_revision:source.answer_revision,path:definition.path})),
   case_id:input.caseId,path:definition.path,value:Number(value),status:'needs_confirmation',confidence:1,
   provenance:[{source_type:'declared',source_reference:{kind:'case_request_answer',request_id:source.id,answer_revision:source.answer_revision}}],
   conflicting_fact_ids:[],resolution:null,created_at:input.createdAt}));
 }
 return facts;
}

/** Merge assertions only to satisfy the canonical one-fact-per-path contract.
 * Agreement retains both references. A changed answer cannot silently rewrite
 * a contradictory questionnaire; the unresolved conflict remains explicit. */
export function savedDeclaredFacts(input:Input):readonly CanonicalFact[]{
 const grouped=new Map<CanonicalFact['path'],CanonicalFact[]>();
 for(const fact of [...savedQuestionnaireFacts(input),...savedRequestFacts(input)]){
  const group=grouped.get(fact.path)??[];group.push(fact);grouped.set(fact.path,group);
 }
 return [...grouped.values()].map(facts=>{
  if(facts.length===1)return facts[0];
  const ids=facts.map(f=>f.fact_id).sort(),conflicted=new Set(facts.map(f=>canonicalSha256(f.value))).size>1;
  return canonicalFactSchema.parse({...facts[0],fact_id:savedAnalysisId('saved-declaration-reconciliation',canonicalSha256(ids)),
   value:conflicted?null:facts[0].value,status:conflicted?'conflicted':'needs_confirmation',
   confidence:Math.min(...facts.map(f=>f.confidence)),provenance:facts.flatMap(f=>f.provenance),
   conflicting_fact_ids:conflicted?ids:[],resolution:null});
 });
}
