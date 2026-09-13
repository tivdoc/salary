import {z} from 'zod';
import {candidateSourceSchema} from './contracts.ts';

const sha=z.string().regex(/^[a-f0-9]{64}$/u);
export const sourceStructureMonthSchema=z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u);
export const sourceStructureBasisSchema=z.object({page:z.number().int().min(1).max(100),locator:z.string().trim().min(1).max(120),text:z.string().trim().min(1).max(160)}).strict();
export const sourceStructureRefSchema=z.object({kind:z.enum(['field','scope','component']),id:z.uuid(),sha256:sha,
 source:candidateSourceSchema,label:z.string().min(1).max(500),raw_value:z.string().nullable()}).strict();
export type SourceStructureRef=Readonly<z.infer<typeof sourceStructureRefSchema>>;
export const sourceRelationshipComponentSchema=z.enum(['pension_employee','pension_employer','severance','combined_employer_funds']);
export const sourceRelationshipValueSchema=z.object({kind:z.literal('source_relationship'),relationship:z.enum(['same_base','different_base']),
 component_kind:sourceRelationshipComponentSchema,fund_kind:z.enum(['pension','study','severance','combined','unknown']),
 fund_label:z.string().trim().min(1).max(160),source_kind:z.enum(['same_row','labelled_section','explicit_reference']),basis:sourceStructureBasisSchema}).strict();
export const sourceDeductionGroupValueSchema=z.object({kind:z.literal('deduction_group'),
 members:z.array(z.object({component_id:z.uuid(),group:z.enum(['mandatory','voluntary','unknown'])}).strict()).min(1).max(100),
 inventory:z.enum(['complete','partial']),basis:sourceStructureBasisSchema}).strict().superRefine((value,ctx)=>{
 if(new Set(value.members.map(m=>m.component_id)).size!==value.members.length)ctx.addIssue({code:'custom',message:'Duplicate deduction member'});
 if(value.inventory==='complete'&&value.members.some(m=>m.group==='unknown'))ctx.addIssue({code:'custom',message:'Unknown member prevents complete inventory'});
});
export const sourceBalanceMovementValueSchema=z.discriminatedUnion('state',[
 z.object({kind:z.literal('balance_movement'),state:z.literal('value'),amount:z.string().trim().min(1).max(100),unit:z.enum(['days','hours','source_native_unknown']),period:sourceStructureMonthSchema,basis:sourceStructureBasisSchema}).strict(),
 z.object({kind:z.literal('balance_movement'),state:z.literal('not_present'),period:sourceStructureMonthSchema,basis:sourceStructureBasisSchema}).strict(),
]);
const sourcePeriodDate=z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine(v=>Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v);
export const sourcePeriodAssociationValueSchema=z.object({kind:z.literal('period_association'),period_kind:z.enum(['current','retroactive','cumulative']),
 period:z.object({from:sourcePeriodDate,to:sourcePeriodDate}).strict().refine(p=>p.from<=p.to),basis:sourceStructureBasisSchema}).strict();
