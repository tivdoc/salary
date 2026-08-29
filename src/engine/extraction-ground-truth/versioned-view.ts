import type { GroundTruthManifest } from "../wave2/contracts.ts";
import { deepFreeze } from "../rule-runtime/canonical.ts";
import { validateGroundTruthManifest } from "./validation.ts";

/**
 * A deterministic read model. The frozen manifest remains the sole source of
 * truth; its schema version and revision are inherited by every section and
 * field rather than duplicated as independently mutable contracts.
 */
export function projectVersionedGroundTruth(input: GroundTruthManifest) {
  const manifest = validateGroundTruthManifest(input);
  const sections = [...manifest.sections]
    .sort((left, right) => left.section_id.localeCompare(right.section_id))
    .map((section) => ({
      section_id: section.section_id,
      schema_version: manifest.schema_version,
      manifest_revision: manifest.revision,
      page_from: section.page_from,
      page_to: section.page_to,
      fields: manifest.annotations
        .filter((annotation) => annotation.section === section.section_id)
        .sort((left, right) => left.field_identity.localeCompare(right.field_identity) || left.annotation_id.localeCompare(right.annotation_id))
        .map((annotation) => ({
          annotation_id: annotation.annotation_id,
          field_identity: annotation.field_identity,
          schema_version: manifest.schema_version,
          manifest_revision: manifest.revision,
          annotation_pass: annotation.annotation_pass,
          document_sha256: annotation.document_sha256,
          page: annotation.page,
          section: annotation.section,
          bounding_box: annotation.bounding_box,
          value: annotation.value,
          author_id: annotation.author_id,
          annotated_at: annotation.annotated_at,
          resolves_annotation_ids: annotation.resolves_annotation_ids,
        })),
    }));
  return deepFreeze({
    document: {
      manifest_id: manifest.manifest_id,
      schema_version: manifest.schema_version,
      revision: manifest.revision,
      document_sha256: manifest.document_sha256,
      status: manifest.status,
      locked_sha256: manifest.locked_sha256,
    },
    sections,
  });
}
