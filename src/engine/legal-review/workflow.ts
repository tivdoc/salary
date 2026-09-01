// V0.10.3 legal review operations workflow.
//
// Deterministic, non-operative and fail-closed. Approving a packet records a
// human review decision about evidence; it does not activate a source, derive
// a parameter value, or make anything reachable by a customer path.

import { authorityCanIndependentlySupportMonetaryRule } from "../legal-knowledge/authority.ts";
import { frozen, legalOperationsSha256 } from "../legal-operations/canonical.ts";
import {
  legalReviewActionSchema,
  legalReviewPacketBindingSchema,
  legalReviewPacketSchema,
  legalReviewQueueEntrySchema,
  legalReviewScopeSchema,
  LegalReviewError,
  LEGAL_REVIEW_SCHEMA_VERSION,
  type LegalReviewAction,
  type LegalReviewDecision,
  type LegalReviewPacket,
  type LegalReviewQueueEntry,
  type LegalReviewState,
  type LegalReviewerRole,
} from "./contracts.ts";

export const LEGAL_REVIEW_QUEUE_BOUND = 500 as const;

/**
 * Closed transition table. Terminal states have no outgoing edges, so an
 * approval can never quietly overwrite a rejection; the only way forward from
 * a terminal state is a new packet, which by construction has a new identity.
 */
const TRANSITIONS: Readonly<Record<LegalReviewState, readonly LegalReviewState[]>> = frozen({
  pending_review: frozen(["in_review", "superseded"]),
  in_review: frozen(["changes_requested", "approved", "rejected", "superseded"]),
  changes_requested: frozen(["in_review", "superseded"]),
  approved: frozen([]),
  rejected: frozen([]),
  superseded: frozen([]),
});

const DECISION_TARGET: Readonly<Record<LegalReviewDecision, LegalReviewState>> = frozen({
  claim: "in_review",
  request_changes: "changes_requested",
  approve: "approved",
  reject: "rejected",
  supersede: "superseded",
});

/** Observers may read and claim nothing; only a senior reviewer may approve. */
const DECISION_ROLES: Readonly<Record<LegalReviewDecision, readonly LegalReviewerRole[]>> = frozen({
  claim: frozen(["legal_reviewer", "senior_legal_reviewer"]),
  request_changes: frozen(["legal_reviewer", "senior_legal_reviewer"]),
  approve: frozen(["senior_legal_reviewer"]),
  reject: frozen(["legal_reviewer", "senior_legal_reviewer"]),
  supersede: frozen(["senior_legal_reviewer"]),
});

const TERMINAL: readonly LegalReviewState[] = frozen(["approved", "rejected", "superseded"]);

function parse<T>(schema: { parse: (value: unknown) => T }, value: unknown, code: "LEGAL_REVIEW_PACKET_INVALID" | "LEGAL_REVIEW_ACTION_INVALID"): T {
  try {
    return schema.parse(value);
  } catch (error) {
    throw new LegalReviewError(code, error instanceof Error ? error.message.slice(0, 200) : undefined);
  }
}

export function isTerminalLegalReviewState(state: LegalReviewState): boolean {
  return TERMINAL.includes(state);
}

/**
 * Packet identity is the hash of the evidence binding plus the reviewed scope.
 * Re-parsing with a new parser version, re-normalizing, or changing the scope
 * all produce a different packet rather than a mutated one.
 */
export function deriveLegalReviewPacketIdentity(
  bindingInput: unknown,
  scopeInput: unknown,
): Readonly<{ packet_id: string; packet_sha256: string }> {
  const binding = parse(legalReviewPacketBindingSchema, bindingInput, "LEGAL_REVIEW_PACKET_INVALID");
  const scope = parse(legalReviewScopeSchema, scopeInput, "LEGAL_REVIEW_PACKET_INVALID");
  const packetSha256 = legalOperationsSha256({
    schema_version: LEGAL_REVIEW_SCHEMA_VERSION,
    binding,
    scope,
  });
  return frozen({
    packet_id: `LRP:${binding.source_version_id}:${scope.topic}:${packetSha256.slice(0, 16)}`,
    packet_sha256: packetSha256,
  });
}

export function createLegalReviewPacket(input: Readonly<{
  binding: unknown;
  scope: unknown;
  citations: readonly unknown[];
  created_at: string;
}>): LegalReviewPacket {
  const identity = deriveLegalReviewPacketIdentity(input.binding, input.scope);
  return parse(legalReviewPacketSchema, {
    schema_version: LEGAL_REVIEW_SCHEMA_VERSION,
    packet_id: identity.packet_id,
    packet_sha256: identity.packet_sha256,
    binding: input.binding,
    scope: input.scope,
    citations: input.citations,
    state: "pending_review",
    revision: 1,
    created_at: input.created_at,
    updated_at: input.created_at,
  }, "LEGAL_REVIEW_PACKET_INVALID");
}

/**
 * True only when the packet cites at least one source whose authority can
 * independently support a monetary rule. Secondary explanatory material may be
 * cited, but never carries a monetary candidate on its own.
 */
export function packetSupportsMonetaryCandidate(packet: LegalReviewPacket): boolean {
  return packet.citations.some((citation) => authorityCanIndependentlySupportMonetaryRule(citation.authority));
}

