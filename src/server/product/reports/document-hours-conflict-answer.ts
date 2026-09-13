// This module is also safe to import from the customer form. No provider,
// database, authority material or saved checkpoint enters the client bundle.
export {HOURS_CONFLICT_NAMESPACE,HOURS_CONFLICT_ANSWER_VERSION,conflictHoursSchema,hoursConflictAnswerSchema,
 parseHoursConflictAnswer,formatHoursConflictAnswer,type HoursConflictAnswer} from '@/engine/extraction/hours-conflict-answer';
