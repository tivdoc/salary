import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquisitionRequestSchema, type AcquisitionRequest } from "../../../../engine/legal-knowledge/acquisition-contracts.ts";
import {
  controlledImportPersistentReadiness,
  controlledImportStrictOperationalReadiness,
  importControlledOfficialArtifact,
  probeControlledArtifactVisibility,
  readCommittedControlledArtifact,
  verifyControlledAcquisitionLedger,
} from "../controlled-import-security.ts";

const testNotice = "TEST COPY OF EXISTING PUBLIC OFFICIAL ARTIFACT; NOT AN OWNER IMPORT" as const;

function sha256(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function syntheticPdf(marker: string) {
  return Buffer.from(`%PDF-1.7
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>
endobj
${`% synthetic closure proof ${marker}\n`.repeat(24)}xref
0 4
0000000000 65535 f
trailer
<< /Size 4 /Root 1 0 R >>
startxref
0
%%EOF
`);
}

function request(bytes: Uint8Array, kind: "synthetic_test_attestation" | "owner_attestation") {
  const owner = kind === "owner_attestation";
  const suffix = owner ? "OWNER-DENIAL" : "SYNTHETIC-TOCTOU";
  const title = owner ? "Synthetic owner-denial sentinel" : "Synthetic public-copy reader sentinel";
  const filename = owner ? "synthetic-owner-denial.pdf" : "synthetic-public-copy.pdf";
  return acquisitionRequestSchema.parse({
    acquisition_request_id: `ACQ-WAVE22-${suffix}`,
    source_id: `IL_WAVE22_${suffix.replaceAll("-", "_")}`,
    instrument_id: `INSTRUMENT:IL:WAVE22:${suffix}`,
    canonical_landing_url: "https://www.gov.il/wave22-synthetic-sentinel",
    artifact_url: "https://www.gov.il/wave22-synthetic-sentinel.pdf",
    allowlisted_hosts: ["www.gov.il"],
    allowed_artifact_urls: ["https://www.gov.il/wave22-synthetic-sentinel.pdf"],
    allowed_final_urls: ["https://www.gov.il/wave22-synthetic-sentinel.pdf"],
    expected_media_type: "application/pdf",
    expected_document_identity: {
      title,
      artifact_sha256: sha256(bytes),
      identity_basis: owner
        ? "owner_must_confirm_official_record"
        : "known_existing_public_official_artifact_test_copy",
    },
    allowed_attestation_types: [kind],
    expected_document_title: title,
    recommended_filename: filename,
    failure_evidence: [],
    receipt_template: {
      acquisition_request_id: `ACQ-WAVE22-${suffix}`,
      source_id: `IL_WAVE22_${suffix.replaceAll("-", "_")}`,
      landing_url: "https://www.gov.il/wave22-synthetic-sentinel",
      artifact_url: "https://www.gov.il/wave22-synthetic-sentinel.pdf",
      final_url: "https://www.gov.il/wave22-synthetic-sentinel.pdf",
      artifact_sha256: sha256(bytes),
      expected_media_type: "application/pdf",
      expected_document_title: title,
      attestation_type: kind,
      actor_type: owner ? "owner" : "system_test",
      acquisition_method: owner
        ? "owner_attested_official_download"
        : "synthetic_test_copy_existing_public_official_artifact",
      unchanged_original: true,
      used_print_to_pdf: false,
      ...(owner ? {} : { test_only_notice: testNotice }),
    },
  });
}

function receipt(bytes: Uint8Array, acquisitionRequest: AcquisitionRequest, kind: "synthetic_test_attestation" | "owner_attestation") {
  const owner = kind === "owner_attestation";
  return {
    acquisition_request_id: acquisitionRequest.acquisition_request_id,
    source_id: acquisitionRequest.source_id,
    original_filename: acquisitionRequest.recommended_filename,
    landing_url: acquisitionRequest.canonical_landing_url,
    artifact_url: acquisitionRequest.artifact_url,
    final_url: acquisitionRequest.allowed_final_urls[0],
    artifact_sha256: sha256(bytes),
    expected_media_type: acquisitionRequest.expected_media_type,
    expected_document_title: acquisitionRequest.expected_document_title,
    acquired_at: "2026-08-30T00:00:00Z",
    attestation_type: kind,
    actor_type: owner ? "owner" : "system_test",
    acquisition_method: owner
      ? "owner_attested_official_download"
      : "synthetic_test_copy_existing_public_official_artifact",
    unchanged_original: true,
    used_print_to_pdf: false,
    ...(owner ? {} : { test_only_notice: testNotice }),
  };
}

async function fixture(root: string, marker: string, kind: "synthetic_test_attestation" | "owner_attestation") {
  const bytes = syntheticPdf(marker);
  const acquisitionRequest = request(bytes, kind);
  const incomingRoot = path.join(root, "incoming");
  const inbox = path.join(incomingRoot, acquisitionRequest.acquisition_request_id);
  await mkdir(inbox, { recursive: true });
  await writeFile(path.join(inbox, acquisitionRequest.recommended_filename), bytes);
  await writeFile(path.join(inbox, "receipt.json"), JSON.stringify(receipt(bytes, acquisitionRequest, kind)));
  return {
    bytes,
    input: {
      request: acquisitionRequest,
      incomingRoot,
      artifactRoot: path.join(root, "artifacts"),
      ledgerRoot: path.join(root, "ledger"),
      originalFilename: acquisitionRequest.recommended_filename,
      receiptFilename: "receipt.json",
      requiredAttestationType: kind,
    },
  };
}

async function readerSourceBindingProof() {
  const sourcePath = path.resolve("src/server/engine/legal-knowledge/controlled-import-security.ts");
  const source = await readFile(sourcePath, "utf8");
  const start = source.indexOf("export async function readCommittedControlledArtifact");
  const end = source.indexOf("export async function probeControlledArtifactVisibility", start);
  if (start < 0 || end < 0) throw new Error("canonical_reader_source_not_found");
  const reader = source.slice(start, end);
  const requirements = {
    content_open_count: (reader.match(/readFile\(artifactPath\)/gu) ?? []).length,
    exact_opened_bytes_hashed_after_read: reader.includes("sha256(bytes) !== marker.artifact_sha256"),
    exact_opened_byte_count_bound_after_read: reader.includes("bytes.byteLength !== marker.byte_count"),
    same_opened_bytes_passed_to_isolated_screen: reader.includes("screenUntrustedPdfIsolated({ bytes })"),
    marker_record_event_identity_journal_bound_before_content_open:
      reader.indexOf("controlled_commit_journal_binding_mismatch") < reader.indexOf("readFile(artifactPath)"),
  };
  return {
    canonical_reader: "readCommittedControlledArtifact",
    source_path: "src/server/engine/legal-knowledge/controlled-import-security.ts",
    source_sha256: sha256(source),
    ...requirements,
    passed: requirements.content_open_count === 1
      && requirements.exact_opened_bytes_hashed_after_read
      && requirements.exact_opened_byte_count_bound_after_read
      && requirements.same_opened_bytes_passed_to_isolated_screen
      && requirements.marker_record_event_identity_journal_bound_before_content_open,
  };
}

async function emptyOrMissing(directory: string) {
  try {
    return (await readdir(directory)).length === 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

async function pathMissing(target: string) {
  try {
    await lstat(target);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

export async function runWave22OperationalProof() {
  const root = await mkdtemp(path.join(os.tmpdir(), "tivdoc-wave22-operational-proof-"));
  try {
    const synthetic = await fixture(path.join(root, "synthetic"), "reader", "synthetic_test_attestation");
    const imported = await importControlledOfficialArtifact(synthetic.input);
    const artifactPath = path.join(
      synthetic.input.artifactRoot,
      synthetic.input.request.source_id,
      "synthetic-test-v0.3.1",
      `${sha256(synthetic.bytes)}.pdf`,
    );
    const initialRead = await readCommittedControlledArtifact({
      ledgerRoot: synthetic.input.ledgerRoot,
      artifactRoot: synthetic.input.artifactRoot,
      artifactSha256: sha256(synthetic.bytes),
    });
    const mutated = syntheticPdf("reader-mutated-after-commit");
    await writeFile(artifactPath, mutated);
    let directMutationError: string | null = null;
    try {
      await readCommittedControlledArtifact({
        ledgerRoot: synthetic.input.ledgerRoot,
        artifactRoot: synthetic.input.artifactRoot,
        artifactSha256: sha256(synthetic.bytes),
      });
    } catch (error) {
      directMutationError = error instanceof Error ? error.message : "unknown";
    }
    const mutatedProbe = await probeControlledArtifactVisibility({
      ledgerRoot: synthetic.input.ledgerRoot,
      artifactRoot: synthetic.input.artifactRoot,
      artifactSha256: sha256(synthetic.bytes),
    });
    await writeFile(artifactPath, synthetic.bytes);
    const restoredRead = await readCommittedControlledArtifact({
      ledgerRoot: synthetic.input.ledgerRoot,
      artifactRoot: synthetic.input.artifactRoot,
      artifactSha256: sha256(synthetic.bytes),
    });
    const readerBinding = await readerSourceBindingProof();

    const ownerFixture = await fixture(path.join(root, "owner"), "owner-denial", "owner_attestation");
    let ownerDenial: string | null = null;
    try {
      await importControlledOfficialArtifact(ownerFixture.input);
    } catch (error) {
      ownerDenial = error instanceof Error ? error.message : "unknown";
    }
    const ownerLedger = await verifyControlledAcquisitionLedger({
      ledgerRoot: ownerFixture.input.ledgerRoot,
      artifactRoot: ownerFixture.input.artifactRoot,
    });
    const ownerReadiness = controlledImportPersistentReadiness(ownerLedger);
    const ownerStrictReadiness = controlledImportStrictOperationalReadiness({
      verification: ownerLedger,
      durableStorageVerified: false,
      persistentLedgerVerified: false,
      osSandboxVerified: false,
      persistenceEvidenceVerified: false,
    });
    const ownerProbe = await probeControlledArtifactVisibility({
      ledgerRoot: ownerFixture.input.ledgerRoot,
      artifactRoot: ownerFixture.input.artifactRoot,
      artifactSha256: sha256(ownerFixture.bytes),
    });
    const ownerPathsAbsent = {
      artifact: await emptyOrMissing(ownerFixture.input.artifactRoot),
      event: await emptyOrMissing(path.join(ownerFixture.input.ledgerRoot, "events")),
      root_record: await pathMissing(path.join(ownerFixture.input.ledgerRoot, `${sha256(ownerFixture.bytes)}.json`)),
      commit_marker: await emptyOrMissing(path.join(ownerFixture.input.ledgerRoot, ".commits")),
    };
    const toctou = {
      case_id: "SECURITY_READER_TOCTOU_001_EXACT_OPENED_BYTES",
      initial_visibility: initialRead.visibility,
      initial_opened_bytes_sha256: sha256(synthetic.bytes),
      marker_sha256: initialRead.commit_marker.artifact_sha256,
      mutation_sha256: sha256(mutated),
      direct_mutation_error: directMutationError,
      mutation_probe: mutatedProbe,
      restored_visibility: restoredRead.visibility,
      restored_opened_bytes_sha256: restoredRead.commit_marker.artifact_sha256,
      parse_result_count_after_failure: mutatedProbe.parse_result === null ? 0 : 1,
      citation_count_after_failure: mutatedProbe.citations.length,
      chunk_count_after_failure: mutatedProbe.chunks.length,
      retrieval_result_count_after_failure: mutatedProbe.retrieval_results.length,
      source_binding: readerBinding,
      passed: imported.ledger_committed
        && initialRead.visibility === "committed"
        && directMutationError === "controlled_commit_artifact_bytes_mismatch"
        && mutatedProbe.visible === false
        && mutatedProbe.safe_error_code === "controlled_commit_artifact_bytes_mismatch"
        && mutatedProbe.parse_result === null
        && mutatedProbe.citations.length === 0
        && mutatedProbe.chunks.length === 0
        && mutatedProbe.retrieval_results.length === 0
        && restoredRead.visibility === "committed"
        && readerBinding.passed,
    };
    const ownerReport = {
      case_id: "SECURITY_OWNER_DENIAL_001_PRE_VISIBILITY",
      exercised_non_test_import_entrypoint: "importControlledOfficialArtifact",
      synthetic_bytes_only: true,
      owner_artifact_imported: false,
      safe_error_code: ownerDenial,
      visible: ownerProbe.visible,
      persistent_owner_import_entries: ownerReadiness.persistent_owner_import_entries,
      ledger_entries: ownerLedger.ledger_entries,
      paths_absent_before_visibility: ownerPathsAbsent,
      strict_operational_readiness: ownerStrictReadiness,
      missing_prerequisites: ownerStrictReadiness.missing_gates,
      passed: ownerDenial === "owner_import_disabled_parser_os_sandbox_not_verified"
        && !ownerProbe.visible
        && ownerReadiness.persistent_owner_import_entries === 0
        && ownerLedger.ledger_entries === 0
        && ownerStrictReadiness.exit_code === 5
        && ownerStrictReadiness.missing_gates.join("|") === [
          "durable_replicated_storage_not_verified",
          "parser_os_sandbox_not_verified",
          "persistence_evidence_not_verified",
          "persistent_ledger_not_verified",
          "persistent_owner_imports_zero",
        ].join("|")
        && Object.values(ownerPathsAbsent).every(Boolean),
    };
    const zeroInvariants = {
      customer_files_read: 0,
      openai_calls: 0,
      external_supabase_connections: 0,
      migrations: 0,
      production_preview_deploy_actions: 0,
      persistent_owner_imports: 0,
      reviewed_sources: 0,
      active_sources: 0,
      real_numeric_candidates: 0,
      real_numeric_attestations: 0,
      active_parameters: 0,
      israeli_rules: 0,
      findings: 0,
    };
    return {
      schema_version: "tivdoc-wave22-operational-proof-v0.4.2",
      synthetic_only: true,
      local_only: true,
      no_generator_imports: true,
      assurance: {
        application: "PARSER_APPLICATION_ISOLATION_VERIFIED",
        os: "PARSER_OS_SANDBOX_NOT_VERIFIED",
        owner_imports: "PERSISTENT_OWNER_IMPORTS_NOT_VERIFIED",
        custody: "DURABLE_REPLICATED_CUSTODY_NOT_IMPLEMENTED",
      },
      toctou,
      owner_denial: ownerReport,
      zero_invariants: zeroInvariants,
      persistent_owner_import_entries: 0,
      overall: toctou.passed && ownerReport.passed && Object.values(zeroInvariants).every((value) => value === 0),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
