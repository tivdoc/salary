import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquisitionRequestSchema } from "../../../../engine/legal-knowledge/acquisition-contracts.ts";
import { controlledImportIdentityKey, verifyControlledAcquisitionLedger } from "../controlled-import-security.ts";
import { controlledImportSha256, controlledImportStableJson } from "./protocol.ts";

const roots: string[] = [];
const notice = "TEST COPY OF EXISTING PUBLIC OFFICIAL ARTIFACT; NOT AN OWNER IMPORT" as const;
const worker = path.resolve(import.meta.dirname, "multiprocess-worker.mts");

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function sha256(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function pdf(marker: string) {
  return Buffer.from(`%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\n${`% ${marker}\n`.repeat(80)}xref\n0 4\ntrailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n0\n%%EOF\n`);
}

async function fixture(marker = "multiprocess", identity = "A") {
  const root = await mkdtemp(path.join(os.tmpdir(), "tivdoc-wave21-multiprocess-"));
  roots.push(root);
  const bytes = pdf(marker);
  const requestId = `ACQ-WAVE21-MP-${identity}`;
  const sourceId = `IL_SYNTHETIC_MP_${identity}`;
  const title = `Synthetic multi-process ${identity}`;
  const request = acquisitionRequestSchema.parse({
    acquisition_request_id: requestId,
    source_id: sourceId,
    instrument_id: `INSTRUMENT:IL:SYNTHETIC_MP_${identity}`,
    canonical_landing_url: "https://www.gov.il/test-record",
    artifact_url: "https://www.gov.il/test-record.pdf",
    allowlisted_hosts: ["www.gov.il"],
    allowed_artifact_urls: ["https://www.gov.il/test-record.pdf"],
    allowed_final_urls: ["https://www.gov.il/test-record.pdf"],
    expected_media_type: "application/pdf",
    expected_document_identity: { title, artifact_sha256: sha256(bytes), identity_basis: "known_existing_public_official_artifact_test_copy" },
    allowed_attestation_types: ["synthetic_test_attestation"],
    expected_document_title: title,
    recommended_filename: "synthetic.pdf",
    failure_evidence: [],
    receipt_template: {
      acquisition_request_id: requestId,
      source_id: sourceId,
      landing_url: "https://www.gov.il/test-record",
      artifact_url: "https://www.gov.il/test-record.pdf",
      final_url: "https://www.gov.il/test-record.pdf",
      artifact_sha256: sha256(bytes),
      expected_media_type: "application/pdf",
      expected_document_title: title,
      attestation_type: "synthetic_test_attestation",
      actor_type: "system_test",
      acquisition_method: "synthetic_test_copy_existing_public_official_artifact",
      unchanged_original: true,
      used_print_to_pdf: false,
      test_only_notice: notice,
    },
  });
  const incomingRoot = path.join(root, "incoming");
  const inbox = path.join(incomingRoot, requestId);
  await mkdir(inbox, { recursive: true });
  await writeFile(path.join(inbox, "synthetic.pdf"), bytes);
  await writeFile(path.join(inbox, "receipt.json"), JSON.stringify({
    ...request.receipt_template,
    original_filename: "synthetic.pdf",
    acquired_at: "2026-08-30T00:00:00Z",
  }));
  return {
    root,
    bytes,
    input: {
      request,
      incomingRoot,
      artifactRoot: path.join(root, "artifacts"),
      ledgerRoot: path.join(root, "ledger"),
      originalFilename: "synthetic.pdf",
      receiptFilename: "receipt.json",
    },
  };
}

async function run(input: unknown) {
  const config = path.join((input as { import_input?: { ledgerRoot?: string }; ledger_root?: string }).import_input?.ledgerRoot
    ?? (input as { ledger_root?: string }).ledger_root!, `.worker-${randomUUID()}.json`);
  await mkdir(path.dirname(config), { recursive: true });
  await writeFile(config, JSON.stringify(input));
  return await new Promise<{ code: number | null; result: { ok: boolean; created?: boolean; idempotent?: boolean; code?: string } }>((resolve) => {
    const child = spawn(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--experimental-strip-types", worker, config], { windowsHide: true });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.on("close", (code) => resolve({ code, result: JSON.parse(stdout.trim()) }));
  });
}

describe("real multi-process local controlled-import matrices", () => {
  it("serializes identical concurrent imports across processes", async () => {
    const item = await fixture();
    const [left, right] = await Promise.all([run({ mode: "import", import_input: item.input }), run({ mode: "import", import_input: item.input })]);
    expect([left.result, right.result].filter((entry) => entry.created)).toHaveLength(1);
    expect([left.result, right.result].filter((entry) => entry.idempotent)).toHaveLength(1);
    expect(await verifyControlledAcquisitionLedger({ ledgerRoot: item.input.ledgerRoot, artifactRoot: item.input.artifactRoot })).toMatchObject({
      ledger_entries: 1,
      persistent_owner_import_entries: 0,
      synthetic_test_import_entries: 1,
    });
  }, 20_000);

  it("fails closed for different bytes under one identity and identical bytes under conflicting identities", async () => {
    const first = await fixture("first", "CONFLICT");
    const secondBytes = pdf("different");
    const secondRoot = path.join(first.root, "incoming-other");
    const secondInbox = path.join(secondRoot, first.input.request.acquisition_request_id);
    await mkdir(secondInbox, { recursive: true });
    await writeFile(path.join(secondInbox, "synthetic.pdf"), secondBytes);
    await writeFile(path.join(secondInbox, "receipt.json"), JSON.stringify({
      ...first.input.request.receipt_template,
      artifact_sha256: sha256(secondBytes),
      original_filename: "synthetic.pdf",
      acquired_at: "2026-08-30T00:00:00Z",
    }));
    const changedRequest = acquisitionRequestSchema.parse({
      ...first.input.request,
      expected_document_identity: { ...first.input.request.expected_document_identity, artifact_sha256: sha256(secondBytes) },
      receipt_template: { ...first.input.request.receipt_template, artifact_sha256: sha256(secondBytes) },
    });
    const outcomes = await Promise.all([
      run({ mode: "import", import_input: first.input }),
      run({ mode: "import", import_input: { ...first.input, incomingRoot: secondRoot, request: changedRequest } }),
    ]);
    expect(outcomes.filter((entry) => entry.result.ok)).toHaveLength(1);
    expect(outcomes.filter((entry) => !entry.result.ok)).toHaveLength(1);

    const identityBase = await fixture("same-byte-identity", "IDENTITY");
    expect((await run({ mode: "import", import_input: identityBase.input })).result.ok).toBe(true);
    const conflictingTitle = "Conflicting identity for identical synthetic bytes";
    const conflictIncoming = path.join(identityBase.root, "incoming-identity-conflict");
    const conflictInbox = path.join(conflictIncoming, identityBase.input.request.acquisition_request_id);
    await mkdir(conflictInbox, { recursive: true });
    await writeFile(path.join(conflictInbox, "synthetic.pdf"), identityBase.bytes);
    await writeFile(path.join(conflictInbox, "receipt.json"), JSON.stringify({
      ...identityBase.input.request.receipt_template,
      expected_document_title: conflictingTitle,
      original_filename: "synthetic.pdf",
      acquired_at: "2026-08-30T00:00:00Z",
    }));
    const conflictingRequest = acquisitionRequestSchema.parse({
      ...identityBase.input.request,
      expected_document_title: conflictingTitle,
      expected_document_identity: { ...identityBase.input.request.expected_document_identity, title: conflictingTitle },
      receipt_template: { ...identityBase.input.request.receipt_template, expected_document_title: conflictingTitle },
    });
    expect(controlledImportIdentityKey(conflictingRequest.acquisition_request_id, conflictingRequest.source_id)).toBe(
      controlledImportIdentityKey(identityBase.input.request.acquisition_request_id, identityBase.input.request.source_id),
    );
    const conflict = await run({ mode: "import", import_input: { ...identityBase.input, incomingRoot: conflictIncoming, request: conflictingRequest } });
    expect(conflict.result).toMatchObject({ ok: false, code: "immutable_target_mismatch" });
  }, 20_000);

  it("takes over dead-process and PID-reuse-poisoned locks", async () => {
    for (const [label, pid, processStart] of [["stale", 2_147_483_647, 0], ["pid-reuse", process.pid, 0]] as const) {
      const item = await fixture(label, label.toUpperCase().replace("-", "_"));
      const lockKey = controlledImportSha256(controlledImportStableJson({
        acquisition_request_id: item.input.request.acquisition_request_id,
        source_id: item.input.request.source_id,
      }));
      const lockPath = path.join(item.input.ledgerRoot, ".locks", `${lockKey}.lock`);
      await mkdir(lockPath, { recursive: true });
      await writeFile(path.join(lockPath, "owner.json"), controlledImportStableJson({
        schema_version: "tivdoc-controlled-import-lock-v0.4.1",
        pid,
        token: randomUUID(),
        process_started_at_ms: processStart,
        heartbeat_at_ms: 0,
      }));
      const old = new Date(Date.now() - 60_000);
      await utimes(lockPath, old, old);
      const outcome = await run({ mode: "import", import_input: item.input });
      expect(outcome.result).toMatchObject({ ok: true, created: true });
    }
  }, 20_000);

  it("recovers after the process holding the identity lock is terminated", async () => {
    const item = await fixture("restart-lock", "RESTART");
    const ready = path.join(item.root, "lock-ready");
    const config = path.join(item.root, "hold.json");
    await writeFile(config, JSON.stringify({
      mode: "hold_lock",
      ledger_root: item.input.ledgerRoot,
      acquisition_request_id: item.input.request.acquisition_request_id,
      source_id: item.input.request.source_id,
      ready_path: ready,
    }));
    const child = spawn(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--experimental-strip-types", worker, config], { windowsHide: true });
    const closed = new Promise((resolve) => child.once("close", resolve));
    let lockReady = false;
    for (let index = 0; index < 500; index += 1) {
      try {
        await stat(ready);
        lockReady = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    expect(lockReady).toBe(true);
    child.kill();
    await closed;
    const outcome = await run({ mode: "import", import_input: item.input });
    expect(outcome.result).toMatchObject({ ok: true, created: true });
  }, 30_000);
});
