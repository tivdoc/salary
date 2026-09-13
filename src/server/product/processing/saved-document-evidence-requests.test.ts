import {describe,it,expect,vi,beforeEach} from 'vitest';
vi.mock('server-only',()=>({}));
vi.mock('./saved-admission',()=>({admitSavedSource:vi.fn(async()=>({}))}));
const orderScope=vi.hoisted(()=>({topics:['working_time'],months:['2026-07']}));
vi.mock('./saved-order-scope',()=>({readSavedOrders:vi.fn(async()=>[orderScope]),purchasedMonths:(order:{months:string[]})=>order.months}));
import {admitSavedSource} from './saved-admission';
import {readSavedOrders} from './saved-order-scope';
import type {PostgresTransactionContext,PostgresStatement} from '@/server/platform/persistence/postgres/contracts';
import {sourceJobSchema} from './source-dispatch';
import {openSavedDocumentEvidenceRequests} from './saved-document-evidence-requests';
import {evidenceReadingFixture,evidenceUuid} from '../reports/document-evidence-reading.fixtures';

function setup(){
 const f=evidenceReadingFixture(),job=sourceJobSchema.parse({schema_version:'saved-case-work-v1',case_id:f.document.case_id,revision:1,input_sha256:'c'.repeat(64),mode:'draft'});
 const targets:unknown[]=[];let altered=false;
 const client={async query(query:PostgresStatement){
  if(query.name==='document_evidence_reading_source')return {row_count:1,rows:[{id:f.productDocumentId,case_id:f.document.case_id,version_id:f.document.document_id,
   content_sha256:f.document.content_sha256,document_type:'attendance',storage_path:`cases/${f.document.case_id}/versions/${f.document.document_id}.png`,
   original_filename:f.document.original_filename,mime_type:f.document.mime_type,size:f.document.size_bytes,created_at:f.document.created_at,
   result:altered?{...f.checkpoint,input_sha256:'f'.repeat(64)}:f.checkpoint}]};
  if(query.name==='document_evidence_reading_open'){targets.push(JSON.parse(String(query.values[3])));return {row_count:1,rows:[{id:evidenceUuid(15)}]};}
  throw Error(`UNEXPECTED_QUERY:${query.name}`);
 }};
 const context:PostgresTransactionContext={client,transaction_id:'synthetic-request-transaction'};
 return {f,job,context,targets,alter(){altered=true;}};
}
beforeEach(()=>{vi.clearAllMocks();orderScope.topics=['working_time'];orderScope.months=['2026-07'];});
describe('saved non-payroll request opening',()=>{
 it('narrows a consumed rest-day cell to its purchased report month without granting another month',async()=>{
  orderScope.topics=['rest_day'];orderScope.months=['2026-06','2026-07'];
  const f=setup(),result=await openSavedDocumentEvidenceRequests(f.context,f.job,f.f.checkpoint,{month:'2026-07',observationIds:[f.f.observationId]});
  expect(result.opened).toHaveLength(1);expect(result.opened[0].month).toBe('2026-07');
  const outside=await openSavedDocumentEvidenceRequests(f.context,f.job,f.f.checkpoint,{month:'2026-08',observationIds:[f.f.observationId]});
  expect(outside.state).toBe('outside_purchased_scope');expect(outside.opened).toEqual([]);expect(f.targets).toHaveLength(1);
 });
 it('admits the current source and opens only initial period gates by default',async()=>{
  const f=setup(),result=await openSavedDocumentEvidenceRequests(f.context,f.job,f.f.checkpoint);
  expect(admitSavedSource).toHaveBeenCalledWith(f.context,f.job);expect(readSavedOrders).toHaveBeenCalled();
  expect(result.opened).toHaveLength(1);expect(result.deferred).toContain(f.f.observationId);
  expect(f.targets[0]).toMatchObject({month:'2026-07',observation:{original:{semantic:'period_start'}}});
 });
 it('opens exact consumed cells only and rejects forged selectors',async()=>{
  const f=setup(),result=await openSavedDocumentEvidenceRequests(f.context,f.job,f.f.checkpoint,{observationIds:[f.f.observationId]});
  expect(result.opened).toHaveLength(1);expect(result.opened[0].observationId).toBe(f.f.observationId);
  await expect(openSavedDocumentEvidenceRequests(f.context,f.job,f.f.checkpoint,{observationIds:['f'.repeat(64)]})).rejects.toThrow('SELECTOR');
 });
 it('refuses a changed current checkpoint before opening any question',async()=>{
  const f=setup();f.alter();await expect(openSavedDocumentEvidenceRequests(f.context,f.job,f.f.checkpoint)).rejects.toThrow('SOURCE_CHANGED');expect(f.targets).toEqual([]);
 });
});
