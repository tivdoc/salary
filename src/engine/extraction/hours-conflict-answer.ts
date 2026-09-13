import {z} from 'zod';

export const HOURS_CONFLICT_NAMESPACE='document_hours_conflict:';
export const HOURS_CONFLICT_ANSWER_VERSION='document-hours-conflict-answer-v1';
export const conflictHoursSchema=z.string().regex(/^(0|[1-9][0-9]{0,2})(?:\.[0-9]{1,4})?$/u)
 .refine(value=>Number(value)>0&&Number(value)<=182);
export const hoursConflictAnswerSchema=z.discriminatedUnion('state',[
 z.object({schema_version:z.literal(HOURS_CONFLICT_ANSWER_VERSION),state:z.literal('declared'),hours:conflictHoursSchema,
  basis:z.string().trim().min(10).max(1000)}).strict(),
 z.object({schema_version:z.literal(HOURS_CONFLICT_ANSWER_VERSION),state:z.literal('unknown'),basis:z.string().trim().max(1000)}).strict(),
]);
export type HoursConflictAnswer=z.infer<typeof hoursConflictAnswerSchema>;

/** JSON is an internal wire format. The UI exposes a number, its basis and an
 * explicit unknown choice; it never labels this answer a document reading. */
export function parseHoursConflictAnswer(value:string):HoursConflictAnswer{
 if(value.length>1800)throw Error('HOURS_CONFLICT_ANSWER_INVALID');
 try{return hoursConflictAnswerSchema.parse(JSON.parse(value));}catch{throw Error('HOURS_CONFLICT_ANSWER_INVALID');}
}
export function formatHoursConflictAnswer(value:string){
 const answer=parseHoursConflictAnswer(value);
 return answer.state==='declared'?`${answer.hours} שעות רגילות — הצהרה על סמך: ${answer.basis}`
  :`לא ניתן לקבוע את מספר השעות${answer.basis?` — ${answer.basis}`:''}`;
}
