import { canonicalSha256, canonicalStringify } from "../../rule-runtime/canonical.ts";
import type { LegalSource } from "../contracts.ts";
import type { LegalTopic } from "../taxonomy.ts";
import type { BuildRecord, CitationState, CorpusInventory } from "./inventory.ts";
import { P3_TOPICS } from "./inventory.ts";

export type BlankDecisionTemplate = Readonly<{
  schema_version: "tivdoc-legal-review-decision-v0.7.0";
  status: "blank_unsigned_template";
  topic: LegalTopic;
  workspace_sha256: string;
  source_set_sha256: string;
  artifact_set_sha256: string;
  text_set_sha256: string;
  interval_scope_sha256: string;
  decision: null;
  reviewer_identity: null;
  reviewer_trust_id: null;
  reviewed_at: null;
  signature_algorithm: null;
  signature_key_id: null;
  signature: null;
  legal_findings: readonly [];
}>;

export type TopicWorkspace = Readonly<{
  schema_version: "tivdoc-legal-topic-workspace-v0.7.0";
  topic: LegalTopic;
  status: "PENDING_HUMAN_LEGAL_REVIEW";
  warnings: readonly string[];
  sources: readonly Readonly<{
    source_id: string;
    source_version_id: string;
    source_status: string;
    artifact_sha256: string | null;
    parsed_version_id: string | null;
    normalized_text_sha256: string | null;
    page_count: number;
    chunk_count: number;
    parse_status: string;
    parse_warning: string | null;
    citation_status: string;
    citation_samples: readonly unknown[];
    normalized_evidence_path: string | null;
    chunk_evidence_path: string | null;
  }>[];
  readiness: CorpusInventory["readiness"]["reports"][number];
  candidate_diffs: readonly Readonly<{ candidate_kind: string; count: number; disposition: "pending_human_review" }>[];
  quarantines: readonly Readonly<{ source_version_id: string; reason: string }>[];
  publication_commencement_status: "UNVERIFIED";
  predecessor_successor_status: "UNVERIFIED_PROPOSALS_ONLY";
  scope_status: "EFFECTIVE_PERIOD_SECTOR_POPULATION_REVIEW_REQUIRED";
  questions: readonly string[];
  source_set_sha256: string;
  artifact_set_sha256: string;
  text_set_sha256: string;
  interval_scope_sha256: string;
  workspace_sha256: string;
  blank_decision: BlankDecisionTemplate;
}>;

function withWorkspaceHash(value: Omit<TopicWorkspace, "workspace_sha256" | "blank_decision">): TopicWorkspace {
  const workspaceSha256 = canonicalSha256(value);
  const blankDecision: BlankDecisionTemplate = Object.freeze({
    schema_version: "tivdoc-legal-review-decision-v0.7.0",
    status: "blank_unsigned_template",
    topic: value.topic,
    workspace_sha256: workspaceSha256,
    source_set_sha256: value.source_set_sha256,
    artifact_set_sha256: value.artifact_set_sha256,
    text_set_sha256: value.text_set_sha256,
    interval_scope_sha256: value.interval_scope_sha256,
    decision: null,
    reviewer_identity: null,
    reviewer_trust_id: null,
    reviewed_at: null,
    signature_algorithm: null,
    signature_key_id: null,
    signature: null,
    legal_findings: Object.freeze([]) as readonly [],
  });
  return Object.freeze({ ...value, workspace_sha256: workspaceSha256, blank_decision: blankDecision });
}

