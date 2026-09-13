import {z} from 'zod';
import {normalizedCandidateFieldSchema,type NormalizedCandidateField} from './payslip.ts';
import {canonicalSha256,deepFreeze} from '../rule-runtime/canonical.ts';
import {hoursConflictAnswerSchema} from './hours-conflict-answer.ts';

const sha=z.string().regex(/^[a-f0-9]{64}$/u);
export function hasHoursConflictObservations(extraction:{fields:readonly NormalizedCandidateField[];warnings:readonly string[]}){
 const hours=extraction.fields.filter(row=>row.field==='regular_hours');
 const values=new Set(hours.filter(row=>row.normalized_value!==null).map(row=>canonicalSha256(row.normalized_value)));
 return values.size>=2||hours.length===0&&extraction.warnings.includes('conflicting_values');
}
const targetBody=z.object({schema_version:z.literal('document-hours-conflict-target-v1'),case_id:z.uuid(),order_id:z.uuid(),
 product_document_id:z.uuid(),version_id:z.uuid(),source_sha256:sha,month:z.literal('2026-06'),
 extraction_policy_version:z.string().min(1).max(100),extraction_result_sha256:sha,source_page_count:z.number().int().positive().max(100),
 reason:z.enum(['conflicting_observations','provider_reported_conflict']),
 observations:z.array(normalizedCandidateFieldSchema).max(12),source_warning_flags:z.array(z.string().min(1).max(100)).max(30),
}).strict();
export const hoursConflictTargetSchema=targetBody.extend({target_sha256:sha}).strict().superRefine((target,ctx)=>{
 const {target_sha256,...body}=target;
 const values=new Set(target.observations.filter(row=>row.normalized_value!==null).map(row=>canonicalSha256(row.normalized_value)));
 if(canonicalSha256(body)!==target_sha256||new Set(target.observations.map(row=>row.candidate_id)).size!==target.observations.length
  ||target.observations.some(row=>row.field!=='regular_hours'||row.source.document_id!==target.version_id
   ||row.source.page<1||row.source.page>target.source_page_count||!row.source.text_fragment?.trim())
  ||(target.reason==='conflicting_observations'?values.size<2:target.observations.length!==0||!target.source_warning_flags.includes('conflicting_values')))
  ctx.addIssue({code:'custom',message:'HOURS_CONFLICT_TARGET_BINDING'});
});
export type HoursConflictTarget=z.infer<typeof hoursConflictTargetSchema>;
const declarationBody=z.object({schema_version:z.literal('document-hours-conflict-declaration-v1'),target:hoursConflictTargetSchema,
 request_id:z.uuid(),answer_revision:z.number().int().positive().safe(),identity_id:z.uuid(),answered_at:z.iso.datetime({offset:true}),
 answer:hoursConflictAnswerSchema.options[0],
 provenance:z.tuple([z.object({source_type:z.literal('declared'),source_reference:z.object({kind:z.literal('case_request_answer'),
  request_id:z.uuid(),answer_revision:z.number().int().positive().safe()}).strict()}).strict()]),
}).strict();
export const hoursConflictDeclarationSchema=declarationBody.extend({declaration_sha256:sha}).strict().superRefine((value,ctx)=>{
 const {declaration_sha256,...body}=value,reference=value.provenance[0].source_reference;
 if(canonicalSha256(body)!==declaration_sha256||value.request_id!==reference.request_id||value.answer_revision!==reference.answer_revision)
  ctx.addIssue({code:'custom',message:'HOURS_CONFLICT_DECLARATION_BINDING'});
});
export type HoursConflictDeclaration=z.infer<typeof hoursConflictDeclarationSchema>;

export function createHoursConflictDeclaration(input:Omit<z.infer<typeof declarationBody>,'schema_version'|'provenance'>):HoursConflictDeclaration{
 const body=declarationBody.parse({schema_version:'document-hours-conflict-declaration-v1',...input,
  provenance:[{source_type:'declared',source_reference:{kind:'case_request_answer',request_id:input.request_id,answer_revision:input.answer_revision}}]});
 return deepFreeze(hoursConflictDeclarationSchema.parse({...body,declaration_sha256:canonicalSha256(body)}));
}
