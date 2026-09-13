import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {legacySourceIntakeFixture} from '../processing/saved-legacy-source-intake.fixture';
import {documentSourcePeriodIntakeTarget,legacySourceDocumentNeedTarget} from '../reports/document-source-period-intake';
import {buildSourceIntakeUploadReceipt,sourceIntakeUploadScopeSchema} from './source-intake-upload';
export function sourceIntakeUploadFixture(month?:string){
 const f=legacySourceIntakeFixture(),empty={...f.journal,documents:[],answers:[]},opening={revision:1,input_sha256:'1'.repeat(64),journal_sha256:canonicalSha256(empty),input:empty};
 const sourceAnchor={...f.anchor,revision:2},target=documentSourcePeriodIntakeTarget({scope:f.scope,source:{document:f.document,anchor:sourceAnchor}});
 const answerRow={...f.answerRow,field_target:target,code:'document_field:'+target.target_sha256};
 const journal={...f.journal,answers:[answerRow]},context={...f.input,revision:3,journal,journalSha256:canonicalSha256(journal),sourceAnchors:[opening,sourceAnchor]};
 const scope=sourceIntakeUploadScopeSchema.parse({schema_version:'legacy-source-intake-upload-scope-v1',request_id:'77777777-7777-4777-8777-777777777777',target:legacySourceDocumentNeedTarget({scope:f.scope,anchor:opening,month})});
 const receipt=buildSourceIntakeUploadReceipt({scope,case_id:f.caseId,batch_id:'88888888-8888-4888-8888-888888888888',received_at:'2026-09-12T11:00:00Z',existing_source_hashes:[],files:[{
  document_id:f.document.id,version_id:f.document.version_id,source_sha256:f.document.sha256,document_kind:'payslip',period_month:null,page_count:2,duplicate_content:false}]});
 return {...f,scope,receipt,context,opening,sourceAnchor,target,answerRow};
}
