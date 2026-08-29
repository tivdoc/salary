import minimumWageEvidenceJson from "./minimum-wage-evidence.v0.4.json";
import { canonicalSha256 } from "../../rule-runtime/canonical.ts";
import {
  reviewDossierSchema,
  type ReviewDossier,
} from "../../wave2/contracts.ts";
import {
  minimumWageSourceEvidenceSchema,
  type MinimumWageSourceEvidence,
} from "./contracts.ts";

export type TechnicalSemanticClassification = ReviewDossier["technical_diffs"][number]["classification"];

function stableContractId(value: string) {
  return value.replace(/[@#]/gu, ":");
}

export function classifyTechnicalSemanticDiff(
  baseline: MinimumWageSourceEvidence["byte_change_baseline"],
  candidate: MinimumWageSourceEvidence["byte_change_candidates"][number],
): TechnicalSemanticClassification {
  if (!candidate.parse_available || candidate.normalized_text_sha256 === null) return "parse_unavailable";
  if (candidate.normalized_text_sha256 === baseline.normalized_text_sha256) return "normalized_text_identical";
  if (candidate.structure_sha256 !== null && candidate.structure_sha256 !== baseline.structure_sha256) {
    return "structure_changed";
  }
  return "text_changed";
}

export function loadMinimumWageSourceEvidence(): MinimumWageSourceEvidence {
  return minimumWageSourceEvidenceSchema.parse(minimumWageEvidenceJson);
}

export function minimumWageSourceSetSha256(evidence: MinimumWageSourceEvidence) {
  return canonicalSha256(evidence.sources.map((source) => ({
    source_id: source.source_id,
    source_version_id: source.source_version_id,
    source_role: source.source_role,
    artifact_role: source.artifact_role,
    legal_force: source.legal_force,
    artifact_sha256: source.artifact_sha256,
    parsed_version_id: source.parsed_version_id,
    parsed_sha256: source.parsed_sha256,
    parser_sha256: canonicalSha256(source.parser_identity),
    citations: source.citations,
    intervals: source.candidate_intervals,
    review_state: source.review_state,
    activation_state: source.activation_state,
  })));
}

export function buildMinimumWageReviewDossier(
  evidence = loadMinimumWageSourceEvidence(),
): ReviewDossier {
  const sourceSetSha256 = minimumWageSourceSetSha256(evidence);
  return reviewDossierSchema.parse({
    dossier_id: `dossier:minimum_wage:${sourceSetSha256.slice(0, 24)}`,
    dossier_version: "4",
    topic: evidence.topic,
    status: "pending_human_review",
    source_set_sha256: sourceSetSha256,
    evidence: evidence.sources.map((source) => ({
      source_id: source.source_id,
      source_version_id: source.source_version_id,
      artifact_sha256: source.artifact_sha256,
      parsed_version_id: source.parsed_version_id,
      citation_id: source.citations[0].citation_id,
      review_state: source.review_state,
      activation_state: source.activation_state,
    })),
    citations: evidence.sources.flatMap((source) => source.citations.map((citation) => ({
      citation_id: citation.citation_id,
      source_id: source.source_id,
      source_version_id: source.source_version_id,
      artifact_sha256: source.artifact_sha256,
      parsed_version_id: stableContractId(source.parsed_version_id),
      parsed_sha256: source.parsed_sha256,
      parser_sha256: canonicalSha256(source.parser_identity),
      page_from: citation.page_from,
      page_to: citation.page_to,
      section_identifier: `${citation.section_identifier};chunk=${citation.chunk_id}`,
    }))),
    candidate_effective_intervals: evidence.sources.flatMap((source) => source.candidate_intervals),
    technical_diffs: evidence.byte_change_candidates.map((candidate) => ({
      candidate_artifact_sha256: candidate.artifact_sha256,
      classification: classifyTechnicalSemanticDiff(evidence.byte_change_baseline, candidate),
      status: "pending_human_review" as const,
    })),
    unresolved_contradictions: evidence.unresolved_contradictions,
    missing_gates: evidence.missing_gates,
    usable_for_rules: false,
    generated_at: evidence.as_of,
  });
}

export function minimumWageDossierSha256(dossier: ReviewDossier) {
  return canonicalSha256(dossier);
}
