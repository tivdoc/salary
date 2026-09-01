import { describe, expect, it } from "vitest";

import { legalCitationSchema } from "../legal-knowledge/contracts.ts";
import { syntheticChunk, syntheticSource } from "../legal-knowledge/synthetic-fixtures.ts";
import {
  LegalReviewError,
  LEGAL_REVIEW_SCHEMA_VERSION,
  type LegalReviewAction,
  type LegalReviewQueueEntry,
} from "./contracts.ts";
import {
  applyLegalReviewAction,
  createLegalReviewPacket,
  deriveLegalReviewPacketIdentity,
  enqueueLegalReviewPacket,
  isTerminalLegalReviewState,
  openLegalReviewQueue,
  packetSupportsMonetaryCandidate,
} from "./workflow.ts";

const AT = "2026-09-01T00:00:00Z";
const LATER = "2026-09-01T01:00:00Z";

function citation(overrides: Record<string, unknown> = {}) {
  const source = syntheticSource();
  const chunk = syntheticChunk(source);
  return legalCitationSchema.parse({
    source_id: source.source_id,
    source_version: source.source_version,
    source_version_id: `${source.source_id}@${source.source_version}`,
    parsed_version_id: chunk.parsed_version_id,
    raw_artifact_sha256: chunk.artifact_sha256,
    normalized_text_sha256: chunk.normalized_text_sha256,
    parser_version: chunk.parser_version,
    chunk_id: chunk.chunk_id,
    title: source.title,
    authority: source.authority,
    canonical_url: source.canonical_url,
    section_or_clause: chunk.section_identifier,
    page: chunk.page_from,
    effective_period: source.effective_period,
    effective_date_evidence_locator: "synthetic clause 1",
    review_status: source.status,
    retrieved_at: "2026-08-29T00:00:00Z",
    locator: {
      format: "pdf",
      page: chunk.page_from,
      section: chunk.section_identifier,
      paragraph: null,
      character_from: chunk.character_from,
      character_to: chunk.character_to,
    },
    supporting_chunk_ids: [chunk.chunk_id],
    excerpt: null,
    ...overrides,
  });
}

const secondaryAuthority = Object.freeze({
  kind: "secondary_professional_source",
  issuing_body: "Synthetic Commentary",
  binding_level: "secondary_explanatory",
  court_level: null,
  scope: "general",
  operative: false,
  explanatory: true,
  contains_numeric_rate: false,
  can_independently_support_monetary_rule: false,
});

const binding = Object.freeze({
  schema_version: LEGAL_REVIEW_SCHEMA_VERSION,
  source_id: "IL_SYNTHETIC_LAW",
  source_version_id: "IL_SYNTHETIC_LAW@v1",
  manifest_sha256: "c".repeat(64),
  raw_artifact_sha256: "a".repeat(64),
  normalized_text_sha256: "d".repeat(64),
  parser_version: "synthetic-parser-v1",
  normalizer_version: "synthetic-normalizer-v1",
});

const scope = Object.freeze({
  topic: "minimum_wage",
  sectors: Object.freeze(["general"]),
  applicability: "general",
  population_constraints: Object.freeze([]),
  effective_period: Object.freeze({
    effective_from: "2020-01-01",
    effective_to: null,
    retroactive: false,
    retroactive_basis: null,
    applicability_basis: "salary_month",
  }),
  period_certainty: "known",
});

function packet(overrides: Record<string, unknown> = {}) {
  return createLegalReviewPacket({
    binding, scope, citations: [citation()], created_at: AT, ...overrides,
  });
}

function action(current: ReturnType<typeof packet>, overrides: Partial<LegalReviewAction> = {}) {
  return {
    schema_version: LEGAL_REVIEW_SCHEMA_VERSION,
    action_id: "LRA:0001",
    packet_id: current.packet_id,
    packet_sha256: current.packet_sha256,
    expected_revision: current.revision,
    decision: "claim",
    actor_role: "legal_reviewer",
    attestation: { actor_id: "reviewer:1", signature_sha256: "e".repeat(64) },
    reason_code: "REVIEW_STARTED",
    reason: "Beginning review of the synthetic packet.",
    cited_chunk_ids: [],
    occurred_at: LATER,
    ...overrides,
  } as const;
}

function claimed(current = packet()) {
  return applyLegalReviewAction(current, action(current)).packet;
}

