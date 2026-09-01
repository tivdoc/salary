import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, parse, resolve, sep } from "node:path";

import type {
  PrivateBlobInventoryEntry,
  PrivateBlobProvider,
} from "../private-storage-provider.ts";

export const LOCAL_RUNTIME_PRIVATE_STORAGE_SCHEMA_VERSION =
  "tivdoc-local-private-immutable-storage-v0.10.2" as const;

const SHA256 = /^[a-f0-9]{64}$/u;
const OBJECT_KEY = /^object_[a-f0-9]{48}$/u;
const LOCATOR = /^(?:objects|quarantine)\/[a-f0-9]{2}\/object_[a-f0-9]{48}$/u;
const ROOT_PREFIX = "tivdoc-private-runtime-";

export type LocalRuntimePrivateStorageProof = Readonly<{
  schema_version: typeof LOCAL_RUNTIME_PRIVATE_STORAGE_SCHEMA_VERSION;
  provider_kind: "local_private_immutable_filesystem";
  root_binding_sha256: string;
  publicly_addressable: false;
  managed_platform_verified: false;
  immutable_active_objects: true;
  quarantine_retained_for_transaction_recovery: true;
  content_hash_verified_on_every_read: true;
  absolute_path_disclosed: false;
}>;

/**
 * A real local-filesystem adapter for the non-managed runtime lane.
 *
 * The inherited provider_kind value is retained for compatibility with the
 * canonical blob port. `proof()` is the authoritative capability projection:
 * it never claims managed storage and never discloses the absolute root.
 */
export class LocalRuntimePrivateBlobProvider implements PrivateBlobProvider {
  readonly provider_kind = "hermetic_filesystem" as const;
  readonly managed_platform_verified = false;
  readonly #root: string;
  readonly #rootBindingSha256: string;

  constructor(input: Readonly<{
    root: string;
    runtime_class: "ignored_local_private_filesystem";
    publicly_addressable: false;
    managed_platform_verified: false;
  }>) {
    if (input.runtime_class !== "ignored_local_private_filesystem"
      || input.publicly_addressable !== false
      || input.managed_platform_verified !== false
      || !isAbsolute(input.root)) {
      throw new Error("LOCAL_PRIVATE_STORAGE_CONFIGURATION_INVALID");
    }
    const root = resolve(input.root);
    if (root === parse(root).root || !basename(root).startsWith(ROOT_PREFIX)) {
      throw new Error("LOCAL_PRIVATE_STORAGE_ROOT_UNSAFE");
    }
    this.#root = root;
    const normalizedRoot = process.platform === "win32" ? root.toLowerCase() : root;
    this.#rootBindingSha256 = sha256(Buffer.from(normalizedRoot.replaceAll("\\", "/"), "utf8"));
  }

  proof(): LocalRuntimePrivateStorageProof {
    return Object.freeze({
      schema_version: LOCAL_RUNTIME_PRIVATE_STORAGE_SCHEMA_VERSION,
      provider_kind: "local_private_immutable_filesystem",
      root_binding_sha256: this.#rootBindingSha256,
      publicly_addressable: false,
      managed_platform_verified: false,
      immutable_active_objects: true,
      quarantine_retained_for_transaction_recovery: true,
      content_hash_verified_on_every_read: true,
      absolute_path_disclosed: false,
    });
  }

  async putQuarantined(input: Readonly<{
    object_key: string;
    expected_sha256: string;
    expected_length: number;
    bytes: Uint8Array;
  }>): Promise<Readonly<{ quarantine_locator: string }>> {
    validateBlob(input);
    const locator = `quarantine/${input.expected_sha256.slice(0, 2)}/${input.object_key}`;
    const path = await this.#preparePath(locator);
    const temporaryPath = `${path}.pending-${process.pid}-${randomBytes(12).toString("hex")}`;
    let handle;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(input.bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await chmod(temporaryPath, 0o600);
      await link(temporaryPath, path);
    } catch (error) {
      await handle?.close();
      handle = undefined;
      await removeFailedWrite(temporaryPath);
      if (isCode(error, "EEXIST")) {
        await this.readExact({
          locator,
          expected_sha256: input.expected_sha256,
          expected_length: input.expected_length,
        });
        return Object.freeze({ quarantine_locator: locator });
      }
      throw new Error("LOCAL_PRIVATE_STORAGE_WRITE_FAILED");
    } finally {
      await handle?.close();
    }
    await removeFailedWrite(temporaryPath);
    await chmod(path, 0o600);
    await this.readExact({
      locator,
      expected_sha256: input.expected_sha256,
      expected_length: input.expected_length,
    });
    return Object.freeze({ quarantine_locator: locator });
  }

