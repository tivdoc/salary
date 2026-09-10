import {describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {syntheticPayslipFixtures} from '@/engine/extraction/fixtures/source-fixtures';
import {extractionResultSchema,type PayslipFieldKey} from '@/engine/extraction/contracts';
import {buildPassEvaluation} from '@/engine/extraction/v2';
import {resolvePayslipExtractionPassesV21} from '@/engine/extraction/v21';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {createOpenAiProviderReceipt} from '@/server/engine/extraction/providers/openai/provider-receipt';
import {readSavedExtractionProvenance} from '../processing/live-extraction-provenance';
import {COMPONENT_AMOUNT_TRANSCRIPTION_ANSWERS,SALARY_TYPE_TRANSCRIPTION_ANSWERS,createDocumentTranscriptionTarget,
 documentTranscriptionQuestion,documentTranscriptionReadingSchema,documentTranscriptionTargetSchema,resolveDocumentTranscriptionReading,
 type DocumentTranscriptionSelector} from './document-field-transcription';

const at='2026-09-10T00:00:00.000Z',policy='saved-payslip-v21-p95-v1';
/** Independently specified synthetic reading. Pure evaluation and an explicitly
 * injected receipt; no SDK, DB, storage bytes, provider or human is invoked. */
function fixture(){
 const template=syntheticPayslipFixtures[0],version=randomUUID(),caseId=randomUUID();
 const fields:readonly [PayslipFieldKey,string][]=[['document_type','payslip'],['salary_period','06/2026'],['gross_salary','3,300.00'],['total_deductions','0.00'],['net_salary','3,300.00'],['hourly_rate','33.00']];
 const raw=extractionResultSchema.parse({...template.extraction,extraction_id:randomUUID(),document_id:version,status:'completed',detected_document_type:'payslip',
  extracted_at:at,document_quality_confidence:.96,quality_metrics:{page_count:1,text_coverage:null,rotation_degrees:0,source_resolution_dpi:null},
  provider:{provider_id:'openai',extractor_version:'2.1',model_version:'synthetic-transcription'},
  operation:{duration_ms:3,provider_response_id:'resp_synthetic_transcription',token_usage:null},
  fields:fields.map(([field,raw_value])=>({field,raw_value,candidate_id:randomUUID(),confidence:.94,
   source:{document_id:version,page:1,text_fragment:field},extraction_method:'ai_vision',warning_flags:[]})),
  additional_components:[{component_id:randomUUID(),source_label:'Regular hourly base',normalized_label:null,semantic_kind:'unknown',
   quantity_raw:null,rate_raw:'33.00',percentage_raw:null,amount_raw:'3,300.00',confidence:.94,
   source:{document_id:version,page:1,text_fragment:'Regular hourly base'},extraction_method:'ai_vision',warning_flags:[]}],
  earnings_components_complete:true,sensitive_metadata:[],warnings:['salary_type_documented_pair_invalid'],error_code:null});
 const first=buildPassEvaluation({pass_id:raw.extraction_id,kind:'first_pass',requested_fields:fields.map(([field])=>field),selected_regions:[],model:'synthetic-transcription',
  prompt_version:'transcription-unit-v1',raw_extraction:raw,salary_type_assessment:{documented:null,inferred:null},
  totals_section_visible:true,pension_section_visible:false,critical_context:{required_fields:['salary_period']},reference_year:2026});
 const result=structuredClone(resolvePayslipExtractionPassesV21({first_pass:first,recovery_passes:[],
  recovery_decision:{requested:false,skipped:true,fields_requested:[],regions:[],reason_codes:['unit_test_no_recovery'],expected_information_gain:'none'},
  final_extraction_id:randomUUID(),critical_context:{required_fields:['salary_period']},reference_year:2026}));
 const receipt=createOpenAiProviderReceipt({schema_version:'tivdoc-openai-provider-receipt-v1',origin:'injected_test_provider',case_id:caseId,analysis_run_id:randomUUID(),
  document_id:version,extraction_id:raw.extraction_id,source_sha256:template.request.document.content_sha256,source_size_bytes:1000,source_mime_type:'application/pdf',source_page_count:1,
  request_sha256:'a'.repeat(64),raw_extraction_sha256:canonicalSha256(raw),pass_kind:'first_pass',requested_model:'synthetic-transcription',actual_model:'synthetic-transcription',
  extractor_version:'2.1',prompt_version:first.prompt_version,provider_response_id:raw.operation.provider_response_id,provider_request_id:'req_synthetic_transcription',
  provider_attempted:true,status:'completed',error_code:null,http_status:200,duration_ms:raw.operation.duration_ms,token_usage:null,
  cost:{status:'not_returned_by_provider',amount_usd:null},created_at:at});
 const checkpoint={schema_version:'tivdoc-saved-extraction-v1' as const,case_id:caseId,product_document_id:randomUUID(),version_id:version,input_sha256:template.request.document.content_sha256,
  expected_month:'2026-06',period_mismatch:false,result_sha256:canonicalSha256(result),run:{result,provider_receipts:[receipt]}};
 const extraction=result.final_extraction,component=extraction.additional_components[0];
 const rehash=()=>{checkpoint.result_sha256=canonicalSha256(result);};
 const target=(kind:'salary_type'|'component_amount'='component_amount')=>createDocumentTranscriptionTarget({checkpoint,policyVersion:policy,
  subject:kind==='salary_type'?{kind}:{kind,componentId:component.component_id}});
 const input=(kind:'salary_type'|'component_amount'='component_amount')=>({target:target(kind),currentCheckpoint:checkpoint,policyVersion:policy,caseId,month:'2026-06',
  requestId:randomUUID(),answerRevision:1,identityId:randomUUID(),answeredAt:at,answer:kind==='salary_type'?SALARY_TYPE_TRANSCRIPTION_ANSWERS[0]:COMPONENT_AMOUNT_TRANSCRIPTION_ANSWERS[0]});
 return {checkpoint,extraction,component,rehash,target,input};
}

describe('source-bound absent-field transcription',()=>{
 it('keeps the entire observed component and exact identified answer without inventing a candidate, confidence or legal decision',()=>{
  const f=fixture(),before=structuredClone(f.checkpoint),target=f.target(),input={...f.input(),answerRevision:3},resolved=resolveDocumentTranscriptionReading(input);
  expect(readSavedExtractionProvenance(f.checkpoint).kind).toBe('injected_test_provider');
  expect(target.subject).toEqual({kind:'component_amount',component:f.component});expect(f.component.confidence).toBe(.94);
  expect(resolved).toMatchObject({state:'confirmed_reading',reading:{actor_kind:'customer',reading_kind:'document_transcription',request_id:input.requestId,
   answer_revision:3,identity_id:input.identityId,normalized_value:{currency:'ILS',minor_units:330000}}});
  expect(resolved).not.toHaveProperty('candidate_id');expect(resolved).not.toHaveProperty('legal_approval');expect(f.checkpoint).toEqual(before);
  const question=documentTranscriptionQuestion(target);expect(question.question).toContain('Regular hourly base');expect(question.question).toContain('3300.00 ₪');
  expect(question.question).toContain('לקריאת הסכום בלבד');expect(question.question.length).toBeLessThanOrEqual(400);expect(question.options).toEqual([...COMPONENT_AMOUNT_TRANSCRIPTION_ANSWERS]);
 });
 it.each([['hourly',0],['monthly',1],['mixed',2]] as const)('transcribes only the printed salary type %s', (value,index)=>{
  const f=fixture(),input=f.input('salary_type');
  expect(resolveDocumentTranscriptionReading({...input,answer:SALARY_TYPE_TRANSCRIPTION_ANSWERS[index]})).toMatchObject({state:'confirmed_reading',reading:{normalized_value:value}});
  expect(documentTranscriptionQuestion(input.target).question).toContain('אין להסיק');
  expect(f.extraction.fields.some(field=>field.field==='salary_type')).toBe(false);
 });
 it.each(['salary_type','component_amount'] as const)('keeps negative/absent/unreadable %s answers unconfirmed',kind=>{
  const f=fixture(),input=f.input(kind),options=kind==='salary_type'?SALARY_TYPE_TRANSCRIPTION_ANSWERS.slice(3):COMPONENT_AMOUNT_TRANSCRIPTION_ANSWERS.slice(1);
  for(const answer of options)expect(resolveDocumentTranscriptionReading({...input,answer})).toEqual({state:'unconfirmed'});
 });
 it.each(['salary_type','component_amount'] as const)('refuses a present %s candidate even when null or low-confidence',kind=>{
  for(const value of [null,'present'] as const){const f=fixture(),source=f.extraction.fields[0];
   f.extraction.fields.push(kind==='salary_type'?{...source,candidate_id:randomUUID(),field:'salary_type',confidence:.2,normalized_value:value===null?null:'hourly'}
    :{...source,candidate_id:randomUUID(),field:'base_monthly_salary',confidence:.2,normalized_value:value===null?null:{currency:'ILS',minor_units:330000}});
   f.rehash();expect(()=>f.target(kind)).toThrow();
  }
 });
 it.each(['case','product-document','version','bytes','checkpoint','month','policy','component-id','component-amount','component-confidence','component-page'] as const)('invalidates a previously saved reading after %s changes',change=>{
  const f=fixture(),input=f.input();
  if(change==='case')f.checkpoint.case_id=randomUUID();
  if(change==='product-document')f.checkpoint.product_document_id=randomUUID();
  if(change==='version')f.checkpoint.version_id=randomUUID();
  if(change==='bytes')f.checkpoint.input_sha256='b'.repeat(64);
  if(change==='checkpoint')f.extraction.warnings.push('conflicting_amount');
  if(change==='month')input.month='2026-07';
  if(change==='policy')input.policyVersion='changed-policy';
  if(change==='component-id')f.component.component_id=randomUUID();
  if(change==='component-amount')f.component.amount!.minor_units++;
  if(change==='component-confidence')f.component.confidence=.93;
  if(change==='component-page')f.component.source.page=2;
  f.rehash();expect(resolveDocumentTranscriptionReading(input)).toEqual({state:'stale'});
 });
 it('rejects a foreign case and tampered target or receipt hashes',()=>{
  const f=fixture(),target={...f.target(),source_sha256:'c'.repeat(64)};
  expect(()=>resolveDocumentTranscriptionReading({...f.input(),caseId:randomUUID()})).toThrow('TRANSCRIPTION_CASE_MISMATCH');
  expect(documentTranscriptionTargetSchema.safeParse(target).success).toBe(false);
  f.checkpoint.run.provider_receipts[0]={...f.checkpoint.run.provider_receipts[0],receipt_sha256:'d'.repeat(64)};expect(f.target).toThrow();
 });
 it.each(['missing-period','partial-period','multi-page','legacy-page','unknown-provider','provider-readings','provider-result-hash'] as const)('refuses %s evidence',change=>{
  const f=fixture();
  if(change==='missing-period')f.extraction.fields=f.extraction.fields.filter(field=>field.field!=='salary_period');
  if(change==='partial-period'){const period=f.extraction.fields.find(field=>field.field==='salary_period')!;period.normalized_value={year:2026,month:6,start_date:'2026-06-02',end_date:'2026-06-30'};}
  if(change==='multi-page')f.extraction.quality_metrics.page_count=2;
  if(change==='legacy-page'){const {receipt_sha256,source_page_count,...body}=f.checkpoint.run.provider_receipts[0];void receipt_sha256;void source_page_count;f.checkpoint.run.provider_receipts[0]=createOpenAiProviderReceipt(body);}
  if(change==='unknown-provider')f.checkpoint.run.provider_receipts=[];
  if(change==='provider-readings')f.extraction.customer_readings=[];
  f.rehash();if(change==='provider-result-hash')f.checkpoint.result_sha256='e'.repeat(64);expect(f.target).toThrow();
 });
 it.each(['no-amount','zero','negative','foreign-currency','amount-raw-missing','amount-raw-conflict','percentage','percentage-raw','warning','normalization-warning','incomplete','second-component','known-semantic','gross-conflict','gross-duplicate','arithmetic-warning'] as const)('refuses unsupported component evidence: %s',change=>{
  const f=fixture(),c=f.component;
  if(change==='no-amount')c.amount=null;
  if(change==='zero')c.amount!.minor_units=0;
  if(change==='negative')c.amount!.minor_units=-100;
  if(change==='foreign-currency')c.amount!.currency='USD';
  if(change==='amount-raw-missing')c.amount_raw=null;
  if(change==='amount-raw-conflict')c.amount_raw='3301.00';
  if(change==='percentage')c.percentage={basis_points:100};
  if(change==='percentage-raw')c.percentage_raw='1%';
  if(change==='warning')c.warning_flags=['ambiguous_value'];
  if(change==='normalization-warning')c.normalization_warnings=['normalization_failed'];
  if(change==='incomplete')f.extraction.earnings_components_complete=false;
  if(change==='second-component')f.extraction.additional_components.push({...structuredClone(c),component_id:randomUUID()});
  if(change==='known-semantic')c.semantic_kind='base_salary';
  if(change==='gross-conflict')f.extraction.fields.find(field=>field.field==='gross_salary')!.normalized_value={currency:'ILS',minor_units:330001};
  if(change==='gross-duplicate')f.extraction.fields.push({...structuredClone(f.extraction.fields.find(field=>field.field==='gross_salary')!),candidate_id:randomUUID()});
  if(change==='arithmetic-warning')f.extraction.warnings.push('payslip_totals_mismatch');
  f.rehash();expect(f.target).toThrow();
 });
 it('retains pending recovery-reading uncertainty while refusing a conflicting field',()=>{
  const f=fixture(),rate=f.extraction.fields.find(field=>field.field==='hourly_rate')!;
  rate.warning_flags=['recovery_reading_confirmation_required'];f.rehash();expect(f.target().subject).toMatchObject({kind:'component_amount'});
  expect(rate.warning_flags).toEqual(['recovery_reading_confirmation_required']);rate.warning_flags.push('recovery_conflict');f.rehash();expect(f.target).toThrow();
 });
 it.each(['3.300,00','3300.00 ₪',' 3300.00 '])('keeps raw amount %s outside the explicitly admitted SQL grammar',raw=>{
  const f=fixture();f.component.amount_raw=raw;f.rehash();expect(f.target).toThrow('TRANSCRIPTION_COMPONENT_UNSUPPORTED');
 });
 it('preserves small confidence values in the complete target hash without rounding or promotion',()=>{
  const f=fixture();f.component.confidence=1e-7;f.rehash();const target=f.target();expect(target.subject).toMatchObject({component:{confidence:1e-7}});
  const {target_sha256,...body}=target;expect(target_sha256).toBe(canonicalSha256(body));
 });
 it('rejects reading-value substitution and unsupported answer text',()=>{
  const f=fixture(),resolved=resolveDocumentTranscriptionReading(f.input());if(resolved.state!=='confirmed_reading')throw Error('READING_EXPECTED');
  expect(documentTranscriptionReadingSchema.safeParse({...resolved.reading,normalized_value:{currency:'ILS',minor_units:330001}}).success).toBe(false);
  expect(documentTranscriptionReadingSchema.safeParse({...resolved.reading,normalized_value:'hourly'}).success).toBe(false);
  for(const answer of ['3300','yes','hourly',''])expect(()=>resolveDocumentTranscriptionReading({...f.input(),answer})).toThrow('TRANSCRIPTION_ANSWER_INVALID');
 });
});

it.skipIf(!process.env.TIVDOC_TRANSCRIPTION_RETAINED_REPLAY_FILE)('admits only source questions from the retained authentic checkpoint without calling the live provider',()=>{
 const checkpoint=JSON.parse(readFileSync(process.env.TIVDOC_TRANSCRIPTION_RETAINED_REPLAY_FILE!,'utf8')) as unknown;
 const provenance=readSavedExtractionProvenance(checkpoint);expect(provenance.kind).toBe('openai_live');
 const parsed=JSON.parse(JSON.stringify(checkpoint)) as {run:{result:{final_extraction:{additional_components:{component_id:string}[]}}}};
 const original=canonicalSha256(checkpoint),selectors:DocumentTranscriptionSelector[]=[{kind:'salary_type'},{kind:'component_amount',componentId:parsed.run.result.final_extraction.additional_components[0].component_id}];
 for(const subject of selectors){const target=createDocumentTranscriptionTarget({checkpoint,policyVersion:policy,subject});expect(documentTranscriptionQuestion(target).answer_kind).toBe('choice');}
 expect(canonicalSha256(checkpoint)).toBe(original);
});
