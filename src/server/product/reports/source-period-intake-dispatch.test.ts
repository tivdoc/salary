import {it,expect} from 'vitest';
import {legacySourceIntakeFixture} from '../processing/saved-legacy-source-intake.fixture';
import {documentReadingTargetSchema,documentReadingTargetForCheckpoint} from './document-field-confirmation';
import {documentFieldVerificationDisplay,resolveDocumentReadingVerification,materializeDocumentVerification,validateDocumentReadingAnswerForTarget} from './reading-verification';
import {listCaseRequests} from './case-requests';
import type {CaseAccessDb} from '../case-access/db';
import {vi} from 'vitest';
vi.mock('server-only',()=>({}));
function fixture(){const f=legacySourceIntakeFixture();return {...f,input:{target:f.target,caseId:f.caseId,month:null,policyVersion:f.target.policy_version,
 requestId:f.answerRow.id,answerRevision:1,identityId:f.answerRow.answer_identity_id,answeredAt:f.answerRow.answer_created_at,answer:JSON.stringify(f.answer),
 sourcePeriodIntake:{scope:f.scope,currentDocument:f.document,anchor:f.anchor,currentRevision:2}}};}
it('reconstructs a monthless target only from explicit original scope and source context',()=>{
 const f=fixture();expect(documentReadingTargetSchema.parse(f.target)).toEqual(f.target);
 expect(documentReadingTargetForCheckpoint({target:f.target,sourcePeriodIntake:{scope:f.scope,source:{document:f.document,anchor:f.anchor}}})).toEqual(f.target);
 expect(()=>documentReadingTargetForCheckpoint({target:f.target,currentCheckpoint:f.target})).toThrow('SOURCE_INTAKE_CONTEXT_REQUIRED');
 const result=resolveDocumentReadingVerification(f.input);expect(result.state).toBe('intake_current');
 // The monthly numerical materializer cannot turn an intake reading into an operand.
 expect(materializeDocumentVerification(result,'a'.repeat(64))).toBeNull();
});
it.each(['unknown','unreadable'] as const)('retains %s through dispatch without affirmative period evidence',action=>{
 const f=fixture(),result=resolveDocumentReadingVerification({...f.input,answer:JSON.stringify({v:1,action})});
 expect(result.state).toBe('intake_current');if(result.state!=='intake_current')throw Error('SYNTHETIC_RESULT');
 expect(result.reading.answer).toEqual({v:1,action});expect(result.reading.origin).toBe('customer_document_reading');expect(result.reading).not.toHaveProperty('effective_value');
});
it('rejects another case, wrong policy and changed source before producing a current reading',()=>{
 const f=fixture();expect(()=>resolveDocumentReadingVerification({...f.input,caseId:f.answerRow.answer_identity_id})).toThrow('REQUEST_FIELD_CASE_MISMATCH');
 expect(resolveDocumentReadingVerification({...f.input,policyVersion:'different'}).state).toBe('stale');
 expect(resolveDocumentReadingVerification({...f.input,month:'2026-06',currentCheckpoint:undefined}).state).toBe('stale');
 expect(()=>resolveDocumentReadingVerification({...f.input,sourcePeriodIntake:{...f.input.sourcePeriodIntake,currentDocument:{...f.document,sha256:'f'.repeat(64)}}})).toThrow('SOURCE_INTAKE_ANCHOR_DOCUMENT');
});
it('does not admit a monthless target into a legacy numerical answer or accept an unverified page',()=>{
 const f=fixture();expect(()=>validateDocumentReadingAnswerForTarget(f.target,JSON.stringify({schema_version:'document-field-answer-v2',action:'confirm'}))).toThrow('REQUEST_ANSWER_INVALID');
 expect(()=>validateDocumentReadingAnswerForTarget(f.target,JSON.stringify({...f.answer,value:{...f.answer.value,page:3}}))).toThrow('REQUEST_ANSWER_INVALID');
 const display=documentFieldVerificationDisplay(f.target);expect(display).toMatchObject({scope:'source_period_intake_only',period_intake_context:{page_count:2,month:null},source:{page:1,bounding_box:null},actions:['correct','unreadable','unknown']});
});
it('lists a current intake request with client-safe context and no target or journal hashes',async()=>{
 const f=fixture(),row={id:f.answerRow.id,case_id:f.caseId,code:f.answerRow.code,question:'Synthetic intake',answer_kind:'choice',options:[],blocking:true,field_crop:null,opened_at:'2026-09-01T00:00:00Z',expires_at:'2099-01-01T00:00:00Z',answered_at:null,answer_text:null};
 const responses:Record<string,unknown[]>={case_request_list:[row],case_request_revision_list:[],case_request_field_states:[{request_id:row.id,source_current:true}],case_request_field_reading_targets:[{request_id:row.id,target:f.target}]};
 const db:CaseAccessDb={provider:'fake',async rpc<T>(name:string){if(!(name in responses))throw Error('UNEXPECTED_RPC:'+name);return responses[name] as T[];}};
 const [request]=await listCaseRequests(f.caseId,db,f.answerRow.answer_identity_id);expect(request.reading_display?.period_intake_context).toEqual({page_count:2,month:null});
 expect(request.source_current).toBe(true);const display=JSON.stringify(request.reading_display);expect(display).not.toContain(f.target.source_sha256);expect(display).not.toContain('source_journal');expect(display).not.toContain('order_receipt');
});
