// V0.10.6 reviewer workbench (L2) and attestation/RuleSpec handoff view (L3).
//
// Everything here is a projection of records that already exist. It composes
// nothing new about the law: it lays out the evidence, the lineage, the
// invalidation chain and the reasons a reviewer cannot yet proceed, so a
// qualified human can decide with the whole picture visible.

import { frozen, legalOperationsSha256 } from "../legal-operations/canonical.ts";
import { authorityCanIndependentlySupportMonetaryRule } from "../legal-knowledge/authority.ts";
import type { LegalReviewAction, LegalReviewPacket, LegalReviewState } from "./contracts.ts";
import { isTerminalLegalReviewState } from "./workflow.ts";

export const LEGAL_REVIEW_WORKBENCH_SCHEMA = "tivdoc-legal-review-workbench-v0.10.6" as const;
export const ATTESTATION_PRECONDITION_SCHEMA = "tivdoc-attestation-precondition-v0.10.6" as const;

export type PacketLineageEntry = Readonly<{
  packet_id: string;
  packet_sha256: string;
  state: LegalReviewState;
  superseded_by_packet_id: string | null;
}>;

export type InvalidationEdge = Readonly<{
  from_packet_id: string;
  to_packet_id: string;
  reason: "superseded_by" | "artifact_changed" | "parser_version_changed" | "scope_changed";
}>;

export type ReviewerWorkbench = Readonly<{
  schema_version: typeof LEGAL_REVIEW_WORKBENCH_SCHEMA;
  packet_id: string;
  packet_sha256: string;
  state: LegalReviewState;
  revision: number;
  terminal: boolean;
  evidence: Readonly<{
    source_version_id: string;
    raw_artifact_sha256: string;
    normalized_text_sha256: string;
    manifest_sha256: string;
    parser_version: string;
    normalizer_version: string;
  }>;
  scope: Readonly<{
    topic: string;
    applicability: string;
    sectors: readonly string[];
    population_constraints: readonly string[];
    effective_from: string | null;
    effective_to: string | null;
    period_certainty: string;
  }>;
  citations: readonly Readonly<{
    chunk_id: string;
    section_or_clause: string;
    page: number | null;
    character_from: number;
    character_to: number;
    authority_tier: string;
    operative: boolean;
    supports_monetary_rule: boolean;
    raw_artifact_sha256: string;
    parser_version: string;
  }>[];
  lineage: readonly PacketLineageEntry[];
  invalidation_edges: readonly InvalidationEdge[];
  timeline: readonly Readonly<{
    action_id: string;
    decision: string;
    actor_id: string | null;
    actor_role: string;
    occurred_at: string;
    resulting_revision: number;
  }>[];
  monetary_authority_present: boolean;
  blocked_reason_codes: readonly string[];
}>;

/**
 * One packet laid out for review. The timeline is ordered by the revision each
 * action produced, so it reads as the immutable history it is.
 */
