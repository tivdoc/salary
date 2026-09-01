import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";

import { frozen, legalOperationsSha256 } from "../../../../../engine/legal-operations/canonical.ts";
import {
  GOVERNANCE_SCHEMA_VERSION,
  governanceIdSchema,
  governanceSha256Schema,
  governanceTimestampSchema,
  legalObservationCandidateSchema,
  type GovernanceMutationReceipt,
  type LegalObservationCandidate,
} from "./contracts.ts";
import {
  PostgresGovernanceWorkRepository,
  PostgresLegalReconciliationRepository,
} from "./repositories.ts";

export const HISTORICAL_OBSERVATION_CROSSWALK_SCHEMA =
  "tivdoc-wave1-artifact-reconciliation-v0.4" as const;
export const HISTORICAL_OBSERVATION_CROSSWALK_FILE_SHA256 =
  "7a3ccb07e58cce2901b959fdbeb3afb85cf57506eb99089796a3668aa6caeb90" as const;
export const HISTORICAL_OBSERVATION_CROSSWALK_CONTENT_SHA256 =
  "5a929dad2802a7b71b97c2b83cd7a04022393055b68eec6abab3f0da8fa0bb59" as const;

const historicalAcquisitionSchema = z.object({
  acquisition_observation_id: z.string().regex(/^ACQOBS:WAVE1:[a-f0-9]{32}$/u),
  activation_state: z.literal("inactive"),
  artifact_id: governanceIdSchema,
  artifact_sha256: governanceSha256Schema,
  byte_count: z.number().int().positive(),
  collection: z.enum(["hours_publications", "work_permits"]),
  corpus_registration: z.object({
    reason: z.string().min(1),
    source_version_id: governanceIdSchema.nullable(),
    status: z.enum(["not_registered", "registered_selected_raw_artifact"]),
  }).strict(),
  declared_media_type: z.literal("application/pdf"),
  final_url: z.url().max(2_048),
  immutable_evidence_location: z.string().min(1),
  media_validation: z.object({
    declared_pdf: z.literal(true),
    passed: z.literal(true),
    pdf_magic: z.literal(true),
  }).strict(),
  observation_id_semantics: z.literal(
    "deterministic_audit_identifier_derived_from_original_acquisition_record",
  ),
  official_url: z.url().max(2_048),
  review_package_member_sha256: governanceSha256Schema,
  review_state: z.literal("needs_review"),
  source_pack_location: z.string().min(1),
}).strict().superRefine((entry, context) => {
  if (entry.artifact_sha256 !== entry.review_package_member_sha256) {
    context.addIssue({ code: "custom", message: "historical_crosswalk_member_hash_mismatch" });
  }
  if (entry.official_url !== entry.final_url) {
    context.addIssue({ code: "custom", message: "historical_crosswalk_final_url_mismatch" });
  }
  const registered = entry.corpus_registration.status === "registered_selected_raw_artifact";
  if (registered !== (entry.corpus_registration.source_version_id !== null)) {
    context.addIssue({ code: "custom", message: "historical_crosswalk_registration_binding_invalid" });
  }
}).readonly();

const shaInputsSchema = z.object({
  tracked_publication_inventory_sha256: governanceSha256Schema,
  tracked_permit_inventory_sha256: governanceSha256Schema,
  source_pack_report_sha256: governanceSha256Schema,
  owner_handoff_sha256: governanceSha256Schema,
  fetch_state_sha256: governanceSha256Schema,
  build_state_sha256: governanceSha256Schema,
  source_diff_report_sha256: governanceSha256Schema,
}).strict().readonly();

