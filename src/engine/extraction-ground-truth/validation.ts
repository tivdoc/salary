import { ZodError } from "zod";
import {
  groundTruthManifestSchema,
  type GroundTruthFieldAnnotation,
  type GroundTruthManifest,
} from "../wave2/contracts.ts";
import { canonicalSha256, canonicalStringify, deepFreeze } from "../rule-runtime/canonical.ts";
import { GroundTruthError, requireGroundTruth } from "./errors.ts";

const PASS_ORDER = {
  annotation_1: 1,
  annotation_2: 2,
  human_adjudication: 3,
} as const;

function normalizedAnnotations(annotations: readonly GroundTruthFieldAnnotation[]) {
  return [...annotations].sort((left, right) => {
    const pass = PASS_ORDER[left.annotation_pass] - PASS_ORDER[right.annotation_pass];
    if (pass !== 0) return pass;
    return left.field_identity.localeCompare(right.field_identity) || left.annotation_id.localeCompare(right.annotation_id);
  });
}

function normalizedSections(manifest: GroundTruthManifest) {
  return [...manifest.sections].sort((left, right) => left.section_id.localeCompare(right.section_id));
}

export function lockedGroundTruthPayload(manifest: GroundTruthManifest) {
  return {
    manifest_id: manifest.manifest_id,
    schema_version: manifest.schema_version,
    revision: manifest.revision,
    document_sha256: manifest.document_sha256,
    sections: normalizedSections(manifest),
    annotations: normalizedAnnotations(manifest.annotations),
    annotator_1_id: manifest.annotator_1_id,
    annotator_2_id: manifest.annotator_2_id,
    adjudicator_id: manifest.adjudicator_id,
    supersedes_manifest_id: manifest.supersedes_manifest_id,
    revision_reason: manifest.revision_reason,
    created_at: manifest.created_at,
  } as const;
}

export function calculateLockedGroundTruthSha256(manifest: GroundTruthManifest): string {
  return canonicalSha256(lockedGroundTruthPayload(manifest));
}

function valuesEqual(left: GroundTruthFieldAnnotation, right: GroundTruthFieldAnnotation) {
  return canonicalStringify(left.value) === canonicalStringify(right.value);
}

function annotationsByPass(manifest: GroundTruthManifest, pass: GroundTruthFieldAnnotation["annotation_pass"]) {
  return new Map(
    manifest.annotations
      .filter((annotation) => annotation.annotation_pass === pass)
      .map((annotation) => [annotation.field_identity, annotation]),
  );
}

function timestampMillis(value: string) {
  const result = Date.parse(value);
  requireGroundTruth(Number.isFinite(result), "ground_truth_invalid_timestamp");
  return result;
}

function validateGeometry(annotation: GroundTruthFieldAnnotation) {
  const box = annotation.bounding_box;
  if (box === null) return;
  requireGroundTruth(
    [box.x, box.y, box.width, box.height].every(Number.isFinite),
    "ground_truth_invalid_geometry",
  );
  if (box.coordinate_space === "normalized") {
    requireGroundTruth(
      box.x <= 1 && box.y <= 1 && box.width <= 1 && box.height <= 1 && box.x + box.width <= 1 && box.y + box.height <= 1,
      "ground_truth_invalid_geometry",
    );
  }
}

function parseFrozenContract(input: unknown): GroundTruthManifest {
  try {
    return groundTruthManifestSchema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      const first = error.issues[0];
      throw new GroundTruthError(first?.message ?? "ground_truth_contract_invalid");
    }
    throw error;
  }
}

