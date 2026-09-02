import { describe, expect, it } from "vitest";

import { legalOperationsSha256 } from "../../../engine/legal-operations/canonical.ts";
import { legalCitationSchema } from "../../../engine/legal-knowledge/contracts.ts";
import { syntheticChunk, syntheticSource } from "../../../engine/legal-knowledge/synthetic-fixtures.ts";
import { LEGAL_REVIEW_SCHEMA_VERSION } from "../../../engine/legal-review/contracts.ts";
import { GOVERNANCE_SCHEMA_VERSION } from "../../platform/persistence/postgres/governance/contracts.ts";
import type { PostgresLegalReviewRepository } from "../../platform/persistence/postgres/governance/repositories.ts";
import { enqueueLegalReviewBacklog } from "./backlog-enqueue.ts";
import { projectStagedObservationsToReviewBacklog } from "./staging-projection.ts";

const NOW = "2040-01-01T00:00:00.000Z";
const OBSERVATION = "ACQOBS:WAVE1:00000000000000000000000000000001";

function citation() {
  const source = syntheticSource();
  const chunk = syntheticChunk(source);
  return legalCitationSchema.parse({
    source_id: source.source_id, source_version: source.source_version,
    source_version_id: `${source.source_id}@${source.source_version}`,
    parsed_version_id: chunk.parsed_version_id, raw_artifact_sha256: chunk.artifact_sha256,
    normalized_text_sha256: chunk.normalized_text_sha256, parser_version: chunk.parser_version,
    chunk_id: chunk.chunk_id, title: source.title, authority: source.authority,
    canonical_url: source.canonical_url, section_or_clause: chunk.section_identifier,
    page: chunk.page_from, effective_period: source.effective_period,
    effective_date_evidence_locator: "synthetic clause 1", review_status: source.status,
    retrieved_at: "2026-08-29T00:00:00Z",
    locator: {
      format: "pdf", page: chunk.page_from, section: chunk.section_identifier, paragraph: null,
      character_from: chunk.character_from, character_to: chunk.character_to,
    },
    supporting_chunk_ids: [chunk.chunk_id], excerpt: null,
  });
}

const ARTIFACT = "a".repeat(64);

const binding = Object.freeze({
  schema_version: LEGAL_REVIEW_SCHEMA_VERSION,
  source_id: "IL_SYNTHETIC_LAW", source_version_id: "IL_SYNTHETIC_LAW@v1",
  manifest_sha256: "c".repeat(64), raw_artifact_sha256: ARTIFACT,
  normalized_text_sha256: "d".repeat(64),
  parser_version: "synthetic-parser-v1", normalizer_version: "synthetic-normalizer-v1",
});

const scope = Object.freeze({
  topic: "minimum_wage", sectors: Object.freeze(["general"]), applicability: "general",
  population_constraints: Object.freeze([]),
  effective_period: Object.freeze({
    effective_from: "2020-01-01", effective_to: null,
    retroactive: false, retroactive_basis: null, applicability_basis: "salary_month",
  }),
  period_certainty: "known",
});

function candidate(overrides: Record<string, unknown> = {}) {
  const base = {
    schema_version: GOVERNANCE_SCHEMA_VERSION,
    observation_id: OBSERVATION, observation_version: "1", observation_kind: "source_bytes",
    source_candidate_id: null, instrument_candidate_id: null,
    observed_url: "https://www.gov.il/synthetic-observation",
    artifact_version_id: "ARTIFACT:v1", byte_object_id: "BYTES:v1", bytes_sha256: ARTIFACT,
    topic: "minimum_wage", candidate_valid_from: "2020-01-01", candidate_valid_to: null,
    knowledge_time: null, sectors: ["general"], populations: [], geographies: [],
    provenance: { collection: "hours_publications" },
    contradiction_refs: [], gap_refs: [], alias_refs: [], duplicate_refs: [], overlap_refs: [],
    legal_effect: "unreviewed", activation_allowed: false, ...overrides,
  };
  return { ...base, candidate_sha256: legalOperationsSha256(base).slice(0, 64) };
}

function evidence(overrides: Record<string, unknown> = {}) {
  return { observation_id: OBSERVATION, binding, scope, citations: [citation()], ...overrides };
}

function repository() {
  const calls: unknown[] = [];
  const stub = {
    async enqueuePacket(input: unknown) { calls.push(input); return { activation_allowed: false }; },
  } as unknown as PostgresLegalReviewRepository;
  return { stub, calls };
}

