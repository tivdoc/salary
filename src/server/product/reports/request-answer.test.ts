import {it,expect} from 'vitest';
import {validateRequestAnswer as validate} from './request-answer';
it('P06 rejects forged choices, nonfinite numbers, impossible day length and document text',()=>{
 for(const [request,value] of [[{answer_kind:'choice',options:['5','6'],code:'schedule_unknown'},'7'],[{answer_kind:'number',code:'regular_day_hours_unknown'},'25'],[{answer_kind:'number',code:'other'},'Infinity'],[{answer_kind:'document',code:'document_missing'},'uploaded']] as const)expect(()=>validate({...request,options:'options' in request?[...request.options]:undefined},value)).toThrow('REQUEST_ANSWER_INVALID');
 expect(validate({answer_kind:'number',code:'regular_day_hours_unknown'},' 8.5 ')).toBe('8.5');
});
