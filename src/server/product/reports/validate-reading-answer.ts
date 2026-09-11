import {z} from 'zod';
import type {CaseAccessDb} from '../case-access/db';
import {documentReadingTargetSchema} from './document-field-confirmation';
import {validateDocumentReadingAnswerForTarget} from './reading-verification';

/** Validate typed corrections before the authenticated writer captures a new
 * immutable source revision. SQL rechecks currentness inside the case lock. */
export async function validateSavedReadingAnswer(input:{store:CaseAccessDb;caseId:string;identityId?:string;requestId:string;code:string;answer:string}){
 if(!input.identityId)throw Error('REQUEST_FIELD_FORBIDDEN');
 const rows=await input.store.rpc<{request_id:string;target:unknown}>('case_request_field_reading_targets',{target_case:input.caseId,target_identity:input.identityId});
 const matches=rows.filter(r=>r.request_id===input.requestId);if(matches.length!==1)throw Error('REQUEST_FIELD_FORBIDDEN');
 const target=documentReadingTargetSchema.parse(matches[0].target);
 if(target.case_id!==z.uuid().parse(input.caseId)||input.code!==`document_field:${target.target_sha256}`)throw Error('REQUEST_FIELD_FORBIDDEN');
 validateDocumentReadingAnswerForTarget(target,input.answer);
}
