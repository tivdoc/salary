import {createHash} from 'node:crypto';
import {PDFDocument,PDFRawStream} from 'pdf-lib';
import {beforeAll,describe,expect,it} from 'vitest';
import {ownerEngineeringServiceSetup,issueOwnerEngineeringService} from '@/engine/case-analysis/service-owner-engineering.fixture';
import {fixture as sourceFixture} from '@/engine/entitlement-review/compose.fixture';
import {pensionEntitlementInputSchema} from '@/engine/entitlement-review/pension/contracts';
import {obligationsEntitlementInputSchema} from '@/engine/entitlement-review/obligations/contracts';
import {nineTopicRuntimeSource} from '@/engine/ai-release-runtime/runtime.fixture';
import {ownerEngineeringFixture,repinEngineeringFixture} from '@/engine/ai-release-runtime/owner-engineering.fixture';
import {createCaseAnalysisOwnerEngineering} from '@/engine/case-analysis/contracts';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import type {AnalysisResultBundle} from '@/engine/wave3/contracts';
import type {DocumentReviewInput} from '@/engine/document-review/contracts';
import {validateReport} from '@/server/platform/persistence/postgres/analysis/validation';
import {renderOwnerEngineeringBundle,ownerEngineeringPresentation,OWNER_ENGINEERING_REPORT_TEMPLATE} from './owner-engineering-report';
import type {DocumentReviewPresentationInput,DocumentReviewPresentationFinding} from './document-review-artifacts';

const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
async function pdfText(bytes:Uint8Array){
 const pdf=await PDFDocument.load(bytes);return pdf.getPages().map(page=>{
  const stream=page.node.Contents();if(!(stream instanceof PDFRawStream))throw Error('TEST_PDF_CONTENTS_REQUIRED');
  return [...stream.getContentsString().matchAll(/\/ActualText <FEFF([0-9a-f]*)>/giu)].map(m=>Buffer.from(m[1],'hex').swap16().toString('utf16le')).join('');
 }).join('\n');
}
async function bundle(source?:DocumentReviewInput){const f=ownerEngineeringServiceSetup({prepareOwnerEngineering:async c=>issueOwnerEngineeringService(c)},source);return f.service.runCaseAnalysis(f.command);}
function changedSource(state:'zero'|'unknown'){
 const input=sourceFixture().input,p=pensionEntitlementInputSchema.parse(input.entitlement_evidence!.pension);
 if(state==='zero')p.pensionable_wage!.printed_value='0.00';else{p.pensionable_wage!.state='unknown';p.pensionable_wage!.printed_value=null;}
 input.entitlement_evidence!.pension=p;return input;
}
const reportId='77777777-7777-4777-8777-777777777777';
let ordinary:AnalysisResultBundle;
beforeAll(async()=>{ordinary=await bundle();});

