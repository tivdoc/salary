import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

const SHA256 = /^[a-f0-9]{64}$/;
const OBJECT_KEY = /^object_[a-f0-9]{48}$/;
const LOCATOR = /^(?:objects|quarantine)\/[a-f0-9]{2}\/object_[a-f0-9]{48}$/;

export type PrivateBlobInventoryEntry = Readonly<{
  locator: string;
  sha256: string;
  byte_count: number;
}>;

export interface PrivateBlobProvider {
  readonly provider_kind: "hermetic_filesystem" | "supabase_storage";
  readonly managed_platform_verified: boolean;
  putQuarantined(input: Readonly<{ object_key: string; expected_sha256: string; expected_length: number; bytes: Uint8Array }>): Promise<Readonly<{ quarantine_locator: string }>>;
  promoteQuarantined(input: Readonly<{ quarantine_locator: string; object_key: string; expected_sha256: string; expected_length: number }>): Promise<Readonly<{ active_locator: string }>>;
  readExact(input: Readonly<{ locator: string; expected_sha256: string; expected_length: number }>): Promise<Uint8Array>;
  deleteExact(input: Readonly<{ locator: string; expected_sha256: string }>): Promise<Readonly<{ deleted: boolean }>>;
  inventory(): Promise<readonly PrivateBlobInventoryEntry[]>;
}

export class HermeticFilesystemPrivateBlobProvider implements PrivateBlobProvider {
  readonly provider_kind = "hermetic_filesystem" as const;
  readonly managed_platform_verified = false;
  readonly #root: string;

  constructor(input: Readonly<{ root: string; environment: "generated_local_test_root" }>) {
    const root = resolve(input.root);
    if (input.environment !== "generated_local_test_root" || !basename(root).startsWith("tivdoc-")) throw new Error("PRIVATE_OBJECT_ROOT_NOT_GENERATED");
    this.#root = root;
  }

  async putQuarantined(input: Readonly<{ object_key: string; expected_sha256: string; expected_length: number; bytes: Uint8Array }>): Promise<Readonly<{ quarantine_locator: string }>> {
    validateBlobInput(input);
    const locator = `quarantine/${input.expected_sha256.slice(0, 2)}/${input.object_key}`;
    const path = this.#path(locator);
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(path, input.bytes, { flag: "wx" });
    } catch {
      throw new Error("PRIVATE_OBJECT_IMMUTABLE_EXISTS");
    }
    return Object.freeze({ quarantine_locator: locator });
  }

  async promoteQuarantined(input: Readonly<{ quarantine_locator: string; object_key: string; expected_sha256: string; expected_length: number }>): Promise<Readonly<{ active_locator: string }>> {
    assertLocator(input.quarantine_locator, "quarantine");
    assertObjectKey(input.object_key);
    assertHashAndLength(input.expected_sha256, input.expected_length);
    const activeLocator = `objects/${input.expected_sha256.slice(0, 2)}/${input.object_key}`;
    const source = this.#path(input.quarantine_locator);
    const destination = this.#path(activeLocator);
    await this.readExact({ locator: input.quarantine_locator, expected_sha256: input.expected_sha256, expected_length: input.expected_length });
    await mkdir(dirname(destination), { recursive: true });
    try {
      await rename(source, destination);
    } catch {
      throw new Error("PRIVATE_OBJECT_PROMOTION_FAILED");
    }
    return Object.freeze({ active_locator: activeLocator });
  }

  async readExact(input: Readonly<{ locator: string; expected_sha256: string; expected_length: number }>): Promise<Uint8Array> {
    assertLocator(input.locator);
    assertHashAndLength(input.expected_sha256, input.expected_length);
    const path = this.#path(input.locator);
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("PRIVATE_OBJECT_INTEGRITY_FAILURE");
      const actual = await realpath(path);
      if (!actual.startsWith(`${this.#root}${sep}`)) throw new Error("PRIVATE_OBJECT_INTERNAL_PATH_ESCAPE");
      const bytes = await readFile(actual);
      if (bytes.byteLength !== input.expected_length || sha256(bytes) !== input.expected_sha256) throw new Error("PRIVATE_OBJECT_INTEGRITY_FAILURE");
      return Uint8Array.from(bytes);
    } catch (error) {
      if (error instanceof Error && ["PRIVATE_OBJECT_INTEGRITY_FAILURE", "PRIVATE_OBJECT_INTERNAL_PATH_ESCAPE"].includes(error.message)) throw error;
      throw new Error("PRIVATE_OBJECT_INTEGRITY_FAILURE");
    }
  }

  async deleteExact(input: Readonly<{ locator: string; expected_sha256: string }>): Promise<Readonly<{ deleted: boolean }>> {
    assertLocator(input.locator);
    if (!SHA256.test(input.expected_sha256)) throw new Error("PRIVATE_OBJECT_PROVIDER_INPUT_INVALID");
    const path = this.#path(input.locator);
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("PRIVATE_OBJECT_INTEGRITY_FAILURE");
      await unlink(path);
      return Object.freeze({ deleted: true });
    } catch (error) {
      if (isMissing(error)) return Object.freeze({ deleted: false });
      if (error instanceof Error && error.message === "PRIVATE_OBJECT_INTEGRITY_FAILURE") throw error;
      throw new Error("PRIVATE_OBJECT_DELETE_FAILED");
    }
  }

  async inventory(): Promise<readonly PrivateBlobInventoryEntry[]> {
    const entries: PrivateBlobInventoryEntry[] = [];
    for (const prefix of ["objects", "quarantine"] as const) {
      const prefixRoot = this.#pathRoot(prefix);
      for (const shard of await safeDirectoryNames(prefixRoot)) {
        if (!/^[a-f0-9]{2}$/.test(shard)) continue;
        const shardRoot = resolve(prefixRoot, shard);
        for (const objectKey of await safeFileNames(shardRoot)) {
          if (!OBJECT_KEY.test(objectKey)) continue;
          const locator = `${prefix}/${shard}/${objectKey}`;
          const path = this.#path(locator);
          try {
            const stat = await lstat(path);
            if (!stat.isFile() || stat.isSymbolicLink()) continue;
            const bytes = await readFile(path);
            entries.push(Object.freeze({ locator, sha256: sha256(bytes), byte_count: bytes.byteLength }));
          } catch {
            // Races are represented as absence and reconciled on the next pass.
          }
        }
      }
    }
    return Object.freeze(entries.sort((left, right) => left.locator.localeCompare(right.locator)));
  }

  #path(locator: string): string {
    assertLocator(locator);
    const path = resolve(this.#root, ...locator.split("/"));
    if (!path.startsWith(`${this.#root}${sep}`)) throw new Error("PRIVATE_OBJECT_INTERNAL_PATH_ESCAPE");
    return path;
  }

  #pathRoot(prefix: "objects" | "quarantine"): string {
    const path = resolve(this.#root, prefix);
    if (!path.startsWith(`${this.#root}${sep}`)) throw new Error("PRIVATE_OBJECT_INTERNAL_PATH_ESCAPE");
    return path;
  }
}

