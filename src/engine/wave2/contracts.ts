import { z } from "zod";
import { calculationValueSchema } from "../calculations/contracts.ts";
import {
  confidenceSchema,
  domainCodeSchema,
  isoDateSchema,
  isoTimestampSchema,
  versionSchema,
} from "../domain/primitives.ts";
import {
  documentBoundingBoxSchema,
  evidenceReferenceSchema,
} from "../facts/contracts.ts";
import { factPathSchema } from "../facts/fact-paths.ts";
import { sha256Schema } from "../legal-knowledge/contracts.ts";
import {
  legalEvidenceRefSchema,
  ruleInputSnapshotSchema,
} from "../wave1/contracts.ts";

const stableIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/);

export const dossierCitationSchema = z.object({
  citation_id: stableIdSchema,
  source_id: stableIdSchema,
  source_version_id: z.string().min(3).max(240),
  artifact_sha256: sha256Schema,
  parsed_version_id: stableIdSchema,
  parsed_sha256: sha256Schema,
  parser_sha256: sha256Schema,
  page_from: z.number().int().positive(),
  page_to: z.number().int().positive(),
  section_identifier: z.string().trim().min(1).max(500),
}).strict().refine((value) => value.page_to >= value.page_from, {
  message: "citation_page_interval_inverted",
  path: ["page_to"],
}).readonly();

export const reviewDossierSchema = z.object({
  dossier_id: stableIdSchema,
  dossier_version: versionSchema,
  topic: domainCodeSchema,
  status: z.literal("pending_human_review"),
  source_set_sha256: sha256Schema,
  evidence: z.array(legalEvidenceRefSchema).min(1).readonly(),
  citations: z.array(dossierCitationSchema).min(1).readonly(),
  candidate_effective_intervals: z.array(z.object({
    claim_id: stableIdSchema,
    from: isoDateSchema.nullable(),
    to: isoDateSchema.nullable(),
    verification_state: z.literal("unverified"),
  }).strict()).readonly(),
  technical_diffs: z.array(z.object({
    candidate_artifact_sha256: sha256Schema,
    classification: z.enum([
      "normalized_text_identical",
      "text_changed",
      "structure_changed",
      "parse_unavailable",
    ]),
    status: z.literal("pending_human_review"),
  }).strict()).readonly(),
  unresolved_contradictions: z.array(z.string().trim().min(1)).readonly(),
  missing_gates: z.array(z.string().trim().min(1)).min(1).readonly(),
  usable_for_rules: z.literal(false),
  generated_at: isoTimestampSchema,
}).strict().readonly();

export const independentVerificationRefSchema = z.object({
  verification_id: stableIdSchema,
  reviewer_id: stableIdSchema,
  reviewer_role: domainCodeSchema,
  verified_at: isoTimestampSchema,
  source_id: stableIdSchema,
  source_version_id: z.string().min(3).max(240),
  artifact_sha256: sha256Schema,
  parsed_version_id: stableIdSchema,
  parsed_sha256: sha256Schema,
  parser_sha256: sha256Schema,
  citation_id: stableIdSchema,
  value_representation: calculationValueSchema,
  unit: domainCodeSchema,
  effective_from: isoDateSchema,
  effective_to: isoDateSchema.nullable(),
  sector: domainCodeSchema,
  population: domainCodeSchema,
  dossier_sha256: sha256Schema,
  source_set_sha256: sha256Schema,
}).strict().refine((value) => value.effective_to === null || value.effective_to >= value.effective_from, {
  message: "verification_effective_interval_inverted",
  path: ["effective_to"],
}).readonly();

export const numericParameterDraftSchema = z.object({
  parameter_id: stableIdSchema,
  parameter_version: versionSchema,
  parameter_key: domainCodeSchema,
  state: z.enum(["draft", "independently_verified_twice", "activation_eligible"]),
  value_representation: calculationValueSchema,
  unit: domainCodeSchema,
  effective_from: isoDateSchema,
  effective_to: isoDateSchema.nullable(),
  sector: domainCodeSchema,
  population: domainCodeSchema,
  dossier_sha256: sha256Schema,
  source_set_sha256: sha256Schema,
  verifications: z.array(independentVerificationRefSchema).max(2).readonly(),
  activation_state: z.literal("inactive"),
}).strict().superRefine((value, context) => {
  if (value.effective_to !== null && value.effective_to < value.effective_from) {
    context.addIssue({ code: "custom", message: "parameter_effective_interval_inverted", path: ["effective_to"] });
  }
  const reviewers = new Set(value.verifications.map((entry) => entry.reviewer_id));
  if (reviewers.size !== value.verifications.length) {
    context.addIssue({ code: "custom", message: "independent_verification_requires_distinct_reviewers", path: ["verifications"] });
  }
  if (value.state !== "draft" && value.verifications.length !== 2) {
    context.addIssue({ code: "custom", message: "verified_parameter_state_requires_two_attestations", path: ["verifications"] });
  }
}).readonly();

export const ruleInputValueRefSchema = z.object({
  input_id: domainCodeSchema,
  fact_path: factPathSchema,
  source_fact_id: stableIdSchema,
  value: calculationValueSchema,
  provenance: z.array(evidenceReferenceSchema).min(1).readonly(),
  confidence: confidenceSchema,
  confirmation_state: z.enum(["confirmed", "unconfirmed", "conflicted", "missing", "rejected"]),
  stale: z.boolean(),
  snapshot: ruleInputSnapshotSchema,
  transformation: z.object({
    transformation_id: domainCodeSchema,
    transformation_version: versionSchema,
  }).strict().nullable(),
}).strict().readonly();

