import { describe, expect, it } from "vitest";
import {
  groundTruthManifestSchema,
  numericParameterDraftSchema,
  ruleInputPreparationResultSchema,
} from "./contracts.ts";

const hash = "a".repeat(64);
const snapshot = { snapshot_id: "SYNTHETIC_SNAPSHOT_001", snapshot_version: "1", snapshot_sha256: hash };

describe("Wave 2 frozen contracts", () => {
  it("rejects a non-draft parameter without two distinct verifications", () => {
    expect(numericParameterDraftSchema.safeParse({
      parameter_id: "SYNTHETIC_PARAMETER_001",
      parameter_version: "1",
      parameter_key: "synthetic.neutral_value",
      state: "independently_verified_twice",
      value_representation: { kind: "integer", value: 7 },
      unit: "synthetic.unit",
      effective_from: "2040-01-01",
      effective_to: null,
      sector: "synthetic.sector",
      population: "synthetic.population",
      dossier_sha256: hash,
      source_set_sha256: hash,
      verifications: [],
      activation_state: "inactive",
    }).success).toBe(false);
  });

  it("does not expose partial values on rejected input preparation", () => {
    expect(ruleInputPreparationResultSchema.safeParse({
      preparation_id: "SYNTHETIC_PREPARATION_001",
      preparation_version: "1",
      mapping_registry_id: "synthetic.mapping",
      mapping_registry_version: "1",
      mapping_registry_sha256: hash,
      input_snapshot: snapshot,
      status: "rejected",
      values: [{ unexpected: true }],
      rejection_codes: ["fact.missing"],
      prepared_at: "2040-01-01T00:00:00Z",
    }).success).toBe(false);
  });

  it("requires separate annotators and a human adjudicator before locking", () => {
    const annotation = {
      annotation_id: "SYNTHETIC_ANNOTATION_001",
      field_identity: "synthetic.field",
      document_sha256: hash,
      page: 1,
      section: "Synthetic section",
      bounding_box: null,
      value: { kind: "text", value: "neutral" },
      annotation_pass: "annotation_1",
      author_id: "ANNOTATOR_001",
      annotated_at: "2040-01-01T00:00:00Z",
      resolves_annotation_ids: [],
    };
    expect(groundTruthManifestSchema.safeParse({
      manifest_id: "SYNTHETIC_MANIFEST_001",
      schema_version: "1",
      revision: 1,
      document_sha256: hash,
      status: "locked_ground_truth",
      sections: [{ section_id: "synthetic.section", page_from: 1, page_to: 1 }],
      annotations: [annotation],
      annotator_1_id: "ANNOTATOR_001",
      annotator_2_id: "ANNOTATOR_001",
      adjudicator_id: null,
      locked_sha256: null,
      supersedes_manifest_id: null,
      revision_reason: null,
      created_at: "2040-01-01T00:00:00Z",
    }).success).toBe(false);
  });
});
