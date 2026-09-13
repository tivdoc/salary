import {z} from 'zod';
import {AI_RELEASE_TOPICS,aiReleaseAssessmentInputSchema,aiReleaseGeneratorSchema} from '../ai-release/contracts.ts';
import {documentReviewInputSchema} from '../document-review/contracts.ts';

export const AI_RELEASE_RUNTIME_VERSION='tivdoc-ai-release-runtime-v1' as const;
export const AI_RELEASE_RUNTIME_FAMILIES=Object.freeze(AI_RELEASE_TOPICS.map(topic=>Object.freeze({
 family_id:`entitlement.${topic}`,branch_id:`entitlement.${topic}`,topic,
 generator_id:`tivdoc.entitlement.${topic}.generator`,generator_version:'1',
})));
export type AiReleaseRuntimeTopic=typeof AI_RELEASE_TOPICS[number];
export const aiReleaseTrustedGeneratorPinSchema=z.object({family_id:z.string().min(1),generator:aiReleaseGeneratorSchema}).strict();
export const aiReleaseRuntimePreparationInputSchema=z.object({source:documentReviewInputSchema,
 analysis_run_id:z.string().min(1).max(160),trusted_generator_pins:z.array(aiReleaseTrustedGeneratorPinSchema).min(1).max(9),
}).strict().superRefine((v,ctx)=>{
 if(new Set(v.trusted_generator_pins.map(p=>p.family_id)).size!==v.trusted_generator_pins.length)
  ctx.addIssue({code:'custom',message:'AI_RUNTIME_DUPLICATE_GENERATOR_PIN'});
});
export const aiReleaseRuntimeInputSchema=z.object({source:documentReviewInputSchema,
 analysis_run_id:z.string().min(1).max(160),trusted_generator_pins:z.array(aiReleaseTrustedGeneratorPinSchema).min(1).max(9),
 assessment_input:aiReleaseAssessmentInputSchema,
}).strict();
export type AiReleaseRuntimePreparationInput=z.infer<typeof aiReleaseRuntimePreparationInputSchema>;
export type AiReleaseRuntimeInput=z.infer<typeof aiReleaseRuntimeInputSchema>;
export type AiReleaseTrustedGeneratorPin=z.infer<typeof aiReleaseTrustedGeneratorPinSchema>;

/** Pins identify code already compiled into this application. They must be
 * loaded from the server's verified build manifest. A policy's own code hash
 * is not an independent expectation; no dynamic generator is injected here. */
export function assertTrustedRuntimeGeneratorPins(pins:readonly AiReleaseTrustedGeneratorPin[]){
 if(new Set(pins.map(p=>p.family_id)).size!==pins.length)throw Error('AI_RUNTIME_DUPLICATE_GENERATOR_PIN');
 for(const pin of pins){
  const family=AI_RELEASE_RUNTIME_FAMILIES.find(f=>f.family_id===pin.family_id);
  if(!family||pin.generator.id!==family.generator_id||pin.generator.version!==family.generator_version)
   throw Error('AI_RUNTIME_GENERATOR_FAMILY_MISMATCH');
 }
}
