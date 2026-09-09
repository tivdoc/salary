import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../rule-runtime/canonical.ts';
import { JUNE2026_MINIMUM_WAGE_SOURCES } from './sources.ts';
import { june2026MinimumWageSourceCandidates } from './admission.ts';

const directory = resolve('docs/release-evidence/minimum-wage-june2026');
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('June2026 source version acquisition bindings', () => {
  it.each(JUNE2026_MINIMUM_WAGE_SOURCES)('rechecks the actual archived bytes for $source_id', source => {
    const bytes = readFileSync(resolve(directory, source.file));
    expect(hash(bytes)).toBe(source.artifact_sha256);
    if (source.file.endsWith('.pdf')) {
      expect(bytes.subarray(0, 5).toString('ascii')).toBe('%PDF-');
      expect(hash(readFileSync(resolve(directory, source.file + '.txt')))).toBe(source.parsed_sha256);
    }
    expect(source.human_reviewed).toBe(false);
    expect(source.activation_state).toBe('inactive');
  });

  it('cannot turn official corroboration or acquired bytes into human or activation decisions', () => {
    const candidates = june2026MinimumWageSourceCandidates();
    const rates = candidates.find(source => source.source_id === 'IL_MIN_WAGE_OFFICIAL_RATES')!;
    expect(rates).toMatchObject({source_role: 'corroborative', monetary_support_eligibility: 'ineligible', activation_status: 'inactive'});
    expect(candidates.every(source => source.review_attestation === undefined && !source.human_reviewed && !source.valid_time?.verified)).toBe(true);
    expect(canonicalSha256(candidates)).toBe(canonicalSha256(june2026MinimumWageSourceCandidates()));
  });
});
