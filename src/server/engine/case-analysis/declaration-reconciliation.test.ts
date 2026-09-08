import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@/engine/rule-runtime/canonical';
import { canonicalFactSchema } from '@/engine/facts/contracts';
import { employmentSnapshotSchema } from '@/engine/facts/snapshot';
import { buildSyntheticCaseFixture } from '@/engine/case-analysis/synthetic-fixtures';
import { createFixtureCaseAnalysisHarness } from './fixture-harness';

async function analyzeDeclaration(amount: number | null, missingDocuments: number = 0) {
  const fixture = buildSyntheticCaseFixture({ fixture_id: 'declaration-reconciliation' });
  const declaration = canonicalFactSchema.parse({
    fact_id: '11111111-1111-4111-8111-111111111111',
    case_id: fixture.command.case_id,
    path: 'compensation.base_monthly_salary',
    value: { currency: 'XTS', minor_units: amount ?? 0 },
    status: 'needs_confirmation', confidence: 1,
    provenance: [{ source_type: 'declared', source_reference: {
      kind: 'questionnaire_response', response_id: '22222222-2222-4222-8222-222222222222',
    } }],
    conflicting_fact_ids: [], resolution: null, created_at: '2025-04-01T00:00:00.000Z',
  });
  const declarations = amount === null ? [] : [declaration];
  const extractions = fixture.stored.extractions.map((extraction, index) => index < missingDocuments ? {...extraction, fields: extraction.fields.filter(field => field.field !== 'base_monthly_salary')} : extraction);
  const extractionHash = canonicalSha256(extractions);
  const hash = canonicalSha256(declarations);
  const stored = { ...fixture.stored, extractions, extraction_snapshot_sha256: extractionHash, declared_fact_snapshot: {
    ...fixture.stored.declared_fact_snapshot, facts: declarations, snapshot_sha256: hash,
  } };
  const harness = createFixtureCaseAnalysisHarness([stored]);
  const bundle = await harness.application.runCaseAnalysis({ ...fixture.command, extraction_snapshot_sha256: extractionHash, declared_fact_snapshot_sha256: hash });
  const completed = await harness.service.getCompletedRun(bundle.analysis_run_id);
  const stage = completed?.stages.find(s => s.stage === 'canonical_facts')?.payload as { facts?: unknown } | undefined;
  const facts = employmentSnapshotSchema.parse(stage?.facts);
  return { bundle, completed, fact: facts.facts.find(f => f.path === declaration.path)!, declaration };
}

describe('document and declaration reconciliation', () => {
  it('keeps a noncritical declared salary type in the persisted canonical stage', async () => {
    const fixture=buildSyntheticCaseFixture({fixture_id:'declared-salary-type'});
    const declaration=canonicalFactSchema.parse({fact_id:'11111111-1111-4111-8111-111111111111',case_id:fixture.command.case_id,path:'compensation.salary_type',value:'hourly',status:'needs_confirmation',confidence:1,provenance:[{source_type:'declared',source_reference:{kind:'questionnaire_response',response_id:'22222222-2222-4222-8222-222222222222'}}],conflicting_fact_ids:[],resolution:null,created_at:'2025-04-01T00:00:00.000Z'});
    const hash=canonicalSha256([declaration]);const stored={...fixture.stored,declared_fact_snapshot:{...fixture.stored.declared_fact_snapshot,facts:[declaration],snapshot_sha256:hash}};
    const harness=createFixtureCaseAnalysisHarness([stored]);const bundle=await harness.application.runCaseAnalysis({...fixture.command,declared_fact_snapshot_sha256:hash});const completed=await harness.service.getCompletedRun(bundle.analysis_run_id);
    const stage=completed?.stages.find(s=>s.stage==='canonical_facts')?.payload as {facts:unknown};const fact=employmentSnapshotSchema.parse(stage.facts).facts.find(f=>f.path===declaration.path);
    expect(fact).toBeDefined();expect(fact?.provenance.some(p=>p.source_type==='declared')).toBe(true);expect(fact?.status).toBe('conflicted');expect(fact?.value).toBeNull();
  });

  it('keeps an explicit unconfirmed declaration when every document lacks the field', async () => {
    const {fact}=await analyzeDeclaration(100_000,100);
    expect(fact.status).toBe('needs_confirmation');expect(fact.value).toEqual({currency:'XTS',minor_units:100_000});
    expect(fact.resolution).toBeNull();expect(fact.provenance.every(p=>p.source_type==='declared')).toBe(true);
  });
  it('does not let a missing reading erase agreement between another document and declaration', async () => {
    const {fact}=await analyzeDeclaration(100_000,1);
    expect(fact.status).toBe('needs_confirmation');expect(fact.value).toEqual({currency:'XTS',minor_units:100_000});
  });
  it('does not let a missing reading hide a real conflict in the remaining sources', async () => {
    const {fact,bundle}=await analyzeDeclaration(200_000,1);
    expect(fact.status).toBe('conflicted');expect(fact.value).toBeNull();
    expect(bundle.topic_results.find(r=>r.topic==='minimum_wage')?.status).toBe('blocked_conflict');
  });
  it('retains missing when neither a document nor a declaration supplies a value', async () => {
    const {fact}=await analyzeDeclaration(null,100);expect(fact.status).toBe('missing');expect(fact.value).toBeNull();
  });
  it('does not fill missing documentary coverage from another period without a declaration', async () => {
    const {fact}=await analyzeDeclaration(null,1);expect(fact.status).toBe('missing');expect(fact.value).toBeNull();
  });
  it('retains a conflicting document value instead of silently replacing it with a declaration', async () => {
    const { bundle, fact, declaration } = await analyzeDeclaration(200_000);
    expect(fact.status).toBe('conflicted');
    expect(fact.value).toBeNull();
    expect(fact.conflicting_fact_ids).toContain(declaration.fact_id);
    expect(fact.conflicting_fact_ids.length).toBeGreaterThanOrEqual(2);
    expect(fact.provenance.some(p => p.source_type === 'documented')).toBe(true);
    expect(fact.provenance.some(p => p.source_type === 'declared')).toBe(true);
    const result = bundle.topic_results.find(r => r.topic === 'minimum_wage');
    expect(result?.status).toBe('blocked_conflict');
    expect(result?.amount).toBeNull();
  });

  it('retains both sources on agreement without upgrading an unconfirmed declaration', async () => {
    const { fact, completed } = await analyzeDeclaration(100_000);
    expect(fact.status).toBe('needs_confirmation');
    expect(fact.value).toEqual({ currency: 'XTS', minor_units: 100_000 });
    expect(fact.provenance.some(p => p.source_type === 'documented')).toBe(true);
    expect(fact.provenance.some(p => p.source_type === 'declared')).toBe(true);
    expect(fact.resolution).toBeNull();
    expect(completed?.dependencies?.code_version).toBe('case-analysis@0.6.3');
  });
});