  async promoteQuarantined(input: Readonly<{
    quarantine_locator: string;
    object_key: string;
    expected_sha256: string;
    expected_length: number;
  }>): Promise<Readonly<{ active_locator: string }>> {
    assertLocator(input.quarantine_locator, "quarantine");
    assertObjectKey(input.object_key);
    assertHashAndLength(input.expected_sha256, input.expected_length);
    const activeLocator = `objects/${input.expected_sha256.slice(0, 2)}/${input.object_key}`;
    const destination = await this.#preparePath(activeLocator);
    if (await exists(destination)) {
      await this.readExact({
        locator: activeLocator,
        expected_sha256: input.expected_sha256,
        expected_length: input.expected_length,
      });
      await this.readExact({
        locator: input.quarantine_locator,
        expected_sha256: input.expected_sha256,
        expected_length: input.expected_length,
      });
      return Object.freeze({ active_locator: activeLocator });
    }
    await this.readExact({
      locator: input.quarantine_locator,
      expected_sha256: input.expected_sha256,
      expected_length: input.expected_length,
    });
    const source = await this.#existingPath(input.quarantine_locator);
    try {
      // Promotion is a recoverable prepare step, not a destructive move. The
      // quarantine link remains until an independently proven committed bind
      // can clean it. If PostgreSQL rolls back after this point, an exact
      // replay still has the source bytes needed to complete the approval.
      await link(source, destination);
      await chmod(destination, 0o400);
    } catch {
      if (await exists(destination)) {
        await this.readExact({
          locator: activeLocator,
          expected_sha256: input.expected_sha256,
          expected_length: input.expected_length,
        });
        await this.readExact({
          locator: input.quarantine_locator,
          expected_sha256: input.expected_sha256,
          expected_length: input.expected_length,
        });
        return Object.freeze({ active_locator: activeLocator });
      }
      throw new Error("LOCAL_PRIVATE_STORAGE_PROMOTION_FAILED");
    }
    await this.readExact({
      locator: activeLocator,
      expected_sha256: input.expected_sha256,
      expected_length: input.expected_length,
    });
    return Object.freeze({ active_locator: activeLocator });
  }

  async readExact(input: Readonly<{
    locator: string;
    expected_sha256: string;
    expected_length: number;
  }>): Promise<Uint8Array> {
    assertLocator(input.locator);
    assertHashAndLength(input.expected_sha256, input.expected_length);
    try {
      const path = await this.#existingPath(input.locator);
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("LOCAL_PRIVATE_STORAGE_INTEGRITY_FAILURE");
      const bytes = await readFile(path);
      if (bytes.byteLength !== input.expected_length || sha256(bytes) !== input.expected_sha256) {
        throw new Error("LOCAL_PRIVATE_STORAGE_INTEGRITY_FAILURE");
      }
      return Uint8Array.from(bytes);
    } catch (error) {
      if (error instanceof Error && error.message === "LOCAL_PRIVATE_STORAGE_PATH_ESCAPE") throw error;
      throw new Error("LOCAL_PRIVATE_STORAGE_INTEGRITY_FAILURE");
    }
  }

  async deleteExact(input: Readonly<{
    locator: string;
    expected_sha256: string;
  }>): Promise<Readonly<{ deleted: boolean }>> {
    assertLocator(input.locator);
    assertHash(input.expected_sha256);
    if (input.locator.startsWith("objects/")) {
      throw new Error("LOCAL_PRIVATE_STORAGE_ACTIVE_DELETE_FORBIDDEN");
    }
    const path = this.#path(input.locator);
    if (!await exists(path)) return Object.freeze({ deleted: false });
    const bytes = await this.readExact({
      locator: input.locator,
      expected_sha256: input.expected_sha256,
      expected_length: (await lstat(path)).size,
    });
    if (sha256(bytes) !== input.expected_sha256) throw new Error("LOCAL_PRIVATE_STORAGE_INTEGRITY_FAILURE");
    try {
      await unlink(path);
      return Object.freeze({ deleted: true });
    } catch {
      throw new Error("LOCAL_PRIVATE_STORAGE_DELETE_FAILED");
    }
  }

  async inventory(): Promise<readonly PrivateBlobInventoryEntry[]> {
    await this.#initializeRoot();
    const entries: PrivateBlobInventoryEntry[] = [];
    for (const prefix of ["objects", "quarantine"] as const) {
      const prefixPath = this.#pathRoot(prefix);
      for (const shard of await safeEntries(prefixPath, "directory")) {
        if (!/^[a-f0-9]{2}$/u.test(shard)) continue;
        for (const objectKey of await safeEntries(resolve(prefixPath, shard), "file")) {
          if (!OBJECT_KEY.test(objectKey)) continue;
          const locator = `${prefix}/${shard}/${objectKey}`;
          try {
            const path = await this.#existingPath(locator);
            const bytes = await readFile(path);
            entries.push(Object.freeze({ locator, sha256: sha256(bytes), byte_count: bytes.byteLength }));
          } catch {
            // A concurrent promotion is represented by the next inventory snapshot.
          }
        }
      }
    }
    return Object.freeze(entries.sort((left, right) => left.locator.localeCompare(right.locator)));
  }

