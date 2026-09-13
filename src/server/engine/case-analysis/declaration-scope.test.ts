import {describe,it,expect} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {createFixtureCaseAnalysisHarness} from './fixture-harness';

function declaredFixture(){
 return structuredClone(buildSyntheticCaseFixture({fixture_id:'declaration-scope',missing_topic:'pension'}));
}
function repin(fixture:ReturnType<typeof declaredFixture>){
 const hash=canonicalSha256(fixture.stored.declared_fact_snapshot.facts);
 return {stored:{...fixture.stored,declared_fact_snapshot:{...fixture.stored.declared_fact_snapshot,snapshot_sha256:hash}},
  command:{...fixture.command,declared_fact_snapshot_sha256:hash}};
}
describe('canonical declared input scope',()=>{
 it('rejects a validly hashed declaration from another case before canonical fact persistence',async()=>{
  const fixture=declaredFixture();
  const foreign={...fixture.stored.declared_fact_snapshot.facts[0],case_id:'99999999-9999-4999-8999-999999999999'};
  const input=repin({...fixture,stored:{...fixture.stored,declared_fact_snapshot:{...fixture.stored.declared_fact_snapshot,facts:[foreign]}}} as typeof fixture);
  const harness=createFixtureCaseAnalysisHarness([input.stored]);
  await expect(harness.application.runCaseAnalysis(input.command)).rejects.toThrow('DECLARED_FACT_CASE_MISMATCH');
 });
 it('rejects duplicate declared paths instead of silently selecting the last assertion',async()=>{
  const fixture=declaredFixture();const first=fixture.stored.declared_fact_snapshot.facts[0];
  const second={...first,fact_id:'88888888-8888-4888-8888-888888888888'};
  const input=repin({...fixture,stored:{...fixture.stored,declared_fact_snapshot:{...fixture.stored.declared_fact_snapshot,facts:[first,second]}}} as typeof fixture);
  const harness=createFixtureCaseAnalysisHarness([input.stored]);
  await expect(harness.application.runCaseAnalysis(input.command)).rejects.toThrow('DECLARED_FACT_PATH_DUPLICATE');
 });
});
