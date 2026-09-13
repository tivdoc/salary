import {expect} from 'vitest';
import type pg from 'pg';
import {sourceTraceFixture} from '@/engine/calculations/source-trace.fixtures';
import {createSourceCalculationTrace,sourceCalculationTraceSchema} from '@/engine/calculations/source-trace';
import type {EmploymentSnapshot} from '@/engine/facts/snapshot';
import type {AnalysisResultBundle,TopicAnalysisResult} from '@/engine/wave3/contracts';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import type {PostgresTransactionContext} from '../contracts';
import {PostgresTraceFindingRepository} from './traces';

/** Called only inside the owned field-proof transaction/savepoint. All source
 * facts come from that actual saved worker analysis. The +1 XTS rule is an
 * arithmetic probe, never an entitlement or a publication candidate. */
export async function proveSourceTracePostgres(input:{db:pg.Client;context:PostgresTransactionContext;tenant:string;facts:EmploymentSnapshot;bundle:AnalysisResultBundle}){
 const {db,context,tenant,facts,bundle}=input,checks:string[]=[];
 const fixture=sourceTraceFixture(facts,bundle.analysis_run_id);
 const trace=createSourceCalculationTrace({...fixture.input,catalogSha256:bundle.catalog_sha256});
 const topicResult:TopicAnalysisResult={topic:'minimum_wage',status:'blocked_legal_readiness',blockers:['ARITHMETIC_ONLY'],amount:null,legal_readiness:null,rule_input_sha256:trace.rule_input_sha256,trace};
 const command={case_id:bundle.case_id,analysis_run_id:bundle.analysis_run_id,expected_topics:['minimum_wage'] as const,topic_results:[topicResult],source_scope:bundle};
 const repository=new PostgresTraceFindingRepository(context,tenant);
 const rows=async()=>(await db.query('select trace,trace_sha256 from public.engine_calculation_trace_versions where tenant_id=$1',[tenant])).rows;
 expect(await rows()).toHaveLength(0);
 await db.query('savepoint before_source_trace');
 await repository.persistTraces(command);expect(await rows()).toHaveLength(1);
 await db.query('rollback to savepoint before_source_trace');expect(await rows()).toHaveLength(0);
 checks.push('an aborted write rolls back the trace while the original persisted canonical stages remain available');
 await repository.persistTraces(command);await repository.persistTraces(command);
 const saved=await rows();expect(saved).toHaveLength(1);
 const replay=sourceCalculationTraceSchema.parse(saved[0].trace);
 expect(replay).toEqual(trace);expect(canonicalSha256(replay)).toBe(saved[0].trace_sha256);
 expect(replay.inputs[0].source).toMatchObject({kind:'fact',fact_id:facts.facts.find(f=>f.path==='compensation.base_monthly_salary')!.fact_id});
 expect(replay.inputs[1].source.kind).toBe('parameter');
 checks.push('actual worker role stores one immutable row across retry and independently replays operands from returned PostgreSQL JSON');
 expect(replay.facts_snapshot.facts.find(f=>f.path==='compensation.base_monthly_salary')?.provenance[0]).toMatchObject({customer_confirmation:{actor_kind:'customer'}});
 checks.push('the actual canonical customer-confirmed source and separate versioned parameter survive database roundtrip');
 await expect(new PostgresTraceFindingRepository(context,'synthetic.foreign.tenant').persistTraces(command)).rejects.toThrow('STAGE_HASH_MISMATCH');
 expect(await rows()).toHaveLength(1);
 checks.push('another tenant cannot resolve the source stages or create a linked trace through the verified worker connection');
 await db.query('savepoint immutable_source_trace');
 await expect(db.query('update public.engine_calculation_trace_versions set trace=trace where tenant_id=$1',[tenant])).rejects.toMatchObject({code:'P0001',message:'Engine version history is append-only'});
 await db.query('rollback to savepoint immutable_source_trace');
 expect(await rows()).toEqual(saved);
 checks.push('the database refuses UPDATE and preserves the original trace bytes and hash');
 await repository.assertFindingsDisabled({case_id:bundle.case_id,analysis_run_id:bundle.analysis_run_id});
 expect(bundle.topic_results.every(t=>t.amount===null)).toBe(true);
 checks.push('existing canonical findings remain absent; the arithmetic probe creates no report, amount, legal activation or price');
 let comparisonProof:unknown=null;
 if(process.env.TIVDOC_SOURCE_COMPARISON_DB_PROOF==='1'){
  const {sourceComparisonFixture}=await import('@/engine/findings/source-comparison.fixtures');
  const {createSourceMonetaryComparison,sourceMonetaryComparisonSchema}=await import('@/engine/findings/source-comparison');
  const comparisonFixture=sourceComparisonFixture('positive',facts);
  const comparisonTrace=createSourceCalculationTrace({...comparisonFixture.traceInput,catalogSha256:bundle.catalog_sha256});
  const comparisonCommand={...command,topic_results:[{...topicResult,trace:comparisonTrace}]};
  await repository.persistTraces(comparisonCommand);await repository.persistTraces(comparisonCommand);
  const comparisons=(await rows()).filter(row=>row.trace.trace_sha256===comparisonTrace.trace_sha256);
  expect(comparisons).toHaveLength(1);
  const fromDb=sourceCalculationTraceSchema.parse(comparisons[0].trace);
  const comparison=createSourceMonetaryComparison({trace:fromDb,expectedRef:'result.amount',recordedRef:'fact.salary'});
  expect(comparison.signed_difference).toEqual({currency:'XTS',minor_units:1});
  expect(comparison.recorded).toEqual(facts.facts.find(f=>f.path==='compensation.base_monthly_salary')!.value);
  expect(sourceMonetaryComparisonSchema.parse(JSON.parse(JSON.stringify(comparison)))).toEqual(comparison);
  expect(comparison.is_finding).toBe(false);expect(comparison.pricing_allowed).toBe(false);
  await repository.assertFindingsDisabled({case_id:bundle.case_id,analysis_run_id:bundle.analysis_run_id});
  comparisonProof={checks:[
   'actual saved worker facts feed explicit expected-minus-recorded RuleSpec subtraction; PostgreSQL retry preserves one comparison trace',
   'comparison is independently reconstructed from returned SQL JSON with exact recorded amount and signed difference; no finding or pricing authority'],
   comparisonSha256:comparison.sha256,traceSha256:comparisonTrace.trace_sha256,scope:'Synthetic +1 XTS arithmetic over actual canonical saved facts in isolated DEV. The enclosing transaction rolls it back; no meaningful legal expectation, fund transfer, publication or price proof.'};
 }
 return {checks,comparisonProof,traceSha256:trace.trace_sha256,storedTraceSha256:saved[0].trace_sha256,scope:'Actual isolated DEV worker connection and saved canonical stages, synthetic +1 XTS arithmetic only. Trace/run are rolled back by the enclosing proof; no concurrent-process, OCR, monetary entitlement or publication proof.'};
}
