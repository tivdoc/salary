import {beforeAll,beforeEach,afterEach,it,expect,vi} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import type {CaseAccessDb} from '../case-access/db';
import {loadRealAiServiceDelivery,publishRealAiServiceReport,readRealAiServiceReport,readRealAiServiceRequestReview,assertLoadedRealAiServiceDelivery} from './real-ai-service-delivery';
import {realAiServiceFixture,syntheticServiceId} from './real-ai-service.fixture';

vi.mock('server-only',()=>({}));
let base:ReturnType<typeof realAiServiceFixture>;
beforeAll(()=>{base=realAiServiceFixture();});
beforeEach(()=>{vi.stubEnv('TIVDOC_REAL_AI_SERVICE_ENABLED','1');});
afterEach(()=>{vi.unstubAllEnvs();});
function worker(row:unknown,publication?:unknown):PostgresTransactionContext{
 return {transaction_id:'synthetic-no-db',client:{query:vi.fn(async statement=>({row_count:1,rows:[{value:statement.name==='real_ai_service_report_publish'?publication:row}]}))}};
}
function web(row:unknown):CaseAccessDb{return {provider:'fake',rpc:vi.fn(async()=>[{value:row}]) as CaseAccessDb['rpc']};}
it('loads authenticated REAL source/config/evidence and verifies actual rendered HTML/PDF with the compiled build',async()=>{
 const loaded=await loadRealAiServiceDelivery(worker(base.row),base.selector);
 expect(loaded.report.html_sha256).toBe(base.report.html_sha256);expect(loaded.report.pdf_sha256).toBe(base.report.pdf_sha256);
 expect(()=>assertLoadedRealAiServiceDelivery(loaded)).not.toThrow();
 expect(()=>assertLoadedRealAiServiceDelivery(structuredClone(loaded))).toThrow('REAL_SERVICE_AUTHENTICATED_LOADER_REQUIRED');
 const db=web(base.row),html=await readRealAiServiceReport(db,base.selector,'html'),pdf=await readRealAiServiceReport(db,base.selector,'pdf');
 expect(Buffer.from(html.bytes).equals(Buffer.from(base.report.html))).toBe(true);
 expect(Buffer.from(pdf.bytes).equals(Buffer.from(base.report.pdf))).toBe(true);
 expect(pdf.cache_control).toBe('private, no-store');expect(html).not.toHaveProperty('assessment');expect(pdf).not.toHaveProperty('configuration');
});
it('defaults disabled before any database read',async()=>{
 vi.stubEnv('TIVDOC_REAL_AI_SERVICE_ENABLED','0');const context=worker(base.row);
 await expect(loadRealAiServiceDelivery(context,base.selector)).rejects.toThrow('REAL_SERVICE_DISABLED');expect(context.client.query).not.toHaveBeenCalled();
});
it('returns the exact replay-bound review for server request projection without its authority envelope',async()=>{
 const review=await readRealAiServiceRequestReview(web(base.row),base.selector);
 expect(review).toEqual(base.bundle.document_review);
 expect(review).not.toHaveProperty('configuration');expect(review).not.toHaveProperty('service_decision');expect(review).not.toHaveProperty('ai_release');
});
it.each(['unpublished','superseded','revoked','expired','forbidden'] as const)('never supplies request suppression from %s delivery',async reason=>{
 const row=reason==='unpublished'?{...base.row,publication:null}:{state:'unavailable',reason};
 await expect(readRealAiServiceRequestReview(web(row),base.selector)).rejects.toThrow(reason==='unpublished'?'REAL_SERVICE_REPORT_UNPUBLISHED':`REAL_SERVICE_UNAVAILABLE_${reason.toUpperCase()}`);
});
it.each(['forbidden','revoked','expired','not_enrolled'] as const)('does not fall back after DB reports %s',reason=>{
 return expect(loadRealAiServiceDelivery(worker({state:'unavailable',reason}),base.selector)).rejects.toThrow(`REAL_SERVICE_UNAVAILABLE_${reason.toUpperCase()}`);
});
it.each(['identity','test','enrollment','source','artifact','evidence','configuration','anchor'] as const)('rejects changed authenticated %s',async kind=>{
 const row=structuredClone(base.row);
 if(kind==='identity')row.current.identity_id=syntheticServiceId(99);
 if(kind==='test')row.current.assessment.is_qa=true;
 if(kind==='enrollment')row.enrollment_expires_at=row.current.assessment.evaluated_at;
 if(kind==='source')row.current.assessment.source_pins[0].source_sha256=canonicalSha256({synthetic_changed_document:true});
 if(kind==='artifact')(row.completion.report as Record<string,unknown>).pdf_base64=Buffer.from('tampered').toString('base64');
 if(kind==='evidence')row.evidence[0].content_base64=Buffer.from('tampered').toString('base64');
 if(kind==='configuration')row.configuration_sha256='a'.repeat(64);
 if(kind==='anchor')row.source_created_at='2026-09-12T10:01:00Z';
 const code={identity:'REAL_SERVICE_LOADER_SCOPE',test:'REAL_SERVICE_REAL_CONTEXT_REQUIRED',enrollment:'REAL_SERVICE_ENROLLMENT_EXPIRED',
  source:'AI_RELEASE_CURRENT_ADMISSION_MISMATCH',artifact:'REPORT_HASH_BINDING_INVALID',evidence:'REAL_SERVICE_EVIDENCE_BYTES_CHANGED',
  configuration:'REAL_SERVICE_CONFIGURATION_MISMATCH',anchor:'REAL_SERVICE_EVALUATION_ANCHOR_CHANGED'}[kind];
 await expect(loadRealAiServiceDelivery(worker(row),base.selector).then(()=>undefined)).rejects.toThrow(code);
});
it('requires publication on each read and refuses a publication for another service decision',async()=>{
 const unpublished=structuredClone(base.row);unpublished.publication=null;
 await expect(readRealAiServiceReport(web(unpublished),base.selector,'pdf')).rejects.toThrow('REAL_SERVICE_REPORT_UNPUBLISHED');
 const changed=structuredClone(base.row);changed.publication!.service_decision_sha256='b'.repeat(64);
 await expect(readRealAiServiceReport(web(changed),base.selector,'html')).rejects.toThrow('REAL_SERVICE_PUBLICATION_CHANGED');
});
it('publishes through an exact CAS stage after the saved run and checks the returned binding',async()=>{
 const row=structuredClone(base.row);row.publication=null;
 const ack={...base.row.publication!,published_at:'2026-09-12T10:30:01Z',replayed:false},context=worker(row,ack);
 expect(await publishRealAiServiceReport(context,base.selector)).toEqual(ack);
 const calls=vi.mocked(context.client.query).mock.calls;
 expect(calls.map(c=>c[0].name)).toEqual(['real_ai_service_delivery_context','real_ai_service_report_publish']);
 expect(calls[1][0].values[3]).toBe(row.context_sha256);
 const binding=JSON.parse(String(calls[1][0].values[4]));expect(binding.envelope_sha256).toBe(base.bundle.ai_release!.sha256);
 expect(JSON.parse(String(calls[1][0].values[5])).publication_performed).toBe(false);
 await expect(publishRealAiServiceReport(worker(row,{...ack,envelope_sha256:'e'.repeat(64)}),base.selector)).rejects.toThrow('REAL_SERVICE_PUBLICATION_ACK_BINDING');
});
it('propagates an atomic source/revocation race without retrying against owner/DEV functions',async()=>{
 const context=worker(base.row),query=vi.mocked(context.client.query);
 query.mockImplementationOnce(async()=>({row_count:1,rows:[{value:base.row}]})).mockRejectedValueOnce(Error('REAL_SERVICE_CONTEXT_SUPERSEDED'));
 await expect(publishRealAiServiceReport(context,base.selector)).rejects.toThrow('REAL_SERVICE_CONTEXT_SUPERSEDED');expect(query).toHaveBeenCalledTimes(2);
});
