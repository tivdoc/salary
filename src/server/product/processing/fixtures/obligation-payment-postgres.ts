import {randomUUID,createHash} from 'node:crypto';
import type pg from 'pg';
import {PDFDocument} from 'pdf-lib';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import type {StoredCaseInputSnapshot} from '@/engine/case-analysis/contracts';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {normalizeMoney} from '@/engine/extraction/normalization';
import {normalizedPayslipExtractionSchema} from '@/engine/extraction/payslip';
import {normalizeDocumentEvidence} from '@/engine/extraction/document-evidence/normalization';
import {createDocumentEvidenceReadingTarget,resolveDocumentEvidenceReading} from '@/engine/extraction/document-evidence/reading';
import {savedNonPayslipEvidenceSchema} from '@/engine/extraction/document-evidence/snapshot';
import {observation} from '@/engine/entitlement-review/obligations/product-flow.fixture';
import {attachNonPayslipInventory} from '@/engine/document-review/non-payslip';
import {attachAutomaticNonPayslipEvidence} from '@/engine/entitlement-review/automatic-nonpay';
import {reviewInputFromPayslips,PAYSLIP_REVIEW_POLICY} from '@/engine/document-review/payslip-adapter';
import {SAVED_EXTRACTION_POLICY} from '../saved-snapshot';
import type {seedSourceKindFixture} from './source-kind-postgres';

export type ObligationDbCase=Awaited<ReturnType<typeof seedSourceKindFixture>>;
/** Deterministic reviewed contract evidence is explicitly injected test data.
 * Payroll amount reading is NOT injected: the actual identified web answer is
 * replayed by SavedCaseSnapshot before this ordinary engine composition. */
export async function obligationPaymentFixture(f:ObligationDbCase){
 const base=buildSyntheticCaseFixture({fixture_id:`obligation-payment:${f.caseId}`,mode:'real'}),versionId=randomUUID(),documentId=randomUUID(),componentId=randomUUID();
 const pdf=await PDFDocument.create(),page=pdf.addPage();page.drawText('SYNTHETIC ONLY - June 2026 - payment row 450.00');page.drawText(versionId,{x:30,y:30,size:8});const bytes=await pdf.save();
 const hash=createHash('sha256').update(bytes).digest('hex'),period={from:'2026-06-01',to:'2026-06-30'};
 const source={document_id:versionId,page:1,text_fragment:'SYNTHETIC payment row 450.00',source_scope:{period_kind:'current' as const,fund_kind:'unknown' as const,column_label:'Current amount'}};
 const old=base.stored.extractions[0],candidate=old.fields.find(p=>p.field==='salary_period')!;
 const machine=normalizedPayslipExtractionSchema.parse({...old,document_id:versionId,extracted_at:'2026-07-02T00:00:00Z',
  fields:[{...candidate,source,raw_value:'06/2026',normalized_value:{year:2026,month:6,start_date:period.from,end_date:period.to}}],
  additional_components:[{component_id:componentId,source_label:'בונוס סינתטי',normalized_label:'synthetic.bonus',semantic_kind:'bonus',quantity_raw:'1',rate_raw:'450.00',percentage_raw:null,amount_raw:'450.00',
   quantity:'1',rate:normalizeMoney('450.00'),percentage:null,amount:normalizeMoney('450.00'),confidence:1,source,extraction_method:'fixture',warning_flags:[],normalization_warnings:[]}],earnings_components_complete:false});
 const result={final_extraction:machine,first_pass:{normalized_extraction:machine}},checkpoint={schema_version:'tivdoc-saved-extraction-v1' as const,case_id:f.caseId,product_document_id:documentId,version_id:versionId,
  input_sha256:hash,expected_month:'2026-06',period_mismatch:false,requires_confirmation:false,result_sha256:canonicalSha256(result),run:{result}};
 const contractDocument={...base.stored.documents[0],case_id:f.caseId,document_id:f.versionId,document_type:'contract' as const,document_period:null,
  size_bytes:f.size,content_sha256:f.hash,storage_path:`cases/${f.caseId}/documents/${f.versionId}/original.pdf`,created_at:'2026-07-01T00:00:00Z'};
 const normalized=normalizeDocumentEvidence({document:contractDocument,physicalPageCount:1,raw:{schema_version:'document-evidence-provider-v1',detected_document_type:'contract',page_count:1,pages:[{page:1,coverage:'complete',missing_regions:[]}],
  observations:[observation('clause_text','text','המעסיק ישלם לעובד 500 ש״ח בכל חודש.'),observation('amount','money','500','ILS'),observation('effective_from','iso_date','2026-02-01'),observation('effective_to','iso_date','2026-12-31')],warnings:[]}});
 const readings=normalized.observations.map(o=>{
  const target=createDocumentEvidenceReadingTarget({normalized,productDocumentId:f.documentId,checkpointSha256:'c'.repeat(64),policyVersion:'saved-document-evidence-v1',month:'2026-06',observationId:o.observation_id});
  const reading=resolveDocumentEvidenceReading({target,currentTarget:target,caseId:f.caseId,answer:{action:'confirm'},requestId:randomUUID(),answerRevision:1,identityId:f.identityId,answeredAt:'2026-07-02T00:00:00Z'});
  if(reading.state!=='current')throw Error('SYNTHETIC_CONTRACT_READING');return reading.reading;
 });
 const contract=savedNonPayslipEvidenceSchema.parse({document:contractDocument,product_document_id:f.documentId,checkpoint_result_sha256:'c'.repeat(64),provider_receipt_sha256:'b'.repeat(64),extraction:normalized,failure_code:null,readings});
 return {versionId,documentId,componentId,hash,size:bytes.length,checkpoint,period,contract,
  review(snapshot:StoredCaseInputSnapshot){
   const withContract={...snapshot,non_payslip_evidence:[contract]};
   const payroll=reviewInputFromPayslips({case_id:f.caseId,period,purchased_scope:{order_id:f.scope.id,origin:'legacy_paid_receipt',receipt_sha256:f.scope.receipt_sha256,topics:[...f.scope.topics]},review_policy:PAYSLIP_REVIEW_POLICY,snapshot});
   return attachAutomaticNonPayslipEvidence(attachNonPayslipInventory(payroll,withContract),withContract).input;
  }};
}

export async function seedObligationPayroll(owner:pg.Client,f:ObligationDbCase,data:Awaited<ReturnType<typeof obligationPaymentFixture>>,slot:'payslip-01'|'payslip-02'='payslip-01'){
 await owner.query('begin');
 try{
  await owner.query("insert into public.documents(id,case_id,version_id,document_type,slot,storage_path,original_filename,mime_type,size,content_sha256,period_month) values($1,$2,$3,'payslip',$7,$4,'SYNTHETIC-OBLIGATION-PAYROLL.pdf','application/pdf',$5,$6,'2026-06-01')",[data.documentId,f.caseId,data.versionId,`cases/${f.caseId}/versions/${data.versionId}.pdf`,data.size,data.hash,slot]);
  await owner.query('insert into private.case_extraction_checkpoints(case_id,revision,version_id,input_sha256,policy_version,result_sha256,result) select $1,revision,$2,$3,$4,$5,$6 from private.case_input_heads where case_id=$1',
   [f.caseId,data.versionId,data.hash,SAVED_EXTRACTION_POLICY,data.checkpoint.result_sha256,data.checkpoint]);
  await owner.query('commit');
 }catch(error){await owner.query('rollback');throw error;}
}
