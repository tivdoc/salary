import { WAVE3_TOPICS, type Wave3Topic } from "../wave3/contracts.ts";
import { CORPUS_LIFECYCLE, type CorpusLifecycleEntry } from "../wave23/corpus-trust/lifecycle.ts";
import { canonicalLegalOperationsJson, frozen, legalOperationsSha256 } from "./canonical.ts";
import {
  blankSourceDecisionTemplateSchema,
  reviewOwnerHandoffIndexSchema,
  reviewPacketSchema,
  type BlankSourceDecisionTemplate,
  type ReviewOwnerHandoffIndex,
  type ReviewPacket,
  type ReviewPacketSource,
} from "./contracts.ts";

export const REVIEW_PACKET_GENERATED_AT = "2030-01-01T00:00:00.000Z" as const;
export const REVIEW_PACKET_SCOPE_AS_OF = "2030-01-01" as const;

const REQUIRED_SIGNATURES = Object.freeze([
  { decision_kind: "artifact_authenticity" as const, reviewer_role: "human_artifact_reviewer" as const, status: "pending_human_signature" as const },
  { decision_kind: "content_transcription_accuracy" as const, reviewer_role: "human_content_reviewer" as const, status: "pending_human_signature" as const },
  { decision_kind: "effective_interval" as const, reviewer_role: "human_effective_period_reviewer" as const, status: "pending_human_signature" as const },
  { decision_kind: "sector_population_applicability" as const, reviewer_role: "human_applicability_reviewer" as const, status: "pending_human_signature" as const },
  { decision_kind: "authority_precedence" as const, reviewer_role: "human_authority_reviewer" as const, status: "pending_human_signature" as const },
]);

const TOPIC_QUESTIONS: Readonly<Record<Wave3Topic, readonly string[]>> = Object.freeze(Object.fromEntries(
  WAVE3_TOPICS.map((topic) => [topic, Object.freeze([
    `Are the artifact bytes and immutable source identity for ${topic} authentic?`,
    `Is the transcription for every cited ${topic} chunk complete and accurate?`,
    `Which effective intervals, if any, are verified for ${topic}?`,
    `Which sector and population selectors, if any, are verified for ${topic}?`,
    `What authority role and precedence, if any, are verified for each ${topic} source?`,
  ])]),
) as Record<Wave3Topic, readonly string[]>);

function authorityRole(entry: CorpusLifecycleEntry): ReviewPacketSource["authority_role"] {
  if (entry.source_role === "binding_role_candidate") return "primary_binding";
  if (entry.source_role === "corroborative") return "official_implementation";
  if (entry.source_role === "secondary_explanatory") return "secondary_explanatory";
  return "role_pending";
}

function sourceBlockers(entry: CorpusLifecycleEntry) {
  const blockers = new Set<string>([
    "Immutable artifact byte hash is not present in the frozen lifecycle record.",
    "Immutable chunk hashes are not present in the frozen lifecycle record.",
    "Independent human legal review has not been recorded.",
    "Effective interval, sector, and population remain unverified.",
    "Activation remains inactive.",
  ]);
  if (entry.technical_parse_status === "failed") blockers.add("Technical parse failed; no parsed material may be reviewed or activated.");
  if (entry.retrieval_visibility === "hidden") blockers.add("Instrument boundary is quarantined and canonical retrieval is hidden.");
  if (entry.source_role !== "binding_role_candidate") blockers.add("Source is not a primary binding-role candidate and cannot independently support a monetary parameter.");
  return Object.freeze([...blockers].sort());
}

function packetSource(entry: CorpusLifecycleEntry): ReviewPacketSource {
  return frozen({
    source_version_id: entry.source_version_id,
    immutable_source_record_sha256: legalOperationsSha256(entry),
    artifact_sha256: null,
    chunk_sha256s: [],
    hash_availability: entry.technical_parse_status === "failed" ? "technical_parse_failed" : entry.instrument_resolved_chunks > 0 ? "chunks_unavailable" : "artifact_hash_missing",
    authority_role: authorityRole(entry),
    publication_metadata: { publication_reference: null, published_at: null },
    proposed_effective_periods: [{ from: null, to: null, status: "unverified" }],
    proposed_sectors: ["unverified"],
    proposed_populations: ["unverified"],
    lifecycle_blockers: sourceBlockers(entry),
  });
}

function packetId(topic: Wave3Topic) { return `LEGAL_REVIEW_PACKET_${topic.toUpperCase()}`; }

export function buildReviewPacket(topic: Wave3Topic): ReviewPacket {
  const lifecycle = CORPUS_LIFECYCLE.filter((entry) => entry.topic === topic).sort((left, right) => left.source_version_id < right.source_version_id ? -1 : left.source_version_id > right.source_version_id ? 1 : 0);
  if (lifecycle.length === 0) throw new Error(`REVIEW_PACKET_SOURCE_MISSING:${topic}`);
  const sources = lifecycle.map(packetSource);
  const quarantines = lifecycle.filter((entry) => entry.retrieval_visibility === "hidden").map((entry) => `${entry.source_version_id}: instrument boundary quarantined; retrieval hidden.`);
  const parseFailures = lifecycle.filter((entry) => entry.technical_parse_status === "failed").map((entry) => `${entry.source_version_id}: technical parse failed.`);
  const missingMaterial = lifecycle.flatMap((entry) => [
    `${entry.source_version_id}: immutable artifact byte hash unavailable.`,
    `${entry.source_version_id}: immutable chunk hashes unavailable.`,
  ]);
  const seed = frozen({
    schema_version: "tivdoc-source-review-packet-v0.6.0" as const,
    packet_id: packetId(topic),
    packet_version: "1.0.0",
    topic,
    generated_at: REVIEW_PACKET_GENERATED_AT,
    scope_complete_as_of: REVIEW_PACKET_SCOPE_AS_OF,
    completeness_status: (quarantines.length > 0 || parseFailures.length > 0 ? "blocked" : "incomplete") as "blocked" | "incomplete",
    sources,
    known_conflicts: lifecycle.filter((entry) => entry.instrument_boundary_status !== "resolved").map((entry) => `${entry.source_version_id}: instrument boundary status ${entry.instrument_boundary_status}; no legal resolution inferred.`),
    quarantines,
    parse_failures: parseFailures,
    missing_official_material: missingMaterial,
    reviewer_questions: TOPIC_QUESTIONS[topic],
    decision_template_id: `LEGAL_DECISION_TEMPLATE_${topic.toUpperCase()}`,
    usable_for_rules: false as const,
  });
  return reviewPacketSchema.parse({ ...seed, packet_sha256: legalOperationsSha256(seed) });
}

