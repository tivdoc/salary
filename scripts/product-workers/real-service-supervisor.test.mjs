import {describe,it,expect} from 'vitest';
import path from 'node:path';
import {buildSupervisorEnvironment,validateSupervisorControl,summarizeRealServiceSupervisorOutput,summarizeSupervisorOutput} from './managed-dev-supervisor.mjs';

const sha='a'.repeat(40),privateId='00000000-0000-4000-8000-000000000001';
const environment=()=>({NODE_ENV:'production',TIVDOC_REAL_AI_SERVICE_ENABLED:'1',TIVDOC_REAL_AI_MACHINE_ISSUER_ENABLED:'1',
 TIVDOC_REAL_SERVICE_RUNTIME_CONFIG:JSON.stringify({schema_version:'real-service-runtime-v1',build_sha:sha,extraction_mode:'saved_receipts_only'})});
describe('REAL profile on the existing bounded supervisor',()=>{
 it('accepts only the separate REAL environment and never inherits provider/startup/DEV credentials',()=>{
  const raw={...environment(),TIVDOC_REAL_SERVICE_CONTROLLER_CAPABILITY:'owned'};
  expect(buildSupervisorEnvironment(raw,{SystemRoot:'C:/Windows',NODE_OPTIONS:'private',OPENAI_API_KEY:'private',TIVDOC_MANAGED_DEV_WORKER_CAPABILITY:'private'},sha,'real_service'))
   .toEqual({SystemRoot:'C:/Windows',...raw});
 });
 it.each(['OPENAI_API_KEY','TIVDOC_MANAGED_DEV_WORKER_ENABLED','SUPABASE_SERVICE_ROLE_KEY'])('refuses %s in the receipts-only REAL environment',key=>{
  expect(()=>buildSupervisorEnvironment({...environment(),[key]:'private'}, {},sha,'real_service')).toThrow('SUPERVISOR_ENVIRONMENT_INVALID');
 });
 it('refuses a changed build or extraction mode before spawning',()=>{
  const raw=environment();expect(()=>buildSupervisorEnvironment(raw,{},'b'.repeat(40),'real_service')).toThrow('SUPERVISOR_ENVIRONMENT_INVALID');
  raw.TIVDOC_REAL_SERVICE_RUNTIME_CONFIG=JSON.stringify({schema_version:'real-service-runtime-v1',build_sha:sha,extraction_mode:'budgeted_provider'});
  expect(()=>buildSupervisorEnvironment(raw,{},sha,'real_service')).toThrow('SUPERVISOR_ENVIRONMENT_INVALID');
 });
 it('accepts explicitly configured budgeted provider credentials without inheriting caller credentials',()=>{
  const raw={...environment(),TIVDOC_REAL_AI_PROVIDER_ENABLED:'1',OPENAI_API_KEY:'explicit-private-key',
   TIVDOC_REAL_SERVICE_PROVIDER_ARTIFACT_DIRECTORY:path.resolve('../release-work/synthetic-provider-artifacts'),
   TIVDOC_REAL_SERVICE_RUNTIME_CONFIG:JSON.stringify({schema_version:'real-service-runtime-v1',build_sha:sha,extraction_mode:'budgeted_provider'})};
  expect(buildSupervisorEnvironment(raw,{OPENAI_API_KEY:'inherited-private-key',HTTPS_PROXY:'untrusted'},sha,'real_service')).toEqual(raw);
  for(const key of ['TIVDOC_REAL_AI_PROVIDER_ENABLED','OPENAI_API_KEY','TIVDOC_REAL_SERVICE_PROVIDER_ARTIFACT_DIRECTORY']){
   const missing={...raw};delete missing[key];expect(()=>buildSupervisorEnvironment(missing,{},sha,'real_service')).toThrow('SUPERVISOR_ENVIRONMENT_INVALID');
  }
 });
 it('permits a finite REAL scheduling window without enlarging the historical DEV window',()=>{
  const root=path.resolve('synthetic-repo'),now=Date.now(),out=path.join(root,'output/release-completion/real-service-worker');
  const control={schema_version:'real-service-supervisor-v1',control_id:privateId,enabled:false,expires_at:new Date(now+86400000).toISOString(),expected_git_sha:sha,
   expected_bundle_sha256:'b'.repeat(64),expected_manifest_sha256:'c'.repeat(64),working_directory:root,bundle_path:path.join(out,'worker.cjs'),manifest_path:path.join(out,'manifest.json'),
   environment_path:path.resolve(root,'../release-work/env.private.json'),output_directory:path.join(out,'receipts'),max_ticks:1440,child_timeout_ms:480000};
  expect(validateSupervisorControl(control,root,now).expiry).toBe(now+86400000);
  expect(()=>validateSupervisorControl({...control,schema_version:'managed-dev-supervisor-v1'},root,now)).toThrow('SUPERVISOR_EXPIRY_INVALID');
  expect(()=>validateSupervisorControl({...control,max_ticks:44641},root,now)).toThrow('SUPERVISOR_LIMIT_INVALID');
 });
 it('retains provenance hashes and separate phase outcomes while excluding credentials and customer text',()=>{
  const raw={worker:'real_service',state:'finished',error:'private_error',buildSha:sha,iteration:{items:[{caseId:privateId,
   processing:{state:'succeeded',lastError:'private_customer_text'},notification:{state:'finished',deliveryConfirmed:true,encrypted_payload:'private'},host:'closed'}]},
   machines:[{case_id:privateId,state:'active',provenance_sha256:'d'.repeat(64),expires_at:'2026-09-13T02:00:00Z',session_id:'private_sid',token_id:'private_jti'}],
   cleanup:[{resource:'issuer',state:'closed'}]};
  const summary=summarizeRealServiceSupervisorOutput(JSON.stringify(raw));expect(summary.items[0]).toMatchObject({processing:'succeeded',notification:'finished',deliveryConfirmed:false});
  expect(summary.machines[0].provenance_sha256).toBe('d'.repeat(64));expect(JSON.stringify(summary)).not.toContain('private');
  expect(summarizeSupervisorOutput(JSON.stringify(raw))).toEqual({state:'invalid_output'});
 });
});
