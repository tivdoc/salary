import 'server-only';
import {createHash} from 'node:crypto';
import {PDFDocument} from 'pdf-lib';
import sharp from 'sharp';
import {immutableDocumentSchema,type ImmutableDocument} from '@/engine/domain/documents';
import type {PrivateDocumentSource} from '@/engine/extraction/provider';
import {matchesDocumentSignature} from '@/lib/document-upload';

export const EXTRACTION_INPUT_LIMITS=Object.freeze({bytes:10*1024*1024,pages:12,pixels:40_000_000,providerPasses:2,jobAttempts:3});
export class ExtractionInputError extends Error {
 constructor(readonly code:'source_scope'|'source_changed'|'source_missing'|'invalid_document'|'document_protected'|'document_limit'){super(code);}
}
export async function inspectExtractionBytes(bytes:Uint8Array,mime:string){
 if(bytes.length===0||bytes.length>EXTRACTION_INPUT_LIMITS.bytes)throw new ExtractionInputError('document_limit');
 if(!matchesDocumentSignature(bytes,mime))throw new ExtractionInputError('invalid_document');
 try{
  if(mime==='application/pdf'){
   const pdf=await PDFDocument.load(bytes,{ignoreEncryption:true,updateMetadata:false});
   if(pdf.isEncrypted)throw new ExtractionInputError('document_protected');
   const pages=pdf.getPageCount();if(pages<1||pages>EXTRACTION_INPUT_LIMITS.pages)throw new ExtractionInputError('document_limit');
   return {pages,rotation:pdf.getPage(0).getRotation().angle};
  }
  const meta=await sharp(bytes,{limitInputPixels:EXTRACTION_INPUT_LIMITS.pixels}).metadata();
  if(!meta.width||!meta.height||(meta.pages??1)>1)throw new ExtractionInputError('document_limit');
  return {pages:1,rotation:meta.orientation??1};
 }catch(error){if(error instanceof ExtractionInputError)throw error;throw new ExtractionInputError('invalid_document');}
}
export interface UploadExtractionDb {
 query(text:string,values:unknown[]):Promise<{rows:Record<string,unknown>[]}>
}
export interface UploadExtractionStorage {
 download(path:string):Promise<{data:Blob|null;error:unknown}>
}
/** Lookup is server-only, keyed by BOTH case and immutable upload version. The
 * engine uses its existing immutable-document vocabulary; physical Storage keys
 * remain in this adapter and are never accepted from a browser or a model. */
export async function loadVerifiedUpload(caseId:string,versionId:string,db:UploadExtractionDb,storage:UploadExtractionStorage):Promise<{document:ImmutableDocument;source:PrivateDocumentSource;productDocumentId:string}>{
 const result=await db.query('select id,case_id,version_id,document_type,storage_path,original_filename,mime_type,size,content_sha256,period_month,created_at from public.documents where case_id=$1 and version_id=$2',[caseId,versionId]);
 const row=result.rows[0];if(!row)throw new ExtractionInputError('source_missing');
 if(row.case_id!==caseId||row.version_id!==versionId)throw new ExtractionInputError('source_scope');
 const extension=row.mime_type==='application/pdf'?'pdf':row.mime_type==='image/png'?'png':'jpg';
 const physicalPath=`cases/${caseId}/versions/${versionId}.${extension}`;
 if(row.storage_path!==physicalPath)throw new ExtractionInputError('source_scope');
 const document=immutableDocumentSchema.parse({document_id:versionId,case_id:caseId,document_type:row.document_type,storage_path:`cases/${caseId}/documents/${versionId}/original.${extension}`,original_filename:row.original_filename,mime_type:row.mime_type,size_bytes:Number(row.size),content_sha256:row.content_sha256,document_period:null,supersedes_document_id:null,created_at:new Date(String(row.created_at)).toISOString()});
 return {document,productDocumentId:String(row.id),source:{async read(requested){
  if(requested.case_id!==caseId||requested.document_id!==versionId||requested.content_sha256!==document.content_sha256||requested.storage_path!==document.storage_path)throw new ExtractionInputError('source_scope');
  const {data,error}=await storage.download(physicalPath);if(error||!data)throw new ExtractionInputError('source_missing');
  if(data.size!==document.size_bytes)throw new ExtractionInputError('source_changed');
  const bytes=new Uint8Array(await data.arrayBuffer());
  if(createHash('sha256').update(bytes).digest('hex')!==document.content_sha256)throw new ExtractionInputError('source_changed');
  await inspectExtractionBytes(bytes,document.mime_type);return bytes;
 }}};
}
