import {describe,it,expect} from 'vitest';
import {PDFDocument} from 'pdf-lib';
import sharp from 'sharp';
import {inspectSourcePhysicalPages} from './physical-pages';
describe('physical source pages',()=>{
 it('parses the page tree without treating page-looking text as pages',async()=>{
  const pdf=await PDFDocument.create();pdf.addPage().drawText('/Type /Page /Type /Page');pdf.addPage();
  expect(await inspectSourcePhysicalPages(await pdf.save(),'application/pdf')).toBe(2);
 });
 it('decodes a real single image and rejects wrong MIME and truncation',async()=>{
  const image=await sharp({create:{width:40,height:40,channels:3,background:'white'}}).png().toBuffer();
  expect(await inspectSourcePhysicalPages(image,'image/png')).toBe(1);
  await expect(inspectSourcePhysicalPages(image,'image/jpeg')).rejects.toThrow('SOURCE_PHYSICAL_INVALID');
  await expect(inspectSourcePhysicalPages(image.subarray(0,40),'image/png')).rejects.toThrow('SOURCE_PHYSICAL_INVALID');
 });
 it('refuses malformed and oversized inputs rather than assuming one page',async()=>{
  await expect(inspectSourcePhysicalPages(new TextEncoder().encode('%PDF-1.7 garbage'),'application/pdf')).rejects.toThrow('SOURCE_PHYSICAL_INVALID');
  await expect(inspectSourcePhysicalPages(new Uint8Array(10*1024*1024+1),'image/png')).rejects.toThrow('SOURCE_PHYSICAL_INVALID');
  const pdf=await PDFDocument.create();for(let i=0;i<101;i++)pdf.addPage();
  await expect(inspectSourcePhysicalPages(await pdf.save(),'application/pdf')).rejects.toThrow('SOURCE_PHYSICAL_INVALID');
 });
});