  async #initializeRoot(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    await chmod(this.#root, 0o700);
    const stat = await lstat(this.#root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("LOCAL_PRIVATE_STORAGE_ROOT_UNSAFE");
    const actual = resolve(await realpath(this.#root));
    if (!samePath(actual, this.#root)) throw new Error("LOCAL_PRIVATE_STORAGE_ROOT_UNSAFE");
  }

  async #preparePath(locator: string): Promise<string> {
    await this.#initializeRoot();
    const path = this.#path(locator);
    const parent = dirname(path);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await chmod(parent, 0o700);
    const stat = await lstat(parent);
    const actual = resolve(await realpath(parent));
    if (!stat.isDirectory() || stat.isSymbolicLink() || !within(this.#root, actual)) {
      throw new Error("LOCAL_PRIVATE_STORAGE_PATH_ESCAPE");
    }
    return path;
  }

  async #existingPath(locator: string): Promise<string> {
    await this.#initializeRoot();
    const path = this.#path(locator);
    const actual = resolve(await realpath(path));
    if (!within(this.#root, actual)) throw new Error("LOCAL_PRIVATE_STORAGE_PATH_ESCAPE");
    return actual;
  }

  #path(locator: string): string {
    assertLocator(locator);
    const path = resolve(this.#root, ...locator.split("/"));
    if (!within(this.#root, path)) throw new Error("LOCAL_PRIVATE_STORAGE_PATH_ESCAPE");
    return path;
  }

  #pathRoot(prefix: "objects" | "quarantine"): string {
    const path = resolve(this.#root, prefix);
    if (!within(this.#root, path)) throw new Error("LOCAL_PRIVATE_STORAGE_PATH_ESCAPE");
    return path;
  }
}

function validateBlob(input: Readonly<{
  object_key: string;
  expected_sha256: string;
  expected_length: number;
  bytes: Uint8Array;
}>): void {
  assertObjectKey(input.object_key);
  assertHashAndLength(input.expected_sha256, input.expected_length);
  if (!(input.bytes instanceof Uint8Array)
    || input.bytes.byteLength !== input.expected_length
    || sha256(input.bytes) !== input.expected_sha256) {
    throw new Error("LOCAL_PRIVATE_STORAGE_INPUT_INVALID");
  }
}

function assertHashAndLength(hash: string, length: number): void {
  assertHash(hash);
  if (!Number.isSafeInteger(length) || length < 1 || length > 52_428_800) {
    throw new Error("LOCAL_PRIVATE_STORAGE_INPUT_INVALID");
  }
}

function assertHash(value: string): void {
  if (!SHA256.test(value)) throw new Error("LOCAL_PRIVATE_STORAGE_INPUT_INVALID");
}

function assertObjectKey(value: string): void {
  if (!OBJECT_KEY.test(value)) throw new Error("LOCAL_PRIVATE_STORAGE_INPUT_INVALID");
}

function assertLocator(value: string, prefix?: "objects" | "quarantine"): void {
  if (!LOCATOR.test(value) || (prefix && !value.startsWith(`${prefix}/`))) {
    throw new Error("LOCAL_PRIVATE_STORAGE_LOCATOR_INVALID");
  }
}

function within(root: string, path: string): boolean {
  const normalizedRoot = process.platform === "win32" ? root.toLowerCase() : root;
  const normalizedPath = process.platform === "win32" ? path.toLowerCase() : path;
  return normalizedPath.startsWith(`${normalizedRoot}${sep}`);
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function safeEntries(root: string, kind: "directory" | "file"): Promise<readonly string[]> {
  try {
    return Object.freeze((await readdir(root, { withFileTypes: true }))
      .filter((entry) => !entry.isSymbolicLink()
        && (kind === "directory" ? entry.isDirectory() : entry.isFile()))
      .map((entry) => entry.name));
  } catch (error) {
    if (isCode(error, "ENOENT")) return Object.freeze([]);
    throw new Error("LOCAL_PRIVATE_STORAGE_INVENTORY_FAILED");
  }
}

async function removeFailedWrite(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw new Error("LOCAL_PRIVATE_STORAGE_WRITE_FAILED");
  }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && Reflect.get(error, "code") === code;
}
