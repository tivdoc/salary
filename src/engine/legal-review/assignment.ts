// V0.10.6 legal review queue work management (L1).
//
// Deterministic assignment over the durable packet queue. Every transition is
// compare-and-swap on the packet revision, every command is idempotent on its
// command id, and a claim is fenced so a lost claim can never be resurrected.
// Nothing here approves anything; it only decides who is allowed to look.

import { frozen, legalOperationsSha256 } from "../legal-operations/canonical.ts";
import { LegalReviewError, type LegalReviewerRole } from "./contracts.ts";

export const LEGAL_REVIEW_ASSIGNMENT_SCHEMA = "tivdoc-legal-review-assignment-v0.10.6" as const;

/** An observer may hold no assignment; only these roles may be assigned work. */
const ASSIGNABLE_ROLES: readonly LegalReviewerRole[] = frozen(["legal_reviewer", "senior_legal_reviewer"]);

export type LegalReviewAssignment = Readonly<{
  schema_version: typeof LEGAL_REVIEW_ASSIGNMENT_SCHEMA;
  packet_id: string;
  packet_sha256: string;
  packet_revision: number;
  assignee_id: string | null;
  assignee_role: LegalReviewerRole | null;
  fencing_token: number;
  lease_expires_at: string | null;
  enqueued_at: string;
  last_command_id: string | null;
  state: "unassigned" | "assigned" | "lease_expired";
}>;

export type LegalReviewAssignmentCommand = Readonly<{
  command_id: string;
  kind: "assign" | "unassign" | "claim" | "requeue";
  actor_id: string;
  actor_role: LegalReviewerRole;
  expected_packet_revision: number;
  expected_fencing_token: number;
  now: string;
  lease_seconds?: number;
  /** The reviewer who authored the packet's evidence, if any. */
  packet_author_id?: string | null;
}>;

export type LegalReviewAssignmentResult = Readonly<{
  assignment: LegalReviewAssignment;
  applied: boolean;
}>;

export type LegalReviewWorkloadRow = Readonly<{
  assignee_id: string;
  open_assignments: number;
  oldest_enqueued_at: string;
  packet_ids: readonly string[];
}>;

export function createLegalReviewAssignment(input: Readonly<{
  packet_id: string;
  packet_sha256: string;
  packet_revision: number;
  enqueued_at: string;
}>): LegalReviewAssignment {
  return frozen({
    schema_version: LEGAL_REVIEW_ASSIGNMENT_SCHEMA,
    packet_id: input.packet_id,
    packet_sha256: input.packet_sha256,
    packet_revision: input.packet_revision,
    assignee_id: null,
    assignee_role: null,
    fencing_token: 0,
    lease_expires_at: null,
    enqueued_at: input.enqueued_at,
    last_command_id: null,
    state: "unassigned" as const,
  });
}

function millis(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new LegalReviewError("LEGAL_REVIEW_ACTION_INVALID", "timestamp");
  return parsed;
}

/**
 * A lease that has run out is reported as expired rather than silently
 * reassigned: the holder must be seen to have lost it before anyone else can
 * take the work.
 */
export function expireLegalReviewLease(
  assignment: LegalReviewAssignment,
  now: string,
): LegalReviewAssignment {
  if (assignment.state !== "assigned" || assignment.lease_expires_at === null) return assignment;
  if (millis(now) < millis(assignment.lease_expires_at)) return assignment;
  return frozen({ ...assignment, state: "lease_expired" as const });
}