export const sourceStructureValueSchema=z.union([sourceRelationshipValueSchema,sourceDeductionGroupValueSchema,sourceBalanceMovementValueSchema,sourcePeriodAssociationValueSchema]);
export type SourceStructureValue=Readonly<z.infer<typeof sourceStructureValueSchema>>;
export const sourceBalanceCellSchema=z.enum(['opening','accrued','used','adjustments','closing']);
export const sourceStructureSubjectSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('period_association'),refs:z.array(sourceStructureRefSchema).min(1).max(20)}).strict().superRefine((s,ctx)=>{
  const keys=s.refs.map(r=>`${r.kind}:${r.id}`);
  if(s.refs.some(r=>r.kind==='scope')||new Set(s.refs.map(r=>r.id)).size!==s.refs.length||new Set(s.refs.map(r=>r.source.page)).size!==1
   ||keys.join('|')!==[...keys].sort((a,b)=>a.localeCompare(b)).join('|'))ctx.addIssue({code:'custom',message:'Invalid period association references'});
 }),
 z.object({kind:z.literal('source_relationship'),component_kind:sourceRelationshipComponentSchema,contribution:sourceStructureRefSchema,base:sourceStructureRefSchema}).strict(),
 z.object({kind:z.literal('deduction_group'),rows:z.array(sourceStructureRefSchema).min(1).max(100),mandatory_total:sourceStructureRefSchema,voluntary_total:sourceStructureRefSchema.nullable()}).strict(),
 z.object({kind:z.literal('balance_movement'),balance_kind:z.enum(['vacation','sick']),cell:sourceBalanceCellSchema,anchor:sourceStructureRefSchema,
  original_raw_value:z.string().nullable(),page:z.number().int().min(1).max(100)}).strict(),
]);
export type SourceStructureSubject=Readonly<z.infer<typeof sourceStructureSubjectSchema>>;
/** Reading a relationship or a source section is explicit evidence separate
 * from numeric cell reading. It grants no legal applicability or remittance. */
export const customerSourceStructureReadingV1Schema=z.object({schema_version:z.literal('document-source-structure-reading-v1'),actor_kind:z.literal('customer'),
 case_id:z.uuid(),document_id:z.uuid(),source_sha256:sha,normalized_extraction_sha256:sha,first_pass_extraction_sha256:sha,extraction_result_sha256:sha,target_sha256:sha,
 subject:sourceStructureSubjectSchema,month:sourceStructureMonthSchema,policy_version:z.string().min(1).max(100),
 request_id:z.uuid(),answer_revision:z.number().int().positive(),identity_id:z.uuid(),confirmed_at:z.string().datetime({offset:true}),
 value:sourceStructureValueSchema,decision_sha256:sha,verification_sha256:sha,
}).strict();
export type CustomerSourceStructureReadingV1=Readonly<z.infer<typeof customerSourceStructureReadingV1Schema>>;
const periodReading=customerSourceStructureReadingV1Schema.refine(r=>r.subject.kind==='period_association'&&r.value.kind==='period_association');
export const sourceStructurePeriodWitnessSchema=z.object({schema_version:z.literal('document-source-structure-period-witness-v1'),
 period:z.object({from:sourcePeriodDate,to:sourcePeriodDate}).strict().refine(p=>p.from<=p.to),
 refs:z.array(z.discriminatedUnion('basis',[
  z.object({ref:sourceStructureRefSchema,basis:z.literal('original_current'),reading:z.null()}).strict(),
  z.object({ref:sourceStructureRefSchema,basis:z.literal('identified_current'),reading:periodReading}).strict(),
 ])).min(1).max(102),
}).strict().superRefine((w,ctx)=>{
 const keys=w.refs.map(e=>`${e.ref.kind}:${e.ref.id}`);
 if(new Set(w.refs.map(e=>e.ref.id)).size!==keys.length||keys.join('|')!==[...keys].sort((a,b)=>a.localeCompare(b)).join('|'))ctx.addIssue({code:'custom',message:'Period witness references must be unique and ordered'});
});
export type SourceStructurePeriodWitness=Readonly<z.infer<typeof sourceStructurePeriodWitnessSchema>>;
export const customerSourceStructureReadingV2Schema=customerSourceStructureReadingV1Schema.extend({schema_version:z.literal('document-source-structure-reading-v2'),
 period_witness:sourceStructurePeriodWitnessSchema}).refine(r=>r.subject.kind==='source_relationship'||r.subject.kind==='deduction_group');
export const customerSourceStructureReadingSchema=z.discriminatedUnion('schema_version',[customerSourceStructureReadingV1Schema,customerSourceStructureReadingV2Schema]);
export type CustomerSourceStructureReading=Readonly<z.infer<typeof customerSourceStructureReadingSchema>>;
