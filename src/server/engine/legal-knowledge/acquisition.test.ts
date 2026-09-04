import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquisitionRequestSchema } from "../../../engine/legal-knowledge/acquisition-contracts.ts";
import {
  canonicalOwnerPdfReachability,
  corpusReadinessOutcome,
  determineAcquisitionReadinessOutcome,
  importOwnerOfficialArtifact,
  loadBrowserObservations,
  validateOwnerPdfBytes,
  verifyOwnerAcquisitionLedger,
} from "./acquisition.ts";

const temporaryRoots: string[] = [];
const testNotice = "TEST COPY OF EXISTING PUBLIC OFFICIAL ARTIFACT; NOT AN OWNER IMPORT" as const;

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function temporaryRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "tivdoc-legal-acquisition-"));
  temporaryRoots.push(root);
  return root;
}

function syntheticPdf(suffix = "") {
  const body = `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n${"% deterministic padding\n".repeat(30)}${suffix}\nxref\n0 4\n0000000000 65535 f \ntrailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n0\n%%EOF\n`;
  return Buffer.from(body);
}

function hash(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function request(bytes = syntheticPdf()) {
  return acquisitionRequestSchema.parse({
    acquisition_request_id: "ACQ-V02-TEST",
    source_id: "IL_TEST_SOURCE",
    instrument_id: "INSTRUMENT:IL:TEST",
    canonical_landing_url: "https://www.gov.il/test",
    artifact_url: "https://www.gov.il/test.pdf",
    allowlisted_hosts: ["www.gov.il"],
    allowed_artifact_urls: ["https://www.gov.il/test.pdf"],
    allowed_final_urls: ["https://www.gov.il/test.pdf"],
    expected_media_type: "application/pdf",
    expected_document_identity: { title: "Test official PDF", artifact_sha256: hash(bytes), identity_basis: "known_existing_public_official_artifact_test_copy" },
    allowed_attestation_types: ["synthetic_test_attestation"],
    expected_document_title: "Test official PDF",
    recommended_filename: "official.pdf",
    failure_evidence: [{ stage: "fetch", safe_error_code: "http_status_403" }],
    receipt_template: {
      acquisition_request_id: "ACQ-V02-TEST",
      source_id: "IL_TEST_SOURCE",
      landing_url: "https://www.gov.il/test",
      artifact_url: "https://www.gov.il/test.pdf",
      final_url: "https://www.gov.il/test.pdf",
      artifact_sha256: hash(bytes),
      expected_media_type: "application/pdf",
      expected_document_title: "Test official PDF",
      attestation_type: "synthetic_test_attestation",
      actor_type: "system_test",
      acquisition_method: "synthetic_test_copy_existing_public_official_artifact",
      unchanged_original: true,
      used_print_to_pdf: false,
      test_only_notice: testNotice,
    },
  });
}

function receipt(bytes = syntheticPdf(), overrides: Record<string, unknown> = {}) {
  return {
    acquisition_request_id: "ACQ-V02-TEST",
    source_id: "IL_TEST_SOURCE",
    original_filename: "official.pdf",
    landing_url: "https://www.gov.il/test",
    artifact_url: "https://www.gov.il/test.pdf",
    final_url: "https://www.gov.il/test.pdf",
    artifact_sha256: hash(bytes),
    expected_media_type: "application/pdf",
    expected_document_title: "Test official PDF",
    acquired_at: "2026-08-29T00:00:00Z",
    attestation_type: "synthetic_test_attestation",
    actor_type: "system_test",
    acquisition_method: "synthetic_test_copy_existing_public_official_artifact",
    unchanged_original: true,
    used_print_to_pdf: false,
    test_only_notice: testNotice,
    ...overrides,
  };
}

// Every case in this suite performs a real controlled import: bytes written,
// hashed, committed and re-read on disk. That is the mechanism and it is the
// same for all of them. Measured at roughly 1.4s alone; under full-suite
// parallelism they compete with the whole run for the filesystem and cross the
// 5s default. Raising cases one at a time only moves the failure to the next
// one, which is how this budget ended up on the file rather than on a case.
describe("controlled owner acquisition", () => {
  it("routes every owner PDF validation through the isolated screener", async () => {
    await expect(validateOwnerPdfBytes(Buffer.from(`<html>${"x".repeat(600)}</html>`))).rejects.toThrow("isolated_parser_pdf_magic_mismatch");
    await expect(validateOwnerPdfBytes(syntheticPdf("/Encrypt"))).rejects.toThrow("isolated_parser_encrypted");
    await expect(validateOwnerPdfBytes(syntheticPdf("/JavaScript"))).rejects.toThrow("isolated_parser_active_content");
    await expect(validateOwnerPdfBytes(Buffer.concat([Buffer.from("MZ"), syntheticPdf()]))).rejects.toThrow();
    await expect(validateOwnerPdfBytes(Buffer.concat([syntheticPdf().subarray(0, -6), Buffer.from("PK\x03\x04\n%%EOF\n")]))).rejects.toThrow("isolated_parser_executable_or_polyglot");
    await expect(validateOwnerPdfBytes(syntheticPdf(), 512)).rejects.toThrow("isolated_parser_input_limit_exceeded");
    await expect(validateOwnerPdfBytes(syntheticPdf())).resolves.toMatchObject({
      parser_application_isolation: "PARSER_APPLICATION_ISOLATION_VERIFIED",
      parser_os_sandbox: "PARSER_OS_SANDBOX_NOT_VERIFIED",
    });
    expect(canonicalOwnerPdfReachability).toMatchObject({
      direct_in_process_owner_pdf_parser_reachable: false,
      application_isolation: "PARSER_APPLICATION_ISOLATION_VERIFIED",
      os_sandbox: "PARSER_OS_SANDBOX_NOT_VERIFIED",
    });
  }, 20_000);

  it("keeps real owner-attested imports disabled while OS sandboxing is unverified", async () => {
    const root = await temporaryRoot();
    const inbox = path.join(root, "incoming", "ACQ-V02-TEST");
    await mkdir(inbox, { recursive: true });
    const bytes = syntheticPdf("owner-import-disabled");
    await writeFile(path.join(inbox, "official.pdf"), bytes);
    await writeFile(path.join(inbox, "receipt.json"), JSON.stringify(receipt(bytes, {
      attestation_type: "owner_attestation",
      actor_type: "owner",
      acquisition_method: "owner_attested_official_download",
      test_only_notice: undefined,
    })));
    const syntheticRequest = request();
    const ownerRequest = acquisitionRequestSchema.parse({
      ...syntheticRequest,
      expected_document_identity: { title: "Test official PDF", artifact_sha256: null, identity_basis: "owner_must_confirm_official_record" },
      allowed_attestation_types: ["owner_attestation"],
      receipt_template: {
        acquisition_request_id: syntheticRequest.acquisition_request_id,
        source_id: syntheticRequest.source_id,
        landing_url: syntheticRequest.canonical_landing_url,
        artifact_url: syntheticRequest.artifact_url,
        final_url: syntheticRequest.artifact_url,
        expected_media_type: "application/pdf",
        expected_document_title: "Test official PDF",
        attestation_type: "owner_attestation",
        actor_type: "owner",
        acquisition_method: "owner_attested_official_download",
        unchanged_original: true,
        used_print_to_pdf: false,
      },
    });
    const input = {
      request: ownerRequest,
      incomingRoot: path.join(root, "incoming"),
      artifactRoot: path.join(root, "artifacts"),
      ledgerRoot: path.join(root, "ledger"),
      originalFilename: "official.pdf",
      receiptFilename: "receipt.json",
    };
    await expect(importOwnerOfficialArtifact(input)).rejects.toThrow("owner_import_disabled_parser_os_sandbox_not_verified");
    await expect(verifyOwnerAcquisitionLedger({ ledgerRoot: input.ledgerRoot, artifactRoot: input.artifactRoot })).resolves.toMatchObject({
      ledger_entries: 0,
      persistent_owner_import_entries: 0,
    });
  });

  it("imports atomically, verifies hashes and is idempotent for identical bytes", async () => {
    const root = await temporaryRoot();
    const inbox = path.join(root, "incoming", "ACQ-V02-TEST");
    await mkdir(inbox, { recursive: true });
    const bytes = syntheticPdf();
    await writeFile(path.join(inbox, "official.pdf"), bytes);
    await writeFile(path.join(inbox, "receipt.json"), JSON.stringify(receipt(bytes)));
    const input = { request: request(), incomingRoot: path.join(root, "incoming"), artifactRoot: path.join(root, "artifacts"), ledgerRoot: path.join(root, "ledger"), originalFilename: "official.pdf", receiptFilename: "receipt.json", now: () => "2026-08-29T00:00:01Z" };
    const first = await importOwnerOfficialArtifact(input);
    const second = await importOwnerOfficialArtifact(input);
    expect(first.created).toBe(true);
    expect(second.idempotent).toBe(true);
    expect(first.artifact_version).toMatchObject({ review_state: "needs_review", activation_state: "inactive", provenance: { acquisition_method: "synthetic_test_copy_existing_public_official_artifact" } });
    expect(await verifyOwnerAcquisitionLedger({ ledgerRoot: path.join(root, "ledger"), artifactRoot: path.join(root, "artifacts") })).toMatchObject({ ledger_entries: 1 });
  });

  it("rejects changed bytes under the already committed request/source identity", async () => {
    const root = await temporaryRoot();
    const inbox = path.join(root, "incoming", "ACQ-V02-TEST");
    await mkdir(inbox, { recursive: true });
    const firstBytes = syntheticPdf("first");
    const secondBytes = syntheticPdf("second");
    await writeFile(path.join(inbox, "receipt.json"), JSON.stringify(receipt(firstBytes)));
    const input = { request: request(firstBytes), incomingRoot: path.join(root, "incoming"), artifactRoot: path.join(root, "artifacts"), ledgerRoot: path.join(root, "ledger"), originalFilename: "official.pdf", receiptFilename: "receipt.json" };
    await writeFile(path.join(inbox, "official.pdf"), firstBytes);
    const first = await importOwnerOfficialArtifact(input);
    await writeFile(path.join(inbox, "official.pdf"), secondBytes);
    await writeFile(path.join(inbox, "receipt.json"), JSON.stringify(receipt(secondBytes)));
    await expect(importOwnerOfficialArtifact({ ...input, request: request(secondBytes) })).rejects.toThrow("immutable_target_mismatch");
    expect(first.artifact_version.artifact_sha256).not.toBe(hash(secondBytes));
    expect((await verifyOwnerAcquisitionLedger({ ledgerRoot: path.join(root, "ledger"), artifactRoot: path.join(root, "artifacts") })).ledger_entries).toBe(1);
  });

  it("rejects traversal, symlink escape, fake domains and tampered receipts", async () => {
    const root = await temporaryRoot();
    const inbox = path.join(root, "incoming", "ACQ-V02-TEST");
    await mkdir(inbox, { recursive: true });
    const bytes = syntheticPdf();
    await writeFile(path.join(inbox, "official.pdf"), bytes);
    await writeFile(path.join(inbox, "receipt.json"), JSON.stringify(receipt(bytes)));
    const base = { request: request(), incomingRoot: path.join(root, "incoming"), artifactRoot: path.join(root, "artifacts"), ledgerRoot: path.join(root, "ledger"), originalFilename: "official.pdf", receiptFilename: "receipt.json" };
    await expect(importOwnerOfficialArtifact({ ...base, originalFilename: "../official.pdf" })).rejects.toThrow("request_original_filename_mismatch");
    await writeFile(path.join(inbox, "receipt.json"), JSON.stringify(receipt(bytes, { final_url: "https://gov.il.evil.example/test.pdf" })));
    await expect(importOwnerOfficialArtifact(base)).rejects.toThrow("owner_receipt_final_url_host_not_allowlisted");
    await writeFile(path.join(inbox, "receipt.json"), JSON.stringify(receipt(bytes, { artifact_url: "https://www.gov.il/different.pdf" })));
    await expect(importOwnerOfficialArtifact(base)).rejects.toThrow("artifact_url_override_not_exactly_allowlisted");
    await writeFile(path.join(inbox, "receipt.json"), JSON.stringify({ ...receipt(bytes), unexpected: true }));
    await expect(importOwnerOfficialArtifact(base)).rejects.toThrow();
    if (process.platform === "win32") {
      const outside = path.join(root, "outside.pdf");
      await writeFile(outside, syntheticPdf());
      await rm(path.join(inbox, "official.pdf"));
      try {
        await symlink(outside, path.join(inbox, "official.pdf"), "file");
        await writeFile(path.join(inbox, "receipt.json"), JSON.stringify(receipt(bytes)));
        await expect(importOwnerOfficialArtifact(base)).rejects.toThrow("inbox_file_not_regular");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      }
    }
  });

  it("detects ledger tampering", async () => {
    const root = await temporaryRoot();
    const inbox = path.join(root, "incoming", "ACQ-V02-TEST");
    await mkdir(inbox, { recursive: true });
    const bytes = syntheticPdf();
    await writeFile(path.join(inbox, "official.pdf"), bytes);
    await writeFile(path.join(inbox, "receipt.json"), JSON.stringify(receipt(bytes)));
    const result = await importOwnerOfficialArtifact({ request: request(), incomingRoot: path.join(root, "incoming"), artifactRoot: path.join(root, "artifacts"), ledgerRoot: path.join(root, "ledger"), originalFilename: "official.pdf", receiptFilename: "receipt.json" });
    const artifactPath = path.join(root, "artifacts", "IL_TEST_SOURCE", "synthetic-test-v0.3.1", `${result.artifact_version.artifact_sha256}.pdf`);
    const original = await readFile(artifactPath);
    await writeFile(artifactPath, Buffer.concat([original, Buffer.from("tamper")]));
    await expect(verifyOwnerAcquisitionLedger({ ledgerRoot: path.join(root, "ledger"), artifactRoot: path.join(root, "artifacts") })).rejects.toThrow("controlled_commit_artifact_bytes_mismatch");
  });
}, 30_000);

describe("readiness outcomes", () => {
  it("uses the complete Wave 1 browser inventories without changing their discovery-only role", async () => {
    const browser = await loadBrowserObservations();
    const permits = browser.observations.find((observation) => observation.catalog_id === "IL_WORK_PERMITS_CATALOG");
    const publications = browser.observations.find((observation) => observation.catalog_id === "IL_HOURS_WORK_REST_LAW_PUBLICATIONS");
    expect(permits).toMatchObject({ status: "complete", result_count_reported: 58, discovery_only: true });
    expect(permits?.entries_observed).toHaveLength(58);
    expect(publications).toMatchObject({ status: "complete", result_count_reported: 20, discovery_only: true });
    expect(publications?.entries_observed).toHaveLength(20);
  });

  it("returns each acquisition readiness exit code deterministically", () => {
    expect(determineAcquisitionReadinessOutcome({ missingTargetIds: [], implementationComplete: true, ownerHandoffComplete: true, environmentBlocked: false }).exit_code).toBe(0);
    expect(determineAcquisitionReadinessOutcome({ missingTargetIds: ["A"], implementationComplete: false, ownerHandoffComplete: false, environmentBlocked: false }).exit_code).toBe(1);
    expect(determineAcquisitionReadinessOutcome({ missingTargetIds: ["A"], implementationComplete: true, ownerHandoffComplete: true, environmentBlocked: false }).exit_code).toBe(2);
    expect(determineAcquisitionReadinessOutcome({ missingTargetIds: [], implementationComplete: true, ownerHandoffComplete: true, environmentBlocked: true }).exit_code).toBe(3);
  });

  it("keeps corpus readiness non-zero", () => {
    expect(corpusReadinessOutcome()).toMatchObject({ exit_code: 1, status: "LEGAL_SOURCE_CORPUS_INCOMPLETE" });
  });
});
