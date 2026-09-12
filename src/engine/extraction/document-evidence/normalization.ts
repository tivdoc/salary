import {immutableDocumentSchema,type ImmutableDocument} from '../../domain/documents.ts';
import {canonicalSha256,deepFreeze} from '../../rule-runtime/canonical.ts';
import {normalizeDecimal,normalizeMoney} from '../normalization.ts';
import {normalizeDocumentEvidenceMoney} from './money.ts';
import {DOCUMENT_EVIDENCE_NORMALIZATION,documentEvidenceSchema,documentEvidenceValueSchema,rawDocumentEvidenceSchema,
 type RawDocumentObservation,type DocumentEvidenceValue,type NormalizedDocumentEvidence} from './contracts.ts';

/** No contextual date/year, currency or unit inference. Unsupported printed
 * formats remain available for targeted reading instead of disappearing. */
export function normalizeDocumentObservation(original:RawDocumentObservation,correctedRaw?:string,policy:NormalizedDocumentEvidence['normalization_policy']=DOCUMENT_EVIDENCE_NORMALIZATION):DocumentEvidenceValue|null {
 const raw=(correctedRaw??original.raw_value)?.trim();if(!raw)return null;
 const kind=original.value_kind;
 if(kind==='text')return documentEvidenceValueSchema.parse({kind,value:raw});
 if(kind==='iso_date'){
  const printed=/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/u.exec(raw);
  const value=printed?`${printed[3]}-${printed[2].padStart(2,'0')}-${printed[1].padStart(2,'0')}`:raw;
  const parsed=documentEvidenceValueSchema.safeParse({kind,value});return parsed.success?parsed.data:null;
 }
 if(kind==='clock_time'){
  if(!/^\d{1,2}:[0-5]\d$/u.test(raw))return null;
  const parsed=documentEvidenceValueSchema.safeParse({kind,value:raw.padStart(5,'0')});return parsed.success?parsed.data:null;
 }
 if(kind==='duration_hhmm')return original.unit==='hours'&&/^\d{1,5}:[0-5]\d$/u.test(raw)?{kind,value:raw,unit:'hours'}:null;
 if(kind==='money'){
  if(original.unit!=='ILS')return null;
  const money=policy==='document-evidence-normalization-v1'?normalizeMoney(raw,'ILS'):normalizeDocumentEvidenceMoney(raw);
  return money?{kind,minor_units:money.minor_units,currency:'ILS'}:null;
 }
 if(kind==='percentage'){
  if(original.unit!=='percent'||!/^[-+]?\d+(?:[.,]\d+)?\s*%?$/u.test(raw))return null;
  const value=normalizeDecimal(raw.replace(/%$/u,''));return value===null?null:{kind,value,unit:'percent'};
 }
 if(!['hours','days','count','unknown'].includes(original.unit??''))return null;
 if(!/^[-+]?\d+(?:[.,]\d+)?$/u.test(raw))return null;
 const value=normalizeDecimal(raw);if(value===null)return null;
 const parsed=documentEvidenceValueSchema.safeParse({kind:'decimal',value,unit:original.unit});return parsed.success?parsed.data:null;
}

export function normalizeDocumentEvidence(input:{raw:unknown;document:ImmutableDocument;physicalPageCount:number;normalizationPolicy?:NormalizedDocumentEvidence['normalization_policy']}):NormalizedDocumentEvidence {
 const policy=input.normalizationPolicy??DOCUMENT_EVIDENCE_NORMALIZATION;
 const document=immutableDocumentSchema.parse(input.document),raw=rawDocumentEvidenceSchema.parse(input.raw);
 if(document.document_type!=='attendance'&&document.document_type!=='contract')throw Error('DOCUMENT_EVIDENCE_KIND');
 if(raw.page_count!==input.physicalPageCount||raw.pages.length!==input.physicalPageCount||new Set(raw.pages.map(p=>p.page)).size!==input.physicalPageCount
  ||raw.pages.some(p=>p.page>input.physicalPageCount)||raw.observations.some(o=>o.page>input.physicalPageCount))throw Error('DOCUMENT_EVIDENCE_PAGE');
 const rawHash=canonicalSha256(raw);
 const observations=raw.observations.map((original,index)=>{
  const sameCell=raw.observations.filter(o=>o.page===original.page&&o.block_id===original.block_id&&o.row_id===original.row_id&&o.cell_id===original.cell_id);
  const sameLocation=raw.observations.filter(o=>o.page===original.page&&o.locator===original.locator&&o.semantic===original.semantic);
  const duplicate=sameCell.length>1||sameLocation.length>1;
  const conflict=original.state==='conflict'||sameCell.some(o=>o.raw_value!==original.raw_value)||sameLocation.some(o=>o.raw_value!==original.raw_value);
  const normalized=normalizeDocumentObservation(original,undefined,policy);
  const state=conflict?'conflict':original.state==='missing'?'missing':original.state==='unreadable'?'unreadable':!normalized?'invalid':'candidate';
  const issues=[...(duplicate?['duplicate_source_cell']:[]),...(conflict?['conflicting_source_readings']:[]),...(!normalized&&original.state==='present'?['normalization_unavailable']:[])];
  return {observation_id:canonicalSha256({case_id:document.case_id,document_id:document.document_id,source_sha256:document.content_sha256,raw_sha256:rawHash,index,original}),
   original,original_sha256:canonicalSha256(original),normalized_value:normalized,state,issues};
 });
 return deepFreeze(documentEvidenceSchema.parse({schema_version:'normalized-document-evidence-v1',normalization_policy:policy,
  case_id:document.case_id,document_id:document.document_id,source_sha256:document.content_sha256,declared_document_type:document.document_type,
  detected_document_type:raw.detected_document_type,physical_page_count:input.physicalPageCount,raw_sha256:rawHash,observations,pages:raw.pages,
  warnings:[...raw.warnings,...(raw.detected_document_type!==document.document_type?['document_type_mismatch']:[])]}));
}

/** Checkpoint readers rederive; schema validity alone is not evidence that a
 * normalized number is the one obtained from its immutable provider payload. */
export function assertDocumentEvidenceReplay(input:{raw:unknown;normalized:unknown;document:ImmutableDocument;physicalPageCount:number}){
 const parsed=documentEvidenceSchema.parse(input.normalized),expected=normalizeDocumentEvidence({...input,normalizationPolicy:parsed.normalization_policy});
 if(canonicalSha256(parsed)!==canonicalSha256(expected))throw Error('DOCUMENT_EVIDENCE_NORMALIZATION_CHANGED');
 return expected;
}
