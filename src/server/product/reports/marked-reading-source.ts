import 'server-only';
import {createHash} from 'node:crypto';
import {PDFDocument,rgb} from 'pdf-lib';
import {documentReadingTargetSchema} from './document-field-confirmation';
import {documentFieldVerificationDisplay} from './reading-verification';
import {selectedObligationPaymentTarget} from './document-obligation-payment-link';
import type {CaseAccessDb} from '../case-access/db';

/** Derive a view from the already authorized, hash-verified original. Never
 * modify storage or guess a cell rectangle from an unlocated text fragment. */
export async function markReadingSource(input:{caseId:string;identityId:string;requestId:string;version:string;bytes:Buffer;mime:string;candidateHash?:string;linked?:'payroll'|'clause'},db:CaseAccessDb){
 const rows=await db.rpc<{request_id:string;target:unknown}>('case_request_field_reading_targets',{target_case:input.caseId,target_identity:input.identityId});
 const selected=rows.filter(row=>row.request_id===input.requestId);
 if(selected.length!==1)return null;
 let target=documentReadingTargetSchema.parse(selected[0].target);
 if(target.schema_version==='obligation-payment-choice-v1'){
  // The source RPC already verified both pins. These locators have no trusted
  // rectangle; retain the original and page link rather than invent a crop.
  if(input.linked==='clause')return null;
  target=selectedObligationPaymentTarget(target,input.candidateHash);
 }
 const source=documentFieldVerificationDisplay(target).source,box=source.bounding_box;
 if(target.case_id!==input.caseId||target.version_id!==input.version||target.source_sha256!==createHash('sha256').update(input.bytes).digest('hex'))throw Error('REQUEST_FIELD_SOURCE_CHANGED');
 if(!box)return null;
 const pdf=input.mime==='application/pdf'?await PDFDocument.load(input.bytes):await PDFDocument.create();
 if(input.mime!=='application/pdf'){
  if(source.page!==1)return null;
  const bitmap=input.mime==='image/png'?await pdf.embedPng(input.bytes):await pdf.embedJpg(input.bytes);
  const page=pdf.addPage([bitmap.width,bitmap.height]);page.drawImage(bitmap,{x:0,y:0,width:bitmap.width,height:bitmap.height});
 }
 const page=pdf.getPages()[source.page-1];if(!page||page.getRotation().angle!==0)return null;
 const {width,height}=page.getSize();
 // PDF pixel coordinates have no reliable DPI mapping. Image dimensions do.
 if(box.coordinate_space==='pixels'&&input.mime==='application/pdf')return null;
 const x=box.x*(box.coordinate_space==='normalized'?width:1),y=box.y*(box.coordinate_space==='normalized'?height:1);
 const w=box.width*(box.coordinate_space==='normalized'?width:1),h=box.height*(box.coordinate_space==='normalized'?height:1);
 if(x<0||y<0||w<=0||h<=0||x+w>width||y+h>height)return null;
 page.drawRectangle({x,y:height-y-h,width:w,height:h,borderColor:rgb(0.8,0.35,0),borderWidth:2,color:rgb(1,0.8,0),opacity:0.12});
 return Buffer.from(await pdf.save());
}
