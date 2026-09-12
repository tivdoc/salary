import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { CHAIN_REPLAY_SCHEMA, discoverMigrationFiles, replayMigrationChain } from "./chain-replay.mts";
import { DENIED_PROJECT_REFS, TIVDOC_DEV_LABEL, TIVDOC_DEV_PROJECT_REF } from "./guard.mts";

const MIGRATIONS = "supabase/migrations";
const DEV_ENV = { SUPABASE_PROJECT_REF: TIVDOC_DEV_PROJECT_REF, SUPABASE_PROJECT_LABEL: TIVDOC_DEV_LABEL };

describe("V0.10.9 byte-pinned chain replay", () => {
  it("discovers every migration in filename order with LF-normalized hashes", async () => {
    const files = await discoverMigrationFiles(MIGRATIONS);
    expect(files).toHaveLength(190);
    expect(files.map((file) => file.name)).toEqual([...files.map((file) => file.name)].sort());
    expect(files.slice(-59).map(file=>file.name)).toEqual([
      "20260910040429_document_source_transcriptions.sql",
      "20260910040753_dev_financial_source_completion_runs.sql",
      "20260910042333_dev_missing_hours_declaration_wording.sql",
      "20260910044646_dev_financial_completion_target_binding.sql",
      "20260910141530_june2026_isolated_canonical_assessments.sql",
      "20260910144517_june2026_comparison_stage_binding.sql",
      "20260910145013_june2026_customer_canonical_case_binding.sql",
      "20260910160042_june2026_regular_service_authority.sql",
      "20260910160553_june2026_regular_hours_declarations.sql",
      "20260910161527_june2026_regular_results_publication.sql",
      "20260910164356_june2026_regular_effective_source_binding.sql",
      "20260910165457_june2026_repeated_period_observations.sql",
      "20260910172700_june2026_regular_current_authority.sql",
      "20260910173100_june2026_regular_notification_claim.sql",
      "20260910182000_regular_authority_worker_dependency.sql",
      "20260910183000_regular_report_dependency_pin.sql",
      "20260910184000_regular_publication_dependency_guard.sql",
      "20260911002520_managed_dev_health_and_authority_expiry.sql",
      "20260911004113_june2026_hours_conflict_journal.sql",
      "20260911004401_june2026_hours_conflict_effective_binding.sql",
      "20260911005353_june2026_conflict_partial_draft_guard.sql",
      "20260911005513_june2026_conflict_receipt_required.sql",
      "20260911005612_june2026_conflict_single_document_scope.sql",
      "20260911014710_hours_conflict_open_variable_scope.sql",
      "20260911015947_managed_notification_product_mirror.sql",
      "20260911061959_managed_dev_repeatable_lifecycle.sql",
      "20260911063456_managed_dev_completion_rounds.sql",
      "20260911144617_document_review_identified_completions.sql",
      "20260911164033_identified_cell_reading_v2.sql",
      "20260911164425_private_document_review_artifacts.sql",
      "20260911165540_legacy_paid_review_upload_flow.sql",
      "20260911171000_document_review_source_revisions.sql",
      "20260911171700_private_review_canonical_case_binding.sql",
      "20260911173000_legacy_scope_period_variable.sql",
      "20260911173500_scoped_financial_source_completion.sql",
      "20260911183000_extraction_prompt_derivation.sql",
      "20260911183500_extraction_prompt_qa_lock.sql",
      "20260911195557_document_row_cell_readings.sql",
      "20260911222336_document_source_structures.sql",
      "20260912080403_document_evidence_invocation_contract.sql",
      "20260912082645_document_evidence_identified_readings.sql",
      "20260912084511_document_evidence_answer_revision_currentness.sql",
      "20260912085031_ai_release_configuration_registry.sql",
      "20260912090500_ai_release_findings.sql",
      "20260912091000_document_evidence_retained_receipts.sql",
      "20260912092000_ai_release_operator_events.sql",
      "20260912094426_ai_release_report_publication.sql",
      "20260912102430_ai_release_managed_scope.sql",
      "20260912104926_ai_release_machine_first_enrollment.sql",
      "20260912174500_owner_engineering_purpose.sql",
      "20260912184500_managed_candidate_scope_alias.sql",
      "20260912185000_review_public_source_inventory.sql",
      "20260912185500_worker_health_factual_requests.sql",
      "20260912190000_travel_tariff_document_purpose.sql",
      "20260912191500_travel_tariff_reading_targets.sql",
      "20260912193000_travel_tariff_review_upload.sql",
      "20260912194500_document_source_period_association.sql",
      "20260912194600_document_source_structure_period_witness.sql",
      "20260912194700_managed_dev_bounded_live_epoch.sql",
    ]);
    for (const file of files) {
      expect(file.sha256_raw).toMatch(/^[a-f0-9]{64}$/u);
      expect(file.sha256_lf).toMatch(/^[a-f0-9]{64}$/u);
      expect(file.byte_count).toBeGreaterThan(0);
    }
    expect(files.map((file) => file.applied_order)).toEqual(files.map((_, index) => index + 1));
  });

  it("hashes the bytes it will send, matching the repository pin for the legal review migration", async () => {
    const { EXPECTED_MIGRATION_SHA256 } = await import(
      "../canonical-persistence-v091/foundation/migrations.mts"
    );
    const files = await discoverMigrationFiles(MIGRATIONS);
    const pinnedFiles = files.filter((file) => EXPECTED_MIGRATION_SHA256[file.name]);
    expect(pinnedFiles.length).toBeGreaterThanOrEqual(23);
    for (const file of pinnedFiles) {
      const pinned = EXPECTED_MIGRATION_SHA256[file.name];
      // The pin must match the bytes on disk under one of the two conventions
      // the repository actually uses; neither matching means the file drifted.
      // L9-7: a Linux checkout carries LF only; the CRLF convention the pin may
      // have been taken under is recomputed here so the check is host-neutral.
      const crlf = createHash("sha256").update(readFileSync(path.join(MIGRATIONS, file.name), "utf8").replaceAll("\r\n", "\n").replaceAll("\n", "\r\n"), "utf8").digest("hex");
      expect([file.sha256_raw, file.sha256_lf, crlf], file.name).toContain(pinned);
    }
  });

  it("refuses to run without a DEV credential rather than falling back", async () => {
    const receipt = await replayMigrationChain({ migrations_root: MIGRATIONS, environment: DEV_ENV });
    expect(receipt.schema_version).toBe(CHAIN_REPLAY_SCHEMA);
    expect(receipt.status).toBe("BLOCKED_NO_CREDENTIAL");
    expect(receipt.blocked_reason).toBe("TIVDOC_DEV_DATABASE_URL_ABSENT");
    expect(receipt.files_applied).toBe(0);
    expect(receipt.project_ref_verified).toBe(true);
  });

  it("runs the guard before anything else and refuses a denied or absent ref", async () => {
    await expect(replayMigrationChain({ migrations_root: MIGRATIONS, environment: {} }))
      .rejects.toThrow(/PROJECT_REF_MISSING/u);
    await expect(replayMigrationChain({
      migrations_root: MIGRATIONS,
      environment: { SUPABASE_PROJECT_REF: DENIED_PROJECT_REFS[0], SUPABASE_PROJECT_LABEL: TIVDOC_DEV_LABEL },
    })).rejects.toThrow(/PROJECT_REF_DENYLISTED/u);
    await expect(replayMigrationChain({
      migrations_root: MIGRATIONS,
      environment: { SUPABASE_PROJECT_REF: TIVDOC_DEV_PROJECT_REF, SUPABASE_PROJECT_LABEL: "PRODUCTION" },
    })).rejects.toThrow(/DEV_LABEL_MISSING/u);
  });

  it("never returns a connection string or password in the receipt", async () => {
    const receipt = await replayMigrationChain({
      migrations_root: MIGRATIONS,
      environment: { ...DEV_ENV, TIVDOC_DEV_DATABASE_URL: "" },
    });
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toMatch(/postgres(?:ql)?:\/\//u);
    expect(Object.keys(receipt)).not.toContain("connection_string");
  });
});