export function buildSevenTopicReviewWorkspace(input: Readonly<{
  inventory: CorpusInventory;
  sources: readonly LegalSource[];
  build_records: readonly BuildRecord[];
  citation_state: CitationState;
}>) {
  const buildById = new Map(input.build_records.map((record) => [`${record.source_id}@${record.source_version}`, record]));
  const citationById = new Map(input.citation_state.records.map((record) => [record.source_version_id, record]));
  const topics = P3_TOPICS.map((topic) => {
    const topicSources = input.sources.filter((source) => source.topics.includes(topic)).sort((left, right) => left.source_id.localeCompare(right.source_id));
    const rows = topicSources.map((source) => {
      const id = `${source.source_id}@${source.source_version}`;
      const build = buildById.get(id);
      const citation = citationById.get(id);
      if (!build || !citation) throw new Error(`P3_WORKSPACE_SOURCE_EVIDENCE_MISSING:${id}`);
      return Object.freeze({
        source_id: source.source_id,
        source_version_id: id,
        source_status: source.status,
        artifact_sha256: source.content_sha256,
        parsed_version_id: build.parsed_version_id,
        normalized_text_sha256: build.normalized_text_sha256,
        page_count: build.page_count,
        chunk_count: build.chunk_count,
        parse_status: build.parse_status,
        parse_warning: build.safe_error_code,
        citation_status: citation.status,
        citation_samples: Object.freeze([...(citation.samples ?? [])]),
        normalized_evidence_path: build.normalized_path ?? null,
        chunk_evidence_path: build.chunks_path ?? null,
      });
    });
    const readiness = input.inventory.readiness.reports.find((report) => report.topic === topic);
    if (!readiness) throw new Error(`P3_WORKSPACE_READINESS_MISSING:${topic}`);
    const hashes = {
      source_set_sha256: canonicalSha256(rows.map((row) => row.source_version_id)),
      artifact_set_sha256: canonicalSha256(rows.map((row) => ({ id: row.source_version_id, artifact_sha256: row.artifact_sha256 }))),
      text_set_sha256: canonicalSha256(rows.map((row) => ({ id: row.source_version_id, parsed: row.parsed_version_id, text_sha256: row.normalized_text_sha256 }))),
      interval_scope_sha256: canonicalSha256(topicSources.map((source) => ({ id: `${source.source_id}@${source.source_version}`, effective_period: source.effective_period, sectors: source.sectors, topics: source.topics }))),
    };
    return withWorkspaceHash(Object.freeze({
      schema_version: "tivdoc-legal-topic-workspace-v0.7.0" as const,
      topic,
      status: "PENDING_HUMAN_LEGAL_REVIEW" as const,
      warnings: Object.freeze(["NO_LEGAL_MEANING_PRESELECTED", "PUBLICATION_IS_NOT_COMMENCEMENT", "OCR_CONFIDENCE_IS_NOT_LEGAL_CONFIDENCE", "INACTIVE_UNTIL_CANONICAL_HUMAN_DECISION"]),
      sources: Object.freeze(rows),
      readiness,
      candidate_diffs: Object.freeze(topic === "minimum_wage" ? [{ candidate_kind: "official_rate_byte_change", count: input.inventory.source_specific_gaps.minimum_wage_byte_candidates, disposition: "pending_human_review" as const }] : []),
      quarantines: Object.freeze(rows.filter((row) => row.parse_warning !== null || row.citation_status !== "round_trip_passed").map((row) => ({ source_version_id: row.source_version_id, reason: row.parse_warning ?? row.citation_status }))),
      publication_commencement_status: "UNVERIFIED" as const,
      predecessor_successor_status: "UNVERIFIED_PROPOSALS_ONLY" as const,
      scope_status: "EFFECTIVE_PERIOD_SECTOR_POPULATION_REVIEW_REQUIRED" as const,
      questions: Object.freeze(["VERIFY_SOURCE_IDENTITY", "VERIFY_PUBLICATION_AND_COMMENCEMENT", "VERIFY_PREDECESSOR_SUCCESSOR_RELATIONS", "VERIFY_EFFECTIVE_INTERVAL", "VERIFY_SECTOR", "VERIFY_POPULATION", "VERIFY_EXACT_CITATIONS", "RECORD_CONFLICTS_AND_QUARANTINES"]),
      ...hashes,
    }));
  });
  if (topics.length !== 7 || new Set(topics.map((topic) => topic.topic)).size !== 7) throw new Error("P3_SEVEN_TOPIC_WORKSPACE_REQUIRED");
  const indexCore = Object.freeze({
    schema_version: "tivdoc-legal-review-workspace-index-v0.7.0" as const,
    status: "PENDING_HUMAN_LEGAL_REVIEW" as const,
    inventory_sha256: input.inventory.inventory_sha256,
    topic_workspaces: Object.freeze(topics.map((topic) => ({ topic: topic.topic, workspace_sha256: topic.workspace_sha256, decision_status: topic.blank_decision.status }))),
    owner_actions: Object.freeze(topics.map((topic) => ({ topic: topic.topic, action_codes: topic.questions, blockers: topic.readiness.canonical_decision.reason_codes }))),
    generated_signatures: 0,
    selected_corpus_mutated: false,
  });
  return Object.freeze({ topics: Object.freeze(topics), index: Object.freeze({ ...indexCore, workspace_index_sha256: canonicalSha256(indexCore) }) });
}