export function validateGroundTruthManifest(input: unknown): GroundTruthManifest {
  const manifest = parseFrozenContract(input);
  requireGroundTruth(manifest.annotations.length > 0, "ground_truth_empty_template");

  const sectionById = new Map<string, (typeof manifest.sections)[number]>();
  for (const section of manifest.sections) {
    requireGroundTruth(!sectionById.has(section.section_id), "ground_truth_duplicate_section_identity");
    sectionById.set(section.section_id, section);
  }

  const annotationIds = new Set<string>();
  for (const annotation of manifest.annotations) {
    requireGroundTruth(!annotationIds.has(annotation.annotation_id), "ground_truth_duplicate_annotation_id");
    annotationIds.add(annotation.annotation_id);
    requireGroundTruth(annotation.document_sha256 === manifest.document_sha256, "ground_truth_annotation_document_hash_mismatch");
    requireGroundTruth(
      timestampMillis(annotation.annotated_at) >= timestampMillis(manifest.created_at),
      "ground_truth_annotation_timestamp_precedes_manifest",
    );
    const section = sectionById.get(annotation.section);
    requireGroundTruth(section !== undefined, "ground_truth_annotation_section_missing");
    requireGroundTruth(annotation.page >= section.page_from && annotation.page <= section.page_to, "ground_truth_annotation_page_outside_section");
    validateGeometry(annotation);
    if (annotation.annotation_pass === "annotation_1") {
      requireGroundTruth(annotation.author_id === manifest.annotator_1_id, "ground_truth_annotation_1_author_mismatch");
      requireGroundTruth(annotation.resolves_annotation_ids.length === 0, "ground_truth_non_adjudication_cannot_resolve");
    } else if (annotation.annotation_pass === "annotation_2") {
      requireGroundTruth(annotation.author_id === manifest.annotator_2_id, "ground_truth_annotation_2_author_mismatch");
      requireGroundTruth(annotation.resolves_annotation_ids.length === 0, "ground_truth_non_adjudication_cannot_resolve");
    } else {
      requireGroundTruth(annotation.author_id === manifest.adjudicator_id, "ground_truth_adjudicator_author_mismatch");
    }
  }

  const first = annotationsByPass(manifest, "annotation_1");
  const second = annotationsByPass(manifest, "annotation_2");
  const adjudicated = annotationsByPass(manifest, "human_adjudication");
  requireGroundTruth(first.size > 0, "ground_truth_annotation_1_required");

  if (manifest.status === "annotation_1") {
    requireGroundTruth(second.size === 0 && adjudicated.size === 0, "ground_truth_annotation_1_state_contains_later_pass");
    requireGroundTruth(manifest.annotator_2_id === null && manifest.adjudicator_id === null, "ground_truth_annotation_1_state_has_later_actor");
  } else {
    requireGroundTruth(second.size === first.size, "ground_truth_annotation_2_must_cover_all_fields");
    requireGroundTruth([...first.keys()].every((identity) => second.has(identity)), "ground_truth_annotation_2_field_set_mismatch");
  }

  if (["annotation_1", "annotation_2", "disagreement"].includes(manifest.status)) {
    requireGroundTruth(adjudicated.size === 0, "ground_truth_adjudication_before_human_state");
  } else {
    requireGroundTruth(adjudicated.size === first.size, "ground_truth_adjudication_must_cover_all_fields");
    for (const [identity, annotation] of adjudicated) {
      const firstAnnotation = first.get(identity);
      const secondAnnotation = second.get(identity);
      requireGroundTruth(firstAnnotation !== undefined && secondAnnotation !== undefined, "ground_truth_adjudication_field_set_mismatch");
      const resolved = [...annotation.resolves_annotation_ids].sort();
      const expected = [firstAnnotation.annotation_id, secondAnnotation.annotation_id].sort();
      requireGroundTruth(canonicalStringify(resolved) === canonicalStringify(expected), "ground_truth_adjudication_evidence_mismatch");
      requireGroundTruth(timestampMillis(annotation.annotated_at) >= timestampMillis(firstAnnotation.annotated_at), "ground_truth_adjudication_timestamp_precedes_annotation");
      requireGroundTruth(timestampMillis(annotation.annotated_at) >= timestampMillis(secondAnnotation.annotated_at), "ground_truth_adjudication_timestamp_precedes_annotation");
    }
  }

  if (manifest.status === "disagreement") {
    requireGroundTruth(
      [...first.keys()].some((identity) => {
        const right = second.get(identity);
        return right !== undefined && !valuesEqual(first.get(identity)!, right);
      }),
      "ground_truth_disagreement_state_requires_value_difference",
    );
  }

  if (manifest.status === "locked_ground_truth") {
    requireGroundTruth(
      manifest.locked_sha256 === calculateLockedGroundTruthSha256(manifest),
      "ground_truth_locked_hash_mismatch",
    );
  } else {
    requireGroundTruth(manifest.locked_sha256 === null, "ground_truth_unlocked_state_has_locked_hash");
  }

  return deepFreeze(manifest) as GroundTruthManifest;
}

export function manifestHasDisagreement(manifest: GroundTruthManifest): boolean {
  const first = annotationsByPass(manifest, "annotation_1");
  const second = annotationsByPass(manifest, "annotation_2");
  return [...first.keys()].some((identity) => {
    const right = second.get(identity);
    return right !== undefined && !valuesEqual(first.get(identity)!, right);
  });
}
