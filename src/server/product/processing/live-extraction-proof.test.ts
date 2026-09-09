import {it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {z} from 'zod';
import {resolvedPayslipFactPaths} from '@/engine/extraction/resolver';
import {extractSavedPayslip} from '@/server/engine/extraction/saved-payslip';
import {createLiveExtractionRuntime} from './live-extraction-runtime';
import {readSavedExtractionProvenance} from './live-extraction-provenance';
import {liveFixtureSha} from './live-extraction-fixtures';
vi.mock('server-only',()=>({}));

const manifestSchema=z.object({synthetic:z.literal(true),providerCalled:z.literal(false),files:z.array(z.object({
 id:z.string(),path:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/u),sizeBytes:z.number().int().positive(),
 mimeType:z.enum(['application/pdf','image/png','image/jpeg']),oracle:z.object({hours:z.array(z.string()),baseMinor:z.number().int(),
  outcome:z.enum(['readable','essential_input_missing','conflicting_observations'])})})).length(7)});

// No provider/SDK mock exists in this test. Enable explicitly only to send the
// seven synthetic inputs to the configured real API. It never creates findings,
// reports, customer confirmations or database rows.
it.skipIf(process.env.TIVDOC_LIVE_EXTRACTION_PROOF!=='1')('proves actual provider reads against seven independent synthetic inputs',async()=>{
 if(process.env.VERCEL||process.env.NODE_ENV!=='test')throw Error('LIVE_EXTRACTION_PROOF_DEV_ONLY');
 const directory='output/release-completion/automatic-dev-live-extraction';mkdirSync(directory,{recursive:true});
 const runtime=createLiveExtractionRuntime(),results:unknown[]=[],failures:string[]=[];let providerAttempted=false;
 const record=(state:string)=>writeFileSync(`${directory}/live-provider-proof.json`,JSON.stringify({schemaVersion:'tivdoc-live-provider-proof-v1',
  state,checkedAt:new Date().toISOString(),gitSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  worktreeDirty:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim().length>0,
  providerCalled:providerAttempted,providerKind:runtime.state==='configured'?runtime.provider.kind:null,
  configuration:runtime.state==='blocked'?{state:runtime.state,code:runtime.code}:runtime.provider,
  results,failures,productionChanged:false,databaseChanged:false,humanConfirmations:false,
  scope:'Actual API extraction only; synthetic English PDFs and raster simulations. This does not prove a real Israeli payslip, customer identity, payment or legal activation.'},null,2)+'\n');
 if(runtime.state==='blocked'){record('BLOCKED_CONFIGURATION');throw Error(runtime.code);}
 const manifest=manifestSchema.parse(JSON.parse(readFileSync('docs/release-evidence/automatic-dev-live-extraction/independent-input-oracles.json','utf8')));
 record('RUNNING');
 for(const entry of manifest.files){
  const bytes=readFileSync(entry.path),caseId=randomUUID(),versionId=randomUUID(),runId=randomUUID(),extension=entry.mimeType==='application/pdf'?'pdf':entry.mimeType==='image/png'?'png':'jpg';
  const path=`cases/${caseId}/versions/${versionId}.${extension}`;
  const runResult:Record<string,unknown>={id:entry.id,sourceSha256:entry.sha256,state:'running'};results.push(runResult);
  try{
   expect(liveFixtureSha(bytes)).toBe(entry.sha256);expect(bytes.length).toBe(entry.sizeBytes);
   const checkpoint=await extractSavedPayslip({caseId,versionId,expectedMonth:'2026-06',extractor:runtime.extractor,
    context:{snapshot_id:randomUUID(),case_id:caseId,analysis_run_id:runId,schema_version:'1.0.0',created_at:new Date().toISOString(),
     fact_ids:Object.fromEntries(resolvedPayslipFactPaths.map(field=>[field,randomUUID()]))},
    db:{async query(){return {rows:[{id:randomUUID(),case_id:caseId,version_id:versionId,document_type:'payslip',storage_path:path,
     original_filename:entry.path.split('/').at(-1),mime_type:entry.mimeType,size:bytes.length,content_sha256:entry.sha256,period_month:'2026-06-01',created_at:new Date().toISOString()}]};}},
    storage:{async download(requested){expect(requested).toBe(path);return {data:new Blob([bytes],{type:entry.mimeType}),error:null};}},
   });
   writeFileSync(`${directory}/live-checkpoint-${entry.id}.json`,JSON.stringify(checkpoint,null,2)+'\n');
   const provenance=readSavedExtractionProvenance(checkpoint);
   runResult.provenance=provenance;providerAttempted=providerAttempted||provenance.providerAttempted;
   expect(provenance.kind).toBe('openai_live');expect(provenance.providerAttempted).toBe(true);expect(provenance.allPassesSucceeded).toBe(true);
   const extraction=checkpoint.run.result.final_extraction;
   const values=(field:string)=>extraction.fields.filter(value=>value.field===field&&value.normalized_value!==null).map(value=>value.normalized_value);
   expect(values('salary_period')).toContainEqual({year:2026,month:6,start_date:'2026-06-01',end_date:'2026-06-30'});
   expect(values('salary_type')).toContain('hourly');
   expect(values('base_monthly_salary')).toContainEqual({currency:'ILS',minor_units:entry.oracle.baseMinor});
   if(entry.oracle.outcome==='readable')expect(values('regular_hours')).toEqual([{amount:entry.oracle.hours[0],unit:'hours_per_month'}]);
   if(entry.oracle.outcome==='essential_input_missing')expect(values('regular_hours')).toEqual([]);
   if(entry.oracle.outcome==='conflicting_observations'){
    const fact=checkpoint.run.snapshot?.facts.find(value=>value.path==='work.regular_hours');
    expect(['conflicted','needs_confirmation','candidate']).toContain(fact?.status);
    expect(checkpoint.run.result.final_validation.issues.some(issue=>issue.field_keys.includes('regular_hours')
     &&['conflicting_candidates','recovery_conflict'].includes(issue.code))).toBe(true);
   }
   runResult.state='passed';
  }catch(error){
   failures.push(entry.id);
   // Provider messages/bodies can contain source text or secrets. Detailed
   // bounded provider codes remain in receipts; assertions are summarized here.
   runResult.state='failed';runResult.errorKind=error instanceof Error?error.name:'unknown';
  }
  record('RUNNING');
 }
 record(failures.length?'FAIL':'PASS');
 expect(failures).toEqual([]);
},20*60*1000);
