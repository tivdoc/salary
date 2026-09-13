import {it,expect} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {employmentSnapshotSchema} from '@/engine/facts/snapshot';
import {resolvedPayslipFactPaths} from '@/engine/extraction/resolver';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {createFixtureCaseAnalysisHarness} from './fixture-harness';

async function run(conflict=false){
 const fixture=buildSyntheticCaseFixture({fixture_id:'document-fact-retention'});
 const extractions=fixture.stored.extractions.map((e,i)=>({...e,fields:e.fields.map(f=>conflict&&i===1&&f.field==='net_salary'?{...f,normalized_value:{currency:'XTS',minor_units:80000}}:f)}));
 const hash=canonicalSha256(extractions),stored={...fixture.stored,extractions,extraction_snapshot_sha256:hash};
 const harness=createFixtureCaseAnalysisHarness([stored]);const command={...fixture.command,extraction_snapshot_sha256:hash};
 const bundle=await harness.application.runCaseAnalysis(command),completed=await harness.service.getCompletedRun(bundle.analysis_run_id);
 const stage=completed?.stages.find(s=>s.stage==='canonical_facts')?.payload as {facts:unknown};
 return {facts:employmentSnapshotSchema.parse(stage.facts).facts,bundle,completed,harness,command};
}
it('retains every resolved document fact, including paid inputs outside the seven topic gate paths',async()=>{
 const {facts}=await run();
 for(const path of resolvedPayslipFactPaths)expect(facts.find(f=>f.path===path),path).toBeDefined();
 expect(facts.find(f=>f.path==='compensation.gross_salary')?.value).toEqual({currency:'XTS',minor_units:100000});
 expect(facts.find(f=>f.path==='compensation.net_salary')?.value).toEqual({currency:'XTS',minor_units:90000});
 expect(facts.find(f=>f.path==='compensation.hourly_rate')?.status).toBe('missing');
});
it('retains paid-field disagreements without selecting one document or manufacturing verification',async()=>{
 const {facts}=await run(true);const paid=facts.find(f=>f.path==='compensation.net_salary');
 expect(paid?.status).toBe('conflicted');expect(paid?.value).toBeNull();expect(paid?.conflicting_fact_ids.length).toBeGreaterThan(1);
 expect(paid?.provenance.filter(p=>p.source_type==='documented').every(p=>p.verified===false)).toBe(true);
});
