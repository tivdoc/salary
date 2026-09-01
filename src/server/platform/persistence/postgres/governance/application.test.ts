import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { legalOperationsSha256 } from "../../../../../engine/legal-operations/canonical.ts";
import type { PostgresClient, PostgresQueryResult, PostgresStatement } from "../contracts.ts";
import { createDurableGovernanceApplication } from "./application.ts";
import {
  HISTORICAL_OBSERVATION_CROSSWALK_CONTENT_SHA256,
  HISTORICAL_OBSERVATION_CROSSWALK_FILE_SHA256,
  loadExactHistoricalObservationImportPlan,
  validateHistoricalObservationCrosswalkBytes,
} from "./historical-observation-import.ts";

const localHistoricalCrosswalk = path.resolve(
  "output/parallel-wave-2/review-package-v0.4/worker-evidence/A1/wave1-artifact-crosswalk.json",
);

function byteSha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactCountFixture(): Readonly<{ bytes: Uint8Array; file_sha256: string; content_sha256: string }> {
  const acquired = Array.from({ length: 72 }, (_, index) => {
    const artifactSha256 = byteSha(`historical-byte-${index === 71 ? 70 : index}`);
    const registered = index === 0;
    return {
      acquisition_observation_id: `ACQOBS:WAVE1:${byteSha(`observation-${index}`).slice(0, 32)}`,
      activation_state: "inactive",
      artifact_id: `ARTIFACT:${String(index).padStart(3, "0")}`,
      artifact_sha256: artifactSha256,
      byte_count: 1_000 + index,
      collection: index < 20 ? "hours_publications" : "work_permits",
      corpus_registration: registered
        ? { reason: "exact_test_overlap", source_version_id: "SOURCE:REGISTERED:001", status: "registered_selected_raw_artifact" }
        : { reason: "staged_for_review", source_version_id: null, status: "not_registered" },
      declared_media_type: "application/pdf",
      final_url: `https://example.invalid/artifact/${index}`,
      immutable_evidence_location: `fixture.zip!/artifact/${index}.pdf`,
      media_validation: { declared_pdf: true, passed: true, pdf_magic: true },
      observation_id_semantics: "deterministic_audit_identifier_derived_from_original_acquisition_record",
      official_url: `https://example.invalid/artifact/${index}`,
      review_package_member_sha256: artifactSha256,
      review_state: "needs_review",
      source_pack_location: `artifacts/${index}.pdf`,
    } as const;
  });
  const content = {
    schema_version: "tivdoc-wave1-artifact-reconciliation-v0.4",
    evidence_inputs: {
      tracked_publication_inventory_sha256: byteSha("publication"),
      tracked_permit_inventory_sha256: byteSha("permit"),
      source_pack_report_sha256: byteSha("source-pack"),
      owner_handoff_sha256: byteSha("handoff"),
      fetch_state_sha256: byteSha("fetch"),
      build_state_sha256: byteSha("build"),
      source_diff_report_sha256: byteSha("diff"),
    },
    count_meaning: {
      law_publication_records: 20,
      permit_catalog_records: 58,
      permit_artifact_urls_only: 68,
      law_publication_artifact_urls: 20,
      combined_distinct_artifact_urls: 88,
      clarification: "fixture preserves independent URL populations",
    },
    before_after: {},
    category_reconciliation: {
      registered_corpus_raw_artifacts: 20,
      selected_manifest_source_versions: 17,
      acquisition_source_pack_artifacts: 72,
      acquisition_source_pack_is_not_corpus_registration: true,
      browser_catalog_observations: 6,
      persistent_import_ledger_entries: 0,
      test_only_ledger_entries_retained: 0,
      test_only_ledger_note: "none retained",
      quarantine_observations: 3,
      unavailable_fetch_records: 1,
      change_detections: 5,
      actual_byte_change_candidates: 3,
      rejected_challenge_detections: 2,
    },
    quarantine_partition: {},
    change_detection_partition: {},
    working_time_publications: Array.from({ length: 20 }, (_, index) => ({ index })),
    permit_catalog_records: Array.from({ length: 58 }, (_, index) => ({
      artifacts: Array.from({ length: index < 10 ? 2 : 1 }, (__, artifactIndex) => ({ artifactIndex })),
    })),
    url_mappings: Array.from({ length: 88 }, (_, index) => ({
      collection: index < 20 ? "hours_publications" : "work_permits",
      logical_record_ids: [`ARTIFACT:${String(index).padStart(3, "0")}`],
      official_url: `https://example.invalid/artifact/${index}`,
    })),
    acquired_files: acquired,
    remaining_gaps: {
      total: 16,
      http_403: Array.from({ length: 15 }, (_, index) => ({ index })),
      http_404: [{ index: 15 }],
      exact_404_catalog_value: "fixture-404",
      owner_handoff_required: true,
    },
    invariants: {
      reviewed_sources: 0,
      active_sources: 0,
      corpus_meaning_mutated_by_audit: false,
      source_status_mutated_by_audit: false,
    },
  } as const;
  const contentSha256 = legalOperationsSha256(content);
  const bytes = Buffer.from(`${JSON.stringify({ ...content, report_content_sha256: contentSha256 }, null, 2)}\n`, "utf8");
  return { bytes, file_sha256: byteSha(bytes.toString("utf8")), content_sha256: contentSha256 };
}

