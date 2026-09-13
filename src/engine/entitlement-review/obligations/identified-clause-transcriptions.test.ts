import {describe,it,expect} from 'vitest';
import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {buildSyntheticCaseFixture} from '../../case-analysis/synthetic-fixtures.ts';
import {documentReviewInputSchema} from '../../document-review/contracts.ts';
import {documentEvidenceSourceTranscriptionTarget,resolveDocumentEvidenceSourceReading} from '../../extraction/document-evidence/source-transcription.ts';
import {attachAutomaticNonPayslipEvidence} from '../automatic-nonpay.ts';
import {composeEntitlementReview} from '../compose.ts';
import {runDocumentReview} from '../../document-review/service.ts';
import {attachIdentifiedClauseTranscriptions,parseIdentifiedClausePromise} from './identified-clause-transcriptions.ts';
import {obligationsEntitlementInputSchema} from './contracts.ts';
import {produceObligationSourceEvidence} from './product-source-evidence.ts';
import {normalizeDocumentEvidence} from '../../extraction/document-evidence/normalization.ts';
import {savedNonPayslipEvidenceSchema} from '../../extraction/document-evidence/snapshot.ts';

const uuid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,period={from:'2026-06-01',to:'2026-06-30'};
const explicit='המעסיק ישלם לעובד 500 ש״ח בכל חודש מיום 2026-01-01 ועד יום 2026-12-31.';
function fixture(text=explicit,action:'correct'|'unknown'|'unreadable'='correct'){
 const original=buildSyntheticCaseFixture({fixture_id:'identified-clause-only-synthetic',mode:'real'}).stored;
 const document={...original.documents[0],document_type:'contract' as const,document_period:null};
 const purchase={order_id:uuid(20),origin:'saved_order' as const,receipt_sha256:'a'.repeat(64),topics:['contract' as const,'bonuses' as const]};
 const source={case_id:document.case_id,product_document_id:uuid(30),version_id:document.document_id,source_sha256:document.content_sha256,
  document_kind:'contract' as const,document_month:null,page_count:7,reading_dependencies:[]};
 const target=documentEvidenceSourceTranscriptionTarget({source,purchase,month:'2026-06',page:null});
 const result=resolveDocumentEvidenceSourceReading({target,currentSource:source,currentPurchase:purchase,caseId:document.case_id,month:'2026-06',
  requestId:uuid(40),answerRevision:1,identityId:uuid(50),answeredAt:'2026-07-02T00:00:00Z',
  answer:action==='correct'?{schema_version:'document-evidence-source-answer-v2',action,value:{raw_value:text,page:3,locator:'Synthetic clause 4'}}:{schema_version:'document-evidence-source-answer-v2',action}});
 if(result.state!=='current')throw Error('SYNTHETIC_CURRENT_READING');
 const snapshot={...original,documents:[document],extractions:[],document_source_transcriptions:[result.reading]};
 const input=documentReviewInputSchema.parse({schema_version:'document-review-product-v1',case_id:document.case_id,period,purchased_scope:purchase,
  documents:[{case_id:document.case_id,document_id:document.document_id,version_id:document.document_id,file_sha256:document.content_sha256,
   page_count:null,kind:'contract',label:'Synthetic retained contract',period:null,reading_origin:'source_inventory',reading_sha256:'d'.repeat(64)}],
  checks:[],completion_input:{case_id:document.case_id,period,documents:[{pin:{case_id:document.case_id,document_id:document.document_id,version_id:document.document_id,source_sha256:document.content_sha256},
   kind:'contract',review:'not_reviewed',period:null}],needs:[],evidence:[]},document_source_transcriptions:[result.reading]});
 return {input,snapshot,reading:result.reading,run:()=>attachAutomaticNonPayslipEvidence(input,snapshot).input};
}
describe('identified full-clause transcription evidence',()=>{
 it('uses explicit amount and dates through the ordinary resolver while preserving original source and missing legal facts',()=>{
  const f=fixture(),before=canonicalSha256({input:f.input,snapshot:f.snapshot}),review=f.run(),packet=obligationsEntitlementInputSchema.parse(review.entitlement_evidence?.obligations),o=packet.obligations[0];
  expect(o).toMatchObject({clause:{text:explicit,effective_period:{from:'2026-01-01',to:'2026-12-31'},source:{page:3,reading_receipt_sha256:f.reading.verification_sha256}},
   promise:{kind:'fixed',amount:{printed_value:'500.00',state:'observed'}},recorded:null,assessments:[],product_facts:{agreement_used_for_employment:{state:'missing'}}});
  expect(review.documents[0]).toMatchObject({reading_origin:'source_inventory',reading_sha256:'d'.repeat(64),page_count:7,accepted_reading_sha256:[f.reading.verification_sha256]});
  const produced=produceObligationSourceEvidence(packet,o.obligation_id,review);expect(produced.entries.map(e=>e.kind)).toEqual(['literal_promise','payment_period']);
  expect(produced.unresolved).toEqual(['positive_exact_agreement_statement_required','positive_complete_condition_inventory_required']);
  expect(()=>runDocumentReview(composeEntitlementReview(review),'synthetic.transcription.review')).not.toThrow();
  expect(canonicalSha256({input:f.input,snapshot:f.snapshot})).toBe(before);
 });
 it.each(['01.01.2026','1/1/2026'])('reads complete printed date %s without taking it from the purchased month',from=>{
  expect(parseIdentifiedClausePromise(explicit.replace('2026-01-01',from))?.effective_period.from).toBe('2026-01-01');
 });
 it('dispatches the identified receipt independently when the same document also retains a provider extraction',()=>{
  const f=fixture(),review=f.run(),document=f.snapshot.documents[0];
  const extraction=normalizeDocumentEvidence({document,physicalPageCount:7,raw:{schema_version:'document-evidence-provider-v1',detected_document_type:'contract',page_count:7,
   pages:Array.from({length:7},(_,i)=>({page:i+1,coverage:'partial',missing_regions:['Synthetic untranscribed region']})),observations:[],warnings:[]}});
  const record=savedNonPayslipEvidenceSchema.parse({document,product_document_id:uuid(30),checkpoint_result_sha256:'c'.repeat(64),provider_receipt_sha256:'b'.repeat(64),extraction,failure_code:null,readings:[]});
  const packet=obligationsEntitlementInputSchema.parse(review.entitlement_evidence?.obligations),before=canonicalSha256(record);
  const result=produceObligationSourceEvidence(packet,packet.obligations[0].obligation_id,{...review,non_payslip_evidence:[record]});
  expect(result.entries.map(e=>e.kind)).toEqual(['literal_promise','payment_period']);
  expect(result.unresolved).toContain('positive_complete_condition_inventory_required');expect(canonicalSha256(record)).toBe(before);
 });
 it.each([
  'המעסיק ישלם לעובד 500 ש״ח בכל חודש.',
  explicit.replace('2026-01-01','2026-02-30'),explicit.replace('2026-12-31','2025-12-31'),
  explicit+' בכפוף להשלמת הפרויקט.',explicit.replace('500','500 או 600'),
  'שכר העובד ייקבע לפי שיקול דעת המעסיק.',
 ])('keeps incomplete or unsupported wording as a precise gap: %s',text=>{
  const f=fixture(text),review=f.run();expect(review.entitlement_evidence?.obligations).toBeUndefined();expect(review.coverage_gaps).toHaveLength(1);
  expect(review.document_source_transcriptions).toEqual(f.input.document_source_transcriptions);
 });
 it.each(['unknown','unreadable'] as const)('retains %s without making a zero promise',action=>{
  const f=fixture(explicit,action),review=f.run();expect(review.entitlement_evidence?.obligations).toBeUndefined();expect(review.coverage_gaps[0].kind).toBe('missing_source');
 });
 it('refuses partial-month applicability and never derives performed quantities from a rate',()=>{
  expect(fixture(explicit.replace('2026-01-01','2026-06-15')).run().coverage_gaps[0].kind).toBe('missing_applicability');
  const f=fixture(explicit.replace('500 ש״ח בכל חודש','12.50 ש״ח לכל משמרת בחודש')),review=f.run();
  expect(obligationsEntitlementInputSchema.parse(review.entitlement_evidence?.obligations).obligations[0].promise).toMatchObject({kind:'linear',rate:{printed_value:'12.50'},quantity:null,quantity_unit:'count'});
 });
 it('rejects changed snapshots, source versions, page counts and paid receipts',()=>{
  const f=fixture();expect(()=>attachIdentifiedClauseTranscriptions(f.input,{...f.snapshot,document_source_transcriptions:[]})).toThrow('CLAUSE_TRANSCRIPTION_SNAPSHOT_BINDING');
  for(const input of [{...f.input,purchased_scope:{...f.input.purchased_scope,receipt_sha256:'f'.repeat(64)}},
   {...f.input,documents:f.input.documents.map(d=>({...d,version_id:uuid(99)}))},
   {...f.input,documents:f.input.documents.map(d=>({...d,page_count:2}))}])expect(()=>attachIdentifiedClauseTranscriptions(input,f.snapshot)).toThrow();
 });
 it('does not duplicate an already constructed same-source obligation on a repeated attachment',()=>{
  const f=fixture(),first=f.run(),next=attachIdentifiedClauseTranscriptions(first,f.snapshot);
  expect(next.entitlement_evidence).toEqual(first.entitlement_evidence);expect(next.documents).toEqual(first.documents);
 });
});
