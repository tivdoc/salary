import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalRuntimePrivateBlobProvider } from "./private-blob-provider.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("V0.10.2 local private immutable filesystem storage", () => {
  it("writes, promotes and replays an exact content-addressed object without exposing its root", async () => {
    const { provider, root } = await fixture();
    const bytes = Uint8Array.from(Buffer.from("synthetic exact report bytes", "utf8"));
    const hash = sha256(bytes);
    const stagingKey = `object_${"1".repeat(48)}`;
    const finalKey = `object_${"2".repeat(48)}`;

    const peer = new LocalRuntimePrivateBlobProvider({
      root,
      runtime_class: "ignored_local_private_filesystem",
      publicly_addressable: false,
      managed_platform_verified: false,
    });
    const [first, replay] = await Promise.all([provider, peer].map((writer) => writer.putQuarantined({
      object_key: stagingKey,
      expected_sha256: hash,
      expected_length: bytes.byteLength,
      bytes,
    })));
    expect(replay).toEqual(first);

    const active = await provider.promoteQuarantined({
      quarantine_locator: first.quarantine_locator,
      object_key: finalKey,
      expected_sha256: hash,
      expected_length: bytes.byteLength,
    });
    expect(await provider.promoteQuarantined({
      quarantine_locator: first.quarantine_locator,
      object_key: finalKey,
      expected_sha256: hash,
      expected_length: bytes.byteLength,
    })).toEqual(active);
    expect(await provider.readExact({
      locator: active.active_locator,
      expected_sha256: hash,
      expected_length: bytes.byteLength,
    })).toEqual(bytes);
    expect(await provider.inventory()).toEqual([{
      locator: active.active_locator,
      sha256: hash,
      byte_count: bytes.byteLength,
    }]);
    expect(provider.proof()).toMatchObject({
      provider_kind: "local_private_immutable_filesystem",
      managed_platform_verified: false,
      publicly_addressable: false,
      immutable_active_objects: true,
      absolute_path_disclosed: false,
    });
    expect(JSON.stringify(provider.proof())).not.toContain(root);
    await expect(provider.deleteExact({ locator: active.active_locator, expected_sha256: hash }))
      .rejects.toThrow("LOCAL_PRIVATE_STORAGE_ACTIVE_DELETE_FORBIDDEN");
  });

  it("fails closed after an out-of-band byte mutation", async () => {
    const { provider, root } = await fixture();
    const bytes = Uint8Array.from([1, 3, 5, 7]);
    const hash = sha256(bytes);
    const key = `object_${"3".repeat(48)}`;
    const staged = await provider.putQuarantined({
      object_key: key,
      expected_sha256: hash,
      expected_length: bytes.byteLength,
      bytes,
    });
    await writeFile(join(root, ...staged.quarantine_locator.split("/")), Uint8Array.from([7, 5, 3, 1]));
    await expect(provider.readExact({
      locator: staged.quarantine_locator,
      expected_sha256: hash,
      expected_length: bytes.byteLength,
    })).rejects.toThrow("LOCAL_PRIVATE_STORAGE_INTEGRITY_FAILURE");
  });

  it("rejects public, managed, relative and broadly named roots", async () => {
    const root = join(tmpdir(), "tivdoc-private-runtime-config");
    expect(() => new LocalRuntimePrivateBlobProvider({
      root,
      runtime_class: "ignored_local_private_filesystem",
      publicly_addressable: true as false,
      managed_platform_verified: false,
    })).toThrow("LOCAL_PRIVATE_STORAGE_CONFIGURATION_INVALID");
    expect(() => new LocalRuntimePrivateBlobProvider({
      root,
      runtime_class: "ignored_local_private_filesystem",
      publicly_addressable: false,
      managed_platform_verified: true as false,
    })).toThrow("LOCAL_PRIVATE_STORAGE_CONFIGURATION_INVALID");
    expect(() => new LocalRuntimePrivateBlobProvider({
      root: "relative-storage",
      runtime_class: "ignored_local_private_filesystem",
      publicly_addressable: false,
      managed_platform_verified: false,
    })).toThrow("LOCAL_PRIVATE_STORAGE_CONFIGURATION_INVALID");
    expect(() => new LocalRuntimePrivateBlobProvider({
      root: join(tmpdir(), "generic-storage"),
      runtime_class: "ignored_local_private_filesystem",
      publicly_addressable: false,
      managed_platform_verified: false,
    })).toThrow("LOCAL_PRIVATE_STORAGE_ROOT_UNSAFE");
  });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tivdoc-private-runtime-"));
  roots.push(root);
  return {
    root,
    provider: new LocalRuntimePrivateBlobProvider({
      root,
      runtime_class: "ignored_local_private_filesystem",
      publicly_addressable: false,
      managed_platform_verified: false,
    }),
  };
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
