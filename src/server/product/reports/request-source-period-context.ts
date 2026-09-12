import 'server-only';
import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {savedSourcePeriodReadings} from '../processing/saved-field-readings';
import type {CaseAccessDb} from '../case-access/db';
import {documentReadingTargetForCheckpoint} from './document-field-confirmation';
import {documentSourceStructureTargetSchema,type DocumentSourceStructureTarget} from './document-source-structure';

const sha=z.string().regex(/^[a-f0-9]{64}$/u);
const contextSchema=z.object({case_id:z.uuid(),request_id:z.uuid(),source_revision:z.number().int().positive(),source_input_sha256:sha,source_journal_sha256:sha,
 source_journal:z.record(z.string(),z.unknown()),checkpoint:z.unknown()}).strict();
const checkpointPins=z.object({case_id:z.uuid(),product_document_id:z.uuid(),version_id:z.uuid(),input_sha256:sha,expected_month:z.string(),result_sha256:sha});

/** This RPC returns one owner-authorized head and its exact immutable journal.
 * Its locked SQL writer repeats currentness after this read to close the race.
 * No browser-supplied journal or embedded target witness is authority here. */
export async function loadRequestSourcePeriodContext(input:{store:CaseAccessDb;caseId:string;identityId:string;requestId:string;target:DocumentSourceStructureTarget}){
 z.uuid().parse(input.caseId);z.uuid().parse(input.identityId);z.uuid().parse(input.requestId);
 const target=documentSourceStructureTargetSchema.parse(input.target);
 if(!('period_witness' in target)||target.case_id!==input.caseId)throw Error('REQUEST_FIELD_FORBIDDEN');
 const rows=await input.store.rpc<{value:unknown}>('case_request_source_period_context',{target_case:input.caseId,target_identity:input.identityId,target_request:input.requestId});
 if(!rows.length||rows.length===1&&rows[0].value===null)throw Error('REQUEST_FIELD_SOURCE_CHANGED');
 if(rows.length!==1)throw Error('REQUEST_FIELD_CONTEXT_AMBIGUOUS');
 const current=contextSchema.parse(rows[0].value),checkpoint=checkpointPins.parse(current.checkpoint);
 if(current.case_id!==input.caseId||current.request_id!==input.requestId||canonicalSha256(current.source_journal)!==current.source_journal_sha256
  ||checkpoint.case_id!==input.caseId||checkpoint.product_document_id!==target.product_document_id||checkpoint.version_id!==target.version_id
  ||checkpoint.input_sha256!==target.source_sha256||checkpoint.expected_month!==target.month||checkpoint.result_sha256!==target.extraction_result_sha256)
  throw Error('REQUEST_FIELD_CONTEXT_INVALID');
 const periodReadings=savedSourcePeriodReadings({caseId:input.caseId,month:target.month,policyVersion:target.policy_version,journal:current.source_journal,checkpoint:current.checkpoint});
 let reconstructed;
 try{reconstructed=documentReadingTargetForCheckpoint({target,currentCheckpoint:current.checkpoint,periodReadings});}
 catch(error){
  if(error instanceof Error&&error.message==='SOURCE_STRUCTURE_PERIOD_NOT_CURRENT')throw Error('REQUEST_FIELD_SOURCE_CHANGED');
  throw error;
 }
 if(reconstructed.target_sha256!==target.target_sha256)throw Error('REQUEST_FIELD_SOURCE_CHANGED');
 return {currentCheckpoint:current.checkpoint,periodReadings,sourceRevision:current.source_revision,sourceInputSha256:current.source_input_sha256,sourceJournalSha256:current.source_journal_sha256};
}