export function buildReviewerWorkbench(input: Readonly<{
  packet: LegalReviewPacket;
  actions?: readonly LegalReviewAction[];
  lineage?: readonly PacketLineageEntry[];
  blocked_reason_codes?: readonly string[];
}>): ReviewerWorkbench {
  const packet = input.packet;
  const actions = [...(input.actions ?? [])]
    .sort((left, right) => left.expected_revision - right.expected_revision
      || left.action_id.localeCompare(right.action_id));
  const lineage = frozen([...(input.lineage ?? [])]
    .sort((left, right) => left.packet_id.localeCompare(right.packet_id)));

  const edges: InvalidationEdge[] = [];
  for (const entry of lineage) {
    if (entry.superseded_by_packet_id) {
      edges.push(frozen({
        from_packet_id: entry.packet_id,
        to_packet_id: entry.superseded_by_packet_id,
        reason: "superseded_by" as const,
      }));
    }
  }

  return frozen({
    schema_version: LEGAL_REVIEW_WORKBENCH_SCHEMA,
    packet_id: packet.packet_id,
    packet_sha256: packet.packet_sha256,
    state: packet.state,
    revision: packet.revision,
    terminal: isTerminalLegalReviewState(packet.state),
    evidence: frozen({
      source_version_id: packet.binding.source_version_id,
      raw_artifact_sha256: packet.binding.raw_artifact_sha256,
      normalized_text_sha256: packet.binding.normalized_text_sha256,
      manifest_sha256: packet.binding.manifest_sha256,
      parser_version: packet.binding.parser_version,
      normalizer_version: packet.binding.normalizer_version,
    }),
    scope: frozen({
      topic: packet.scope.topic,
      applicability: packet.scope.applicability,
      sectors: frozen([...packet.scope.sectors]),
      population_constraints: frozen([...packet.scope.population_constraints]),
      effective_from: packet.scope.effective_period.effective_from,
      effective_to: packet.scope.effective_period.effective_to,
      period_certainty: packet.scope.period_certainty,
    }),
    citations: frozen(packet.citations.map((citation) => frozen({
      chunk_id: citation.chunk_id,
      section_or_clause: citation.section_or_clause,
      page: citation.page,
      character_from: citation.locator.character_from,
      character_to: citation.locator.character_to,
      authority_tier: citation.authority.binding_level,
      operative: citation.authority.operative,
      supports_monetary_rule: authorityCanIndependentlySupportMonetaryRule(citation.authority),
      raw_artifact_sha256: citation.raw_artifact_sha256,
      parser_version: citation.parser_version,
    }))),
    lineage,
    invalidation_edges: frozen(edges),
    timeline: frozen(actions.map((action) => frozen({
      action_id: action.action_id,
      decision: action.decision,
      actor_id: action.attestation.actor_id,
      actor_role: action.actor_role,
      occurred_at: action.occurred_at,
      resulting_revision: action.expected_revision + 1,
    }))),
    monetary_authority_present: packet.citations
      .some((citation) => authorityCanIndependentlySupportMonetaryRule(citation.authority)),
    blocked_reason_codes: frozen([...(input.blocked_reason_codes ?? [])].sort()),
  });
}

/** Local export. It is explicitly not a delivery to anyone. */
export function exportReviewerWorkbench(
  workbench: ReviewerWorkbench,
  format: "json" | "markdown",
): Readonly<{ disposition: "internal_review_not_delivered"; sha256: string; body: string }> {
  const body = format === "json"
    ? JSON.stringify({ disposition: "internal_review_not_delivered", workbench }, null, 2)
    : renderMarkdown(workbench);
  return frozen({
    disposition: "internal_review_not_delivered" as const,
    sha256: legalOperationsSha256({ format, workbench }),
    body,
  });
}

function renderMarkdown(workbench: ReviewerWorkbench): string {
  const lines = [
    "# Legal review packet (internal_review_not_delivered)",
    "",
    `- Packet: ${workbench.packet_id}`,
    `- Identity: ${workbench.packet_sha256}`,
    `- State: ${workbench.state} (revision ${workbench.revision})`,
    `- Source version: ${workbench.evidence.source_version_id}`,
    `- Artifact: ${workbench.evidence.raw_artifact_sha256}`,
    `- Normalized text: ${workbench.evidence.normalized_text_sha256}`,
    `- Manifest: ${workbench.evidence.manifest_sha256}`,
    `- Parser / normalizer: ${workbench.evidence.parser_version} / ${workbench.evidence.normalizer_version}`,
    `- Scope: ${workbench.scope.topic} / ${workbench.scope.applicability} / ${workbench.scope.sectors.join(", ")}`,
    `- Effective: ${workbench.scope.effective_from ?? "unknown"} .. ${workbench.scope.effective_to ?? "open"}`
      + ` (${workbench.scope.period_certainty})`,
    "",
    "## Citations",
    ...workbench.citations.map((citation) =>
      `- ${citation.chunk_id} §${citation.section_or_clause} [${citation.character_from}-${citation.character_to}]`
      + ` tier=${citation.authority_tier} monetary=${citation.supports_monetary_rule}`),
    "",
    "## Timeline",
    ...(workbench.timeline.length === 0
      ? ["- none"]
      : workbench.timeline.map((entry) =>
        `- r${entry.resulting_revision} ${entry.decision} by ${entry.actor_id ?? "unknown"} at ${entry.occurred_at}`)),
    "",
    "## Blockers",
    ...(workbench.blocked_reason_codes.length === 0
      ? ["- none"]
      : workbench.blocked_reason_codes.map((code) => `- ${code}`)),
    "",
    "No source, parameter or rule is activated by this document.",
  ];
  return lines.join("\n");
}