export type LegalReviewApplication = Readonly<{
  packet: LegalReviewPacket;
  applied: boolean;
}>;

/**
 * Applies one immutable action. Every rejection path is explicit; nothing is
 * coerced. Replaying an identical action is a no-op so at-least-once delivery
 * is safe, while a different action reusing an action_id is a conflict.
 */
export function applyLegalReviewAction(
  packetInput: LegalReviewPacket,
  actionInput: unknown,
  appliedActions: readonly LegalReviewAction[] = [],
): LegalReviewApplication {
  const packet = parse(legalReviewPacketSchema, packetInput, "LEGAL_REVIEW_PACKET_INVALID");
  const action = parse(legalReviewActionSchema, actionInput, "LEGAL_REVIEW_ACTION_INVALID");

  const previous = appliedActions.find((entry) => entry.action_id === action.action_id);
  if (previous) {
    if (legalOperationsSha256(previous) !== legalOperationsSha256(action)) {
      throw new LegalReviewError("LEGAL_REVIEW_ACTION_CONFLICT", action.action_id);
    }
    return frozen({ packet, applied: false });
  }

  if (action.packet_id !== packet.packet_id || action.packet_sha256 !== packet.packet_sha256) {
    throw new LegalReviewError("LEGAL_REVIEW_PACKET_IDENTITY_CHANGED", action.packet_id);
  }
  if (action.expected_revision !== packet.revision) {
    throw new LegalReviewError("LEGAL_REVIEW_STALE_REVISION", `${action.expected_revision}!=${packet.revision}`);
  }
  if (isTerminalLegalReviewState(packet.state)) {
    throw new LegalReviewError("LEGAL_REVIEW_TERMINAL_STATE", packet.state);
  }
  if (!DECISION_ROLES[action.decision].includes(action.actor_role)) {
    throw new LegalReviewError("LEGAL_REVIEW_ROLE_NOT_PERMITTED", `${action.actor_role}:${action.decision}`);
  }
  if (action.attestation.actor_id === null || action.attestation.signature_sha256 === null) {
    throw new LegalReviewError("LEGAL_REVIEW_HUMAN_ATTESTATION_BLOCKED", action.action_id);
  }

  const known = new Set(packet.citations.map((citation) => citation.chunk_id));
  const unknown = action.cited_chunk_ids.filter((chunkId) => !known.has(chunkId));
  if (unknown.length > 0) {
    throw new LegalReviewError("LEGAL_REVIEW_CITATION_NOT_IN_PACKET", unknown.join(","));
  }

  // Approval is the only decision that could later feed a monetary candidate,
  // so it is the only one that requires operative authority in the packet.
  if (action.decision === "approve" && !packetSupportsMonetaryCandidate(packet)) {
    throw new LegalReviewError("LEGAL_REVIEW_MONETARY_AUTHORITY_INSUFFICIENT", packet.packet_id);
  }

  const target = DECISION_TARGET[action.decision];
  if (!TRANSITIONS[packet.state].includes(target)) {
    throw new LegalReviewError("LEGAL_REVIEW_TRANSITION_FORBIDDEN", `${packet.state}->${target}`);
  }

  return frozen({
    packet: frozen({ ...packet, state: target, revision: packet.revision + 1, updated_at: action.occurred_at }),
    applied: true,
  });
}

function compareQueueEntries(left: LegalReviewQueueEntry, right: LegalReviewQueueEntry): number {
  if (left.priority !== right.priority) return left.priority - right.priority;
  if (left.enqueued_at !== right.enqueued_at) return left.enqueued_at < right.enqueued_at ? -1 : 1;
  return left.packet_id < right.packet_id ? -1 : left.packet_id > right.packet_id ? 1 : 0;
}

/**
 * Bounded, deterministically ordered queue. Enqueue is idempotent on packet
 * identity: replaying the same entry changes nothing, while the same packet at
 * different evidence bytes is a distinct entry rather than an overwrite.
 */
export function enqueueLegalReviewPacket(
  queue: readonly LegalReviewQueueEntry[],
  entryInput: unknown,
  bound: number = LEGAL_REVIEW_QUEUE_BOUND,
): readonly LegalReviewQueueEntry[] {
  const entry = parse(legalReviewQueueEntrySchema, entryInput, "LEGAL_REVIEW_ACTION_INVALID");
  const existing = queue.find((candidate) => candidate.packet_id === entry.packet_id
    && candidate.packet_sha256 === entry.packet_sha256);
  if (existing) {
    if (legalOperationsSha256(existing) !== legalOperationsSha256(entry)) {
      throw new LegalReviewError("LEGAL_REVIEW_ACTION_CONFLICT", entry.packet_id);
    }
    return frozen([...queue].sort(compareQueueEntries));
  }
  if (queue.length + 1 > bound) {
    throw new LegalReviewError("LEGAL_REVIEW_QUEUE_BOUND_EXCEEDED", String(bound));
  }
  return frozen([...queue, entry].sort(compareQueueEntries));
}

/** Entries still awaiting reviewer attention, in deterministic order. */
export function openLegalReviewQueue(
  queue: readonly LegalReviewQueueEntry[],
): readonly LegalReviewQueueEntry[] {
  return frozen(queue.filter((entry) => !isTerminalLegalReviewState(entry.state)).sort(compareQueueEntries));
}
