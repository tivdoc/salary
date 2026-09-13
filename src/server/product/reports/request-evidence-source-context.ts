import {z} from 'zod';
import type {CaseAccessDb} from '../case-access/db';
import {evidenceSourceDocumentSchema,evidenceSourcePurchaseSchema,documentEvidenceSourceTranscriptionTarget,documentEvidenceSourceTranscriptionTargetSchema} from './document-evidence-source-transcription';

export async function loadRequestEvidenceSourceContext(input:{store:CaseAccessDb;caseId:string;identityId:string;requestId:string;target:unknown}){
 const target=documentEvidenceSourceTranscriptionTargetSchema.parse(input.target);
 if(target.case_id!==z.uuid().parse(input.caseId))throw Error('REQUEST_FIELD_FORBIDDEN');
 z.uuid().parse(input.identityId);z.uuid().parse(input.requestId);
 const rows=await input.store.rpc<{value:unknown}>('case_request_evidence_source_context',{target_case:input.caseId,target_identity:input.identityId,target_request:input.requestId});
 if(rows.length!==1||rows[0].value===null)throw Error('REQUEST_FIELD_SOURCE_CHANGED');
 const current=z.object({source:evidenceSourceDocumentSchema,purchase:evidenceSourcePurchaseSchema,month:z.string(),page:z.number().int().positive().nullable()}).strict().parse(rows[0].value);
 if(current.source.case_id!==input.caseId||documentEvidenceSourceTranscriptionTarget(current).target_sha256!==target.target_sha256)throw Error('REQUEST_FIELD_SOURCE_CHANGED');
 return current;
}
