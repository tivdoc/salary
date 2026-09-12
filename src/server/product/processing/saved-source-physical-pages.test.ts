import {beforeEach,describe,expect,it,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {PDFDocument} from 'pdf-lib';
import sharp from 'sharp';
import type {PostgresStatement,PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import type {SavedWorkerTransactions} from './saved-extraction-worker.ts';
import type {SourceJob} from './source-dispatch.ts';
import {ensureSavedSourcePhysicalPages} from './saved-source-physical-pages.ts';

const ports=vi.hoisted(()=>({admit:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('./saved-admission',()=>({admitSavedSource:ports.admit}));
beforeEach(()=>vi.resetAllMocks());

type Mime='application/pdf'|'image/jpeg'|'image/png';
async function pdfBytes(pages=3){const pdf=await PDFDocument.create();for(let i=0;i<pages;i++)pdf.addPage();return new Uint8Array(await pdf.save());}
const brokenPdf=()=>new TextEncoder().encode('%PDF-1.7\nSynthetic invalid physical page tree\n%%EOF');
function setup(bytes:Uint8Array,mime:Mime='application/pdf'){
 const job:SourceJob={schema_version:'saved-case-work-v1',case_id:randomUUID(),revision:9,input_sha256:'a'.repeat(64),mode:'draft',processing_profile:'qualified_ai_v1',authority_dependency_sha256:'b'.repeat(64)};
 const versionId=randomUUID(),row={document_id:randomUUID(),version_id:versionId,source_sha256:createHash('sha256').update(bytes).digest('hex'),byte_size:bytes.length,mime_type:mime,
  storage_path:`cases/${job.case_id}/versions/${versionId}.${mime==='application/pdf'?'pdf':mime==='image/png'?'png':'jpg'}`};
 const state={lease:true,current:true,pending:[row],afterRead:()=>{},beforeAdmit:()=>{}};
 const events:string[]=[],queries:PostgresStatement[]=[];let depth=0;
 const context:PostgresTransactionContext={transaction_id:'synthetic-physical-pages',client:{async query(query){
  expect(depth).toBe(1);queries.push(query);events.push(query.name);
  if(query.name==='source_physical_lease'){
   expect(query.values).toEqual(['synthetic-job',job.case_id,JSON.stringify(job),'synthetic-worker',7]);
   for(const fence of ["state='running'",'lease_owner=$4','fencing_token=$5','lease_expires_at>clock_timestamp()','not cancellation_requested','payload=$3::jsonb'])expect(query.text).toContain(fence);
   return {rows:state.lease?[{job_id:'synthetic-job'}]:[],row_count:state.lease?1:0};
  }
  if(query.name==='source_physical_pending'){
   expect(query.values).toEqual([job.case_id,job.revision,job.input_sha256]);return {rows:[{value:state.pending}],row_count:1};
  }
  if(query.name==='source_physical_record')return {rows:[{}],row_count:1};
  throw Error('UNEXPECTED_QUERY:'+query.name);
 }}};
 ports.admit.mockImplementation(async(c,j)=>{expect(depth).toBe(1);expect(c).toBe(context);expect(j).toBe(job);events.push('admit');state.beforeAdmit();if(!state.current)throw Error('ANALYSIS_INPUT_SUPERSEDED');});
 const transactions:SavedWorkerTransactions=async operation=>{expect(depth).toBe(0);depth++;events.push('begin');try{const result=await operation(context);events.push('commit');return result;}catch(error){events.push('rollback');throw error;}finally{depth--;}};
 const download=vi.fn(async(path:string):Promise<{data:Blob|null;error:unknown}>=>{expect(depth).toBe(0);expect(path).toBe(row.storage_path);events.push('download');state.afterRead();return {data:new Blob([Uint8Array.from(bytes)]),error:null};});
 const input={job,jobId:'synthetic-job',workerId:'synthetic-worker',fencingToken:7,transactions,storage:{download}};
 const records=()=>queries.filter(q=>q.name==='source_physical_record');
 return {input,row,state,events,queries,download,records,run:()=>ensureSavedSourcePhysicalPages(input)};
}

describe('saved source physical metadata with ordinary source and lease fences',()=>{
 it('records the real PDF page count with exact immutable source metadata after storage I/O outside transactions',async()=>{
  const f=setup(await pdfBytes(3)),before=JSON.stringify(f.row);
  expect(await f.run()).toEqual({recorded:1,unreadableVersions:[]});
  expect(f.records()).toHaveLength(1);expect(f.records()[0].values).toEqual([f.input.job.case_id,f.row.document_id,f.row.version_id,f.row.source_sha256,f.row.byte_size,'application/pdf',3]);
  expect(f.events).toEqual(['begin','admit','source_physical_lease','source_physical_pending','commit','begin','admit','source_physical_lease','commit','download','begin','admit','source_physical_lease','source_physical_record','commit']);
  expect(JSON.stringify(f.row)).toBe(before);
 });
 it.each(['image/png','image/jpeg'] as const)('decodes real %s bytes and records one physical page, retaining its exact MIME and hash',async mime=>{
  const image=sharp({create:{width:4,height:3,channels:3,background:'white'}}),bytes=await (mime==='image/png'?image.png():image.jpeg()).toBuffer();
  const f=setup(bytes,mime);expect(await f.run()).toEqual({recorded:1,unreadableVersions:[]});
  expect(f.records()[0].values).toEqual([f.input.job.case_id,f.row.document_id,f.row.version_id,f.row.source_sha256,bytes.length,mime,1]);
 });
 it('does no storage work when all physical receipts already exist',async()=>{
  const f=setup(await pdfBytes());f.state.pending=[];expect(await f.run()).toEqual({recorded:0,unreadableVersions:[]});expect(f.download).not.toHaveBeenCalled();expect(f.records()).toEqual([]);
 });
 it.each(['source','lease'] as const)('rejects a stale %s before storage I/O',async reason=>{
  const f=setup(await pdfBytes());if(reason==='source')f.state.current=false;else f.state.lease=false;
  await expect(f.run()).rejects.toThrow(reason==='source'?'ANALYSIS_INPUT_SUPERSEDED':'SAVED_JOB_FENCE');expect(f.download).not.toHaveBeenCalled();expect(f.records()).toEqual([]);
 });
 it.each(['source','lease'] as const)('rechecks the %s after storage and rejects replacement, cancellation or lease loss before recording',async reason=>{
  const f=setup(await pdfBytes());f.state.afterRead=()=>{if(reason==='source')f.state.current=false;else f.state.lease=false;};
  await expect(f.run()).rejects.toThrow(reason==='source'?'ANALYSIS_INPUT_SUPERSEDED':'SAVED_JOB_FENCE');expect(f.download).toHaveBeenCalledOnce();expect(f.records()).toEqual([]);expect(f.events.at(-1)).toBe('rollback');
 });
 it.each(['size','hash'] as const)('rejects changed source %s before certifying physical metadata',async reason=>{
  const f=setup(await pdfBytes());if(reason==='size')f.row.byte_size++;else f.row.source_sha256='f'.repeat(64);
  await expect(f.run()).rejects.toThrow('SOURCE_INTAKE_PHYSICAL_CHANGED');expect(f.records()).toEqual([]);
 });
 it('checks the fence again before downloading a second pending file, preserving the first recorded receipt',async()=>{
  const f=setup(await pdfBytes()),secondVersion=randomUUID();f.state.pending.push({...f.row,document_id:randomUUID(),version_id:secondVersion,storage_path:`cases/${f.input.job.case_id}/versions/${secondVersion}.pdf`});
  let admissions=0;f.state.beforeAdmit=()=>{if(++admissions===4)f.state.lease=false;};
  await expect(f.run()).rejects.toThrow('SAVED_JOB_FENCE');expect(f.download).toHaveBeenCalledOnce();expect(f.records()).toHaveLength(1);expect(f.records()[0].values[2]).toBe(f.row.version_id);
 });
 it.each(['case','version','extension'] as const)('rejects a foreign storage %s path before download',async reason=>{
  const f=setup(await pdfBytes());f.row.storage_path=reason==='case'?f.row.storage_path.replace(f.input.job.case_id,randomUUID()):reason==='version'?f.row.storage_path.replace(f.row.version_id,randomUUID()):f.row.storage_path.replace('.pdf','.png');
  await expect(f.run()).rejects.toThrow('SOURCE_INTAKE_PHYSICAL_SCOPE');expect(f.download).not.toHaveBeenCalled();expect(f.records()).toEqual([]);
 });
 it.each(['missing','error'] as const)('reports %s storage without manufacturing physical metadata',async reason=>{
  const f=setup(await pdfBytes());f.download.mockResolvedValue({data:reason==='missing'?null:new Blob(),error:reason==='error'?Error('Synthetic storage failure'):null});
  await expect(f.run()).rejects.toThrow('SOURCE_INTAKE_PHYSICAL_UNAVAILABLE');expect(f.records()).toEqual([]);
 });
 it('holds malformed but correctly hashed PDF bytes as unreadable without inventing page one',async()=>{
  const f=setup(brokenPdf());expect(await f.run()).toEqual({recorded:0,unreadableVersions:[f.row.version_id]});expect(f.records()).toEqual([]);
 });
 it('does not certify truncated image headers as a physical page',async()=>{
  const f=setup(new Uint8Array([137,80,78,71,13,10,26,10]),'image/png');expect(await f.run()).toEqual({recorded:0,unreadableVersions:[f.row.version_id]});expect(f.records()).toEqual([]);
 });
 it('rejects stale source after malformed bytes rather than returning a successful unreadable result',async()=>{
  const f=setup(brokenPdf());f.state.afterRead=()=>{f.state.current=false;};await expect(f.run()).rejects.toThrow('ANALYSIS_INPUT_SUPERSEDED');expect(f.records()).toEqual([]);
 });
});
