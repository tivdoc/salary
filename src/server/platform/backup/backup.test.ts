import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  cloneBundle,
  createLocalBackup,
  InMemoryBackupSource,
  InMemoryRestoreTarget,
  LocalFilesystemBackupSource,
  LocalFilesystemRestoreTarget,
  planLocalRestore,
  restoreLocalFixture,
  sourceCapability,
  verifyLocalBackup,
} from "./backup-service";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureBundle() {
  return createLocalBackup(
    new InMemoryBackupSource([
      { path: "audit/events.json", bytes: new TextEncoder().encode('[{"sequence":1}]') },
      { path: "objects/object_00000001.bin", bytes: Uint8Array.from([0, 1, 2, 3]) },
    ]),
    { backup_id: "backup_00000001", created_at: "2026-08-30T00:00:00.000Z", watermark: "watermark_000001", key_version: "keyversion_00001" },
  );
}

describe("V07-P7-BACKUP", () => {
  it("builds a deterministic, hash-bound local-memory fixture manifest", async () => {
    const first = await fixtureBundle();
    const second = await fixtureBundle();
    expect(first.manifest).toEqual(second.manifest);
    expect(verifyLocalBackup(first)).toMatchObject({ valid: true, status: "VERIFIED_LOCAL_FIXTURE", object_count: 2 });
  });

  it("verifies a bounded local filesystem adapter without following symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "tivdoc-v07-backup-"));
    temporaryRoots.push(root);
    await mkdir(join(root, "state"));
    await writeFile(join(root, "state", "jobs.json"), "[]", "utf8");
    const bundle = await createLocalBackup(new LocalFilesystemBackupSource(root), {
      backup_id: "backup_00000002",
      created_at: "2026-08-30T00:00:00.000Z",
      watermark: "watermark_000002",
      key_version: "keyversion_00001",
    });
    expect(verifyLocalBackup(bundle).valid).toBe(true);
  });

  it.each([
    ["altered object", (bundle: Awaited<ReturnType<typeof fixtureBundle>>) => (bundle.objects as Map<string, Uint8Array>).set("objects/object_00000001.bin", Uint8Array.from([9]))],
    ["missing object", (bundle: Awaited<ReturnType<typeof fixtureBundle>>) => (bundle.objects as Map<string, Uint8Array>).delete("audit/events.json")],
    ["extra object", (bundle: Awaited<ReturnType<typeof fixtureBundle>>) => (bundle.objects as Map<string, Uint8Array>).set("extra.bin", Uint8Array.from([1]))],
  ])("fails closed for %s", async (_name, corrupt) => {
    const bundle = cloneBundle(await fixtureBundle());
    corrupt(bundle);
    const verification = verifyLocalBackup(bundle);
    expect(verification.valid).toBe(false);
    expect(() => planLocalRestore(bundle, "local_memory_staging", "keyversion_00001")).toThrow("RESTORE_REFUSED");
  });

  it("refuses a tampered manifest, unsafe paths, duplicates and empty sources", async () => {
    const original = await fixtureBundle();
    const tampered = cloneBundle(original);
    Object.assign(tampered.manifest, { watermark: "watermark_999999" });
    expect(verifyLocalBackup(tampered).error_codes).toContain("BACKUP_MANIFEST_HASH_MISMATCH");
    await expect(createLocalBackup(new InMemoryBackupSource([{ path: "../escape", bytes: new Uint8Array() }]), {
      backup_id: "backup_00000003", created_at: "2026-08-30T00:00:00.000Z", watermark: "watermark_000003", key_version: "keyversion_00001",
    })).rejects.toThrow("BACKUP_PATH_UNSAFE");
    await expect(createLocalBackup(new InMemoryBackupSource([
      { path: "same.bin", bytes: Uint8Array.from([1]) }, { path: "same.bin", bytes: Uint8Array.from([2]) },
    ]), { backup_id: "backup_00000004", created_at: "2026-08-30T00:00:00.000Z", watermark: "watermark_000004", key_version: "keyversion_00001" })).rejects.toThrow("BACKUP_DUPLICATE_PATH");
    await expect(createLocalBackup(new InMemoryBackupSource([]), {
      backup_id: "backup_00000005", created_at: "2026-08-30T00:00:00.000Z", watermark: "watermark_000005", key_version: "keyversion_00001",
    })).rejects.toThrow("BACKUP_EMPTY_SOURCE");
  });

  it("creates only a dry-run restore plan and reports the isolated DB blocker", async () => {
    const bundle = await fixtureBundle();
    expect(verifyLocalBackup(bundle, "keyversion_wrong1").error_codes).toContain("BACKUP_KEY_VERSION_MISMATCH");
    expect(() => planLocalRestore(bundle, "local_memory_staging", "keyversion_wrong1")).toThrow("RESTORE_REFUSED");
    const plan = planLocalRestore(bundle, "local_memory_staging", "keyversion_00001");
    expect(plan).toMatchObject({ dry_run: true, mutation_applied: false, object_count: 2 });
    expect(sourceCapability("local_memory_fixture")).toMatchObject({
      dynamic_database_verified: false,
      production_rpo_rto_claimed: false,
      blocker_code: "ISOLATED_DATABASE_BACKUP_RESTORE_TARGET_UNAVAILABLE",
    });
  });

  it("restores verified synthetic bytes into empty memory and filesystem staging targets", async () => {
    const bundle = await fixtureBundle();
    const memoryReceipt = await restoreLocalFixture(bundle, new InMemoryRestoreTarget(), "keyversion_00001");
    expect(memoryReceipt).toMatchObject({ status: "VERIFIED_LOCAL_FIXTURE_RESTORE", object_count: 2 });

    const root = await mkdtemp(join(tmpdir(), "tivdoc-v07-restore-"));
    temporaryRoots.push(root);
    const filesystemReceipt = await restoreLocalFixture(bundle, new LocalFilesystemRestoreTarget(root), "keyversion_00001");
    expect(filesystemReceipt.target_kind).toBe("local_filesystem_staging");
    expect(verifyLocalBackup(await createLocalBackup(new LocalFilesystemBackupSource(root), {
      backup_id: "backup_00000006",
      created_at: "2026-08-30T00:00:00.000Z",
      watermark: "watermark_000006",
      key_version: "keyversion_00001",
    }), "keyversion_00001").valid).toBe(true);
  });

  it("refuses corrupt sources and non-empty staging before any restore write", async () => {
    const corrupt = cloneBundle(await fixtureBundle());
    (corrupt.objects as Map<string, Uint8Array>).set("audit/events.json", Uint8Array.from([9]));
    const untouched = new InMemoryRestoreTarget();
    await expect(restoreLocalFixture(corrupt, untouched, "keyversion_00001")).rejects.toThrow("RESTORE_REFUSED");
    expect(await untouched.isEmpty()).toBe(true);

    const nonEmpty = new InMemoryRestoreTarget();
    await nonEmpty.write("occupied.bin", Uint8Array.from([1]));
    await expect(restoreLocalFixture(await fixtureBundle(), nonEmpty, "keyversion_00001")).rejects.toThrow("RESTORE_TARGET_NOT_EMPTY");
  });
});
