import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalSha256, canonicalStringify } from "../../rule-runtime/canonical.ts";
import {
  buildMinimumWageReviewDossier,
  loadMinimumWageSourceEvidence,
  minimumWageDossierSha256,
} from "./dossier.ts";

function evidenceDocument(value: unknown) {
  return `${canonicalStringify(value)}\n`;
}

export async function writeMinimumWageDossierEvidence(outputRoot: string) {
  const evidence = loadMinimumWageSourceEvidence();
  const dossier = buildMinimumWageReviewDossier(evidence);
  const dossierSha256 = minimumWageDossierSha256(dossier);
  const documents = [
    {
      name: "minimum-wage-review-dossier.json",
      value: {
        schema_version: "tivdoc-minimum-wage-review-dossier-evidence-v0.4",
        dossier_sha256: dossierSha256,
        source_observation_dates: evidence.sources.map((source) => ({
          source_id: source.source_id,
          artifact_sha256: source.artifact_sha256,
          observed_at: source.observed_at,
          source_role: source.source_role,
          artifact_role: source.artifact_role,
        })),
        dossier,
      },
    },
    {
      name: "technical-semantic-diffs.json",
      value: {
        schema_version: "tivdoc-technical-semantic-diffs-v0.4",
        baseline: evidence.byte_change_baseline,
        candidates: evidence.byte_change_candidates.map((candidate) => ({
          ...candidate,
          classification: dossier.technical_diffs.find(
            (diff) => diff.candidate_artifact_sha256 === candidate.artifact_sha256,
          )?.classification,
          status: "pending_human_review",
          legal_approval: false,
        })),
      },
    },
    {
      name: "numeric-parameter-governance.json",
      value: {
        schema_version: "tivdoc-numeric-parameter-governance-evidence-v0.4",
        state_machine: ["draft", "independently_verified_twice", "activation_eligible"],
        required_distinct_human_reviewers: 2,
        invalidation_dimensions: [
          "source_byte_changed",
          "parsed_content_changed",
          "parser_changed",
          "citation_changed",
          "value_changed",
          "unit_changed",
          "effective_interval_changed",
          "scope_changed",
          "population_changed",
          "dossier_changed",
          "source_set_changed",
        ],
        real_numeric_candidates: 0,
        real_parameter_attestations: 0,
        active_parameters: 0,
        activation_eligible_real_parameters: 0,
        btl_rates_independent_monetary_authority: false,
        human_legal_review_required: true,
      },
    },
  ] as const;

  await mkdir(outputRoot, { recursive: true });
  const entries = [];
  for (const document of documents) {
    const contents = evidenceDocument(document.value);
    await writeFile(path.join(outputRoot, document.name), contents, { encoding: "utf8", mode: 0o600 });
    entries.push({
      name: document.name,
      byte_count: Buffer.byteLength(contents),
      sha256: createHash("sha256").update(contents, "utf8").digest("hex"),
    });
  }
  const manifest = {
    schema_version: "tivdoc-minimum-wage-dossier-evidence-manifest-v0.4",
    dossier_sha256: dossierSha256,
    files: entries,
    invariant_counts: {
      real_numeric_candidates: 0,
      real_parameter_attestations: 0,
      active_parameters: 0,
    },
  };
  await writeFile(path.join(outputRoot, "evidence-manifest.json"), evidenceDocument(manifest), {
    encoding: "utf8",
    mode: 0o600,
  });
  return { ...manifest, manifest_content_sha256: canonicalSha256(manifest) };
}
