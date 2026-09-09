import {beforeEach,describe,it,expect,vi} from 'vitest';
import type {VerifiedProductSession} from '../auth/hermetic-session';
import {createManagedWorkerHttpHandler} from './managed-worker-http';
vi.mock('server-only',()=>({}));
beforeEach(()=>vi.resetAllMocks());
function setup(){
 const session:VerifiedProductSession={audience:'operations',csrf_token:'synthetic-csrf',expires_at_epoch:1800000000,
  actor:{actor_id:'synthetic.owner',role:'intake_operator',tenant_id:null,assigned_case_ids:[],verified_server_side:true,break_glass_reason:null,break_glass_expires_at:null}};
 const verify=vi.fn(async()=>session as VerifiedProductSession|null),read=vi.fn(async()=>[]),retry=vi.fn();
 const config={enabled:true,sessions:{verify},read,retry,ownerId:'synthetic.owner'};
 const handler=createManagedWorkerHttpHandler(config);
 const body={action:'retry',caseId:'11111111-1111-4111-8111-111111111111',jobId:'saved_job',expectedRevision:3};
 const post=(value:unknown=body)=>handler(new Request('http://127.0.0.1/api/operations/dev-worker',{method:'POST',headers:{'content-type':'application/json','x-tivdoc-csrf':'synthetic-csrf'},body:JSON.stringify(value)}));
 return {config,handler,verify,read,retry,session,body,post};
}
describe('managed DEV operations boundary',()=>{
 it('requires an existing verified operations session before reading',async()=>{
  const s=setup();s.verify.mockResolvedValue(null);expect((await s.handler(new Request('http://127.0.0.1/api/operations/dev-worker'))).status).toBe(404);
  expect(s.read).not.toHaveBeenCalled();
 });
 it('refuses a verified operator other than the configured owner',async()=>{
  const s=setup();s.session.actor.actor_id='other.owner';expect((await s.post()).status).toBe(404);expect(s.retry).not.toHaveBeenCalled();
 });
 it('does not turn a disabled surface into an auth probe',async()=>{
  const s=setup();s.config.enabled=false;expect((await s.post()).status).toBe(404);expect(s.verify).not.toHaveBeenCalled();
 });
 it('verifies CSRF for retry and forwards only the exact current-revision command',async()=>{
  const s=setup();s.retry.mockResolvedValue({job_id:'saved_job',job_revision:4,replayed:false});expect((await s.post()).status).toBe(200);
  expect(s.verify.mock.calls[0]).toEqual([expect.any(Request),'operations',true]);
  expect(s.retry).toHaveBeenCalledWith({caseId:s.body.caseId,jobId:'saved_job',expectedRevision:3});
 });
 it('rejects client-supplied status, identity and missing revision instead of weakening retry',async()=>{
  const s=setup();for(const body of [{...s.body,state:'complete'},{...s.body,identity:'foreign'},{...s.body,expectedRevision:0}])expect((await s.post(body)).status).toBe(400);
  expect(s.retry).not.toHaveBeenCalled();
 });
 it('reports a refused retry safely without exposing SQL or provider text',async()=>{
  const s=setup();s.retry.mockRejectedValue(Error('secret db capability and provider URL'));const response=await s.post();
  expect(response.status).toBe(409);expect(await response.json()).toEqual({code:'MANAGED_DEV_RETRY_REFUSED'});
 });
 it('reads operational status without asking for write CSRF',async()=>{
  const s=setup(),response=await s.handler(new Request('http://127.0.0.1/api/operations/dev-worker'));
  expect(response.status).toBe(200);expect(s.verify.mock.calls[0]).toEqual([expect.any(Request),'operations',false]);expect(s.read).toHaveBeenCalledOnce();
  expect(response.headers.get('cache-control')).toContain('no-store');
 });
});
