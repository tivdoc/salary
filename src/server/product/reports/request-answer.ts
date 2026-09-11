import type {StoredRequest} from './case-requests';
import {HOURS_CONFLICT_NAMESPACE,parseHoursConflictAnswer} from './document-hours-conflict-answer';
export class RequestAnswerError extends Error { constructor(){super('REQUEST_ANSWER_INVALID');} }
export function validateRequestAnswer(request:Pick<StoredRequest,'answer_kind'|'options'|'code'>,value:string):string{
 const answer=value.trim();
 if(!answer||answer.length>2000||request.answer_kind==='document'||request.answer_kind==='none')throw new RequestAnswerError();
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