describe("V0.10.3 legal review packet identity", () => {
  it("derives identity deterministically from evidence bytes and scope", () => {
    const first = deriveLegalReviewPacketIdentity(binding, scope);
    const second = deriveLegalReviewPacketIdentity(binding, scope);
    expect(first).toEqual(second);
    expect(first.packet_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.packet_id).toContain("IL_SYNTHETIC_LAW@v1");
    expect(first.packet_id).toContain("minimum_wage");
  });

  it("changes identity when the parser, normalizer, artifact or scope changes", () => {
    const base = deriveLegalReviewPacketIdentity(binding, scope).packet_sha256;
    const variants = [
      deriveLegalReviewPacketIdentity({ ...binding, parser_version: "synthetic-parser-v2" }, scope),
      deriveLegalReviewPacketIdentity({ ...binding, normalizer_version: "synthetic-normalizer-v2" }, scope),
      deriveLegalReviewPacketIdentity({ ...binding, raw_artifact_sha256: "b".repeat(64) }, scope),
      deriveLegalReviewPacketIdentity({ ...binding, manifest_sha256: "f".repeat(64) }, scope),
      deriveLegalReviewPacketIdentity(binding, { ...scope, period_certainty: "unknown_or_disputed" }),
    ];
    for (const variant of variants) expect(variant.packet_sha256).not.toBe(base);
    expect(new Set(variants.map((entry) => entry.packet_sha256)).size).toBe(variants.length);
  });

  it("starts a packet pending review at revision 1", () => {
    const current = packet();
    expect(current.state).toBe("pending_review");
    expect(current.revision).toBe(1);
    expect(current.updated_at).toBe(AT);
  });

  it("rejects a scope whose declared certainty has no period bound", () => {
    expect(() => packet({
      scope: { ...scope, effective_period: { effective_from: null, effective_to: null, retroactive: false, retroactive_basis: null, applicability_basis: "salary_month" } },
    })).toThrow(LegalReviewError);
  });
});

describe("V0.10.3 legal review action application", () => {
  it("advances pending_review to in_review and bumps the revision", () => {
    const current = packet();
    const result = applyLegalReviewAction(current, action(current));
    expect(result.applied).toBe(true);
    expect(result.packet.state).toBe("in_review");
    expect(result.packet.revision).toBe(2);
    expect(result.packet.updated_at).toBe(LATER);
  });

  it("rejects a stale revision instead of overwriting a newer decision", () => {
    const current = claimed();
    expect(() => applyLegalReviewAction(current, action(current, {
      action_id: "LRA:0002", decision: "reject", expected_revision: 1, reason_code: "STALE",
    }))).toThrow(/LEGAL_REVIEW_STALE_REVISION/u);
  });

  it("rejects an action bound to different evidence bytes", () => {
    const current = packet();
    expect(() => applyLegalReviewAction(current, action(current, { packet_sha256: "b".repeat(64) })))
      .toThrow(/LEGAL_REVIEW_PACKET_IDENTITY_CHANGED/u);
  });

  it("treats an identical replay as a no-op and a divergent reuse as a conflict", () => {
    const current = packet();
    const first = action(current);
    const replay = applyLegalReviewAction(current, first, [first as unknown as LegalReviewAction]);
    expect(replay.applied).toBe(false);
    expect(replay.packet.revision).toBe(1);
    expect(() => applyLegalReviewAction(current, { ...first, reason: "different reason" },
      [first as unknown as LegalReviewAction])).toThrow(/LEGAL_REVIEW_ACTION_CONFLICT/u);
  });

  it("blocks any decision missing human identity or signature", () => {
    const current = packet();
    for (const attestation of [
      { actor_id: null, signature_sha256: "e".repeat(64) },
      { actor_id: "reviewer:1", signature_sha256: null },
      { actor_id: null, signature_sha256: null },
    ]) {
      expect(() => applyLegalReviewAction(current, action(current, { attestation })))
        .toThrow(/LEGAL_REVIEW_HUMAN_ATTESTATION_BLOCKED/u);
    }
  });

  it("permits approval only for a senior reviewer and never for an observer", () => {
    const current = claimed();
    expect(() => applyLegalReviewAction(current, action(current, {
      action_id: "LRA:0003", decision: "approve", actor_role: "legal_reviewer",
      expected_revision: current.revision, reason_code: "APPROVED",
    }))).toThrow(/LEGAL_REVIEW_ROLE_NOT_PERMITTED/u);
    expect(() => applyLegalReviewAction(current, action(current, {
      action_id: "LRA:0004", decision: "claim", actor_role: "legal_reviewer_observer",
      expected_revision: current.revision,
    }))).toThrow(/LEGAL_REVIEW_ROLE_NOT_PERMITTED/u);
  });

  it("refuses an approval whose packet cites only secondary explanatory authority", () => {
    const secondaryOnly = packet({ citations: [citation({ authority: secondaryAuthority })] });
    const inReview = applyLegalReviewAction(secondaryOnly, action(secondaryOnly)).packet;
    expect(packetSupportsMonetaryCandidate(inReview)).toBe(false);
    expect(() => applyLegalReviewAction(inReview, action(inReview, {
      action_id: "LRA:0005", decision: "approve", actor_role: "senior_legal_reviewer",
      expected_revision: inReview.revision, reason_code: "APPROVED",
    }))).toThrow(/LEGAL_REVIEW_MONETARY_AUTHORITY_INSUFFICIENT/u);
  });

  it("allows approval when operative binding authority is cited alongside secondary material", () => {
    const mixed = packet({ citations: [citation({ authority: secondaryAuthority }), citation()] });
    const inReview = applyLegalReviewAction(mixed, action(mixed)).packet;
    const approved = applyLegalReviewAction(inReview, action(inReview, {
      action_id: "LRA:0006", decision: "approve", actor_role: "senior_legal_reviewer",
      expected_revision: inReview.revision, reason_code: "APPROVED",
    }));
    expect(approved.packet.state).toBe("approved");
    expect(isTerminalLegalReviewState(approved.packet.state)).toBe(true);
  });

  it("never reopens or overwrites a terminal packet", () => {
    const inReview = claimed();
    const rejected = applyLegalReviewAction(inReview, action(inReview, {
      action_id: "LRA:0007", decision: "reject", actor_role: "senior_legal_reviewer",
      expected_revision: inReview.revision, reason_code: "REJECTED",
    })).packet;
    expect(rejected.state).toBe("rejected");
    for (const decision of ["approve", "claim", "request_changes", "supersede"] as const) {
      expect(() => applyLegalReviewAction(rejected, action(rejected, {
        action_id: `LRA:term-${decision}`, decision, actor_role: "senior_legal_reviewer",
        expected_revision: rejected.revision, reason_code: "REOPEN",
      }))).toThrow(/LEGAL_REVIEW_TERMINAL_STATE/u);
    }
  });

  it("forbids a transition that is not on the closed table", () => {
    const current = packet();
    expect(() => applyLegalReviewAction(current, action(current, {
      decision: "approve", actor_role: "senior_legal_reviewer", reason_code: "APPROVED",
    }))).toThrow(/LEGAL_REVIEW_TRANSITION_FORBIDDEN/u);
  });

  it("supports the changes_requested round trip back into review", () => {
    const inReview = claimed();
    const changes = applyLegalReviewAction(inReview, action(inReview, {
      action_id: "LRA:0008", decision: "request_changes", expected_revision: inReview.revision,
      reason_code: "CHANGES_REQUESTED",
    })).packet;
    expect(changes.state).toBe("changes_requested");
    const reclaimed = applyLegalReviewAction(changes, action(changes, {
      action_id: "LRA:0009", decision: "claim", expected_revision: changes.revision,
    })).packet;
    expect(reclaimed.state).toBe("in_review");
    expect(reclaimed.revision).toBe(4);
  });

  it("rejects citations that are not part of the packet", () => {
    const current = packet();
    expect(() => applyLegalReviewAction(current, action(current, { cited_chunk_ids: ["not-in-packet"] })))
      .toThrow(/LEGAL_REVIEW_CITATION_NOT_IN_PACKET/u);
  });
});

