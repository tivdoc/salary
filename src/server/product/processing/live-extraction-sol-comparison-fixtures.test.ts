import {expect,it,vi} from 'vitest';
import {mkdirSync,writeFileSync,readFileSync,readdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {createSolSingleBaseSource} from './live-extraction-sol-comparison-fixtures';
vi.mock('server-only',()=>({}));

it('keeps the three independent source scenarios distinct and does not encode an inferred answer in absent-hours',async()=>{
 const clear=createSolSingleBaseSource('clear'),absent=createSolSingleBaseSource('absent-hours'),conflict=createSolSingleBaseSource('conflicting-hours');
 expect(clear.oracle).toMatchObject({regularHours:['100'],hourlyRateMinor:3300,canonicalExpectedMinor:354058,canonicalGapMinor:24058});
 expect(absent.oracle).toMatchObject({regularHours:[],hourlyRateMinor:null,canonicalExpectedMinor:null,canonicalGapMinor:null});
 expect(conflict.oracle).toMatchObject({regularHours:['100','120'],hourlyRateMinor:null,canonicalGapMinor:null});
 expect(new Set([clear.sha256,absent.sha256,conflict.sha256]).size).toBe(3);
 for(const fixture of [clear,absent,conflict]){
  expect(fixture.bytes).toEqual(createSolSingleBaseSource(fixture.kind).bytes);
  expect((await PDFDocument.load(fixture.bytes)).getPageCount()).toBe(1);
 }
},30000);

it.skipIf(process.env.TIVDOC_SOL_SOURCE_FIXTURES!=='1')('exports and renders the three actual Hebrew source PDFs and separate oracles without calling a provider',()=>{
 const directory='output/release-completion/live-provider-sol-comparison/single-base-inputs';mkdirSync(directory,{recursive:true});
 const python=process.env.TIVDOC_PDF_PYTHON;if(!python)throw Error('SOL_FIXTURE_PDF_PYTHON_REQUIRED');
 const files=[];
 for(const kind of ['clear','absent-hours','conflicting-hours'] as const){
  const {bytes,...fixture}=createSolSingleBaseSource(kind),file=path.join(directory,fixture.name);writeFileSync(file,bytes);
  const text=execFileSync(python,['-c','import sys,pdfplumber; p=pdfplumber.open(sys.argv[1]); print("\\n".join(x.extract_text() or "" for x in p.pages))',file],{encoding:'utf8'});
  expect(text).toContain('3300.00');expect(text).toContain('06/2026');expect(text).not.toContain('3540');expect(text).not.toContain('240.58');
  if(kind==='clear')expect(text).toContain('33.00');
  if(kind==='absent-hours'){expect(text).not.toContain('100');expect(text).not.toContain('120');expect(text).not.toContain('33.00');}
  if(kind==='conflicting-hours'){expect(text).toContain('100');expect(text).toContain('120');expect(text).not.toContain('33.00');}
  writeFileSync(path.join(directory,fixture.id+'-source-text.txt'),text);
  execFileSync('pdftoppm',['-png','-r','108',file,path.join(directory,fixture.id)],{stdio:'pipe'});
  files.push({...fixture,path:file.replaceAll('\\','/'),renderedPngs:readdirSync(directory).filter(name=>name.startsWith(fixture.id+'-')&&name.endsWith('.png'))});
  expect(readFileSync(file)).toEqual(Buffer.from(bytes));
 }
 writeFileSync(path.join(directory,'independent-input-oracles.json'),JSON.stringify({schemaVersion:'sol-hebrew-single-base-inputs-v1',synthetic:true,
  providerCalled:false,humanReview:false,legalGoldenApproval:false,files},null,2)+'\n');
},30000);
