import {randomUUID} from 'node:crypto';
import {beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import type {AnalysisResultBundle} from '@/engine/wave3/contracts';
import {createAdmissionTestFixture} from '@/engine/minimum-wage-june2026/evidence-admission.test-fixtures';
import {createRegularServiceTrustFixture} from '@/engine/minimum-wage-june2026/regular-service/regular-service.test-fixtures';
import {createJune2026RegularAuthority} from '@/engine/minimum-wage-june2026/regular-service/authority';
import {June2026RegularCatalog} from '@/engine/minimum-wage-june2026/regular-service/catalog';
import {June2026RegularExecutor} from '@/engine/minimum-wage-june2026/regular-service/executor';
import {encodeReport} from '@/server/platform/persistence/postgres/analysis/validation';
import {June2026RegularReportBuilder} from './june2026-regular-service';
import {readJune2026RegularArtifact} from './june2026-regular-artifact';

const state=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('../case-access/db',()=>({resolveCaseAccessDb:async()=>({rpc:state.rpc})}));

// Only the authenticated SQL boundary is mocked. The rule, signed synthetic
// trust fixture, trace, report generation and reader reconstruction are real
// code. No DB/current-authority or live OCR evidence is claimed by this unit.
async function fixture(){
 const f=createAdmissionTestFixture(),packet=f.packet(),keys=createRegularServiceTrustFixture();
 const admitted=createJune2026RegularAuthority(keys.input(packet,f.facts));
 if(admitted.state!=='ready')throw Error(admitted.blockers.join(','));
 const authority=admitted.authority,selection=await new June2026RegularCatalog(authority).resolve({mode:'synthetic_test',topic:'minimum_wage',
  target_date:'2026-06-30',as_of:'2026-09-10',sector:'general_private',population:'adult_general'});
 const executor=new June2026RegularExecutor({authority,packet,facts:f.facts});
 const execution=await executor.execute({selection,rule_input:packet.rule_input,execution_id:randomUUID(),calculated_at:keys.now});
 const seed:Omit<AnalysisResultBundle,'result_sha256'>={schema_version:'tivdoc-analysis-result-bundle-v0.6.0',analysis_run_id:f.facts.analysis_run_id,case_id:f.facts.case_id,
  case_revision:packet.current.input_revision,period:{start_date:'2026-06-01',end_date:'2026-06-30'},as_of:'2026-09-10',
  document_snapshot_sha256:f.checkpoint.input_sha256,extraction_snapshot_sha256:f.checkpoint.result_sha256,declared_fact_snapshot_sha256:canonicalSha256(f.collection),
  facts_snapshot_sha256:canonicalSha256(f.facts),facts:f.facts.facts,rule_inputs:[packet.rule_input],catalog_sha256:selection.catalog_sha256,
  topic_results:[{topic:'minimum_wage',status:'calculated',blockers:[],rule_input_sha256:packet.rule_input.snapshot_sha256,
   amount:execution.amount,trace:execution.trace,legal_readiness:selection.readiness}],known_subtotal:execution.amount,coverage_complete:true};
 const bundle={...seed,result_sha256:canonicalSha256(seed)},builder=new June2026RegularReportBuilder({authority,executor,publicId:'TV-1234ABCD',offerSha256:'a'.repeat(64),reportKind:'full'});
 const report=await builder.build(bundle);
 return {caseId:f.facts.case_id,identityId:randomUUID(),report,row:{completion:{bundle,report:encodeReport(report)},execution:executor.result,
  namespace:'isolated_test',current:true,authority_current:true,projection_id:report.report_id}};
}
let saved:Awaited<ReturnType<typeof fixture>>;
beforeAll(async()=>{saved=await fixture();});
beforeEach(()=>{state.rpc.mockReset();state.rpc.mockResolvedValue([{value:structuredClone(saved.row)}]);});
const read=()=>readJune2026RegularArtifact(saved.caseId,saved.identityId,saved.report.report_id);
function unchangedBytes(result:Awaited<ReturnType<typeof read>>){
 expect(result?.report.report_id).toBe(saved.report.report_id);
 expect(result?.report.report_sha256).toBe(saved.report.report_sha256);
 // The persisted decoder returns Uint8Array while the renderer emits Buffer.
 // Compare bytes explicitly, not constructor identity or a multi-MB diff.
 for(const field of ['json','html','pdf','manifest'] as const)
  expect(result&&Buffer.from(result.report[field]).equals(Buffer.from(saved.report[field]))).toBe(true);
}

it('reconstructs the same immutable artifact only as current when both SQL fences are current',async()=>{
 const result=await read();expect(result?.current).toBe(true);unchangedBytes(result);
 expect(state.rpc).toHaveBeenCalledWith('june2026_regular_report_artifact',{target_case:saved.caseId,target_identity:saved.identityId,target_projection:saved.report.report_id});
});
it.each(['assessment revoked','assessment expired','registry changed'])('marks an unchanged input non-current after SQL rejects authority: %s',async()=>{
 state.rpc.mockResolvedValue([{value:{...saved.row,authority_current:false}}]);
 const result=await read();expect(result?.current).toBe(false);unchangedBytes(result);
});
it('does not let current authority restore a replaced input',async()=>{
 state.rpc.mockResolvedValue([{value:{...saved.row,current:false}}]);expect((await read())?.current).toBe(false);
});
it.each([undefined,null,'true',1])('refuses missing or malformed authority-current receipt %s',async authorityCurrent=>{
 const {authority_current:omitted,...row}=saved.row;void omitted;
 state.rpc.mockResolvedValue([{value:{...row,...(authorityCurrent===undefined?{}:{authority_current:authorityCurrent})}}]);
 await expect(read()).rejects.toThrow();
});
it('keeps ownership and same-run reconstruction mandatory when authority is current',async()=>{
 state.rpc.mockResolvedValue([{value:{...saved.row,projection_id:randomUUID()}}]);await expect(read()).rejects.toThrow('REGULAR_REPORT_ARTIFACT_BINDING');
 state.rpc.mockResolvedValue([{value:null}]);await expect(read()).resolves.toBeNull();
 state.rpc.mockRejectedValue(Error('REGULAR_REPORT_FORBIDDEN'));await expect(read()).rejects.toThrow('REGULAR_REPORT_FORBIDDEN');
});