export interface SignatureVerificationPort {
  verify(input: Readonly<{ trust_id: string; key_id: string; algorithm: string; payload: Uint8Array; signature: string }>): Promise<boolean>;
}

export type SignedReviewDecision = Readonly<{
  schema_version: "tivdoc-legal-review-decision-v0.7.0";
  status: "signed_human_decision";
  topic: LegalTopic;
  workspace_sha256: string;
  source_set_sha256: string;
  artifact_set_sha256: string;
  text_set_sha256: string;
  interval_scope_sha256: string;
  decision: "accept" | "needs_changes" | "reject";
  reviewer_identity: string;
  importer_identity: string;
  reviewer_trust_id: string;
  reviewed_at: string;
  signature_algorithm: string;
  signature_key_id: string;
  signature: string;
  legal_findings: readonly Readonly<{ finding_id: string; reviewer_text: string }>[];
}>;

export async function importSignedReviewDecision(
  workspace: TopicWorkspace,
  decision: SignedReviewDecision,
  trust: SignatureVerificationPort | null,
): Promise<Readonly<{ accepted_for_review_record: boolean; activation_changed: false; usable_for_rules: false; blocker_code: string | null; decision_sha256: string }>> {
  if (decision.schema_version !== "tivdoc-legal-review-decision-v0.7.0" || decision.status !== "signed_human_decision" || decision.topic !== workspace.topic || decision.workspace_sha256 !== workspace.workspace_sha256 || decision.source_set_sha256 !== workspace.source_set_sha256 || decision.artifact_set_sha256 !== workspace.artifact_set_sha256 || decision.text_set_sha256 !== workspace.text_set_sha256 || decision.interval_scope_sha256 !== workspace.interval_scope_sha256) {
    throw new Error("P3_DECISION_BINDING_MISMATCH");
  }
  if (!/^[a-z][a-z0-9_-]{7,63}$/.test(decision.reviewer_identity) || !/^[a-z][a-z0-9_-]{7,63}$/.test(decision.importer_identity) || decision.reviewer_identity === decision.importer_identity || !/^[a-z][a-z0-9_-]{7,127}$/.test(decision.reviewer_trust_id) || !/^[a-z][a-z0-9_.:-]{3,127}$/.test(decision.signature_key_id) || !/^[a-z0-9_-]{3,32}$/.test(decision.signature_algorithm) || Number.isNaN(Date.parse(decision.reviewed_at)) || decision.signature.length < 16) {
    throw new Error("P3_DECISION_IDENTITY_OR_SIGNATURE_INVALID");
  }
  if (!trust) return Object.freeze({ accepted_for_review_record: false, activation_changed: false, usable_for_rules: false, blocker_code: "REVIEWER_IDENTITY_AND_SIGNATURE_VERIFICATION_MISSING", decision_sha256: canonicalSha256(decision) });
  const payload = new TextEncoder().encode(canonicalStringify({ ...decision, signature: "" }));
  const verified = await trust.verify({ trust_id: decision.reviewer_trust_id, key_id: decision.signature_key_id, algorithm: decision.signature_algorithm, payload, signature: decision.signature });
  return Object.freeze({ accepted_for_review_record: verified, activation_changed: false, usable_for_rules: false, blocker_code: verified ? null : "SIGNATURE_VERIFICATION_FAILED", decision_sha256: canonicalSha256(decision) });
}
