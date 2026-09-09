import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';
import {legalOperationsSha256} from '../legal-operations/canonical.ts';
import {reviewPacketSchema, sourceReviewAttestationSchema} from '../legal-operations/contracts.ts';
import {AppendOnlyLegalOperationsStore} from '../legal-operations/state-machine.ts';
import {buildJune2026MinimumWageReviewPackage,buildJune2026MinimumWageReviewAddendum,JUNE2026_NII_RATE_REVIEW_CHUNK} from './review-package.ts';
import {JUNE2026_MINIMUM_WAGE_SOURCES} from './sources.ts';
import {june2026MinimumWageSourceCandidates} from './admission.ts';

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

describe('June2026 forward source-review supplement', () => {
  const directory = resolve('docs/release-evidence/minimum-wage-june2026');
  const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

  it('binds the parsed table to the exact acquired HTML region, preserving merged headers and published values', () => {
    const pin = JUNE2026_NII_RATE_REVIEW_CHUNK;
    const source = readFileSync(resolve(directory,pin.artifact_file));
    const bytes = readFileSync(resolve(directory,pin.file));
    expect(hash(source)).toBe(pin.artifact_sha256);
    expect(hash(bytes)).toBe(pin.sha256);
    const chunk = JSON.parse(bytes.toString('utf8'));
    const html = source.toString('utf8');
    const begin = html.indexOf('<strong>שכר מינימום </strong><strong>מגיל 18 ומעלה');
    const end = html.indexOf('</tr>',html.indexOf('01.04.2026<br>',begin)) + '</tr>'.length;
    expect(begin).toBeGreaterThan(0);
    expect(chunk.raw_fragment_sha256).toBe(hash(html.slice(begin,end)));
    expect(chunk.source_sha256).toBe(pin.artifact_sha256);
    expect(chunk.review_version_id).toBe(pin.review_version_id);
    expect(chunk.table_rows.map((row: unknown[]) => row.length)).toEqual([4,4,6]);
    expect(chunk.table_rows[0].map((cell: {rowspan:number;colspan:number}) => [cell.rowspan,cell.colspan])).toEqual([[2,1],[1,2],[1,2],[2,1]]);
    expect(chunk.table_rows[1][0].text).toContain('5 ימים');
    expect(chunk.table_rows[1][1].text).toContain('6 ימים');
    expect(chunk.table_rows[1].slice(2).map((cell:{text:string})=>cell.text)).toEqual(['בהיקף של 186 שעות','בהיקף של 182 שעות']);
    expect(chunk.table_rows[2].map((cell:{text:string})=>cell.text)).toEqual(['01.04.2026','297.4','257.75','34.64','35.4','6443.85']);
    expect(chunk.current_rate_list).toHaveLength(5);
    expect(chunk.current_rate_list[2]).toContain('186');
    expect(chunk.current_rate_list[2]).toContain('34.64');
    expect(chunk.current_rate_list[3]).toContain('182');
    expect(chunk.current_rate_list[3]).toContain('35.4');
    expect(chunk.current_rate_list[4]).toContain('6,443.85');
    expect(chunk.human_transcription_attested).toBe(false);
    expect(chunk.operative_parameter_authority).toBe(false);
  });

  it('adds a new review version without rewriting the historical packet, operative source pins or arithmetic candidate', () => {
    const original = buildJune2026MinimumWageReviewPackage();
    const next = buildJune2026MinimumWageReviewAddendum();
    expect(next.prior_packet_sha256).toBe(original.packet.packet_sha256);
    expect(next.prior_bundle_sha256).toBe(original.bundle_sha256);
    expect(next.packet.packet_version).toBe('1.1.0');
    expect(next.packet.sources.slice(0,3)).toEqual(original.packet.sources.slice(0,3));
    expect(next.packet.sources[3].source_version_id).not.toBe(original.packet.sources[3].source_version_id);
    expect(next.packet.sources[3].artifact_sha256).toBe(original.packet.sources[3].artifact_sha256);
    expect(next.packet.sources[3].hash_availability).toBe('verified_hashes_present');
    expect(original.packet.sources[3].hash_availability).toBe('chunks_unavailable');
    expect(next.arithmetic_candidate_policy_sha256).toBe(original.policy_sha256);
    expect(next.reviewed_catalog_source_pins_updated).toBe(false);
    expect(JUNE2026_MINIMUM_WAGE_SOURCES[3].parsed_sha256).toBeNull();
    expect(june2026MinimumWageSourceCandidates()[3]).toMatchObject({source_role:'corroborative',monetary_support_eligibility:'ineligible',active:false});
  });

  it('does not let complete technical chunk hashes masquerade as resolved source conflicts or human approval', () => {
    const next = buildJune2026MinimumWageReviewAddendum();
    expect(next.packet.sources.every(source=>source.hash_availability==='verified_hashes_present')).toBe(true);
    expect(next.packet.completeness_status).toBe('blocked');
    expect(next.packet.known_conflicts).toHaveLength(2);
    expect(next.packet.missing_official_material).toHaveLength(3);
    const {packet_sha256: ignored,...body}=next.packet;void ignored;
    const changed={...body,completeness_status:'candidate_complete_unreviewed'};
    expect(reviewPacketSchema.safeParse({...changed,packet_sha256:legalOperationsSha256(changed)}).success).toBe(false);
    expect(sourceReviewAttestationSchema.safeParse(next.blank_source_decision).success).toBe(false);
    expect(next.activation).toEqual({approved_by:null,signed_envelope:null,allowed:false});
    expect(next.customer_analysis_ready).toBe(false);
    expect(next.technical_handoff_required).toHaveLength(5);
  });

  it('matches the forward artifact and retains a separate immutable bundle hash', () => {
    const next=buildJune2026MinimumWageReviewAddendum();
    const stored=JSON.parse(readFileSync(resolve(directory,'unsigned-review-addendum-1.1.0.json'),'utf8'));
    expect(stored).toEqual(next);
    const {bundle_sha256,...body}=next;
    expect(legalOperationsSha256(body)).toBe(bundle_sha256);
    expect(bundle_sha256).not.toBe(next.prior_bundle_sha256);
  });
});
