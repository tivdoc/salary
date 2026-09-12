import {describe,it,expect} from 'vitest';
import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {immutableDocumentSchema} from '../../domain/documents.ts';
import {rawDocumentEvidenceSchema,rawDocumentObservationSchema} from './contracts.ts';
import {normalizeDocumentEvidence,normalizeDocumentObservation,assertDocumentEvidenceReplay} from './normalization.ts';
import {createDocumentEvidenceReadingTarget,resolveDocumentEvidenceReading,parseDocumentEvidenceIdentifiedReading} from './reading.ts';

const uuid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const document=immutableDocumentSchema.parse({document_id:uuid(2),case_id:uuid(1),document_type:'attendance',original_filename:'synthetic.png',
 mime_type:'image/png',size_bytes:10,content_sha256:'a'.repeat(64),storage_path:`cases/${uuid(1)}/documents/${uuid(2)}/original.png`,
 document_period:null,supersedes_document_id:null,created_at:'2026-07-01T00:00:00Z'});
const observation=rawDocumentObservationSchema.parse({block_id:'table',row_id:'row1',cell_id:'entry',semantic:'entry_time',value_kind:'clock_time',
 raw_value:'08:30',source_label:'כניסה',unit:null,page:1,locator:'table.row1.entry',text_fragment:'08:30',state:'present',confidence:0.94,warnings:[]});
function raw(observations=[observation]){return rawDocumentEvidenceSchema.parse({schema_version:'document-evidence-provider-v1',
 detected_document_type:'attendance',page_count:1,pages:[{page:1,coverage:'complete',missing_regions:[]}],observations,warnings:[]});}
const normalize=(data=raw())=>normalizeDocumentEvidence({raw:data,document,physicalPageCount:1});
function target(data=normalize(),month='2026-07'){return createDocumentEvidenceReadingTarget({normalized:data,productDocumentId:uuid(3),
 checkpointSha256:'b'.repeat(64),policyVersion:'saved-document-evidence-v1',month,observationId:data.observations[0].observation_id});}
function answer(action:unknown,t=target(),current=t){return resolveDocumentEvidenceReading({target:t,currentTarget:current,answer:action,caseId:uuid(1),
 requestId:uuid(4),answerRevision:1,identityId:uuid(5),answeredAt:'2026-07-01T01:00:00Z'});}