const historicalCrosswalkSchema = z.object({
  schema_version: z.literal(HISTORICAL_OBSERVATION_CROSSWALK_SCHEMA),
  evidence_inputs: shaInputsSchema,
  count_meaning: z.object({
    law_publication_records: z.literal(20),
    permit_catalog_records: z.literal(58),
    permit_artifact_urls_only: z.literal(68),
    law_publication_artifact_urls: z.literal(20),
    combined_distinct_artifact_urls: z.literal(88),
    clarification: z.string().min(1),
  }).strict(),
  before_after: z.record(z.string(), z.unknown()),
  category_reconciliation: z.object({
    registered_corpus_raw_artifacts: z.literal(20),
    selected_manifest_source_versions: z.literal(17),
    acquisition_source_pack_artifacts: z.literal(72),
    acquisition_source_pack_is_not_corpus_registration: z.literal(true),
    browser_catalog_observations: z.number().int().nonnegative(),
    persistent_import_ledger_entries: z.number().int().nonnegative(),
    test_only_ledger_entries_retained: z.literal(0),
    test_only_ledger_note: z.string().min(1),
    quarantine_observations: z.number().int().nonnegative(),
    unavailable_fetch_records: z.number().int().nonnegative(),
    change_detections: z.number().int().nonnegative(),
    actual_byte_change_candidates: z.number().int().nonnegative(),
    rejected_challenge_detections: z.number().int().nonnegative(),
  }).strict(),
  quarantine_partition: z.record(z.string(), z.unknown()),
  change_detection_partition: z.record(z.string(), z.unknown()),
  working_time_publications: z.array(z.unknown()).length(20),
  permit_catalog_records: z.array(z.object({
    artifacts: z.array(z.unknown()),
  }).passthrough()).length(58),
  url_mappings: z.array(z.object({
    collection: z.enum(["hours_publications", "work_permits"]),
    logical_record_ids: z.array(governanceIdSchema).min(1),
    official_url: z.url().max(2_048),
  }).strict()).length(88),
  acquired_files: z.array(historicalAcquisitionSchema).length(72),
  remaining_gaps: z.object({
    total: z.literal(16),
    http_403: z.array(z.unknown()).length(15),
    http_404: z.array(z.unknown()).length(1),
    exact_404_catalog_value: z.string().min(1),
    owner_handoff_required: z.literal(true),
  }).strict(),
  invariants: z.object({
    reviewed_sources: z.literal(0),
    active_sources: z.literal(0),
    corpus_meaning_mutated_by_audit: z.literal(false),
    source_status_mutated_by_audit: z.literal(false),
  }).strict(),
  report_content_sha256: governanceSha256Schema,
}).strict().readonly();

type HistoricalAcquisition = z.infer<typeof historicalAcquisitionSchema>;
type HistoricalCrosswalk = z.infer<typeof historicalCrosswalkSchema>;

export type HistoricalObservationImportPlan = Readonly<{
  schema_version: "tivdoc-historical-observation-import-plan-v0.10.2";
  input_file_sha256: string;
  input_report_content_sha256: string;
  source_set_sha256: string;
  plan_sha256: string;
  url_observation_count: 72;
  registered_overlap_count: 1;
  staged_observation_count: 71;
  acquired_byte_object_count: 71;
  staged_byte_object_count: 70;
  alias_group_count: 1;
  registered_overlap_observation_ids: readonly string[];
  candidates: readonly LegalObservationCandidate[];
}>;

export type HistoricalObservationImportReceipt = Readonly<{
  schema_version: "tivdoc-historical-observation-import-receipt-v0.10.2";
  input_report_content_sha256: string;
  source_set_sha256: string;
  plan_sha256: string;
  imported_at: string;
  candidate_receipts: readonly GovernanceMutationReceipt[];
  queue_receipts: readonly GovernanceMutationReceipt[];
  observations_imported: 71;
  work_items_pending: 71;
  activation_allowed: false;
  receipt_sha256: string;
}>;

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function withoutReportHash(crosswalk: HistoricalCrosswalk): Omit<HistoricalCrosswalk, "report_content_sha256"> {
  const { report_content_sha256: omitted, ...content } = crosswalk;
  void omitted;
  return content;
}

function assertUnique(values: readonly string[], code: string): void {
  if (new Set(values).size !== values.length) throw new Error(code);
}

