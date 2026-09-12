import {z} from 'zod';
import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {aiReleaseDecisionMethodSchema,type AiReleaseDecisionMethod} from '../../ai-release-decisions/contracts.ts';

/** Optional versioned receipts; no change to historical source packets. */
export const convalescenceCaseBindingSchema=z.object({schema_version:z.literal('convalescence-case-recipe-binding-v1'),
 method:aiReleaseDecisionMethodSchema,evaluated_at:z.iso.datetime(),binding_sha256:z.string().regex(/^[a-f0-9]{64}$/u)}).strict()
 .refine(v=>{const {binding_sha256,...body}=v;return binding_sha256===canonicalSha256(body);},'CV_CASE_BINDING_HASH');
export function convalescenceCaseBinding(method:AiReleaseDecisionMethod,evaluated_at:string){const body={schema_version:'convalescence-case-recipe-binding-v1' as const,method,evaluated_at};
 return convalescenceCaseBindingSchema.parse({...body,binding_sha256:canonicalSha256(body)});
}
export const convalescencePopulationDerivationSchema=z.object({schema_version:z.literal('convalescence-derived-population-v1'),binding_sha256:z.string().regex(/^[a-f0-9]{64}$/u),inputs_sha256:z.string().regex(/^[a-f0-9]{64}$/u)}).strict();
