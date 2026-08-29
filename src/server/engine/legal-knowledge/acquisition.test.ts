import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquisitionRequestSchema } from "../../../engine/legal-knowledge/acquisition-contracts.ts";
import {
  corpusReadinessOutcome,
  determineAcquisitionReadinessOutcome,
  importOwnerOfficialArtifact,
  validateOwnerPdfBytes,
  verifyOwnerAcquisitionLedger,
} from "./acquisition.ts";

const temporaryRoots: string[] = [];

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

function request() {
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
    expected_document_identity: { title: "Test official PDF", artifact_sha256: null, identity_basis: "owner_must_confirm_official_record" },
    allowed_attestation_types: ["owner_attestation"],
    expected_document_title: "Test official PDF",
    recommended_filename: "official.pdf",
    failure_evidence: [{ stage: "fetch", safe_error_code: "http_status_403" }],
    receipt_template: {
      acquisition_request_id: "ACQ-V02-TEST",
      source_id: "IL_TEST_SOURCE",
      landing_url: "https://www.gov.il/test",
      expected_media_type: "application/pdf",
      expected_document_title: "Test official PDF",
      attestation_type: "owner_attestation",
      actor_type: "owner",
      acquisition_method: "owner_attested_official_download",
      unchanged_original: true,
      used_print_to_pdf: false,
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
    attestation_type: "owner_attestation",
    actor_type: "owner",
    acquisition_method: "owner_attested_official_download",
    unchanged_original: true,
    used_print_to_pdf: false,
    ...overrides,
  };
}

describe("controlled owner acquisition", () => {
  it("rejects HTML, encrypted, active, executable/polyglot and oversized inputs", () => {
    expect(() => validateOwnerPdfBytes(Buffer.from(`<html>${"x".repeat(600)}</html>`))).toThrow("owner_artifact_pdf_magic_mismatch");
    expect(() => validateOwnerPdfBytes(syntheticPdf("/Encrypt"))).toThrow("owner_artifact_encrypted");
    expect(() => validateOwnerPdfBytes(syntheticPdf("/JavaScript"))).toThrow("owner_artifact_active_content");
    expect(() => validateOwnerPdfBytes(Buffer.concat([Buffer.from("MZ"), syntheticPdf()]))).toThrow();
    expect(() => validateOwnerPdfBytes(Buffer.concat([syntheticPdf().subarray(0, -6), Buffer.from("PK\x03\x04\n%%EOF\n")]))).toThrow("owner_artifact_executable_or_polyglot");
    expect(() => validateOwnerPdfBytes(syntheticPdf(), 100)).toThrow("owner_artifact_too_large");
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
    expect(first.artifact_version).toMatchObject({ review_state: "needs_review", activation_state: "inactive", provenance: { acquisition_method: "owner_attested_official_download" } });
    expect(await verifyOwnerAcquisitionLedger({ ledgerRoot: path.join(root, "ledger"), artifactRoot: path.join(root, "artifacts") })).toMatchObject({ ledger_entries: 1 });
  });

  it("creates a separate immutable candidate for changed bytes", async () => {
    const root = await temporaryRoot();
    const inbox = path.join(root, "incoming", "ACQ-V02-TEST");
    await mkdir(inbox, { recursive: true });
    await writeFile(path.join(inbox, "receipt.json"), JSON.stringify(receipt(syntheticPdf("first"))));
    const input = { request: request(), incomingRoot: path.join(root, "incoming"), artifactRoot: path.join(root, "artifacts"), ledgerRoot: path.join(root, "ledger"), originalFilename: "official.pdf", receiptFilename: "receipt.json" };
    await writeFile(path.join(inbox, "official.pdf"), syntheticPdf("first"));
    const first = await importOwnerOfficialArtifact(input);
    await writeFile(path.join(inbox, "official.pdf"), syntheticPdf("second"));
    await writeFile(path.join(inbox, "receipt.json"), JSON.stringify(receipt(syntheticPdf("second"))));
    const second = await importOwnerOfficialArtifact(input);
    expect(second.artifact_version.artifact_sha256).not.toBe(first.artifact_version.artifact_sha256);
    expect((await verifyOwnerAcquisitionLedger({ ledgerRoot: path.join(root, "ledger"), artifactRoot: path.join(root, "artifacts") })).ledger_entries).toBe(2);
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
    const artifactPath = path.join(root, "artifacts", "IL_TEST_SOURCE", "owner-v0.3.1", `${result.artifact_version.artifact_sha256}.pdf`);
    const original = await readFile(artifactPath);
    await writeFile(artifactPath, Buffer.concat([original, Buffer.from("tamper")]));
    await expect(verifyOwnerAcquisitionLedger({ ledgerRoot: path.join(root, "ledger"), artifactRoot: path.join(root, "artifacts") })).rejects.toThrow("owner_ledger_artifact_hash_mismatch");
  });
});

describe("readiness outcomes", () => {
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