function buildCandidate(
  entry: HistoricalAcquisition,
  aliases: readonly HistoricalAcquisition[],
  inputFileSha256: string,
  reportContentSha256: string,
): LegalObservationCandidate {
  const seed = {
    schema_version: GOVERNANCE_SCHEMA_VERSION,
    observation_id: entry.acquisition_observation_id,
    observation_version: "1.0.0",
    observation_kind: "source_bytes" as const,
    source_candidate_id: entry.artifact_id,
    instrument_candidate_id: null,
    observed_url: entry.official_url,
    artifact_version_id: null,
    byte_object_id: `BYTEOBJ:SHA256:${entry.artifact_sha256}`,
    bytes_sha256: entry.artifact_sha256,
    topic: null,
    candidate_valid_from: null,
    candidate_valid_to: null,
    knowledge_time: null,
    sectors: [] as const,
    populations: [] as const,
    geographies: [] as const,
    provenance: {
      historical_crosswalk_schema_version: HISTORICAL_OBSERVATION_CROSSWALK_SCHEMA,
      historical_crosswalk_file_sha256: inputFileSha256,
      historical_crosswalk_report_content_sha256: reportContentSha256,
      acquisition_observation_id: entry.acquisition_observation_id,
      artifact_id: entry.artifact_id,
      collection: entry.collection,
      byte_count: entry.byte_count,
      declared_media_type: entry.declared_media_type,
      review_state: entry.review_state,
      activation_state: entry.activation_state,
      corpus_registration_status: entry.corpus_registration.status,
      corpus_source_version_id: entry.corpus_registration.source_version_id,
      immutable_evidence_location: entry.immutable_evidence_location,
      source_pack_location: entry.source_pack_location,
      review_package_member_sha256: entry.review_package_member_sha256,
      observation_time_status: "unknown_not_recorded_in_crosswalk",
      observation_version_semantics: "governance_import_version_not_legal_source_version",
    },
    contradiction_refs: [] as const,
    gap_refs: [] as const,
    alias_refs: aliases
      .filter((alias) => alias.acquisition_observation_id !== entry.acquisition_observation_id)
      .map((alias) => alias.acquisition_observation_id)
      .sort(),
    duplicate_refs: [] as const,
    overlap_refs: [] as const,
    legal_effect: "unreviewed" as const,
    activation_allowed: false as const,
  };
  return frozen(legalObservationCandidateSchema.parse({
    ...seed,
    candidate_sha256: legalOperationsSha256(seed),
  }));
}

/**
 * Validates a historical crosswalk without trusting its embedded hash.  The
 * expected digests are arguments so focused tests can use generated fixtures;
 * product runtime must use `loadExactHistoricalObservationImportPlan`, which
 * pins the known V0.4.1 evidence digests.
 */
