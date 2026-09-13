import {z} from 'zod';
import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {aiReleaseDecisionMethodSchema,type AiReleaseDecisionMethod} from '../../ai-release-decisions/contracts.ts';

export const obligationCaseBindingSchema=z.object({schema_version:z.literal('obligation-case-recipe-binding-v1'),
 obligation_id:z.string().min(1).max(64),method:aiReleaseDecisionMethodSchema,evaluated_at:z.iso.datetime(),
 binding_sha256:z.string().regex(/^[a-f0-9]{64}$/u)}).strict().refine(v=>{
 const {binding_sha256,...body}=v;return binding_sha256===canonicalSha256(body);
},'OBLIGATION_CASE_BINDING_HASH');
export function obligationCaseBinding(method:AiReleaseDecisionMethod,evaluated_at:string,obligation_id:string){
 const body={schema_version:'obligation-case-recipe-binding-v1' as const,obligation_id,method,evaluated_at};
 return obligationCaseBindingSchema.parse({...body,binding_sha256:canonicalSha256(body)});
}
