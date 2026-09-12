import {buildLegacyPaidScope} from '../../orders/legacy-paid-receipt.ts';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {documentSourcePeriodIntakeTarget,type SourceIntakeDocument,type SourceIntakeAnchor} from '../../reports/document-source-period-intake.ts';
export function legacySourceIntakeFixture(){
 const caseId='11111111-1111-4111-8111-111111111111',paymentId='22222222-2222-4222-8222-222222222222';
 const built=buildLegacyPaidScope({case:{id:caseId,public_id:'SYNTHETIC-INTAKE',payment_status:'verified',is_qa:false},
  payment:{id:paymentId,case_id:caseId,provider:'invoice4u',amount:'9.99',currency:'ILS',status:'verified',verified_at:'2026-08-30T00:00:00Z',
   idempotency_key:caseId+':initial-check',provider_order_id:'tivdoc-salary:SYNTHETIC-INTAKE',provider_payment_id:'1001',provider_reference:'2001',provider_clearing_log_id:'2001',provider_confirmation_number:'3001'},
  source:{project_ref:'a'.repeat(20),captured_at:'2026-09-11T00:00:00Z',snapshot_sha256:'b'.repeat(64)},periods:[]});
 if(built.state!=='admitted')throw Error('SYNTHETIC_FIXTURE');const scope=built.scope;
 const document:SourceIntakeDocument={id:'33333333-3333-4333-8333-333333333333',version_id:'44444444-4444-4444-8444-444444444444',sha256:'c'.repeat(64),type:'payslip',page_count:2};
 const original={case_id:caseId,documents:[document],legacy_orders:[scope],answers:[]};
 const anchor:SourceIntakeAnchor={revision:1,input_sha256:'d'.repeat(64),journal_sha256:canonicalSha256(original),input:original};
 const target=documentSourcePeriodIntakeTarget({source:{document,anchor},scope});
 const answer={v:1 as const,action:'correct' as const,value:{document_kind:'payslip' as const,period:{from:'2026-06-01',to:'2026-06-30'},page:1,source_label:'Synthetic printed June 2026 payroll heading'}};
 const answerRow={id:'55555555-5555-4555-8555-555555555555',case_id:caseId,scope_month:null,code:'document_field:'+target.target_sha256,answer_kind:'choice',answer:JSON.stringify(answer),
  answer_revision:1,answer_identity_id:'66666666-6666-4666-8666-666666666666',answer_created_at:'2026-09-12T12:00:00Z',field_target:target};
 const journal={...original,answers:[answerRow]};
 return {caseId,scope,document,anchor,target,answer,answerRow,journal,input:{caseId,revision:2,inputSha256:'e'.repeat(64),journalSha256:canonicalSha256(journal),journal,currentDocuments:[document],sourceAnchors:[anchor]}};
}