export function validateHistoricalObservationCrosswalkBytes(
  bytes: Uint8Array,
  expectedFileSha256: string,
  expectedContentSha256: string,
): HistoricalObservationImportPlan {
  const fileSha256 = sha256Bytes(bytes);
  if (fileSha256 !== governanceSha256Schema.parse(expectedFileSha256)) {
    throw new Error("HISTORICAL_OBSERVATION_CROSSWALK_FILE_HASH_MISMATCH");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error("HISTORICAL_OBSERVATION_CROSSWALK_JSON_INVALID");
  }
  const crosswalk = historicalCrosswalkSchema.parse(decoded);
  const calculatedContentSha256 = legalOperationsSha256(withoutReportHash(crosswalk));
  if (crosswalk.report_content_sha256 !== calculatedContentSha256
      || crosswalk.report_content_sha256 !== governanceSha256Schema.parse(expectedContentSha256)) {
    throw new Error("HISTORICAL_OBSERVATION_CROSSWALK_CONTENT_HASH_MISMATCH");
  }

  const acquired = [...crosswalk.acquired_files]
    .sort((left, right) => left.acquisition_observation_id.localeCompare(right.acquisition_observation_id));
  assertUnique(acquired.map((entry) => entry.acquisition_observation_id),
    "HISTORICAL_OBSERVATION_ID_DUPLICATED");
  assertUnique(acquired.map((entry) => entry.official_url), "HISTORICAL_OBSERVATION_URL_DUPLICATED");
  assertUnique(crosswalk.url_mappings.map((entry) => entry.official_url),
    "HISTORICAL_CROSSWALK_URL_MAPPING_DUPLICATED");
  const mappedUrls = new Set(crosswalk.url_mappings.map((entry) => entry.official_url));
  if (acquired.some((entry) => !mappedUrls.has(entry.official_url))) {
    throw new Error("HISTORICAL_OBSERVATION_URL_NOT_IN_CROSSWALK");
  }
  const permitArtifactCount = crosswalk.permit_catalog_records
    .reduce((sum, entry) => sum + entry.artifacts.length, 0);
  if (permitArtifactCount !== 68) throw new Error("HISTORICAL_PERMIT_ARTIFACT_COUNT_INVALID");

  const registered = acquired.filter((entry) =>
    entry.corpus_registration.status === "registered_selected_raw_artifact");
  const staged = acquired.filter((entry) => entry.corpus_registration.status === "not_registered");
  if (registered.length !== 1 || staged.length !== 71) {
    throw new Error("HISTORICAL_OBSERVATION_STAGED_PARTITION_INVALID");
  }
  const bySha = new Map<string, HistoricalAcquisition[]>();
  for (const entry of acquired) bySha.set(entry.artifact_sha256, [...(bySha.get(entry.artifact_sha256) ?? []), entry]);
  const stagedByteObjects = new Set(staged.map((entry) => entry.artifact_sha256));
  const aliasGroups = [...bySha.values()].filter((entries) => entries.length > 1);
  if (bySha.size !== 71 || stagedByteObjects.size !== 70 || aliasGroups.length !== 1
      || aliasGroups[0]?.length !== 2) {
    throw new Error("HISTORICAL_OBSERVATION_BYTE_OBJECT_RECONCILIATION_INVALID");
  }

  const candidates = staged.map((entry) => buildCandidate(
    entry,
    bySha.get(entry.artifact_sha256) ?? [],
    fileSha256,
    calculatedContentSha256,
  ));
  const sourceSetSha256 = legalOperationsSha256(acquired.map((entry) => ({
    observation_id: entry.acquisition_observation_id,
    official_url: entry.official_url,
    artifact_sha256: entry.artifact_sha256,
    registration_status: entry.corpus_registration.status,
  })));
  const planBody = {
    schema_version: "tivdoc-historical-observation-import-plan-v0.10.2" as const,
    input_file_sha256: fileSha256,
    input_report_content_sha256: calculatedContentSha256,
    source_set_sha256: sourceSetSha256,
    url_observation_count: 72 as const,
    registered_overlap_count: 1 as const,
    staged_observation_count: 71 as const,
    acquired_byte_object_count: 71 as const,
    staged_byte_object_count: 70 as const,
    alias_group_count: 1 as const,
    registered_overlap_observation_ids: registered.map((entry) => entry.acquisition_observation_id),
    candidates,
  };
  return frozen({ ...planBody, plan_sha256: legalOperationsSha256(planBody) });
}

export async function loadExactHistoricalObservationImportPlan(
  crosswalkPath: string,
): Promise<HistoricalObservationImportPlan> {
  if (typeof crosswalkPath !== "string" || crosswalkPath.trim() === "") {
    throw new Error("HISTORICAL_OBSERVATION_CROSSWALK_PATH_REQUIRED");
  }
  let bytes: Uint8Array;
  try {
    bytes = await readFile(crosswalkPath);
  } catch {
    throw new Error("HISTORICAL_OBSERVATION_CROSSWALK_UNAVAILABLE");
  }
  return validateHistoricalObservationCrosswalkBytes(
    bytes,
    HISTORICAL_OBSERVATION_CROSSWALK_FILE_SHA256,
    HISTORICAL_OBSERVATION_CROSSWALK_CONTENT_SHA256,
  );
}

