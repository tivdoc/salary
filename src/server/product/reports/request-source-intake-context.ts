import {z} from 'zod';
import type {CaseAccessDb} from '../case-access/db';
import {savedLegacySourceIntake,sourceIntakeJournalInputSchema} from '../processing/saved-legacy-source-intake';
import {documentSourcePeriodIntakeTargetSchema,documentSourcePeriodIntakeTarget,sourceIntakeAnchorSchema} from './document-source-period-intake';

/** Protected SQL verifies stored PG input hashes and membership. Replay then
 * reconstructs the exact opening target from the original scope and current
 * physical source; a browser cannot supply this context or an authority flag. */
export async function loadRequestSourceIntakeContext(input:{store:CaseAccessDb;caseId:string;identityId:string;requestId:string;target:unknown}){
 const target=documentSourcePeriodIntakeTargetSchema.parse(input.target);
 if(target.case_id!==z.uuid().parse(input.caseId))throw Error('REQUEST_FIELD_FORBIDDEN');
 z.uuid().parse(input.identityId);z.uuid().parse(input.requestId);
 const rows=await input.store.rpc<{value:unknown}>('case_request_source_intake_context',{target_case:input.caseId,target_identity:input.identityId,target_request:input.requestId});
 if(rows.length===1&&rows[0].value===null)throw Error('REQUEST_FIELD_SOURCE_CHANGED');
 if(rows.length!==1)throw Error('SOURCE_INTAKE_CONTEXT_AMBIGUOUS');
 const context=sourceIntakeJournalInputSchema.parse(rows[0].value);
 if(context.caseId!==input.caseId)throw Error('SOURCE_INTAKE_CONTEXT_CASE');
 const saved=savedLegacySourceIntake(context),scope=saved.scopes.find(s=>s.id===target.order_id&&s.receipt_sha256===target.order_receipt_sha256);
 const currentDocument=saved.documents.find(d=>d.id===target.product_document_id&&d.version_id===target.version_id&&d.sha256===target.source_sha256);
 const anchors=z.array(sourceIntakeAnchorSchema).parse(context.sourceAnchors);
 const matches=anchors.filter(a=>a.revision===target.source_revision&&a.input_sha256===target.source_input_sha256&&a.journal_sha256===target.source_journal_sha256);
 if(!scope||!currentDocument||matches.length!==1||matches[0].revision>saved.revision)throw Error('REQUEST_FIELD_SOURCE_CHANGED');
 const anchor=matches[0],rebuilt=documentSourcePeriodIntakeTarget({scope,source:{document:currentDocument,anchor}});
 if(rebuilt.target_sha256!==target.target_sha256)throw Error('REQUEST_FIELD_SOURCE_CHANGED');
 return {scope,currentDocument,anchor,currentRevision:saved.revision};
}