export type IsolatedSupabaseStorageProof = Readonly<{
  capability_id: "MC-03";
  status: "PASS";
  target_class: "ISOLATED_LOCAL_SUPABASE";
  endpoint_origin: string;
  storage_private_policy_check: "PASS";
}>;

export interface SupabasePrivateStorageTransport {
  uploadPrivate(input: Readonly<{ bucket: "salary-documents"; locator: string; bytes: Uint8Array; content_type: "application/octet-stream"; upsert: false }>): Promise<void>;
  movePrivate(input: Readonly<{ bucket: "salary-documents"; from_locator: string; to_locator: string }>): Promise<void>;
  downloadPrivate(input: Readonly<{ bucket: "salary-documents"; locator: string }>): Promise<Uint8Array>;
  removePrivate(input: Readonly<{ bucket: "salary-documents"; locator: string }>): Promise<Readonly<{ deleted: boolean }>>;
  listPrivate(input: Readonly<{ bucket: "salary-documents" }>): Promise<readonly PrivateBlobInventoryEntry[]>;
}

export class SupabasePrivateBlobProvider implements PrivateBlobProvider {
  readonly provider_kind = "supabase_storage" as const;
  readonly managed_platform_verified: boolean;
  readonly #transport: SupabasePrivateStorageTransport | null;