class RecordingClient implements PostgresClient {
  readonly statements: PostgresStatement[] = [];

  async query(statement: PostgresStatement): Promise<PostgresQueryResult> {
    this.statements.push(statement);
    throw new Error("query_not_expected");
  }
}

describe("durable governance application", () => {
  it("fails closed without a real PostgreSQL transaction context and exposes no memory fallback", () => {
    expect(() => createDurableGovernanceApplication(undefined as never, "tenant.fixture.001"))
      .toThrowError("GOVERNANCE_INPUT_INVALID:durable_governance_application");

    const client = new RecordingClient();
    const context = Object.freeze({ client, transaction_id: "transaction.fixture.001" });
    const application = createDurableGovernanceApplication(context, "tenant.fixture.001");
    expect(application).toMatchObject({
      persistence: "postgresql_required",
      tenant_id: "tenant.fixture.001",
      transaction_id: context.transaction_id,
      product_reachable_memory_fallback: false,
      activation_allowed: false,
      durable_replacement_count: 4,
    });
    expect(application.reviewer_trust).toBeDefined();
    expect(application.ground_truth).toBeDefined();
    expect(application.legal_reconciliation).toBeDefined();
    expect(application.parameters).toBeDefined();
    expect(application.rulespec).toBeDefined();
    expect(application.historical_observations).toBeDefined();
    expect(client.statements).toHaveLength(0);
  });

  it("preserves 72 URL observations, excludes one registered overlap, and models byte aliases separately", () => {
    const fixture = exactCountFixture();
    const plan = validateHistoricalObservationCrosswalkBytes(
      fixture.bytes,
      fixture.file_sha256,
      fixture.content_sha256,
    );
    expect(plan).toMatchObject({
      url_observation_count: 72,
      registered_overlap_count: 1,
      staged_observation_count: 71,
      acquired_byte_object_count: 71,
      staged_byte_object_count: 70,
      alias_group_count: 1,
    });
    expect(plan.candidates).toHaveLength(71);
    expect(plan.candidates.filter((candidate) => candidate.alias_refs.length === 1)).toHaveLength(2);
    expect(plan.candidates.every((candidate) => (
      candidate.knowledge_time === null
      && candidate.legal_effect === "unreviewed"
      && candidate.activation_allowed === false
      && candidate.candidate_valid_from === null
      && candidate.candidate_valid_to === null
    ))).toBe(true);
    expect(plan.registered_overlap_observation_ids).toHaveLength(1);
    expect(plan.candidates.some((candidate) =>
      plan.registered_overlap_observation_ids.includes(candidate.observation_id))).toBe(false);
  });

  it("rejects file and embedded-content hash changes before creating import candidates", () => {
    const fixture = exactCountFixture();
    expect(() => validateHistoricalObservationCrosswalkBytes(
      fixture.bytes,
      "0".repeat(64),
      fixture.content_sha256,
    )).toThrowError("HISTORICAL_OBSERVATION_CROSSWALK_FILE_HASH_MISMATCH");

    const parsed = JSON.parse(Buffer.from(fixture.bytes).toString("utf8")) as Record<string, unknown>;
    parsed.before_after = { changed: true };
    const changed = Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    expect(() => validateHistoricalObservationCrosswalkBytes(
      changed,
      byteSha(changed.toString("utf8")),
      fixture.content_sha256,
    )).toThrowError("HISTORICAL_OBSERVATION_CROSSWALK_CONTENT_HASH_MISMATCH");
  });

  it.runIf(existsSync(localHistoricalCrosswalk))(
    "loads the exact ignored historical crosswalk without tracking its data",
    async () => {
      const plan = await loadExactHistoricalObservationImportPlan(localHistoricalCrosswalk);
      expect(plan.input_file_sha256).toBe(HISTORICAL_OBSERVATION_CROSSWALK_FILE_SHA256);
      expect(plan.input_report_content_sha256).toBe(HISTORICAL_OBSERVATION_CROSSWALK_CONTENT_SHA256);
      expect(plan.candidates).toHaveLength(71);
    },
  );
});