describe("V0.10.3 legal review queue", () => {
  function entry(overrides: Record<string, unknown> = {}) {
    const current = packet();
    return {
      packet_id: current.packet_id,
      packet_sha256: current.packet_sha256,
      state: "pending_review",
      priority: 10,
      enqueued_at: AT,
      ...overrides,
    };
  }

  it("orders deterministically by priority, then time, then packet id", () => {
    const queue = [
      entry({ packet_id: "LRP:c", priority: 5, enqueued_at: LATER }),
      entry({ packet_id: "LRP:a", priority: 5, enqueued_at: AT }),
      entry({ packet_id: "LRP:b", priority: 1, enqueued_at: LATER }),
    ].reduce((accumulator, candidate) => enqueueLegalReviewPacket(accumulator, candidate), [] as readonly LegalReviewQueueEntry[]);
    expect(queue.map((item) => item.packet_id)).toEqual(["LRP:b", "LRP:a", "LRP:c"]);
  });

  it("is idempotent on replay and conflicts on divergent content", () => {
    const first = entry();
    const once = enqueueLegalReviewPacket([], first);
    const twice = enqueueLegalReviewPacket(once, first);
    expect(twice).toHaveLength(1);
    expect(() => enqueueLegalReviewPacket(once, { ...first, priority: 999 }))
      .toThrow(/LEGAL_REVIEW_ACTION_CONFLICT/u);
  });

  it("treats the same packet at different evidence bytes as a separate entry", () => {
    const queue = enqueueLegalReviewPacket(enqueueLegalReviewPacket([], entry()),
      entry({ packet_sha256: "b".repeat(64) }));
    expect(queue).toHaveLength(2);
  });

  it("enforces the queue bound instead of growing without limit", () => {
    const queue = enqueueLegalReviewPacket([], entry({ packet_id: "LRP:only" }), 1);
    expect(() => enqueueLegalReviewPacket(queue, entry({ packet_id: "LRP:second" }), 1))
      .toThrow(/LEGAL_REVIEW_QUEUE_BOUND_EXCEEDED/u);
  });

  it("hides terminal packets from the open queue", () => {
    const queue = [
      entry({ packet_id: "LRP:open", state: "pending_review" }),
      entry({ packet_id: "LRP:done", state: "approved" }),
      entry({ packet_id: "LRP:gone", state: "superseded" }),
    ].reduce((accumulator, candidate) => enqueueLegalReviewPacket(accumulator, candidate), [] as readonly LegalReviewQueueEntry[]);
    expect(openLegalReviewQueue(queue).map((item) => item.packet_id)).toEqual(["LRP:open"]);
  });
});
