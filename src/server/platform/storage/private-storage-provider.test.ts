import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  HermeticFilesystemPrivateBlobProvider,
  SupabasePrivateBlobProvider,
  type SupabasePrivateStorageTransport,
} from "./private-storage-provider";

const roots: string[] = [];

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("MC-05 private blob providers", () => {
  it("keeps hermetic bytes quarantined until promotion and verifies every read", async () => {
    const root = await mkdtemp(join(tmpdir(), "tivdoc-provider-"));
    roots.push(root);
    const provider = new HermeticFilesystemPrivateBlobProvider({ root, environment: "generated_local_test_root" });
    const bytes = Uint8Array.from([1, 3, 5, 7]);
    const sha = sha256(bytes);
    const objectKey = `object_${sha.slice(0, 48)}`;
    const quarantined = await provider.putQuarantined({ object_key: objectKey, expected_sha256: sha, expected_length: bytes.byteLength, bytes });
    expect(quarantined.quarantine_locator.startsWith("quarantine/")).toBe(true);
    expect((await provider.inventory()).map((entry) => entry.locator)).toEqual([quarantined.quarantine_locator]);

    const active = await provider.promoteQuarantined({ ...quarantined, object_key: objectKey, expected_sha256: sha, expected_length: bytes.byteLength });
    expect(active.active_locator.startsWith("objects/")).toBe(true);
    expect(await provider.readExact({ locator: active.active_locator, expected_sha256: sha, expected_length: bytes.byteLength })).toEqual(bytes);
    expect(await provider.deleteExact({ locator: active.active_locator, expected_sha256: sha })).toEqual({ deleted: true });
    expect(await provider.inventory()).toEqual([]);
  });

  it("keeps the Supabase adapter fail closed without exact isolated platform proof", async () => {
    let calls = 0;
    const transport: SupabasePrivateStorageTransport = {
      uploadPrivate: async () => { calls += 1; },
      movePrivate: async () => { calls += 1; },
      downloadPrivate: async () => { calls += 1; return Uint8Array.from([1]); },
      removePrivate: async () => { calls += 1; return { deleted: true }; },
      listPrivate: async () => { calls += 1; return []; },
    };
    const provider = new SupabasePrivateBlobProvider({ bucket: "salary-documents", bucket_public: false, proof: null, transport });
    const bytes = Uint8Array.from([1]);
    await expect(provider.putQuarantined({ object_key: `object_${"a".repeat(48)}`, expected_sha256: sha256(bytes), expected_length: 1, bytes })).rejects.toThrow("SUPABASE_PRIVATE_STORAGE_PLATFORM_UNVERIFIED");
    expect(provider.managed_platform_verified).toBe(false);
    expect(calls).toBe(0);
  });

  it("rejects remote proof and public-bucket configuration before transport use", async () => {
    const remoteProof = Object.freeze({ capability_id: "MC-03", status: "PASS", target_class: "ISOLATED_LOCAL_SUPABASE", endpoint_origin: "https://remote.example", storage_private_policy_check: "PASS" } as const);
    const provider = new SupabasePrivateBlobProvider({ bucket: "salary-documents", bucket_public: false, proof: remoteProof, transport: null });
    expect(provider.managed_platform_verified).toBe(false);
    await expect(provider.inventory()).rejects.toThrow("SUPABASE_PRIVATE_STORAGE_PLATFORM_UNVERIFIED");
    expect(() => new SupabasePrivateBlobProvider({ bucket: "salary-documents", bucket_public: true as false, proof: null, transport: null })).toThrow("SUPABASE_PRIVATE_STORAGE_CONFIGURATION_INVALID");
  });
});
