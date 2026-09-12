import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {buildSyntheticCaseFixture} from '../../case-analysis/synthetic-fixtures.ts';
import {rawDocumentObservationSchema,type RawDocumentObservation} from '../../extraction/document-evidence/contracts.ts';
import {normalizeDocumentEvidence} from '../../extraction/document-evidence/normalization.ts';
import {createDocumentEvidenceReadingTarget,resolveDocumentEvidenceReading} from '../../extraction/document-evidence/reading.ts';
import {savedNonPayslipEvidenceSchema,type SavedNonPayslipEvidence} from '../../extraction/document-evidence/snapshot.ts';
import {documentReviewInputSchema} from '../../document-review/contracts.ts';
import {attachNonPayslipInventory} from '../../document-review/non-payslip.ts';
import {singleDay} from './working-time.fixture.ts';
import {workingTimeEntitlementInputSchema} from './contracts.ts';
import {enableWorkingTimeProductFacts} from './product-facts.ts';

export const uuid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export const clause=(value:string,row:string)=>rawDocumentObservationSchema.parse({block_id:'synthetic.contract',row_id:row,cell_id:'clause_text',semantic:'clause_text',value_kind:'text',raw_value:value,source_label:'Synthetic literal clause',unit:null,page:1,locator:row,text_fragment:value,state:'present',confidence:.94,warnings:[]});
export const date=(value:string,end=false)=>({...clause(value,end?'end':'start'),semantic:end?'effective_to':'effective_from',value_kind:'iso_date'} as RawDocumentObservation);
export const literalRows=()=>[
 clause('שבוע העבודה הוא בן שישה ימים','week'),clause('ימי העבודה הקבועים הם ראשון, שני, שלישי, רביעי, חמישי, שישי','schedule'),
 clause('שעות התקן ביום ראשון הן 08:00','limit'),clause('השכר הרגיל לשעה הוא 40.00 ש״ח ואין רכיבי שכר רגילים נוספים','wage'),
 date('2026-01-01'),date('2026-12-31',true),
];
export function productFlowFixture(rows=literalRows()){
 const old=buildSyntheticCaseFixture({fixture_id:'working-time-source-flow-synthetic',mode:'real'});
 const document={...old.stored.documents[0],document_type:'contract' as const,document_period:null,created_at:'2026-07-01T00:00:00Z'};
 const extraction=normalizeDocumentEvidence({document,physicalPageCount:1,raw:{schema_version:'document-evidence-provider-v1',detected_document_type:'contract',page_count:1,pages:[{page:1,coverage:'complete',missing_regions:[]}],observations:rows,warnings:[]}});
 let record:SavedNonPayslipEvidence=savedNonPayslipEvidenceSchema.parse({document,product_document_id:uuid(30),checkpoint_result_sha256:'c'.repeat(64),provider_receipt_sha256:'b'.repeat(64),extraction,failure_code:null,readings:[]});
 const input=enableWorkingTimeProductFacts(workingTimeEntitlementInputSchema.parse(JSON.parse(JSON.stringify(singleDay()).replaceAll('synthetic.case',document.case_id).replaceAll('"ai_document_review"','"identified_document_reading"'))));
 input.calculation_policy='working-time-separated-expected-v2';input.applicability=[];
 input.arrangement={state:'missing',value:null,source:null};input.scheduled_weekdays={state:'missing',value:null,source:null};
 input.workdays[0].ordinary_limit={...input.workdays[0].ordinary_limit,state:'missing',printed_value:null};
 const review=()=>{
  const s=input.regular_hourly_wage.source;
  const baseline=documentReviewInputSchema.parse({schema_version:'document-review-product-v1',case_id:input.case_id,period:input.period,purchased_scope:{order_id:'synthetic.order',receipt_sha256:'a'.repeat(64),topics:['working_time','rest_day'],origin:'saved_order'},
   documents:[{case_id:input.case_id,document_id:s.document_id,version_id:s.version_id,file_sha256:s.file_sha256,page_count:1,kind:'attendance',label:'Synthetic attendance and payroll allocation',period:input.period,reading_origin:'identified_document_reading',reading_sha256:s.reading_receipt_sha256}],checks:[],completion_input:{case_id:input.case_id,period:input.period,documents:[{pin:{case_id:input.case_id,document_id:s.document_id,version_id:s.version_id,source_sha256:s.file_sha256},kind:'attendance',period:input.period,review:'complete'}],needs:[],evidence:[]}});
  return attachNonPayslipInventory(baseline,{...old.stored,documents:[document],extractions:[],non_payslip_evidence:[record]});
 };
 const answer=(row:string,answer:unknown={action:'confirm'})=>{
  const o=extraction.observations.find(o=>o.original.row_id===row)!;
  const target=createDocumentEvidenceReadingTarget({normalized:extraction,productDocumentId:record.product_document_id,checkpointSha256:record.checkpoint_result_sha256!,policyVersion:'saved-document-evidence-v1',month:'2026-06',observationId:o.observation_id});
  const prior=record.readings.find(r=>r.target.observation.observation_id===o.observation_id);
  const result=resolveDocumentEvidenceReading({target,currentTarget:target,caseId:document.case_id,answer,requestId:uuid(100+extraction.observations.indexOf(o)),answerRevision:(prior?.answer_revision??0)+1,identityId:uuid(300),answeredAt:'2026-07-02T00:00:00Z'});
  if(result.state!=='current')throw Error('Synthetic current source');record={...record,readings:[...record.readings.filter(r=>r.target.observation.observation_id!==o.observation_id),result.reading]};
 };
 const identify=()=>extraction.observations.forEach(o=>answer(o.original.row_id!));
 return {input,review,answer,identify,extraction,document,get record(){return record;},sourceHash:()=>canonicalSha256(record)};
}
