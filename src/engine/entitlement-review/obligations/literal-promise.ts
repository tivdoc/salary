import {normalizeMoney} from '../../extraction/normalization.ts';

/** Full clause only. No amount search, ranges, discretion, fallback currency
 * or missing-quantity default. Historical automatic grammar is kept exact. */
export function parseObligationLiteralPromise(text:string){
 const match=/^המעסיק ישלם לעובד(?:ת)? (בונוס בסך )?([0-9]+(?:\.[0-9]{1,2})?) (?:ש״ח|ש"ח|ILS) (בכל חודש|לחודש|לכל (שעה|יום|משמרת) בחודש)[.]?$/u.exec(text.trim());
 if(!match)return null;
 const amount=normalizeMoney(match[2],'ILS');if(!amount)return null;
 return {bonus:!!match[1],minor:amount.minor_units,kind:match[4]?'linear' as const:'fixed' as const,
  unit:match[4]==='שעה'?'hours' as const:match[4]==='יום'?'days' as const:'count' as const};
}
