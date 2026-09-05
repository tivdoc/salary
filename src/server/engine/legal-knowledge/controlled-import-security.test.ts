import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquisitionRequestSchema, type AcquisitionRequest } from "../../../engine/legal-knowledge/acquisition-contracts.ts";
import {
  controlledImportInstanceReadiness,
  controlledImportPersistentReadiness,
  probeControlledArtifactVisibility,
  importControlledOfficialArtifact,
  inspectControlledImportRecovery,
  scanControlledImportMetadata,
  validateArtifactUrlOverride,
  validateControlledPdfBytes,
  verifyControlledAcquisitionLedger,
} from "./controlled-import-security.ts";
import { createControlledImportJournalBinding, readControlledImportJournal } from "./controlled-import-recovery/protocol.ts";

const roots: string[] = [];
const testNotice = "TEST COPY OF EXISTING PUBLIC OFFICIAL ARTIFACT; NOT AN OWNER IMPORT" as const;

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function hash(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validPdf(marker = "baseline") {
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
${`% bounded test padding ${marker}\n`.repeat(24)}
xref
0 4
0000000000 65535 f
trailer
<< /Size 4 /Root 1 0 R >>
startxref
0
%%EOF
`);
}

function request(bytes: Uint8Array, overrides: Partial<AcquisitionRequest> = {}) {
  const title = "Existing public official artifact test copy";
  return acquisitionRequestSchema.parse({
    acquisition_request_id: "ACQ-V031-SYNTHETIC-IMPORT",
    source_id: "IL_SYNTHETIC_TEST_SOURCE",
    instrument_id: "INSTRUMENT:IL:SYNTHETIC_TEST",
    canonical_landing_url: "https://www.gov.il/test-record",
    artifact_url: "https://www.gov.il/test-record.pdf",
    allowlisted_hosts: ["www.gov.il"],
    allowed_artifact_urls: ["https://www.gov.il/test-record.pdf"],
    allowed_final_urls: ["https://www.gov.il/test-record.pdf"],
    expected_media_type: "application/pdf",
    expected_document_identity: { title, artifact_sha256: hash(bytes), identity_basis: "known_existing_public_official_artifact_test_copy" },
    allowed_attestation_types: ["synthetic_test_attestation"],
    expected_document_title: title,
    recommended_filename: "official-test-copy.pdf",
    failure_evidence: [],
    receipt_template: {
      acquisition_request_id: "ACQ-V031-SYNTHETIC-IMPORT",
      source_id: "IL_SYNTHETIC_TEST_SOURCE",
      landing_url: "https://www.gov.il/test-record",
      artifact_url: "https://www.gov.il/test-record.pdf",
      final_url: "https://www.gov.il/test-record.pdf",
      artifact_sha256: hash(bytes),
      expected_media_type: "application/pdf",
      expected_document_title: title,
      attestation_type: "synthetic_test_attestation",
      actor_type: "system_test",
      acquisition_method: "synthetic_test_copy_existing_public_official_artifact",
      unchanged_original: true,
      used_print_to_pdf: false,
      test_only_notice: testNotice,
    },
    ...overrides,
  });
}

function receipt(bytes: Uint8Array, overrides: Record<string, unknown> = {}) {
  return {
    acquisition_request_id: "ACQ-V031-SYNTHETIC-IMPORT",
    source_id: "IL_SYNTHETIC_TEST_SOURCE",
    original_filename: "official-test-copy.pdf",
    landing_url: "https://www.gov.il/test-record",
    artifact_url: "https://www.gov.il/test-record.pdf",
    final_url: "https://www.gov.il/test-record.pdf",
    artifact_sha256: hash(bytes),
    expected_media_type: "application/pdf",
    expected_document_title: "Existing public official artifact test copy",
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

async function fixture(bytes = validPdf()) {
  const root = await mkdtemp(path.join(os.tmpdir(), "tivdoc-controlled-import-security-"));
  roots.push(root);
  const acquisitionRequest = request(bytes);
  const inbox = path.join(root, "incoming", acquisitionRequest.acquisition_request_id);
  await mkdir(inbox, { recursive: true });
  await writeFile(path.join(inbox, acquisitionRequest.recommended_filename), bytes);
  await writeFile(path.join(inbox, "receipt.json"), JSON.stringify(receipt(bytes)));
  return {
    root,
    bytes,
    inbox,
    input: {
      request: acquisitionRequest,
      incomingRoot: path.join(root, "incoming"),
      artifactRoot: path.join(root, "artifacts"),
      ledgerRoot: path.join(root, "ledger"),
      originalFilename: acquisitionRequest.recommended_filename,
      receiptFilename: "receipt.json",
    },
  };
}

// Every case in this suite performs a real controlled import: bytes written,
// hashed, committed and re-read on disk. That is the mechanism and it is the
// same for all of them. Measured at roughly 1.4s alone; under full-suite
// parallelism they compete with the whole run for the filesystem and cross the
// 5s default. Raising cases one at a time only moves the failure to the next
// one, which is how this budget ended up on the file rather than on a case.
describe("controlled import E2E and atomic selection", () => {
  it("proves synthetic request to private-copy hash to immutable publish to ledger to strict verify", async () => {
    const item = await fixture();
    const imported = await importControlledOfficialArtifact(item.input);
    const replay = await importControlledOfficialArtifact(item.input);
    const verified = await verifyControlledAcquisitionLedger({
      ledgerRoot: item.input.ledgerRoot,
      artifactRoot: item.input.artifactRoot,
      requiredRequestIds: [item.input.request.acquisition_request_id],
      strictRequiredInstances: true,
    });
    expect(imported).toMatchObject({
      created: true,
      private_copy_sha256: hash(item.bytes),
      published_sha256: hash(item.bytes),
      attestation_type: "synthetic_test_attestation",
      test_only_notice: testNotice,
      parser_state: "screened_in_isolated_process",
      no_partial_selection_before_commit_marker: true,
      parser_isolation: "PARSER_APPLICATION_ISOLATION_VERIFIED",
      parser_os_sandbox: "PARSER_OS_SANDBOX_NOT_VERIFIED",
      artifact_version: { review_state: "needs_review", activation_state: "inactive", parse_state: "not_attempted" },
    });
    expect(replay.idempotent).toBe(true);
    expect(verified).toMatchObject({ status: "ACQUISITION_IMPORTS_VERIFIED", exit_code: 0, ledger_entries: 1, missing_required_request_ids: [] });
    expect(controlledImportInstanceReadiness(verified, item.input.request.acquisition_request_id)).toMatchObject({
      status: "TEST_ACQUISITION_INSTANCE_VERIFIED",
      ready: true,
      usable_for_legal_rules: false,
      activates_source: false,
    });
    expect(controlledImportPersistentReadiness(verified)).toMatchObject({
      status: "PERSISTENT_OWNER_IMPORTS_NOT_VERIFIED",
      ready: false,
      persistent_owner_import_entries: 0,
      synthetic_test_import_entries_excluded: 1,
    });
    // Measured at 1338ms alone; it timed out at the 5s default under full-suite
    // parallelism during Session B's freeze. Budget raised to well over 2x
    // measured per the flake-triage rule, with the measurement recorded rather
    // than the number picked. It does real filesystem work — writes a private
    // copy, hashes it, publishes it immutably, appends to the ledger and
    // verifies strictly — so it is slow by nature, not by accident.
  }, 20_000);

  it("rejects changed bytes under the same immutable request/source identity", async () => {
    const item = await fixture(validPdf("first"));
    const first = await importControlledOfficialArtifact(item.input);
    const changed = validPdf("changed" );
    const changedRequest = request(changed);
    await writeFile(path.join(item.inbox, "official-test-copy.pdf"), changed);
    await writeFile(path.join(item.inbox, "receipt.json"), JSON.stringify(receipt(changed)));
    await expect(importControlledOfficialArtifact({ ...item.input, request: changedRequest })).rejects.toThrow("immutable_target_mismatch");
    const verified = await verifyControlledAcquisitionLedger({ ledgerRoot: item.input.ledgerRoot, artifactRoot: item.input.artifactRoot });
    expect(first.artifact_version.artifact_sha256).not.toBe(hash(changed));
    expect(verified.ledger_entries).toBe(1);
    expect((await probeControlledArtifactVisibility({
      ledgerRoot: item.input.ledgerRoot,
      artifactRoot: item.input.artifactRoot,
      artifactSha256: hash(changed),
    })).visible).toBe(false);
  });

  it("uses the private snapshot when the incoming file changes after copy", async () => {
    const item = await fixture();
    const imported = await importControlledOfficialArtifact({
      ...item.input,
      afterPrivateCopyForTest: async () => writeFile(path.join(item.inbox, "official-test-copy.pdf"), validPdf("mutated-after-copy")),
    });
    expect(imported.private_copy_sha256).toBe(hash(item.bytes));
    expect(imported.published_sha256).toBe(hash(item.bytes));
  });

  it("is concurrency-safe for identical imports", async () => {
    const item = await fixture();
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => importControlledOfficialArtifact(item.input)));
    expect(outcomes.filter((result) => result.created)).toHaveLength(1);
    expect(outcomes.filter((result) => result.idempotent)).toHaveLength(7);
    expect((await verifyControlledAcquisitionLedger({ ledgerRoot: item.input.ledgerRoot, artifactRoot: item.input.artifactRoot })).ledger_entries).toBe(1);
  }, 20_000);

  it("leaves interrupted artifacts/events unreachable until the atomic commit marker", async () => {
    const afterArtifact = await fixture(validPdf("after-artifact"));
    await expect(importControlledOfficialArtifact({ ...afterArtifact.input, faultInjection: "after_artifact_publish" })).rejects.toThrow("injected_interruption_after_artifact_publish");
    expect(await inspectControlledImportRecovery({ ledgerRoot: afterArtifact.input.ledgerRoot, artifactRoot: afterArtifact.input.artifactRoot })).toMatchObject({
      committed_record_hashes: [],
      selectable_hashes: [],
      orphan_outputs_are_not_selectable: true,
    });
    const afterEvent = await fixture(validPdf("after-event"));
    await expect(importControlledOfficialArtifact({ ...afterEvent.input, faultInjection: "after_event_publish" })).rejects.toThrow("injected_interruption_after_event_publish");
    const recovery = await inspectControlledImportRecovery({ ledgerRoot: afterEvent.input.ledgerRoot, artifactRoot: afterEvent.input.artifactRoot });
    expect(recovery.committed_record_hashes).toEqual([]);
    expect(recovery.orphan_event_hashes).toEqual([hash(afterEvent.bytes)]);
    expect(recovery.orphan_artifact_hashes).toEqual([hash(afterEvent.bytes)]);
    expect(recovery.selectable_hashes).toEqual([]);
    expect((await importControlledOfficialArtifact(afterEvent.input)).created).toBe(true);
  });

  it.each([
    ["after_received", "received"],
    ["after_private_copy", "quarantined"],
    ["after_validation", "validated"],
    ["after_artifact_publish", "published"],
    ["after_event_publish", "published"],
    ["after_ledger_append", "ledger_appended"],
  ] as const)("recovers deterministically after crash injection %s", async (faultInjection, lastStage) => {
    const item = await fixture(validPdf(faultInjection));
    let signalCheckpoint!: () => void;
    let releaseCheckpoint!: () => void;
    const checkpoint = new Promise<void>((resolve) => { signalCheckpoint = resolve; });
    const released = new Promise<void>((resolve) => { releaseCheckpoint = resolve; });
    const attempt = importControlledOfficialArtifact({
      ...item.input,
      faultInjection,
      afterCheckpointForTest: async (current) => {
        if (current !== faultInjection) return;
        signalCheckpoint();
        await released;
      },
    });
    await checkpoint;
    expect(await probeControlledArtifactVisibility({
      ledgerRoot: item.input.ledgerRoot,
      artifactRoot: item.input.artifactRoot,
      artifactSha256: hash(item.bytes),
    })).toMatchObject({ visible: false, parse_result: null, citations: [], chunks: [], retrieval_results: [] });
    releaseCheckpoint();
    await expect(attempt).rejects.toThrow(`injected_interruption_${faultInjection}`);
    const binding = createControlledImportJournalBinding({
      request: item.input.request,
      acquisitionRequestId: item.input.request.acquisition_request_id,
      sourceId: item.input.request.source_id,
      expectedFilename: item.input.request.recommended_filename,
      expectedMediaType: item.input.request.expected_media_type,
      expectedArtifactSha256: item.input.request.expected_document_identity.artifact_sha256 ?? null,
      receiptInputSha256: hash(Buffer.from(JSON.stringify(receipt(item.bytes)))),
    });
    expect((await readControlledImportJournal(item.input.ledgerRoot, binding.operation_id)).at(-1)?.stage).toBe(lastStage);
    expect(await probeControlledArtifactVisibility({
      ledgerRoot: item.input.ledgerRoot,
      artifactRoot: item.input.artifactRoot,
      artifactSha256: hash(item.bytes),
    })).toMatchObject({
      visible: false,
      parse_result: null,
      citations: [],
      chunks: [],
      retrieval_results: [],
    });
    const recovered = await importControlledOfficialArtifact(item.input);
    const journal = await readControlledImportJournal(item.input.ledgerRoot, binding.operation_id);
    expect(journal.map((entry) => entry.stage)).toEqual(["received", "quarantined", "validated", "published", "ledger_appended"]);
    expect(recovered.ledger_committed).toBe(true);
    expect((await inspectControlledImportRecovery({ ledgerRoot: item.input.ledgerRoot, artifactRoot: item.input.artifactRoot })).selectable_hashes).toEqual([hash(item.bytes)]);
  }, 20_000);

  it("keeps the canonical reader fail-closed while it races published bytes", async () => {
    const item = await fixture(validPdf("reader-race"));
    let signalPublished!: () => void;
    let releaseCommit!: () => void;
    const published = new Promise<void>((resolve) => { signalPublished = resolve; });
    const mayCommit = new Promise<void>((resolve) => { releaseCommit = resolve; });
    const importing = importControlledOfficialArtifact({
      ...item.input,
      afterArtifactPublishForTest: async () => {
        signalPublished();
        await mayCommit;
      },
    });
    await published;
    expect(await probeControlledArtifactVisibility({
      ledgerRoot: item.input.ledgerRoot,
      artifactRoot: item.input.artifactRoot,
      artifactSha256: hash(item.bytes),
    })).toMatchObject({ visible: false, parse_result: null, citations: [], chunks: [], retrieval_results: [] });
    releaseCommit();
    await importing;
    expect(await probeControlledArtifactVisibility({
      ledgerRoot: item.input.ledgerRoot,
      artifactRoot: item.input.artifactRoot,
      artifactSha256: hash(item.bytes),
    })).toMatchObject({ visible: true, commit_state: "committed" });
  });

  it("makes the atomically committed marker visible even if the caller crashes immediately after it", async () => {
    const item = await fixture(validPdf("after-commit-marker"));
    let signalCheckpoint!: () => void;
    let releaseCheckpoint!: () => void;
    const checkpoint = new Promise<void>((resolve) => { signalCheckpoint = resolve; });
    const released = new Promise<void>((resolve) => { releaseCheckpoint = resolve; });
    const attempt = importControlledOfficialArtifact({
      ...item.input,
      faultInjection: "after_commit_marker",
      afterCheckpointForTest: async (current) => {
        if (current !== "after_commit_marker") return;
        signalCheckpoint();
        await released;
      },
    });
    await checkpoint;
    expect(await probeControlledArtifactVisibility({
      ledgerRoot: item.input.ledgerRoot,
      artifactRoot: item.input.artifactRoot,
      artifactSha256: hash(item.bytes),
    })).toMatchObject({ visible: true, commit_state: "committed" });
    releaseCheckpoint();
    await expect(attempt).rejects.toThrow("injected_interruption_after_commit_marker");
    expect((await importControlledOfficialArtifact(item.input)).idempotent).toBe(true);
  });

  it.each(["journal", "event", "ledger", "commit-marker"] as const)("hides a committed artifact when its %s is truncated", async (recordKind) => {
    const item = await fixture(validPdf(`truncate-${recordKind}`));
    const imported = await importControlledOfficialArtifact(item.input);
    const artifactSha256 = hash(item.bytes);
    const target = recordKind === "journal"
      ? path.join(item.input.ledgerRoot, ".journals", imported.journal_operation_id, "0005-ledger_appended.json")
      : recordKind === "event"
        ? path.join(item.input.ledgerRoot, "events", `${artifactSha256}.json`)
        : recordKind === "ledger"
          ? path.join(item.input.ledgerRoot, `${artifactSha256}.json`)
          : path.join(item.input.ledgerRoot, ".commits", `${artifactSha256}.json`);
    await writeFile(target, "{");
    expect(await probeControlledArtifactVisibility({
      ledgerRoot: item.input.ledgerRoot,
      artifactRoot: item.input.artifactRoot,
      artifactSha256,
    })).toMatchObject({ visible: false, parse_result: null, citations: [], chunks: [], retrieval_results: [] });
  });

  it("recovers the exact quarantined private inputs when the inbox is no longer present", async () => {
    const item = await fixture(validPdf("inbox-removed-after-quarantine"));
    await expect(importControlledOfficialArtifact({ ...item.input, faultInjection: "after_private_copy" })).rejects.toThrow("injected_interruption_after_private_copy");
    await rm(item.inbox, { recursive: true, force: true });
    const recovered = await importControlledOfficialArtifact(item.input);
    expect(recovered).toMatchObject({ ledger_committed: true, private_copy_sha256: hash(item.bytes), published_sha256: hash(item.bytes) });
  });

  it("rejects the same bytes under a conflicting bound identity without a second ledger record", async () => {
    const item = await fixture();
    await importControlledOfficialArtifact(item.input);
    const conflictingTitle = "Conflicting synthetic document identity";
    const baseRequest = request(item.bytes);
    const conflictingRequest = acquisitionRequestSchema.parse({
      ...baseRequest,
      expected_document_title: conflictingTitle,
      expected_document_identity: { title: conflictingTitle, artifact_sha256: hash(item.bytes), identity_basis: "known_existing_public_official_artifact_test_copy" },
      receipt_template: { ...baseRequest.receipt_template, expected_document_title: conflictingTitle },
    });
    await writeFile(path.join(item.inbox, "receipt.json"), JSON.stringify(receipt(item.bytes, { expected_document_title: conflictingTitle })));
    await expect(importControlledOfficialArtifact({ ...item.input, request: conflictingRequest })).rejects.toThrow("immutable_target_mismatch");
    const verified = await verifyControlledAcquisitionLedger({ ledgerRoot: item.input.ledgerRoot, artifactRoot: item.input.artifactRoot });
    expect(verified).toMatchObject({ ledger_entries: 1, persistent_owner_import_entries: 0, synthetic_test_import_entries: 1 });
  });

  it("quarantines different bytes supplied under the same expected identity", async () => {
    const expected = validPdf("expected-identity");
    const item = await fixture(expected);
    const different = validPdf("different-bytes");
    await writeFile(path.join(item.inbox, "official-test-copy.pdf"), different);
    await writeFile(path.join(item.inbox, "receipt.json"), JSON.stringify(receipt(different)));
    await expect(importControlledOfficialArtifact(item.input)).rejects.toThrow("request_document_hash_mismatch");
    const binding = createControlledImportJournalBinding({
      request: item.input.request,
      acquisitionRequestId: item.input.request.acquisition_request_id,
      sourceId: item.input.request.source_id,
      expectedFilename: item.input.request.recommended_filename,
      expectedMediaType: item.input.request.expected_media_type,
      expectedArtifactSha256: item.input.request.expected_document_identity.artifact_sha256 ?? null,
      receiptInputSha256: hash(Buffer.from(JSON.stringify(receipt(different)))),
    });
    expect((await readControlledImportJournal(item.input.ledgerRoot, binding.operation_id)).at(-1)?.stage).toBe("rejected");
    expect((await inspectControlledImportRecovery({ ledgerRoot: item.input.ledgerRoot, artifactRoot: item.input.artifactRoot })).selectable_hashes).toEqual([]);
  });

  it("distinguishes empty verification and strict missing-instance verification", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tivdoc-controlled-import-empty-"));
    roots.push(root);
    const empty = await verifyControlledAcquisitionLedger({ ledgerRoot: path.join(root, "ledger"), artifactRoot: path.join(root, "artifacts") });
    const strict = await verifyControlledAcquisitionLedger({
      ledgerRoot: path.join(root, "ledger"),
      artifactRoot: path.join(root, "artifacts"),
      requiredRequestIds: ["ACQ-V031-REQUIRED"],
      strictRequiredInstances: true,
    });
    expect(empty).toMatchObject({ status: "NO_IMPORTS_TO_VERIFY", exit_code: 0, ledger_entries: 0 });
    expect(strict).toMatchObject({ status: "REQUIRED_IMPORTS_MISSING", exit_code: 4, missing_required_request_ids: ["ACQ-V031-REQUIRED"] });
  });
}, 30_000);

describe("receipt, request, URL, media and identity binding", () => {
  it.each([
    ["request id", { acquisition_request_id: "ACQ-V031-WRONG" }, "owner_receipt_request_mismatch"],
    ["source id", { source_id: "IL_WRONG_SOURCE" }, "owner_receipt_request_mismatch"],
    ["filename", { original_filename: "wrong.pdf" }, "owner_receipt_filename_mismatch"],
    ["hash", { artifact_sha256: "f".repeat(64) }, "owner_receipt_artifact_hash_mismatch"],
    ["media", { expected_media_type: "text/html" }, "Invalid input"],
    ["title", { expected_document_title: "Wrong document" }, "owner_receipt_document_identity_mismatch"],
    ["artifact path", { artifact_url: "https://www.gov.il/other.pdf" }, "artifact_url_override_not_exactly_allowlisted"],
    ["final path", { final_url: "https://www.gov.il/other.pdf" }, "owner_receipt_final_url_not_exactly_allowlisted"],
    ["host", { final_url: "https://www.gov.il.evil.example/test.pdf" }, "owner_receipt_final_url_host_not_allowlisted"],
  ])("rejects tampered %s", async (_label, override, expected) => {
    const item = await fixture();
    await writeFile(path.join(item.inbox, "receipt.json"), JSON.stringify(receipt(item.bytes, override)));
    await expect(importControlledOfficialArtifact(item.input)).rejects.toThrow(expected);
  });

  it("does not let artifact-url override binding, TLS, host or exact path", () => {
    const bytes = validPdf();
    const acquisitionRequest = request(bytes);
    expect(validateArtifactUrlOverride(acquisitionRequest, "https://www.gov.il/test-record.pdf")).toContain("https://");
    expect(() => validateArtifactUrlOverride(acquisitionRequest, "http://www.gov.il/test-record.pdf")).toThrow("artifact_url_override_invalid");
    expect(() => validateArtifactUrlOverride(acquisitionRequest, "https://www.gov.il.evil.example/test-record.pdf")).toThrow("artifact_url_override_host_not_allowlisted");
    expect(() => validateArtifactUrlOverride(acquisitionRequest, "https://www.gov.il/other.pdf")).toThrow("artifact_url_override_not_exactly_allowlisted");
  });

  // External review #1, findings 6 and 9. The י"פ 7287 excerpt the reviewer
  // named sits on a law firm's site and the §18 judgment on court and legal
  // database sites; none is an official source host, and the controlled path
  // refuses them by name before any byte is fetched. V5 therefore stays
  // "partially verified" and the base rule stays unbound until the owner
  // brings the official record through the path (Reshumot on gov.il).
  it.each([
    ["the law firm's excerpt of י\"פ 7287", "https://www.goldfarb.com/wp-content/uploads/2016/06/yalkut-7287.pdf"],
    ["the court's judgment page", "https://www.gov.il.court-mirror.example/verdicts/38313-03-18.pdf"],
    ["a legal database's copy", "https://www.nevo.co.il/psika_html/avoda/A-38313-03-18.htm"],
  ])("refuses %s as a host that is not allowlisted", (_label, url) => {
    const acquisitionRequest = request(validPdf());
    expect(() => validateArtifactUrlOverride(acquisitionRequest, url)).toThrow("artifact_url_override_host_not_allowlisted");
  });

  it("rejects a wrong receipt file selection", async () => {
    const item = await fixture();
    await writeFile(path.join(item.inbox, "alternate.json"), JSON.stringify(receipt(item.bytes)));
    await expect(importControlledOfficialArtifact({ ...item.input, receiptFilename: "alternate.json" })).rejects.toThrow("request_receipt_filename_mismatch");
  });

  it("rejects secret, PII, session and local-path metadata", () => {
    for (const unsafe of [
      { cookie: "session=abc" },
      { header: "Bearer abcdefghijklmnopqrstuvwxyz" },
      { path: "C:\\Users\\private-user\\Downloads\\file.pdf" },
      { contact: "person@example.com" },
      { url: "https://www.gov.il/test.pdf?token=secret" },
      { exif: { gps: "1,2" } },
    ]) expect(scanControlledImportMetadata(unsafe).safe).toBe(false);
    expect(scanControlledImportMetadata({ safe_error_code: "test_only", host: "www.gov.il" })).toEqual({ safe: true, findings: [] });
  });
});

describe("Windows and filesystem path hardening", () => {
  it.each([
    "../official.pdf",
    "C:\\temp\\official.pdf",
    "\\\\server\\share\\official.pdf",
    "official.pdf:secret",
    "CON.pdf",
    "NUL",
    "official.pdf.",
    " official.pdf",
  ])("rejects portable-path attack %s", (filename) => {
    const bytes = validPdf();
    expect(() => acquisitionRequestSchema.parse({ ...request(bytes), recommended_filename: filename })).toThrow();
  });

  it("rejects a case-colliding filename", async () => {
    const item = await fixture();
    const collidingRequest = request(item.bytes, { recommended_filename: "Official-Test-Copy.pdf" });
    await writeFile(path.join(item.inbox, "receipt.json"), JSON.stringify(receipt(item.bytes, { original_filename: "Official-Test-Copy.pdf" })));
    await expect(importControlledOfficialArtifact({ ...item.input, request: collidingRequest, originalFilename: "Official-Test-Copy.pdf" })).rejects.toThrow("inbox_filename_case_collision");
  });

  it("rejects hardlinks", async () => {
    const item = await fixture();
    const outside = path.join(item.root, "outside.pdf");
    await writeFile(outside, item.bytes);
    await rm(path.join(item.inbox, "official-test-copy.pdf"));
    await link(outside, path.join(item.inbox, "official-test-copy.pdf"));
    await expect(importControlledOfficialArtifact(item.input)).rejects.toThrow("inbox_hardlink_forbidden");
  });

  it("rejects symlinked files and junction/reparse inboxes when supported", async () => {
    const item = await fixture();
    const outside = path.join(item.root, "outside.pdf");
    await writeFile(outside, item.bytes);
    await rm(path.join(item.inbox, "official-test-copy.pdf"));
    try {
      await symlink(outside, path.join(item.inbox, "official-test-copy.pdf"), "file");
      await expect(importControlledOfficialArtifact(item.input)).rejects.toThrow();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }

    const junctionRoot = await mkdtemp(path.join(os.tmpdir(), "tivdoc-controlled-import-junction-"));
    roots.push(junctionRoot);
    const outsideInbox = path.join(junctionRoot, "outside-inbox");
    await mkdir(outsideInbox, { recursive: true });
    await writeFile(path.join(outsideInbox, "official-test-copy.pdf"), item.bytes);
    await writeFile(path.join(outsideInbox, "receipt.json"), JSON.stringify(receipt(item.bytes)));
    const incoming = path.join(junctionRoot, "incoming");
    await mkdir(incoming, { recursive: true });
    try {
      await symlink(outsideInbox, path.join(incoming, item.input.request.acquisition_request_id), process.platform === "win32" ? "junction" : "dir");
      await expect(importControlledOfficialArtifact({ ...item.input, incomingRoot: incoming, artifactRoot: path.join(junctionRoot, "artifacts"), ledgerRoot: path.join(junctionRoot, "ledger") })).rejects.toThrow("controlled_path_reparse_point_forbidden");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
  });

  it("rejects a junction/reparse ledger root when supported", async () => {
    const item = await fixture();
    const outsideLedger = path.join(item.root, "outside-ledger");
    await mkdir(outsideLedger, { recursive: true });
    const linkedLedger = path.join(item.root, "linked-ledger");
    try {
      await symlink(outsideLedger, linkedLedger, process.platform === "win32" ? "junction" : "dir");
      await expect(importControlledOfficialArtifact({ ...item.input, ledgerRoot: linkedLedger })).rejects.toThrow("controlled_path_reparse_point_forbidden");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
  });
});

describe("bounded PDF validation and quarantine non-reachability", () => {
  it.each([
    ["HTML", Buffer.from(`<html>${"x".repeat(600)}</html>`), "owner_artifact_pdf_magic_mismatch"],
    ["encrypted", validPdf("/Encrypt"), "owner_artifact_encrypted"],
    ["actions", validPdf("/JavaScript /OpenAction"), "owner_artifact_active_content"],
    ["embedded", validPdf("/EmbeddedFile /Filespec"), "owner_artifact_embedded_content"],
    ["external", validPdf("/URI (https://example.invalid)"), "owner_artifact_external_reference"],
    ["page bomb", validPdf("/Count 999999"), "owner_artifact_page_limit_exceeded"],
    ["stream bomb", validPdf("/Length 999999999"), "owner_artifact_declared_stream_limit_exceeded"],
    ["corrupt object", Buffer.from(validPdf().toString("latin1").replace("endobj", "broken")), "owner_artifact_object_structure_invalid"],
    ["missing xref", Buffer.from(validPdf().toString("latin1").replace("xref", "xxxx").replace("startxref", "startxxxx")), "owner_artifact_xref_missing_or_corrupt"],
    ["trailing polyglot", Buffer.concat([validPdf(), Buffer.from("PK\x03\x04")]), "owner_artifact_polyglot_trailing_payload"],
    ["zip polyglot", Buffer.from(validPdf().toString("latin1").replace("% bounded", "PK\x03\x04 bounded"), "latin1"), "owner_artifact_executable_or_polyglot"],
  ])("rejects %s", (_label, bytes, code) => {
    expect(() => validateControlledPdfBytes(bytes)).toThrow(code);
  });

  it("rejects oversize input before parsing", () => {
    expect(() => validateControlledPdfBytes(validPdf(), 100)).toThrow("owner_artifact_too_large");
  });

  it("does not select a quarantined challenge outside the committed ledger", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tivdoc-controlled-import-quarantine-"));
    roots.push(root);
    await mkdir(path.join(root, "quarantine"), { recursive: true });
    await writeFile(path.join(root, "quarantine", "challenge.html"), `<html>${"x".repeat(600)}</html>`);
    const verification = await verifyControlledAcquisitionLedger({ ledgerRoot: path.join(root, "ledger"), artifactRoot: path.join(root, "artifacts") });
    const recovery = await inspectControlledImportRecovery({ ledgerRoot: path.join(root, "ledger"), artifactRoot: path.join(root, "artifacts") });
    expect(verification).toMatchObject({ status: "NO_IMPORTS_TO_VERIFY", verified_artifact_version_ids: [] });
    expect(recovery.selectable_hashes).toEqual([]);
  });
});
