// V0.10.3B staging backlog to durable review queue command.
//
// The projection describes observations; a review packet describes parsed,
// cited evidence. Those are not the same thing, so this command never derives
// one from the other. Evidence must be supplied explicitly per observation; an
// observation without it is reported as not enqueued, with its reasons, rather
// than completed with an inferred binding, scope or citation.

import { frozen, legalOperationsSha256 } from "../../../engine/legal-operations/canonical.ts";
import { LegalReviewError, type LegalReviewPacket } from "../../../engine/legal-review/contracts.ts";
import { createLegalReviewPacket } from "../../../engine/legal-review/workflow.ts";
import type { GovernanceCommandMetadata } from "../../platform/persistence/postgres/governance/contracts.ts";
import type { PostgresLegalReviewRepository } from "../../platform/persistence/postgres/governance/repositories.ts";
import type { LegalReviewBacklog, LegalReviewBacklogEntry } from "./staging-projection.ts";

export const LEGAL_REVIEW_BACKLOG_ENQUEUE_SCHEMA = "tivdoc-legal-review-backlog-enqueue-v0.10.3" as const;

/** Parsed evidence a reviewer needs, supplied by the caller, never inferred. */
export type LegalReviewBacklogEvidence = Readonly<{
  observation_id: string;
  binding: unknown;
  scope: unknown;
  citations: readonly unknown[];
}>;

export type LegalReviewBacklogEnqueueOutcome = Readonly<{
  observation_id: string;
  enqueued: boolean;
  packet_id: string | null;
  not_enqueued_reason_codes: readonly string[];
}>;

export type LegalReviewBacklogEnqueueResult = Readonly<{
  schema_version: typeof LEGAL_REVIEW_BACKLOG_ENQUEUE_SCHEMA;
  outcomes: readonly LegalReviewBacklogEnqueueOutcome[];
  counts: Readonly<{ total: number; enqueued: number; not_enqueued: number }>;
  activation_allowed: false;
}>;

function outcome(
  entry: LegalReviewBacklogEntry,
  packetId: string | null,
  reasons: readonly string[],
): LegalReviewBacklogEnqueueOutcome {
  return frozen({
    observation_id: entry.observation_id,
    enqueued: packetId !== null,
    packet_id: packetId,
    not_enqueued_reason_codes: frozen([...reasons]),
  });
}

/**
 * Enqueues every backlog entry that has both a clean projection and explicit
 * evidence. Enqueue is idempotent on packet identity, so replaying the same
 * command produces the same packets; a repository-level replay is surfaced by
 * the receipt rather than swallowed here.
 */
export async function enqueueLegalReviewBacklog(input: Readonly<{
  backlog: LegalReviewBacklog;
  evidence: readonly LegalReviewBacklogEvidence[];
  repository: PostgresLegalReviewRepository;
  metadata: GovernanceCommandMetadata;
  queue_priority?: number;
}>): Promise<LegalReviewBacklogEnqueueResult> {
  const evidenceById = new Map(input.evidence.map((entry) => [entry.observation_id, entry]));
  const priority = input.queue_priority ?? 100;
  const outcomes: LegalReviewBacklogEnqueueOutcome[] = [];

  for (const entry of input.backlog.entries) {
    if (entry.disposition === "blocked") {
      outcomes.push(outcome(entry, null, entry.blocked_reason_codes));
      continue;
    }
    const evidence = evidenceById.get(entry.observation_id);
    if (!evidence) {
      outcomes.push(outcome(entry, null, ["PARSED_EVIDENCE_NOT_SUPPLIED"]));
      continue;
    }
    let packet: LegalReviewPacket;
    try {
      packet = createLegalReviewPacket({
        binding: evidence.binding,
        scope: evidence.scope,
        citations: evidence.citations,
        created_at: input.metadata.occurred_at,
      });
    } catch (error) {
      if (!(error instanceof LegalReviewError)) throw error;
      outcomes.push(outcome(entry, null, ["PARSED_EVIDENCE_INVALID"]));
      continue;
    }
    // The observation's own bytes must be the bytes under review; a mismatch is
    // a wiring error, never something to reconcile silently.
    if (entry.bytes_sha256 !== null && packet.binding.raw_artifact_sha256 !== entry.bytes_sha256) {
      outcomes.push(outcome(entry, null, ["EVIDENCE_ARTIFACT_MISMATCH"]));
      continue;
    }
    await input.repository.enqueuePacket({
      packet,
      queue_priority: priority,
      blocked_reason_codes: [],
      metadata: frozen({
        idempotency_key: `lrq.${legalOperationsSha256(packet.packet_sha256).slice(0, 32)}`,
        occurred_at: input.metadata.occurred_at,
      }),
    });
    outcomes.push(outcome(entry, packet.packet_id, []));
  }

  const enqueued = outcomes.filter((entry) => entry.enqueued).length;
  return frozen({
    schema_version: LEGAL_REVIEW_BACKLOG_ENQUEUE_SCHEMA,
    outcomes: frozen(outcomes),
    counts: frozen({ total: outcomes.length, enqueued, not_enqueued: outcomes.length - enqueued }),
    activation_allowed: false as const,
  });
}
