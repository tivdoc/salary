import type {StoredRequest} from './case-requests';
import {HOURS_CONFLICT_NAMESPACE,parseHoursConflictAnswer} from './document-hours-conflict-answer';
import {parseDocumentFieldAnswer} from './reading-verification';
import {parseDocumentFieldAnswerV3} from './document-source-structure';
import {parseTravelTariffWireAnswer} from './document-travel-tariff';
import {parseDocumentSourcePeriodIntakeAnswer} from './document-source-period-intake';
export class RequestAnswerError extends Error { constructor(){super('REQUEST_ANSWER_INVALID');} }
export function validateRequestAnswer(request:Pick<StoredRequest,'answer_kind'|'options'|'code'>,value:string):string{
 const answer=value.trim();
 if(!answer||answer.length>2000||request.answer_kind==='document'||request.answer_kind==='none')throw new RequestAnswerError();
 if(request.code.startsWith('document_field:')&&answer.startsWith('{')){
  if(request.answer_kind!=='choice')throw new RequestAnswerError();
  try{
   const wire=JSON.parse(answer);
   if(wire.v===1)return JSON.stringify(parseDocumentSourcePeriodIntakeAnswer(wire));
   if(wire.schema_version==='document-field-answer-v3'&&wire.structured_value?.kind==='travel_tariff')return JSON.stringify(parseTravelTariffWireAnswer(wire));
   return JSON.stringify(wire.schema_version==='document-field-answer-v3'?parseDocumentFieldAnswerV3(answer):parseDocumentFieldAnswer(answer));
  }catch{throw new RequestAnswerError();}
 }
 if(request.code.startsWith(HOURS_CONFLICT_NAMESPACE)){
  if(request.answer_kind!=='text')throw new RequestAnswerError();
  try{return JSON.stringify(parseHoursConflictAnswer(answer));}catch{throw new RequestAnswerError();}
 }
 if(request.answer_kind==='choice'&&!request.options?.includes(answer))throw new RequestAnswerError();
 if(request.answer_kind==='number'){
  if(!/^-?\d{1,9}(?:\.\d{1,4})?$/.test(answer)||!Number.isFinite(Number(answer)))throw new RequestAnswerError();
  if(request.code==='regular_day_hours_unknown'&&(Number(answer)<=0||Number(answer)>24))throw new RequestAnswerError();
  if(request.code.startsWith('low_confidence:')&&Number(answer)<0)throw new RequestAnswerError();
 }
 return answer;
}