export class PostgresHistoricalObservationImportService {
  readonly #legal: PostgresLegalReconciliationRepository;
  readonly #work: PostgresGovernanceWorkRepository;

  constructor(
    legal: PostgresLegalReconciliationRepository,
    work: PostgresGovernanceWorkRepository,
  ) {
    this.#legal = legal;
    this.#work = work;
  }

  async importExactPlan(
    planInput: HistoricalObservationImportPlan,
    importedAtInput: string,
  ): Promise<HistoricalObservationImportReceipt> {
    const importedAt = governanceTimestampSchema.parse(importedAtInput);
    if (planInput.input_file_sha256 !== HISTORICAL_OBSERVATION_CROSSWALK_FILE_SHA256
        || planInput.input_report_content_sha256 !== HISTORICAL_OBSERVATION_CROSSWALK_CONTENT_SHA256
        || planInput.candidates.length !== 71
        || planInput.plan_sha256 !== legalOperationsSha256((({ plan_sha256: omitted, ...body }) => {
          void omitted;
          return body;
        })(planInput))) {
      throw new Error("HISTORICAL_OBSERVATION_IMPORT_PLAN_INVALID");
    }

    const candidateReceipts: GovernanceMutationReceipt[] = [];
    const queueReceipts: GovernanceMutationReceipt[] = [];
    for (const candidate of planInput.candidates) {
      const suffix = candidate.observation_id.replace("ACQOBS:WAVE1:", "");
      const candidateReceipt = await this.#legal.importObservation(candidate, {
        idempotency_key: `IDEMP:LEGALOBS:IMPORT:${suffix}`,
        occurred_at: importedAt,
      });
      if (candidateReceipt.state !== "reconciliation_candidate_inactive"
          || candidateReceipt.aggregate_id !== candidate.observation_id
          || candidateReceipt.activation_allowed !== false) {
        throw new Error("HISTORICAL_OBSERVATION_IMPORT_RECEIPT_INVALID");
      }
      candidateReceipts.push(candidateReceipt);
      const queueReceipt = await this.#work.enqueue({
        work_item_id: `WORK:LEGALOBS:${suffix}`,
        workflow_kind: "legal_reconciliation",
        aggregate_id: candidate.observation_id,
        aggregate_version: candidate.observation_version,
        work_kind: "legal_observation_reconciliation",
        required_role: "human_source_reviewer",
        document_sha256: candidate.bytes_sha256,
        object_version_id: candidate.byte_object_id,
        input_sha256: candidate.candidate_sha256,
        payload: {
          candidate_sha256: candidate.candidate_sha256,
          observed_url_sha256: legalOperationsSha256(candidate.observed_url),
          input_report_content_sha256: planInput.input_report_content_sha256,
          legal_effect: "unreviewed",
          activation_allowed: false,
        },
        idempotency_key: `IDEMP:LEGALOBS:QUEUE:${suffix}`,
        created_at: importedAt,
      });
      if (queueReceipt.state !== "pending" || queueReceipt.aggregate_id !== candidate.observation_id
          || queueReceipt.activation_allowed !== false) {
        throw new Error("HISTORICAL_OBSERVATION_QUEUE_RECEIPT_INVALID");
      }
      queueReceipts.push(queueReceipt);
    }
    const body = {
      schema_version: "tivdoc-historical-observation-import-receipt-v0.10.2" as const,
      input_report_content_sha256: planInput.input_report_content_sha256,
      source_set_sha256: planInput.source_set_sha256,
      plan_sha256: planInput.plan_sha256,
      imported_at: importedAt,
      candidate_receipts: candidateReceipts,
      queue_receipts: queueReceipts,
      observations_imported: 71 as const,
      work_items_pending: 71 as const,
      activation_allowed: false as const,
    };
    return frozen({ ...body, receipt_sha256: legalOperationsSha256(body) });
  }
}
