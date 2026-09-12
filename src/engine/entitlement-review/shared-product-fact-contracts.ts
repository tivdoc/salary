import {z} from 'zod';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
const hash=z.string().regex(/^[a-f0-9]{64}$/u);
export const SHARED_PERSONAL_FACTS_POLICY='shared-personal-facts-v1' as const;
export const SHARED_PERSONAL_FACTS_TRAVEL_POLICY='shared-personal-facts-v2' as const;
export const sharedPersonalFactsPolicySchema=z.enum([SHARED_PERSONAL_FACTS_POLICY,SHARED_PERSONAL_FACTS_TRAVEL_POLICY]);
export const sharedPersonalFactSchema=z.enum(['birth_date','employment_relationship','workplace_sector']);
export const sharedPersonalFactGroupSchema=z.object({schema_version:z.literal('shared-personal-fact-group-v1'),policy_version:sharedPersonalFactsPolicySchema,
 case_id:z.string().min(1),period:z.object({from:z.iso.date(),to:z.iso.date()}).strict(),fact:sharedPersonalFactSchema,
 canonical_fact_key:z.string().min(1),canonical_target_sha256:hash.nullable(),
 state:z.enum(['missing','provided','unknown','unreadable','conflict']),
 origin:z.discriminatedUnion('kind',[
  z.object({kind:z.literal('none')}).strict(),
  z.object({kind:z.literal('answer'),request_id:z.uuid(),target_sha256:hash,answer_sha256:hash,source_sha256:hash}).strict(),
  z.object({kind:z.literal('source_fact'),branch:z.enum(['minimum_wage','pension','travel']),input_path:z.string(),fact_sha256:hash,source_sha256:hash}).strict(),
 ]),
 value_sha256:hash.nullable(),source_sha256s:z.array(hash).max(24),current_source_pins_sha256:hash,
 aliases:z.array(z.object({branch:z.enum(['minimum_wage','pension','travel']),input_path:z.string(),original_fact_sha256:hash,
  fact_key:z.string(),target_sha256:hash.nullable(),dependent_check_ids:z.array(z.string()).max(128)}).strict()).min(1).max(3),
 historical_target_sha256s:z.array(hash).max(24),group_sha256:hash,
}).strict().refine(v=>{const {group_sha256,...body}=v;return group_sha256===canonicalSha256(body);},'SHARED_PERSONAL_GROUP_HASH');
export const sharedPersonalFactsManifestSchema=z.object({policy_version:sharedPersonalFactsPolicySchema,groups:z.array(sharedPersonalFactGroupSchema).max(3),manifest_sha256:hash}).strict()
 .refine(v=>v.groups.every(g=>g.policy_version===v.policy_version),'SHARED_PERSONAL_POLICY_MISMATCH')
 .refine(v=>{const {manifest_sha256,...body}=v;return manifest_sha256===canonicalSha256(body);},'SHARED_PERSONAL_MANIFEST_HASH');
export type SharedPersonalFactManifest=z.infer<typeof sharedPersonalFactsManifestSchema>;
