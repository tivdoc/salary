import {it,expect} from 'vitest';
import {validateRequestAnswer as validate} from './request-answer';
it('P06 rejects forged choices, nonfinite numbers, impossible day length and document text',()=>{
 for(const [request,value] of [[{answer_kind:'choice',options:['5','6'],code:'schedule_unknown'},'7'],[{answer_kind:'number',code:'regular_day_hours_unknown'},'25'],[{answer_kind:'number',code:'other'},'Infinity'],[{answer_kind:'document',code:'document_missing'},'uploaded']] as const)expect(()=>validate({...request,options:'options' in request?[...request.options]:undefined},value)).toThrow('REQUEST_ANSWER_INVALID');
 expect(validate({answer_kind:'number',code:'regular_day_hours_unknown'},' 8.5 ')).toBe('8.5');
});

const obligationRequest={answer_kind:'choice' as const,code:'document_field:'+'a'.repeat(64),field_crop:'obligation.payment_link',options:[]};
const sourceLink={action:'correct',value:{relationship:'same_obligation',basis:{page:2,locator:'Synthetic payroll row 2',text:'Synthetic printed payment reference'}}};
it.each(['same_obligation','different_obligation'])('accepts a raw %s source reading only through the stored obligation field',relationship=>{
 for(const selected of [false,true]){
  const answer={...sourceLink,value:{...sourceLink.value,relationship},...(selected?{candidate_target_sha256:'b'.repeat(64)}:{})};
  expect(JSON.parse(validate(obligationRequest,JSON.stringify(answer)))).toEqual(answer);
 }
});
it.each(['unknown','unreadable'])('retains raw %s without inventing a candidate, amount, or approval',action=>{
 expect(validate(obligationRequest,JSON.stringify({action}))).toBe(JSON.stringify({action}));
 for(const extra of [{candidate_target_sha256:'b'.repeat(64)},{value:sourceLink.value}])expect(()=>validate(obligationRequest,JSON.stringify({action,...extra}))).toThrow('REQUEST_ANSWER_INVALID');
});
it.each([undefined,null,'payroll.amount','source.structure'])('refuses raw obligation answers when the stored field is %s',field_crop=>{
 for(const answer of [sourceLink,{action:'unknown'},{action:'unreadable'},{...sourceLink,field_crop:'obligation.payment_link'}])
  expect(()=>validate({...obligationRequest,field_crop},JSON.stringify(answer))).toThrow('REQUEST_ANSWER_INVALID');
});
it('requires the stored document-field namespace and choice answer kind',()=>{
 expect(()=>validate({...obligationRequest,code:'other'},JSON.stringify(sourceLink))).toThrow('REQUEST_ANSWER_INVALID');
 for(const answer_kind of ['number','text','document','none'] as const)expect(()=>validate({...obligationRequest,answer_kind},JSON.stringify(sourceLink))).toThrow('REQUEST_ANSWER_INVALID');
});
it.each([
 {action:'confirm'},
 {schema_version:'document-field-answer-v2',action:'confirm'},
 {schema_version:'document-field-answer-v2',action:'correct',corrected_raw_value:'100'},
 {schema_version:'document-field-answer-v3',action:'unknown'},
 {v:1,action:'unknown'},
 {...sourceLink,candidate_target_sha256:'bad'},
 {...sourceLink,value:{...sourceLink.value,amount:'100'}},
 {...sourceLink,value:{...sourceLink.value,relationship:'allocation_approved'}},
 {...sourceLink,scope_assessment:'approved'},
 {...sourceLink,value:{...sourceLink.value,basis:{...sourceLink.value.basis,page:0}}},
])('refuses cross-target or approval-bearing obligation payload %#',answer=>{
 expect(()=>validate(obligationRequest,JSON.stringify(answer))).toThrow('REQUEST_ANSWER_INVALID');
});
it('preserves the separate scalar reading parser for ordinary document fields',()=>{
 const answer=JSON.stringify({schema_version:'document-field-answer-v2',action:'confirm'});
 expect(validate({...obligationRequest,field_crop:'payroll.amount'},answer)).toBe(answer);
});
