import {PDFDocument} from 'pdf-lib';
import sharp from 'sharp';
import {matchesDocumentSignature} from '@/lib/document-upload';

/** Physical source metadata, not a reading or a claim that the file is complete.
 * This wider upload limit does not alter the separate OCR spend/input limits. */
export async function inspectSourcePhysicalPages(bytes:Uint8Array,mime:string):Promise<number>{
 if(!bytes.length||bytes.length>10*1024*1024||!matchesDocumentSignature(bytes,mime))throw Error('SOURCE_PHYSICAL_INVALID');
 try{
  if(mime==='application/pdf'){
   const pdf=await PDFDocument.load(bytes,{ignoreEncryption:true,updateMetadata:false});
   const pages=pdf.getPageCount();
   if(pdf.isEncrypted||pages<1||pages>100)throw Error('SOURCE_PHYSICAL_INVALID');
   return pages;
  }
  if(mime!=='image/jpeg'&&mime!=='image/png')throw Error('SOURCE_PHYSICAL_INVALID');
  const parser=sharp(bytes,{limitInputPixels:40_000_000,failOn:'warning'}),meta=await parser.metadata();
  if(!meta.width||!meta.height||(meta.pages??1)!==1
   ||meta.format!==(mime==='image/jpeg'?'jpeg':'png'))throw Error('SOURCE_PHYSICAL_INVALID');
  // Decode pixels as well as headers, so a truncated image cannot certify a page.
  await parser.stats();
  return 1;
 }catch{throw Error('SOURCE_PHYSICAL_INVALID');}
}