  constructor(input: Readonly<{
    bucket: "salary-documents";
    bucket_public: false;
    proof: IsolatedSupabaseStorageProof | null;
    transport: SupabasePrivateStorageTransport | null;
  }>) {
    if (input.bucket !== "salary-documents" || input.bucket_public !== false) throw new Error("SUPABASE_PRIVATE_STORAGE_CONFIGURATION_INVALID");
    this.managed_platform_verified = validLocalProof(input.proof);
    this.#transport = this.managed_platform_verified ? input.transport : null;
    if (this.managed_platform_verified && !this.#transport) throw new Error("SUPABASE_PRIVATE_STORAGE_TRANSPORT_REQUIRED");
  }

  async putQuarantined(input: Readonly<{ object_key: string; expected_sha256: string; expected_length: number; bytes: Uint8Array }>): Promise<Readonly<{ quarantine_locator: string }>> {
    validateBlobInput(input);
    const transport = this.#requireTransport();
    const locator = `quarantine/${input.expected_sha256.slice(0, 2)}/${input.object_key}`;
    await transport.uploadPrivate({ bucket: "salary-documents", locator, bytes: Uint8Array.from(input.bytes), content_type: "application/octet-stream", upsert: false });
    return Object.freeze({ quarantine_locator: locator });
  }

  async promoteQuarantined(input: Readonly<{ quarantine_locator: string; object_key: string; expected_sha256: string; expected_length: number }>): Promise<Readonly<{ active_locator: string }>> {
    assertLocator(input.quarantine_locator, "quarantine");
    assertObjectKey(input.object_key);
    assertHashAndLength(input.expected_sha256, input.expected_length);
    const activeLocator = `objects/${input.expected_sha256.slice(0, 2)}/${input.object_key}`;
    await this.#requireTransport().movePrivate({ bucket: "salary-documents", from_locator: input.quarantine_locator, to_locator: activeLocator });
    return Object.freeze({ active_locator: activeLocator });
  }

  async readExact(input: Readonly<{ locator: string; expected_sha256: string; expected_length: number }>): Promise<Uint8Array> {
    assertLocator(input.locator);
    assertHashAndLength(input.expected_sha256, input.expected_length);
    const bytes = await this.#requireTransport().downloadPrivate({ bucket: "salary-documents", locator: input.locator });
    if (bytes.byteLength !== input.expected_length || sha256(bytes) !== input.expected_sha256) throw new Error("PRIVATE_OBJECT_INTEGRITY_FAILURE");
    return Uint8Array.from(bytes);
  }

  async deleteExact(input: Readonly<{ locator: string; expected_sha256: string }>): Promise<Readonly<{ deleted: boolean }>> {
    assertLocator(input.locator);
    if (!SHA256.test(input.expected_sha256)) throw new Error("PRIVATE_OBJECT_PROVIDER_INPUT_INVALID");
    return this.#requireTransport().removePrivate({ bucket: "salary-documents", locator: input.locator });
  }

  async inventory(): Promise<readonly PrivateBlobInventoryEntry[]> {
    const entries = await this.#requireTransport().listPrivate({ bucket: "salary-documents" });
    return Object.freeze(entries.map((entry) => {
      assertLocator(entry.locator);
      assertHashAndLength(entry.sha256, entry.byte_count);
      return Object.freeze({ ...entry });
    }).sort((left, right) => left.locator.localeCompare(right.locator)));
  }

  #requireTransport(): SupabasePrivateStorageTransport {
    if (!this.managed_platform_verified || !this.#transport) throw new Error("SUPABASE_PRIVATE_STORAGE_PLATFORM_UNVERIFIED");
    return this.#transport;
  }
}

function validLocalProof(proof: IsolatedSupabaseStorageProof | null): boolean {
  if (!proof || proof.capability_id !== "MC-03" || proof.status !== "PASS" || proof.target_class !== "ISOLATED_LOCAL_SUPABASE" || proof.storage_private_policy_check !== "PASS") return false;
  try {
    const endpoint = new URL(proof.endpoint_origin);
    return endpoint.protocol === "http:" && ["127.0.0.1", "::1", "localhost"].includes(endpoint.hostname) && endpoint.username === "" && endpoint.password === "";
  } catch {
    return false;
  }
}

function validateBlobInput(input: Readonly<{ object_key: string; expected_sha256: string; expected_length: number; bytes: Uint8Array }>): void {
  assertObjectKey(input.object_key);
  assertHashAndLength(input.expected_sha256, input.expected_length);
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength !== input.expected_length || sha256(input.bytes) !== input.expected_sha256) throw new Error("PRIVATE_OBJECT_PROVIDER_INPUT_INVALID");
}

function assertObjectKey(value: string): void {
  if (!OBJECT_KEY.test(value)) throw new Error("PRIVATE_OBJECT_PROVIDER_INPUT_INVALID");
}

function assertHashAndLength(sha: string, length: number): void {
  if (!SHA256.test(sha) || !Number.isSafeInteger(length) || length <= 0) throw new Error("PRIVATE_OBJECT_PROVIDER_INPUT_INVALID");
}

function assertLocator(value: string, prefix?: "objects" | "quarantine"): void {
  if (!LOCATOR.test(value) || (prefix && !value.startsWith(`${prefix}/`))) throw new Error("PRIVATE_OBJECT_PROVIDER_LOCATOR_INVALID");
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function safeDirectoryNames(root: string): Promise<readonly string[]> {
  try {
    return Object.freeze((await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => entry.name));
  } catch {
    return Object.freeze([]);
  }
}

async function safeFileNames(root: string): Promise<readonly string[]> {
  try {
    return Object.freeze((await readdir(root, { withFileTypes: true })).filter((entry) => entry.isFile() && !entry.isSymbolicLink()).map((entry) => entry.name));
  } catch {
    return Object.freeze([]);
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}
