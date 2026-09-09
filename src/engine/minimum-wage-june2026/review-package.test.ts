import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';
import {legalOperationsSha256} from '../legal-operations/canonical.ts';
import {reviewPacketSchema, sourceReviewAttestationSchema} from '../legal-operations/contracts.ts';
import {AppendOnlyLegalOperationsStore} from '../legal-operations/state-machine.ts';
import {buildJune2026MinimumWageReviewPackage} from './review-package.ts';

describe('unsigned June2026 review handoff', () => {
  it('exports a reproducible packet accepted by the existing source-review schema without inventing approvals', () => {
    const bundle = buildJune2026MinimumWageReviewPackage();
    expect(buildJune2026MinimumWageReviewPackage()).toEqual(bundle);
    expect(reviewPacketSchema.parse(bundle.packet).completeness_status).toBe('blocked');
    expect(bundle.blank_source_decision.required_decisions).toHaveLength(5);
    expect(new Set(bundle.blank_source_decision.required_decisions).size).toBe(5);
    for (const key of ['reviewer_id', 'reviewer_role', 'decision', 'decided_at', 'reason', 'signature_sha256'] as const) {
      expect(bundle.blank_source_decision[key]).toBeNull();
    }
    expect(sourceReviewAttestationSchema.safeParse(bundle.blank_source_decision).success).toBe(false);
    expect(bundle.activation).toEqual({approved_by: null, signed_envelope: null, allowed: false});
    expect(bundle.customer_analysis_ready).toBe(false);
  });

  it('cannot relabel unresolved source material as candidate-complete or usable for rules', () => {
    const {packet} = buildJune2026MinimumWageReviewPackage();
    expect(reviewPacketSchema.safeParse({...packet, completeness_status: 'candidate_complete_unreviewed'}).success).toBe(false);
    expect(reviewPacketSchema.safeParse({...packet, usable_for_rules: true}).success).toBe(false);
    expect(packet.sources[3].chunk_sha256s).toEqual([]);
    expect(packet.sources[3].hash_availability).toBe('chunks_unavailable');
  });

  it('imports concrete rule/parameter artifacts as candidates through the existing append-only mechanism', () => {
    const bundle = buildJune2026MinimumWageReviewPackage();
    const store = new AppendOnlyLegalOperationsStore();
    const candidate = bundle.one_component_artifacts;
    store.importGoldenCaseSet(candidate.goldenCases);
    for (const parameter of candidate.parameters) {
      const input = {artifact_id: parameter.parameter_id, artifact_version: parameter.parameter_version, artifact_kind: 'parameter' as const,
        content: parameter, content_sha256: legalOperationsSha256(parameter), bindings: parameter.bindings,
        idempotency_key: `review-import:${parameter.parameter_id}`, imported_at: '2026-09-09T18:00:00.000Z'};
      expect(store.importArtifact(input).receipt.state).toBe('candidate');
      expect(store.importArtifact(input).idempotent_replay).toBe(true);
    }
    expect(store.importArtifact({artifact_id: candidate.rule.rule_spec_id, artifact_version: candidate.rule.rule_spec_version,
      artifact_kind: 'rule_package', content: candidate.rule, content_sha256: legalOperationsSha256(candidate.rule),
      bindings: candidate.parameters[0].bindings, idempotency_key: 'review-import:rule', imported_at: '2026-09-09T18:00:00.000Z'}).receipt.state).toBe('candidate');
  });

  it('pins every bounded component arity to distinct immutable rule and parameter identities', () => {
    const bundle = buildJune2026MinimumWageReviewPackage();
    expect(bundle.candidate_families).toHaveLength(32);
    expect(new Set(bundle.candidate_families.map(c => c.rule_spec_sha256)).size).toBe(32);
    expect(new Set(bundle.candidate_families.map(c => c.parameter_candidates[0].parameter_version)).size).toBe(32);
    const {bundle_sha256, ...seed} = bundle;
    expect(legalOperationsSha256(seed)).toBe(bundle_sha256);
  });

  it('matches the checked-in review handoff without reading a database or importing attestations', () => {
    const stored = JSON.parse(readFileSync(resolve(process.cwd(), 'docs/release-evidence/minimum-wage-june2026/unsigned-review-package.json'), 'utf8'));
    expect(stored).toEqual(buildJune2026MinimumWageReviewPackage());
  });
});
