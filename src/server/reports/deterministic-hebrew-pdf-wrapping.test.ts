import {readFileSync} from 'node:fs';
import {PDFArray,PDFDict,PDFDocument,PDFName,PDFNumber,PDFRawStream} from 'pdf-lib';
import {expect,it,vi} from 'vitest';
import {renderDeterministicRtlDocument,type RtlDocument} from './deterministic-hebrew-pdf';
import {renderDevFinancialArtifacts} from '../product/reports/dev-financial-artifacts';
vi.mock('server-only',()=>({}));

// Inspect the actual PDF text operators and its embedded CID width table,
// independently of the renderer's wrapping/TrueType measurement helpers.
async function readLayout(bytes:Uint8Array){
 const pdf=await PDFDocument.load(bytes);
 return pdf.getPages().map(page=>{
  const resources=page.node.Resources();if(!resources)throw Error('PDF_RESOURCES_MISSING');
  const font=resources.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict);
  const widths=font.lookup(PDFName.of('DescendantFonts'),PDFArray).lookup(0,PDFDict).lookup(PDFName.of('W'),PDFArray);
  const byGlyph=new Map<number,number>();
  for(let i=0;i<widths.size();i+=2){
   const first=widths.lookup(i,PDFNumber).asNumber(),values=widths.lookup(i+1,PDFArray);
   for(let j=0;j<values.size();j++)byGlyph.set(first+j,values.lookup(j,PDFNumber).asNumber());
  }
  const contents=page.node.Contents();if(!(contents instanceof PDFRawStream))throw Error('PDF_CONTENT_STREAM_MISSING');
  const command=/\/ActualText <FEFF([0-9a-f]*)> >> BDC BT \/F1 ([\d.]+) Tf 1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm <([0-9a-f]*)> Tj/giu;
  const runs=[...contents.getContentsString().matchAll(command)].map(match=>{
   const text=Buffer.from(match[1],'hex').swap16().toString('utf16le'),size=Number(match[2]),x=Number(match[3]),y=Number(match[4]);
   const glyphs=match[5].match(/.{4}/gu)??[];
   const width=glyphs.reduce((sum,glyph)=>{const w=byGlyph.get(parseInt(glyph,16));if(w===undefined)throw Error('PDF_GLYPH_WIDTH_MISSING');return sum+w*size/1000;},0);
   return {text,size,x,y,width};
  });
  expect(runs.length).toBeGreaterThan(0);
  return {width:page.getWidth(),height:page.getHeight(),runs};
 });
}
function table(value:string,wrap_cells?:boolean):RtlDocument{
 return {title:'Synthetic measured cells',subject:'synthetic-wrapping-regression',fixed_date:'20260630',blocks:[{kind:'table',columns:['פרט','ערך'],rows:[['עקבות ספק',value]],...(wrap_cells===undefined?{}:{wrap_cells})}]};
}
function requireContainedPages(pages:Awaited<ReturnType<typeof readLayout>>){
 for(const page of pages){
  expect(page.runs.filter(run=>run.text==='פרט')).toHaveLength(1);
  expect(page.runs.filter(run=>run.text==='ערך')).toHaveLength(1);
  for(const run of page.runs){
   const middle=page.width/2,left=run.x<middle?42:middle,right=run.x<middle?middle:page.width-42;
   // Three points of interior padding tolerate the PDF width table's integer
   // rounding while refusing clipped or overlapping text at either boundary.
   expect(run.x,run.text).toBeGreaterThanOrEqual(left+3);
   expect(run.x+run.width,run.text).toBeLessThanOrEqual(right-3);
   expect(run.y,run.text).toBeGreaterThanOrEqual(66);
   expect(run.y+run.size,run.text).toBeLessThanOrEqual(page.height-42);
  }
 }
}

it.each(['initial-calculated','answered-calculated'])('preserves exact stored legacy %s HTML and PDF bytes without provenance',name=>{
 const root='docs/release-evidence/dev-financial-example/',input=JSON.parse(readFileSync(root+name+'.json','utf8'));
 expect(input.extraction_provenance).toBeUndefined();
 const rendered=renderDevFinancialArtifacts(input);
 expect(Buffer.from(rendered.pdf).equals(readFileSync(root+name+'.pdf'))).toBe(true);
 expect(rendered.html).toBe(readFileSync(root+name+'.html','utf8'));
});

it('keeps a full 240-character provider identifier and model inside the actual PDF cell',async()=>{
 const id='req_'+('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.repeat(7)).slice(0,236),value='gpt-5.6-sol;  '+id;
 expect(id).toHaveLength(240);
 const pages=await readLayout(renderDeterministicRtlDocument(table(value,true)));requireContainedPages(pages);
 const fragments=pages.flatMap(page=>page.runs.filter(run=>run.x<page.width/2&&run.text!=='ערך').map(run=>run.text));
 expect(fragments.length).toBeGreaterThan(1);expect(fragments.join('')).toBe(value);
});

it('splits a row taller than a page without lost text, overflow or missing repeated headers',async()=>{
 const value='W'.repeat(6000),document=table(value,true);
 const block=document.blocks[0];if(block.kind!=='table')throw Error('TEST_TABLE_REQUIRED');
 const pages=await readLayout(renderDeterministicRtlDocument({...document,blocks:[{...block,rows:[...block.rows,['סיום','tail-sentinel']]}]}));
 expect(pages.length).toBeGreaterThanOrEqual(3);requireContainedPages(pages);
 const values=pages.flatMap(page=>page.runs.filter(run=>run.x<page.width/2&&run.text!=='ערך').map(run=>run.text)).join('');
 expect(values).toBe(value+'tail-sentinel');
});

it('keeps the historical single-line path opt-in and reproduces the clipping defect when wrapping is absent',async()=>{
 const value='W'.repeat(240),legacy=renderDeterministicRtlDocument(table(value)),explicit=renderDeterministicRtlDocument(table(value,false));
 expect(Buffer.from(legacy).equals(Buffer.from(explicit))).toBe(true);
 const pages=await readLayout(legacy);expect(pages.flatMap(page=>page.runs).some(run=>run.text===value&&run.x<42)).toBe(true);
});

it('preserves an unbroken source URL in measured paragraphs while leaving legacy bytes unchanged',async()=>{
 const value='https://example.test/source/'+('W'.repeat(600));
 const document:RtlDocument={title:'Synthetic source URL',subject:'paragraph width regression',fixed_date:'20260911',blocks:[{kind:'paragraph',text:value}]};
 const legacy=renderDeterministicRtlDocument(document);
 const explicit=renderDeterministicRtlDocument({...document,blocks:[{kind:'paragraph',text:value,wrap_text:false}]});
 expect(legacy).toEqual(explicit);
 expect((await readLayout(legacy)).flatMap(p=>p.runs).some(r=>r.x<0)).toBe(true);
 const measured=await readLayout(renderDeterministicRtlDocument({...document,blocks:[{kind:'paragraph',text:value,wrap_text:true}]}));
 expect(measured.flatMap(p=>p.runs.map(r=>r.text)).join('')).toBe(value);
 for(const p of measured)for(const r of p.runs){
  expect(r.x).toBeGreaterThanOrEqual(41.9);
  expect(r.x+r.width).toBeLessThanOrEqual(p.width-41.9);
  expect(r.y).toBeGreaterThanOrEqual(66);
 }
});