export function applyLegalReviewAssignmentCommand(
  current: LegalReviewAssignment,
  command: LegalReviewAssignmentCommand,
): LegalReviewAssignmentResult {
  // Replaying the identical command is a no-op; reusing its id for anything
  // else is a conflict rather than a second effect.
  if (current.last_command_id === command.command_id) {
    return frozen({ assignment: current, applied: false });
  }
  if (command.expected_packet_revision !== current.packet_revision) {
    throw new LegalReviewError("LEGAL_REVIEW_STALE_REVISION",
      `${command.expected_packet_revision}!=${current.packet_revision}`);
  }
  if (command.expected_fencing_token !== current.fencing_token) {
    throw new LegalReviewError("LEGAL_REVIEW_ACTION_CONFLICT", "fencing_token");
  }
  const observed = expireLegalReviewLease(current, command.now);

  if (command.kind === "assign" || command.kind === "claim") {
    if (!ASSIGNABLE_ROLES.includes(command.actor_role)) {
      throw new LegalReviewError("LEGAL_REVIEW_ROLE_NOT_PERMITTED", command.actor_role);
    }
    // Separation of duties: nobody reviews evidence they authored.
    if (command.packet_author_id && command.packet_author_id === command.actor_id) {
      throw new LegalReviewError("LEGAL_REVIEW_ROLE_NOT_PERMITTED", "separation_of_duties");
    }
    if (observed.state === "assigned" && observed.assignee_id !== command.actor_id) {
      throw new LegalReviewError("LEGAL_REVIEW_ACTION_CONFLICT", "already_assigned");
    }
    const leaseSeconds = command.lease_seconds ?? 900;
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 60 || leaseSeconds > 86_400) {
      throw new LegalReviewError("LEGAL_REVIEW_ACTION_INVALID", "lease_seconds");
    }
    return frozen({
      assignment: frozen({
        ...observed,
        assignee_id: command.actor_id,
        assignee_role: command.actor_role,
        fencing_token: observed.fencing_token + 1,
        lease_expires_at: new Date(millis(command.now) + leaseSeconds * 1_000).toISOString(),
        last_command_id: command.command_id,
        state: "assigned" as const,
      }),
      applied: true,
    });
  }

  if (observed.assignee_id === null) {
    throw new LegalReviewError("LEGAL_REVIEW_ACTION_CONFLICT", "not_assigned");
  }
  // Only the holder or a senior reviewer may take an assignment away.
  if (observed.assignee_id !== command.actor_id && command.actor_role !== "senior_legal_reviewer") {
    throw new LegalReviewError("LEGAL_REVIEW_ROLE_NOT_PERMITTED", "not_assignment_holder");
  }
  return frozen({
    assignment: frozen({
      ...observed,
      assignee_id: null,
      assignee_role: null,
      fencing_token: observed.fencing_token + 1,
      lease_expires_at: null,
      last_command_id: command.command_id,
      state: "unassigned" as const,
    }),
    applied: true,
  });
}

/** Deterministic workload, oldest work first, for a reviewer roster view. */
export function buildLegalReviewWorkload(
  assignments: readonly LegalReviewAssignment[],
  now: string,
): readonly LegalReviewWorkloadRow[] {
  const byAssignee = new Map<string, LegalReviewAssignment[]>();
  for (const assignment of assignments) {
    const observed = expireLegalReviewLease(assignment, now);
    if (observed.state !== "assigned" || observed.assignee_id === null) continue;
    const rows = byAssignee.get(observed.assignee_id) ?? [];
    rows.push(observed);
    byAssignee.set(observed.assignee_id, rows);
  }
  return frozen([...byAssignee.entries()]
    .map(([assigneeId, rows]) => frozen({
      assignee_id: assigneeId,
      open_assignments: rows.length,
      oldest_enqueued_at: rows.map((row) => row.enqueued_at).sort()[0] as string,
      packet_ids: frozen(rows.map((row) => row.packet_id).sort()),
    }))
    .sort((left, right) => left.assignee_id.localeCompare(right.assignee_id)));
}

/** Packets whose lease lapsed and are therefore returnable to the queue. */
export function requeueableLegalReviewAssignments(
  assignments: readonly LegalReviewAssignment[],
  now: string,
): readonly LegalReviewAssignment[] {
  return frozen(assignments
    .map((assignment) => expireLegalReviewLease(assignment, now))
    .filter((assignment) => assignment.state === "lease_expired")
    .sort((left, right) => left.packet_id.localeCompare(right.packet_id)));
}

/** Stable audit fingerprint of one assignment transition. */
export function legalReviewAssignmentSha256(assignment: LegalReviewAssignment): string {
  return legalOperationsSha256(assignment);
}