export const ruleInputPreparationResultSchema = z.object({
  preparation_id: stableIdSchema,
  preparation_version: versionSchema,
  mapping_registry_id: domainCodeSchema,
  mapping_registry_version: versionSchema,
  mapping_registry_sha256: sha256Schema,
  input_snapshot: ruleInputSnapshotSchema,
  status: z.enum(["ready", "rejected"]),
  values: z.array(ruleInputValueRefSchema).readonly(),
  rejection_codes: z.array(domainCodeSchema).readonly(),
  prepared_at: isoTimestampSchema,
}).strict().superRefine((value, context) => {
  if (value.status === "ready" && (value.values.length === 0 || value.rejection_codes.length > 0)) {
    context.addIssue({ code: "custom", message: "ready_preparation_requires_values_without_rejections" });
  }
  if (value.status === "rejected" && (value.values.length > 0 || value.rejection_codes.length === 0)) {
    context.addIssue({ code: "custom", message: "rejected_preparation_must_not_publish_partial_values" });
  }
}).readonly();

export const groundTruthFieldAnnotationSchema = z.object({
  annotation_id: stableIdSchema,
  field_identity: domainCodeSchema,
  document_sha256: sha256Schema,
  page: z.number().int().positive(),
  section: z.string().trim().min(1).max(500),
  bounding_box: documentBoundingBoxSchema.nullable(),
  value: calculationValueSchema,
  annotation_pass: z.enum(["annotation_1", "annotation_2", "human_adjudication"]),
  author_id: stableIdSchema,
  annotated_at: isoTimestampSchema,
  resolves_annotation_ids: z.array(stableIdSchema).readonly(),
}).strict().readonly();

export const groundTruthManifestSchema = z.object({
  manifest_id: stableIdSchema,
  schema_version: versionSchema,
  revision: z.number().int().positive(),
  document_sha256: sha256Schema,
  status: z.enum([
    "annotation_1",
    "annotation_2",
    "disagreement",
    "human_adjudication",
    "locked_ground_truth",
  ]),
  sections: z.array(z.object({
    section_id: domainCodeSchema,
    page_from: z.number().int().positive(),
    page_to: z.number().int().positive(),
  }).strict().refine((value) => value.page_to >= value.page_from, "ground_truth_section_page_interval_inverted")).min(1).readonly(),
  annotations: z.array(groundTruthFieldAnnotationSchema).min(1).readonly(),
  annotator_1_id: stableIdSchema,
  annotator_2_id: stableIdSchema.nullable(),
  adjudicator_id: stableIdSchema.nullable(),
  locked_sha256: sha256Schema.nullable(),
  supersedes_manifest_id: stableIdSchema.nullable(),
  revision_reason: z.string().trim().min(1).max(2_000).nullable(),
  created_at: isoTimestampSchema,
}).strict().superRefine((value, context) => {
  if (value.annotator_2_id !== null && value.annotator_2_id === value.annotator_1_id) {
    context.addIssue({ code: "custom", message: "ground_truth_requires_distinct_annotators", path: ["annotator_2_id"] });
  }
  if (value.status !== "annotation_1" && value.annotator_2_id === null) {
    context.addIssue({ code: "custom", message: "second_annotation_required", path: ["annotator_2_id"] });
  }
  if (["human_adjudication", "locked_ground_truth"].includes(value.status) && value.adjudicator_id === null) {
    context.addIssue({ code: "custom", message: "human_adjudicator_required", path: ["adjudicator_id"] });
  }
  if (value.status === "locked_ground_truth" && value.locked_sha256 === null) {
    context.addIssue({ code: "custom", message: "locked_ground_truth_hash_required", path: ["locked_sha256"] });
  }
  if (value.revision > 1 && (value.supersedes_manifest_id === null || value.revision_reason === null)) {
    context.addIssue({ code: "custom", message: "ground_truth_revision_requires_prior_version_and_reason" });
  }
  if (value.annotations.some((annotation) => annotation.document_sha256 !== value.document_sha256)) {
    context.addIssue({ code: "custom", message: "ground_truth_annotation_document_hash_mismatch", path: ["annotations"] });
  }
  const identities = new Set<string>();
  for (const annotation of value.annotations) {
    const identity = `${annotation.annotation_pass}:${annotation.field_identity}`;
    if (identities.has(identity)) context.addIssue({ code: "custom", message: "duplicate_ground_truth_field_identity", path: ["annotations"] });
    identities.add(identity);
  }
}).readonly();

export type ReviewDossier = z.infer<typeof reviewDossierSchema>;
export type NumericParameterDraft = z.infer<typeof numericParameterDraftSchema>;
export type IndependentVerificationRef = z.infer<typeof independentVerificationRefSchema>;
export type RuleInputSnapshot = z.infer<typeof ruleInputSnapshotSchema>;
export type RuleInputValueRef = z.infer<typeof ruleInputValueRefSchema>;
export type RuleInputPreparationResult = z.infer<typeof ruleInputPreparationResultSchema>;
export type GroundTruthManifest = z.infer<typeof groundTruthManifestSchema>;
export type GroundTruthFieldAnnotation = z.infer<typeof groundTruthFieldAnnotationSchema>;