describe('non-payroll documentary evidence',()=>{
 it('replays v1 money and reading bytes while new v2 rejects malformed grouping',()=>{
  const source=raw([{...observation,semantic:'amount',value_kind:'money',unit:'ILS',raw_value:'1..2'}]);
  const legacy=normalizeDocumentEvidence({raw:source,document,physicalPageCount:1,normalizationPolicy:'document-evidence-normalization-v1'});
  const legacyHash=canonicalSha256(legacy),legacyTarget=target(legacy);
  expect(legacy.observations[0].normalized_value).toEqual({kind:'money',minor_units:120,currency:'ILS'});
  expect(legacyTarget).not.toHaveProperty('normalization_policy');
  assertDocumentEvidenceReplay({raw:source,normalized:legacy,document,physicalPageCount:1});
  expect(canonicalSha256(legacy)).toBe(legacyHash);
  const confirmed=answer({action:'confirm'},legacyTarget);
  if(confirmed.state!=='current')throw Error('TEST_CURRENT');
  expect(parseDocumentEvidenceIdentifiedReading(confirmed.reading)).toEqual(confirmed.reading);
  const legacyCorrection=answer({action:'correct',corrected_raw_value:'₪ 1,234.50',basis:'קריאה בתא המקור'},legacyTarget);
  if(legacyCorrection.state!=='current')throw Error('TEST_CURRENT');
  expect(legacyCorrection.reading.value).toEqual({kind:'money',minor_units:123450,currency:'ILS'});
  expect(parseDocumentEvidenceIdentifiedReading(legacyCorrection.reading)).toEqual(legacyCorrection.reading);
  const current=normalize(source),currentTarget=target(current);
  expect(currentTarget.normalization_policy).toBe('document-evidence-normalization-v2');
  expect(current.observations[0].normalized_value).toBeNull();
  expect(()=>answer({action:'confirm'},currentTarget)).toThrow('DOCUMENT_EVIDENCE_CONFIRM_UNAVAILABLE');
  expect(answer({action:'confirm'},legacyTarget,currentTarget).state).toBe('stale');
  const corrected=answer({action:'correct',corrected_raw_value:'₪ 1,234.50',basis:'קריאה בתא המקור'},currentTarget);
  if(corrected.state!=='current')throw Error('TEST_CURRENT');
  expect(corrected.reading.value).toEqual({kind:'money',minor_units:123450,currency:'ILS'});
  expect(corrected.reading.target.observation.original.raw_value).toBe('1..2');
  expect(parseDocumentEvidenceIdentifiedReading(corrected.reading)).toEqual(corrected.reading);
  expect(()=>answer({action:'correct',corrected_raw_value:'1,2,3',basis:'תא'},currentTarget)).toThrow('DOCUMENT_EVIDENCE_READING_VALUE_INVALID');
 });
 it('keeps source reading candidate even with high model confidence',()=>{
  const result=normalize();expect(result.observations[0].state).toBe('candidate');expect(result.observations[0].original.confidence).toBe(.94);
  expect(result.observations[0].normalized_value).toEqual({kind:'clock_time',value:'08:30'});
 });
 it('distinguishes clock time, duration and decimal hours without subtraction',()=>{
  expect(normalizeDocumentObservation({...observation,value_kind:'duration_hhmm',unit:'hours'})).toEqual({kind:'duration_hhmm',value:'08:30',unit:'hours'});
  expect(normalizeDocumentObservation({...observation,value_kind:'decimal',unit:'hours',raw_value:'8.30'})).toEqual({kind:'decimal',value:'8.3',unit:'hours'});
  expect(normalizeDocumentObservation({...observation,raw_value:'24:00'})).toBeNull();
 });
 it('requires an explicit full date, never borrows requested year/month',()=>{
  expect(normalizeDocumentObservation({...observation,value_kind:'iso_date',raw_value:'1/7/2026'})).toEqual({kind:'iso_date',value:'2026-07-01'});
  expect(normalizeDocumentObservation({...observation,value_kind:'iso_date',raw_value:'1/7'})).toBeNull();
  expect(normalizeDocumentObservation({...observation,value_kind:'iso_date',raw_value:'31/2/2026'})).toBeNull();
 });
 it('keeps blank breaks missing rather than zero',()=>{
  const result=normalize(raw([{...observation,semantic:'break_duration',value_kind:'duration_hhmm',unit:'hours',raw_value:null,state:'missing'}]));
  expect(result.observations[0]).toMatchObject({state:'missing',normalized_value:null});
 });
 it('retains contradictory source cells independently',()=>{
  const result=normalize(raw([observation,{...observation,raw_value:'09:30'}]));
  expect(result.observations).toHaveLength(2);expect(result.observations.map(o=>o.state)).toEqual(['conflict','conflict']);
  expect(result.observations.map(o=>o.original.raw_value)).toEqual(['08:30','09:30']);
 });
 it('does not deduplicate repeated identical cells into a verified observation',()=>{
  const result=normalize(raw([observation,observation]));expect(result.observations[0].issues).toContain('duplicate_source_cell');
  expect(()=>answer({action:'confirm'},target(result))).toThrow('DOCUMENT_EVIDENCE_CONFIRM_UNAVAILABLE');
 });
 it('blocks page-count invention and wrong physical source coordinates',()=>{
  expect(()=>normalizeDocumentEvidence({raw:raw(),document,physicalPageCount:2})).toThrow('DOCUMENT_EVIDENCE_PAGE');
  expect(()=>normalize(raw([{...observation,page:2}]))).toThrow('DOCUMENT_EVIDENCE_PAGE');
 });
 it('retains incomplete coverage and wrong detected type',()=>{
  const result=normalize({...raw(),detected_document_type:'unknown',pages:[{page:1,coverage:'partial',missing_regions:['lower panel']}]});
  expect(result.warnings).toContain('document_type_mismatch');expect(result.pages[0].coverage).toBe('partial');
 });
 it('retains exact contract text and explicit money with no inferred currency',()=>{
  const clause={...observation,semantic:'clause_text' as const,value_kind:'text' as const,raw_value:'בונוס מותנה בהשלמת 4 משמרות.'};
  const result=normalizeDocumentEvidence({raw:{...raw([clause]),detected_document_type:'contract'},document:{...document,document_type:'contract'},physicalPageCount:1});
  expect(result.observations[0].normalized_value).toEqual({kind:'text',value:clause.raw_value});
  expect(normalizeDocumentObservation({...clause,value_kind:'money',raw_value:'500.00',unit:'unknown'})).toBeNull();
  expect(normalizeDocumentObservation({...clause,value_kind:'money',raw_value:'500.00',unit:'ILS'})).toEqual({kind:'money',minor_units:50000,currency:'ILS'});
 });
 it('detects tampered normalized values using raw replay',()=>{
  const result=normalize();const tampered={...result,observations:result.observations.map(o=>({...o,normalized_value:{kind:'clock_time',value:'09:30'}}))};
  expect(()=>assertDocumentEvidenceReplay({raw:raw(),normalized:tampered,document,physicalPageCount:1})).toThrow('DOCUMENT_EVIDENCE_NORMALIZATION_CHANGED');
 });
 it('corrects one identified cell without editing original/provider data',()=>{
  const data=normalize(),before=canonicalSha256(data),result=answer({action:'correct',corrected_raw_value:'09:30',basis:'קריאה בתא המקור'},target(data));
  expect(result.state).toBe('current');if(result.state!=='current')throw Error('TEST_CURRENT');
  expect(result.reading.value).toEqual({kind:'clock_time',value:'09:30'});expect(result.reading.target.observation.original.raw_value).toBe('08:30');
  expect(canonicalSha256(data)).toBe(before);expect(parseDocumentEvidenceIdentifiedReading(result.reading)).toEqual(result.reading);
 });
 it.each(['unknown','unreadable'])('retains %s as its own latest reading state',action=>{
  const result=answer({action});expect(result.state).toBe('current');if(result.state!=='current')throw Error('TEST_CURRENT');
  expect(result.reading.value).toBeNull();expect(result.reading.state).toBe(action);
 });
 it('rejects confirm for missing source and malformed correction before journal save',()=>{
  const data=normalize(raw([{...observation,raw_value:null,state:'missing'}]));
  expect(()=>answer({action:'confirm'},target(data))).toThrow('DOCUMENT_EVIDENCE_CONFIRM_UNAVAILABLE');
  expect(()=>answer({action:'correct',corrected_raw_value:'99:88',basis:'תא'})).toThrow('DOCUMENT_EVIDENCE_READING_VALUE_INVALID');
 });
 it('rejects source/month changes and foreign case reuse',()=>{
  const current=target(normalize(),'2026-06');expect(answer({action:'confirm'},target(),current).state).toBe('stale');
  const foreign=normalizeDocumentEvidence({raw:raw(),document:{...document,case_id:uuid(9),storage_path:`cases/${uuid(9)}/documents/${uuid(2)}/original.png`},physicalPageCount:1});
  expect(()=>answer({action:'confirm'},target(foreign))).toThrow('DOCUMENT_EVIDENCE_READING_CASE');
 });
});