describe('ordinary owner engineering envelope → existing HTML/PDF components',()=>{
 it.each(['required_legal_authority','unknown_source'] as const)('does not display an unmet condition as established when %s blocks its engineering review',reason=>{
  const source=nineTopicRuntimeSource(),obligations=obligationsEntitlementInputSchema.parse(source.entitlement_evidence!.obligations);
  obligations.obligations[0].conditions[0].fact.value=false;source.entitlement_evidence!.obligations=obligations;
  const input=ownerEngineeringFixture(source),assessment=input.assessment_input;
  if(reason==='required_legal_authority')for(const receipt of assessment.interpretation_receipts)receipt.human_by_law.state='required';
  else for(const receipt of assessment.source_receipts)receipt.status='unknown';
  repinEngineeringFixture(assessment);
  const envelope=createCaseAnalysisOwnerEngineering(input,{engine_case_revision:11,source_journal:{case_id:source.case_id,
   input_revision:assessment.current.scope.input_revision,input_sha256:assessment.current.scope.input_sha256}});
  const outcome=envelope.result.nonmonetary_outcomes.find(o=>o.topic==='bonuses');
  if(!outcome)throw Error('TEST_UNMET_BONUS_OUTCOME_REQUIRED');
  expect(outcome).toMatchObject({state:'blocked',amount:null});
  const originalOutcomes=envelope.result.review.input.entitlement_composition?.nonmonetary_outcomes;
  if(!originalOutcomes)throw Error('TEST_ORIGINAL_OUTCOMES_REQUIRED');
  const originalOutcome=originalOutcomes.find(o=>o.check_ids[0]===outcome.source_outcome.check_ids[0]);
  expect(originalOutcome).toBeDefined();
  const conditionId=outcome.source_outcome.check_ids[0]+'.condition';
  const ordinaryView=JSON.parse(Buffer.from(renderOwnerEngineeringBundle(ordinary,reportId).json).toString('utf8')) as DocumentReviewPresentationInput;
  // Exercise the presentation boundary using actual runtime outcomes. The ordinary
  // projection initially labels this known-false source condition as not fulfilled.
  const findings:DocumentReviewPresentationFinding[]=[...envelope.result.checks.map<DocumentReviewPresentationFinding>(c=>({id:c.check_id,title:c.title,source_ids:[],status:'unknown',summary:'Synthetic ordinary check',amounts:[]})),
   {id:conditionId,title:outcome.source_outcome.title,source_ids:[],status:'condition_not_fulfilled',summary:outcome.source_outcome.explanation,amounts:[]}];
  const view=ownerEngineeringPresentation({...ordinaryView,analysis_run_id:envelope.result.analysis_run_id,period:source.period,findings},envelope);
  expect(view.findings.find(f=>f.id===conditionId)).toMatchObject({status:'unknown',amounts:[]});
  expect(view.findings.find(f=>f.id===conditionId)?.summary).toContain('אי אפשר לקבוע שהתנאי לא התקיים');
  expect(envelope.result.nonmonetary_outcomes.find(o=>o.topic==='bonuses')).toEqual(outcome);
 });
 it('labels candidate arithmetic as private and conditional, preserving unresolved legal authority without a debt total',async()=>{
  const original=canonicalSha256(ordinary),report=renderOwnerEngineeringBundle(ordinary,reportId),view=JSON.parse(Buffer.from(report.json).toString('utf8')) as DocumentReviewPresentationInput;
  expect(view.coverage).toBe('partial');expect(view.findings.filter(f=>f.status==='conditional').map(f=>f.amounts[0].minor_units)).toEqual([30000,32500,30000]);
  expect(ordinary.owner_engineering?.result).toMatchObject({legal_debt_total:null,combined_amount:null,verified_debt:false,release_authorized:false,publication_allowed:false,notification_allowed:false});
  for(const text of [Buffer.from(report.html).toString('utf8'),await pdfText(report.pdf)]){
   for(const phrase of ['טיוטת בדיקה הנדסית פרטית לבעלים','תוצאה מותנית','אינה דוח שירות ללקוח','אינה','טרם הוכרעה דרישת סמכות לפי דין','אין לחבר בדיקות חופפות לסך חוב','300.00 ₪','325.00 ₪'])expect(text).toContain(phrase);
   expect(text).not.toContain('חוב מאושר');expect(text).not.toContain('925.00');expect(text).not.toContain('synthetic-ai');
  }
  expect(canonicalSha256(ordinary)).toBe(original);
 });
 it('binds both byte artifacts to the exact run/result and stores engineering provenance only in the private appendix',()=>{
  const report=renderOwnerEngineeringBundle(ordinary,reportId),manifest=JSON.parse(Buffer.from(report.manifest).toString('utf8'));
  const appendix=JSON.parse(Buffer.from(report.private_evidence_appendix).toString('utf8'));
  expect(()=>validateReport(report)).not.toThrow();expect(report.report_id).toBe(reportId);expect(report.analysis_result_sha256).toBe(ordinary.result_sha256);
  expect(manifest).toMatchObject({analysis_run_id:ordinary.analysis_run_id,analysis_result_sha256:ordinary.result_sha256,report_id:reportId,html_sha256:sha(report.html),pdf_sha256:sha(report.pdf),json_sha256:sha(report.json),private_evidence_appendix_sha256:sha(report.private_evidence_appendix)});
  expect(appendix).toMatchObject({analysis_run_id:ordinary.analysis_run_id,analysis_result_sha256:ordinary.result_sha256,report_id:reportId,evidence:{report_qualification:{template:OWNER_ENGINEERING_REPORT_TEMPLATE,
   engineering_runtime_sha256:ordinary.owner_engineering!.result.sha256,legal_debt_total:null,combined_amount:null,release_authorized:false,publication_allowed:false,notification_allowed:false,publication_performed:false}}});
  expect(canonicalSha256(appendix.evidence.report_qualification.owner_engineering)).toBe(canonicalSha256(ordinary.owner_engineering));
  const again=renderOwnerEngineeringBundle(ordinary,reportId);for(const key of ['json','html','pdf','manifest','private_evidence_appendix'] as const)expect(Buffer.from(again[key]).equals(Buffer.from(report[key]))).toBe(true);
  expect(Buffer.from(report.html).toString('utf8')).not.toContain(ordinary.owner_engineering!.sha256);
 });
 it('shows a real source zero as zero in both formats, while preserving expected-only and partial qualification',async()=>{
  const zero=await bundle(changedSource('zero')),report=renderOwnerEngineeringBundle(zero,reportId);
  expect(zero.owner_engineering!.result.checks.map(c=>c.expected)).toEqual([0,0,0].map(minor_units=>({kind:'money',currency:'ILS',minor_units})));
  for(const text of [Buffer.from(report.html).toString('utf8'),await pdfText(report.pdf)]){expect(text).toContain('0.00 ₪');expect(text).toContain('הבדיקה חלקית');expect(text).toContain('היעדר רישום אינו אפס');expect(text).not.toContain('חוב מאושר');}
 });
 it('keeps a source-unknown report partial and does not present a calculated candidate amount or an implicit zero',async()=>{
  const partial=await bundle(changedSource('unknown')),report=renderOwnerEngineeringBundle(partial,reportId),view=JSON.parse(Buffer.from(report.json).toString('utf8')) as DocumentReviewPresentationInput;
  expect(partial.owner_engineering!.result.findings).toEqual([]);expect(view.findings.every(f=>f.status==='unknown'&&f.amounts.length===0)).toBe(true);
  for(const text of [Buffer.from(report.html).toString('utf8'),await pdfText(report.pdf)]){expect(text).toContain('הבדיקה חלקית');expect(text).toContain('מידע חסר אינו סכום אפס');expect(text).not.toContain('0.00 ₪');expect(text).not.toContain('300.00 ₪');}
 });
 it('rejects an envelope whose amount was tampered with, even when its exposed hashes were recomputed',()=>{
  const e=ordinary.owner_engineering!,target=e.result.checks[0].expected;if(target?.kind!=='money')throw Error('TEST_EXPECTED_MONEY');
  const {sha256:resultHash,...resultBody}=e.result;void resultHash;
  const body={...resultBody,checks:[{...resultBody.checks[0],expected:{...target,minor_units:target.minor_units+1}},...resultBody.checks.slice(1)]};
  const result={...body,sha256:canonicalSha256(body)},envelopeBody={schema_version:e.schema_version,binding:e.binding,input:e.input,result},envelope={...envelopeBody,sha256:canonicalSha256(envelopeBody)};
  expect(()=>renderOwnerEngineeringBundle({...ordinary,owner_engineering:envelope},reportId)).toThrow('OWNER_ENGINEERING_REPLAY_MISMATCH');
 });
 it.each(['analysis_run_id','case_id','case_revision','facts_snapshot_sha256'] as const)('rejects transferring a valid envelope to another %s',field=>{
  const other={...ordinary,[field]:field==='case_revision'?ordinary.case_revision+1:field==='facts_snapshot_sha256'?'0'.repeat(64):'foreign'};
  expect(()=>renderOwnerEngineeringBundle(other,reportId)).toThrow('OWNER_ENGINEERING_BUNDLE_SCOPE_MISMATCH');
 });
});