const meta = Object.freeze({ idempotency_key: "idem.backlog.001", occurred_at: NOW });

describe("V0.10.3B backlog to durable review queue", () => {
  it("enqueues an observation that has both a clean projection and explicit evidence", async () => {
    const { stub, calls } = repository();
    const result = await enqueueLegalReviewBacklog({
      backlog: projectStagedObservationsToReviewBacklog([candidate()]),
      evidence: [evidence()], repository: stub, metadata: meta,
    });
    expect(result.counts).toEqual({ total: 1, enqueued: 1, not_enqueued: 0 });
    expect(result.activation_allowed).toBe(false);
    expect(calls).toHaveLength(1);
    expect((calls[0] as { packet: { state: string } }).packet.state).toBe("pending_review");
    expect((calls[0] as { queue_priority: number }).queue_priority).toBe(100);
  });

  it("never invents evidence for a blocked observation", async () => {
    const { stub, calls } = repository();
    const result = await enqueueLegalReviewBacklog({
      backlog: projectStagedObservationsToReviewBacklog([
        candidate({ bytes_sha256: null, byte_object_id: null }),
      ]),
      evidence: [], repository: stub, metadata: meta,
    });
    expect(result.counts).toEqual({ total: 1, enqueued: 0, not_enqueued: 1 });
    expect(result.outcomes[0]?.not_enqueued_reason_codes).toContain("OFFICIAL_ARTIFACT_BYTES_MISSING");
    expect(calls).toHaveLength(0);
  });

  it("reports a reviewable observation whose parsed evidence was not supplied", async () => {
    const { stub, calls } = repository();
    const result = await enqueueLegalReviewBacklog({
      backlog: projectStagedObservationsToReviewBacklog([candidate()]),
      evidence: [], repository: stub, metadata: meta,
    });
    expect(result.outcomes[0]?.not_enqueued_reason_codes).toEqual(["PARSED_EVIDENCE_NOT_SUPPLIED"]);
    expect(calls).toHaveLength(0);
  });

  it("refuses evidence bound to different artifact bytes than the observation", async () => {
    const { stub, calls } = repository();
    const result = await enqueueLegalReviewBacklog({
      backlog: projectStagedObservationsToReviewBacklog([candidate()]),
      evidence: [evidence({ binding: { ...binding, raw_artifact_sha256: "b".repeat(64) } })],
      repository: stub, metadata: meta,
    });
    expect(result.outcomes[0]?.not_enqueued_reason_codes).toEqual(["EVIDENCE_ARTIFACT_MISMATCH"]);
    expect(calls).toHaveLength(0);
  });

  it("reports malformed evidence instead of throwing the whole command away", async () => {
    const { stub, calls } = repository();
    const result = await enqueueLegalReviewBacklog({
      backlog: projectStagedObservationsToReviewBacklog([candidate()]),
      evidence: [evidence({ citations: [] })], repository: stub, metadata: meta,
    });
    expect(result.outcomes[0]?.not_enqueued_reason_codes).toEqual(["PARSED_EVIDENCE_INVALID"]);
    expect(calls).toHaveLength(0);
  });

  it("is deterministic and idempotent on packet identity across replays", async () => {
    const first = repository();
    const second = repository();
    const backlog = projectStagedObservationsToReviewBacklog([candidate()]);
    const one = await enqueueLegalReviewBacklog({
      backlog, evidence: [evidence()], repository: first.stub, metadata: meta,
    });
    const two = await enqueueLegalReviewBacklog({
      backlog, evidence: [evidence()], repository: second.stub, metadata: meta,
    });
    expect(one).toEqual(two);
    const keyOf = (calls: unknown[]) => (calls[0] as { metadata: { idempotency_key: string } }).metadata.idempotency_key;
    expect(keyOf(first.calls)).toBe(keyOf(second.calls));
  });

  it("keeps every enqueued packet pending review with no activation", async () => {
    const { stub, calls } = repository();
    await enqueueLegalReviewBacklog({
      backlog: projectStagedObservationsToReviewBacklog([candidate()]),
      evidence: [evidence()], repository: stub, metadata: meta,
    });
    const enqueued = calls[0] as { packet: { state: string; revision: number }; blocked_reason_codes: readonly string[] };
    expect(enqueued.packet.state).toBe("pending_review");
    expect(enqueued.packet.revision).toBe(1);
    expect(enqueued.blocked_reason_codes).toEqual([]);
  });
});