export function buildBlankDecisionTemplate(packet: ReviewPacket): BlankSourceDecisionTemplate {
  return blankSourceDecisionTemplateSchema.parse({
    schema_version: "tivdoc-blank-source-decision-template-v0.6.0",
    template_id: packet.decision_template_id,
    packet_id: packet.packet_id,
    packet_sha256: packet.packet_sha256,
    required_decisions: REQUIRED_SIGNATURES.map((entry) => entry.decision_kind),
    reviewer_id: null,
    reviewer_role: null,
    decision: null,
    decided_at: null,
    reason: null,
    signature_sha256: null,
  });
}

export function renderReviewPacketMarkdown(packet: ReviewPacket) {
  const lines = [
    `# ${packet.topic} legal-source review packet`,
    "",
    `- Packet: ${packet.packet_id}@${packet.packet_version}`,
    `- Packet SHA-256: ${packet.packet_sha256}`,
    `- Scope complete as of: ${packet.scope_complete_as_of}`,
    `- Completeness: ${packet.completeness_status}`,
    `- Usable for rules: ${packet.usable_for_rules}`,
    "",
    "## Sources",
    "",
  ];
  for (const source of packet.sources) {
    lines.push(
      `### ${source.source_version_id}`,
      "",
      `- Immutable source record SHA-256: ${source.immutable_source_record_sha256}`,
      `- Artifact SHA-256: ${source.artifact_sha256 ?? "UNAVAILABLE"}`,
      `- Chunk SHA-256 count: ${source.chunk_sha256s.length}`,
      `- Hash availability: ${source.hash_availability}`,
      `- Authority role: ${source.authority_role}`,
      `- Publication reference: ${source.publication_metadata.publication_reference ?? "UNVERIFIED"}`,
      `- Published at: ${source.publication_metadata.published_at ?? "UNVERIFIED"}`,
      `- Proposed effective period: UNVERIFIED`,
      `- Proposed sectors: ${source.proposed_sectors.join(", ")}`,
      `- Proposed populations: ${source.proposed_populations.join(", ")}`,
      "- Blockers:",
      ...source.lifecycle_blockers.map((blocker) => `  - ${blocker}`),
      "",
    );
  }
  const sections: readonly [string, readonly string[]][] = [
    ["Known conflicts", packet.known_conflicts],
    ["Quarantines", packet.quarantines],
    ["Parse failures", packet.parse_failures],
    ["Missing official material", packet.missing_official_material],
    ["Reviewer questions", packet.reviewer_questions],
  ];
  for (const [title, entries] of sections) lines.push(`## ${title}`, "", ...(entries.length > 0 ? entries.map((entry) => `- ${entry}`) : ["- None recorded in the frozen technical inventory."]), "");
  lines.push("## Decision template", "", `Use ${packet.decision_template_id}. Every field is blank and requires an identified human reviewer and signed hash.`, "");
  return `${lines.join("\n")}\n`;
}

export type ReviewPacketBundle = Readonly<{
  topic: Wave3Topic;
  packet: ReviewPacket;
  json: string;
  markdown: string;
  blank_decision: BlankSourceDecisionTemplate;
  blank_decision_json: string;
}>;

export function buildAllReviewPacketBundles(): readonly ReviewPacketBundle[] {
  return frozen(WAVE3_TOPICS.map((topic) => {
    const packet = buildReviewPacket(topic);
    const blankDecision = buildBlankDecisionTemplate(packet);
    return {
      topic,
      packet,
      json: canonicalLegalOperationsJson(packet),
      markdown: renderReviewPacketMarkdown(packet),
      blank_decision: blankDecision,
      blank_decision_json: canonicalLegalOperationsJson(blankDecision),
    };
  }));
}

export function buildOwnerHandoffIndex(basePath = "review-packets"): ReviewOwnerHandoffIndex {
  const bundles = buildAllReviewPacketBundles();
  return reviewOwnerHandoffIndexSchema.parse({
    schema_version: "tivdoc-review-owner-handoff-index-v0.6.0",
    generated_at: REVIEW_PACKET_GENERATED_AT,
    packet_count: 7,
    packets: bundles.map(({ topic, packet }) => ({
      topic,
      packet_id: packet.packet_id,
      packet_sha256: packet.packet_sha256,
      json_path: `${basePath}/${topic}.review-packet.json`,
      markdown_path: `${basePath}/${topic}.review-packet.md`,
      blank_decision_path: `${basePath}/${topic}.blank-decision.json`,
      completeness_status: packet.completeness_status,
      required_signatures: REQUIRED_SIGNATURES,
    })),
    real_catalog_activation_permitted: false,
  });
}
