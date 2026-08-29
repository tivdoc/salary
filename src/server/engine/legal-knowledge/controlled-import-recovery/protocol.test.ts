import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  advanceControlledImportJournal,
  controlledImportSha256,
  controlledImportStableJson,
  createControlledImportJournalBinding,
  readControlledImportJournal,
  withControlledImportLock,
} from "./protocol.ts";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function binding() {
  return createControlledImportJournalBinding({
    request: { acquisition_request_id: "ACQ-WAVE2-RECOVERY", source_id: "IL_SYNTHETIC_SOURCE", nonce: "fixed" },
    acquisitionRequestId: "ACQ-WAVE2-RECOVERY",
    sourceId: "IL_SYNTHETIC_SOURCE",
    expectedFilename: "synthetic.pdf",
    expectedMediaType: "application/pdf",
    expectedArtifactSha256: "a".repeat(64),
    receiptInputSha256: "b".repeat(64),
  });
}

describe("controlled import recovery protocol", () => {
  it("accepts only the deterministic received-to-ledger sequence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tivdoc-wave2-journal-"));
    roots.push(root);
    const item = binding();
    await expect(advanceControlledImportJournal({ ledgerRoot: root, binding: item, stage: "validated" })).rejects.toThrow("controlled_import_journal_transition_invalid");
    await advanceControlledImportJournal({ ledgerRoot: root, binding: item, stage: "received" });
    await advanceControlledImportJournal({ ledgerRoot: root, binding: item, stage: "quarantined", privateArtifactSha256: "a".repeat(64), receiptSha256: "b".repeat(64) });
    await advanceControlledImportJournal({ ledgerRoot: root, binding: item, stage: "validated", privateArtifactSha256: "a".repeat(64), receiptSha256: "b".repeat(64) });
    await advanceControlledImportJournal({ ledgerRoot: root, binding: item, stage: "published", privateArtifactSha256: "a".repeat(64), receiptSha256: "b".repeat(64), publishedArtifactSha256: "a".repeat(64) });
    await advanceControlledImportJournal({ ledgerRoot: root, binding: item, stage: "ledger_appended", privateArtifactSha256: "a".repeat(64), receiptSha256: "b".repeat(64), publishedArtifactSha256: "a".repeat(64), ledgerRecordSha256: "c".repeat(64) });
    expect((await readControlledImportJournal(root, item.operation_id)).map((entry) => entry.stage)).toEqual(["received", "quarantined", "validated", "published", "ledger_appended"]);
  });

  it("serializes concurrent operations for the same request identity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tivdoc-wave2-lock-"));
    roots.push(root);
    let active = 0;
    let maximum = 0;
    await Promise.all(Array.from({ length: 8 }, () => withControlledImportLock({ ledgerRoot: root, acquisitionRequestId: "ACQ-WAVE2-LOCK", sourceId: "IL_SYNTHETIC_SOURCE" }, async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    })));
    expect(maximum).toBe(1);
  });

  it("waits through a freshly published lock whose owner file is incomplete", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tivdoc-wave2-incomplete-lock-"));
    const acquisitionRequestId = "ACQ-WAVE2-INCOMPLETE";
    const sourceId = "IL_SYNTHETIC_SOURCE";
    const lockKey = controlledImportSha256(controlledImportStableJson({
      acquisition_request_id: acquisitionRequestId,
      source_id: sourceId,
    }));
    const lockPath = path.join(root, ".locks", `${lockKey}.lock`);
    await mkdir(lockPath, { recursive: true });
    await writeFile(path.join(lockPath, "owner.json"), "{");
    setTimeout(() => void rm(lockPath, { recursive: true, force: true }), 25);

    const result = await withControlledImportLock({
      ledgerRoot: root,
      acquisitionRequestId,
      sourceId,
      timeoutMs: 1_000,
    }, async () => "acquired-after-owner-publication");

    expect(result).toBe("acquired-after-owner-publication");
  });

  it("takes over a lock whose owning process is no longer alive", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tivdoc-wave2-stale-lock-"));
    roots.push(root);
    const lockKey = controlledImportSha256(controlledImportStableJson({ acquisition_request_id: "ACQ-WAVE2-STALE", source_id: "IL_SYNTHETIC_SOURCE" }));
    const lockPath = path.join(root, ".locks", `${lockKey}.lock`);
    await mkdir(lockPath, { recursive: true });
    await writeFile(path.join(lockPath, "owner.json"), controlledImportStableJson({ pid: 2_147_483_647, token: "dead-owner" }));
    await expect(withControlledImportLock({ ledgerRoot: root, acquisitionRequestId: "ACQ-WAVE2-STALE", sourceId: "IL_SYNTHETIC_SOURCE" }, async () => "recovered")).resolves.toBe("recovered");
  });
});