export type AttestationPreconditionCode =
  | "PACKET_NOT_APPROVED"
  | "NO_OPERATIVE_MONETARY_AUTHORITY"
  | "SAME_REVIEWER_AS_FIRST_ATTESTATION"
  | "REVIEWER_NOT_ELIGIBLE"
  | "SECOND_ATTESTATION_MISSING"
  | "CANDIDATE_VERSION_STALE"
  | "EVIDENCE_ARTIFACT_CHANGED"
  | "SCOPE_OR_PERIOD_MISSING"
  | "UNIT_OR_ROUNDING_MISSING";

export type RuleSpecHandoffState =
  | "draft"
  | "legal_review_required"
  | "approved_not_activated"
  | "rejected"
  | "superseded";

export type AttestationPreconditionView = Readonly<{
  schema_version: typeof ATTESTATION_PRECONDITION_SCHEMA;
  candidate_id: string;
  unmet_preconditions: readonly AttestationPreconditionCode[];
  ready_for_second_attestation: boolean;
  ready_for_rule_approval: boolean;
  rulespec_handoff_state: RuleSpecHandoffState;
  activation_allowed: false;
  activation_endpoint_present: false;
}>;

/**
 * Every reason a monetary candidate cannot advance, all at once. Even with no
 * unmet precondition the candidate is only ever ready for rule approval, never
 * active: activation has no endpoint anywhere in this codebase.
 */
export function buildAttestationPreconditionView(input: Readonly<{
  candidate_id: string;
  packet: ReviewerWorkbench;
  first_attestation_reviewer_id: string | null;
  second_attestation_reviewer_id: string | null;
  reviewer_eligible: boolean;
  candidate_version_current: boolean;
  bound_artifact_sha256: string;
  unit: string | null;
  rounding_policy: string | null;
  rulespec_handoff_state?: RuleSpecHandoffState;
}>): AttestationPreconditionView {
  const codes: AttestationPreconditionCode[] = [];
  if (input.packet.state !== "approved") codes.push("PACKET_NOT_APPROVED");
  if (!input.packet.monetary_authority_present) codes.push("NO_OPERATIVE_MONETARY_AUTHORITY");
  if (!input.reviewer_eligible) codes.push("REVIEWER_NOT_ELIGIBLE");
  if (input.first_attestation_reviewer_id !== null
    && input.first_attestation_reviewer_id === input.second_attestation_reviewer_id) {
    codes.push("SAME_REVIEWER_AS_FIRST_ATTESTATION");
  }
  if (input.second_attestation_reviewer_id === null) codes.push("SECOND_ATTESTATION_MISSING");
  if (!input.candidate_version_current) codes.push("CANDIDATE_VERSION_STALE");
  if (input.bound_artifact_sha256 !== input.packet.evidence.raw_artifact_sha256) {
    codes.push("EVIDENCE_ARTIFACT_CHANGED");
  }
  if (input.packet.scope.effective_from === null || input.packet.scope.period_certainty !== "known") {
    codes.push("SCOPE_OR_PERIOD_MISSING");
  }
  if (!input.unit || !input.rounding_policy) codes.push("UNIT_OR_ROUNDING_MISSING");

  const unmet = frozen([...new Set(codes)].sort());
  const blockingSecond = unmet.filter((code) => code !== "SECOND_ATTESTATION_MISSING");
  return frozen({
    schema_version: ATTESTATION_PRECONDITION_SCHEMA,
    candidate_id: input.candidate_id,
    unmet_preconditions: unmet,
    ready_for_second_attestation: blockingSecond.length === 0,
    ready_for_rule_approval: unmet.length === 0,
    rulespec_handoff_state: input.rulespec_handoff_state ?? "legal_review_required",
    activation_allowed: false as const,
    activation_endpoint_present: false as const,
  });
}
