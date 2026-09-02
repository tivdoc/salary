// V0.10.5 legal topic readiness and human-handoff manifest.
//
// Empty by default and blocked by default. Nothing here decides law: a gate
// opens only because a durable record already exists, and no gate can be opened
// by an argument passed to these functions. A topic with no evidence reports
// every gate blocked, which is the honest state of all seven today.

import { frozen, legalOperationsSha256 } from "../legal-operations/canonical.ts";
import { WAVE3_TOPICS, type Wave3Topic } from "../wave3/contracts.ts";
import { isTerminalLegalReviewState } from "./workflow.ts";
import type { LegalReviewState } from "./contracts.ts";

export const LEGAL_TOPIC_READINESS_SCHEMA = "tivdoc-legal-topic-readiness-v0.10.5" as const;
export const LEGAL_HANDOFF_MANIFEST_SCHEMA = "tivdoc-legal-handoff-manifest-v0.10.5" as const;

/** The six gates that must all clear before a topic could ever be considered. */
export const LEGAL_TOPIC_GATES = Object.freeze([
  "source_review",
  "effective_period",
  "sector_population",
  "parameter_attestation",
  "rulespec_approval",
  "ground_truth",
] as const);

export type LegalTopicGate = (typeof LEGAL_TOPIC_GATES)[number];

/** One durable observation per topic. Absent fields mean "no evidence yet". */
export type LegalTopicEvidence = Readonly<{
  topic: Wave3Topic;
  approved_packets: number;
  packets_with_known_period: number;
  packets_with_declared_scope: number;
  dual_attested_parameters: number;
  approved_not_activated_rulespecs: number;
  locked_ground_truth_cases: number;
}>;

export type LegalTopicReadinessRow = Readonly<{
  topic: Wave3Topic;
  ready: false;
  blocked_gates: readonly LegalTopicGate[];
  cleared_gates: readonly LegalTopicGate[];
}>;

export type LegalTopicReadiness = Readonly<{
  schema_version: typeof LEGAL_TOPIC_READINESS_SCHEMA;
  topics: readonly LegalTopicReadinessRow[];
  ready_topics: 0;
  topic_denominator: number;
  activation_allowed: false;
}>;

const EMPTY: Omit<LegalTopicEvidence, "topic"> = Object.freeze({
  approved_packets: 0,
  packets_with_known_period: 0,
  packets_with_declared_scope: 0,
  dual_attested_parameters: 0,
  approved_not_activated_rulespecs: 0,
  locked_ground_truth_cases: 0,
});

function gatesFor(evidence: LegalTopicEvidence): readonly LegalTopicGate[] {
  const cleared: LegalTopicGate[] = [];
  if (evidence.approved_packets > 0) cleared.push("source_review");
  if (evidence.packets_with_known_period > 0) cleared.push("effective_period");
  if (evidence.packets_with_declared_scope > 0) cleared.push("sector_population");
  if (evidence.dual_attested_parameters > 0) cleared.push("parameter_attestation");
  if (evidence.approved_not_activated_rulespecs > 0) cleared.push("rulespec_approval");
  if (evidence.locked_ground_truth_cases > 0) cleared.push("ground_truth");
  return frozen(cleared);
}

/**
 * Readiness across the seven topics. `ready` is a literal false: clearing every
 * gate still does not make a topic ready, because readiness is a human legal
 * decision that no code in this repository is permitted to record.
 */
export function buildLegalTopicReadiness(
  evidence: readonly LegalTopicEvidence[] = [],
): LegalTopicReadiness {
  const byTopic = new Map(evidence.map((entry) => [entry.topic, entry]));
  const topics = [...WAVE3_TOPICS].sort().map((topic) => {
    const observed: LegalTopicEvidence = byTopic.get(topic) ?? frozen({ topic, ...EMPTY });
    const cleared = gatesFor(observed);
    return frozen({
      topic,
      ready: false as const,
      blocked_gates: frozen(LEGAL_TOPIC_GATES.filter((gate) => !cleared.includes(gate))),
      cleared_gates: cleared,
    });
  });
  return frozen({
    schema_version: LEGAL_TOPIC_READINESS_SCHEMA,
    topics: frozen(topics),
    ready_topics: 0 as const,
    topic_denominator: WAVE3_TOPICS.length,
    activation_allowed: false as const,
  });
}

export type LegalHandoffPacketReference = Readonly<{
  packet_id: string;
  packet_sha256: string;
  raw_artifact_sha256: string;
  source_version_id: string;
  state: LegalReviewState;
}>;

export type LegalHandoffManifest = Readonly<{
  schema_version: typeof LEGAL_HANDOFF_MANIFEST_SCHEMA;
  generated_for: string;
  packets: readonly LegalHandoffPacketReference[];
  template_ids: readonly string[];
  open_packet_count: number;
  terminal_packet_count: number;
  manifest_sha256: string;
  delivered: false;
  activation_allowed: false;
}>;

/**
 * A local manifest binding packets to their evidence hashes and to the golden
 * case templates a reviewer would use. It is explicitly not delivered anywhere:
 * `delivered` is a literal false, because this repository cannot witness an
 * external handoff.
 */
export function buildLegalHandoffManifest(input: Readonly<{
  generated_for: string;
  packets: readonly LegalHandoffPacketReference[];
  template_ids: readonly string[];
}>): LegalHandoffManifest {
  const packets = [...input.packets].sort((left, right) => left.packet_id.localeCompare(right.packet_id));
  const templateIds = frozen([...new Set(input.template_ids)].sort());
  const body = {
    schema_version: LEGAL_HANDOFF_MANIFEST_SCHEMA,
    generated_for: input.generated_for,
    packets,
    template_ids: templateIds,
  };
  return frozen({
    ...body,
    packets: frozen(packets),
    open_packet_count: packets.filter((packet) => !isTerminalLegalReviewState(packet.state)).length,
    terminal_packet_count: packets.filter((packet) => isTerminalLegalReviewState(packet.state)).length,
    manifest_sha256: legalOperationsSha256(body),
    delivered: false as const,
    activation_allowed: false as const,
  });
}
