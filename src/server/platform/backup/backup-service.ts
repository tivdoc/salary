import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import type {
  BackupBundle,
  BackupManifest,
  BackupManifestEntry,
  BackupObject,
  BackupSourceAdapter,
  BackupSourceKind,
  BackupVerification,
  LocalRestoreReceipt,
  LocalRestoreTargetAdapter,
  RestorePlan,
} from "./contracts";

const OPAQUE = /^[a-z][a-z0-9_-]{7,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function hash(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertSafePath(path: string): void {
  if (
    path.length === 0 ||
    path.length > 240 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes(":") ||
    path.includes("\0") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..") ||
    !/^[a-zA-Z0-9._/-]+$/.test(path)
  ) {
    throw new Error("BACKUP_PATH_UNSAFE");
  }
}

function canonicalManifestCore(input: Omit<BackupManifest, "manifest_sha256">): string {
  return JSON.stringify(input);
}

function aggregate(entries: readonly BackupManifestEntry[]): string {
  return hash(entries.map((entry) => `${entry.path}\0${entry.byte_count}\0${entry.sha256}\n`).join(""));
}

export class InMemoryBackupSource implements BackupSourceAdapter {
  readonly kind = "local_memory_fixture" as const;
  readonly #objects: readonly BackupObject[];

  constructor(objects: readonly BackupObject[]) {
    this.#objects = objects.map((object) => Object.freeze({ path: object.path, bytes: Uint8Array.from(object.bytes) }));
  }

  async list(): Promise<readonly BackupObject[]> {
    return this.#objects.map((object) => Object.freeze({ path: object.path, bytes: Uint8Array.from(object.bytes) }));
  }
}

export class LocalFilesystemBackupSource implements BackupSourceAdapter {
  readonly kind = "local_filesystem_fixture" as const;
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  async list(): Promise<readonly BackupObject[]> {
    const output: BackupObject[] = [];
    await this.#walk(this.#root, output);
    return output.sort((left, right) => left.path.localeCompare(right.path));
  }

  async #walk(directory: string, output: BackupObject[]): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = resolve(directory, entry.name);
      if (absolute !== this.#root && !absolute.startsWith(`${this.#root}${sep}`)) throw new Error("BACKUP_PATH_ESCAPE");
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) throw new Error("BACKUP_SYMLINK_FORBIDDEN");
      if (metadata.isDirectory()) {
        await this.#walk(absolute, output);
      } else if (metadata.isFile()) {
        const path = relative(this.#root, absolute).split(sep).join("/");
        assertSafePath(path);
        output.push(Object.freeze({ path, bytes: await readFile(absolute) }));
      } else {
        throw new Error("BACKUP_SPECIAL_FILE_FORBIDDEN");
      }
    }
  }
}

export class InMemoryRestoreTarget implements LocalRestoreTargetAdapter {
  readonly kind = "local_memory_staging" as const;
  readonly #objects = new Map<string, Uint8Array>();

  async isEmpty(): Promise<boolean> {
    return this.#objects.size === 0;
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    assertSafePath(path);
    if (this.#objects.has(path)) throw new Error("RESTORE_TARGET_COLLISION");
    this.#objects.set(path, Uint8Array.from(bytes));
  }

  async list(): Promise<readonly BackupObject[]> {
    return [...this.#objects]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, bytes]) => Object.freeze({ path, bytes: Uint8Array.from(bytes) }));
  }
}

export class LocalFilesystemRestoreTarget implements LocalRestoreTargetAdapter {
  readonly kind = "local_filesystem_staging" as const;
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  async isEmpty(): Promise<boolean> {
    return (await readdir(this.#root)).length === 0;
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    assertSafePath(path);
    const absolute = resolve(this.#root, ...path.split("/"));
    if (!absolute.startsWith(`${this.#root}${sep}`)) throw new Error("RESTORE_PATH_ESCAPE");
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes, { flag: "wx" });
  }

  async list(): Promise<readonly BackupObject[]> {
    return new LocalFilesystemBackupSource(this.#root).list();
  }
}

export async function createLocalBackup(
  source: BackupSourceAdapter,
  input: Readonly<{ backup_id: string; created_at: string; watermark: string; key_version: string }>,
): Promise<BackupBundle> {
  if (!OPAQUE.test(input.backup_id) || !OPAQUE.test(input.watermark) || !OPAQUE.test(input.key_version) || Number.isNaN(Date.parse(input.created_at))) {
    throw new Error("BACKUP_METADATA_INVALID");
  }
  const listed = await source.list();
  if (listed.length === 0) throw new Error("BACKUP_EMPTY_SOURCE");
  const paths = new Set<string>();
  const objects = new Map<string, Uint8Array>();
  const entries = listed
    .map((object) => {
      assertSafePath(object.path);
      if (paths.has(object.path)) throw new Error("BACKUP_DUPLICATE_PATH");
      paths.add(object.path);
      const bytes = Uint8Array.from(object.bytes);
      objects.set(object.path, bytes);
      return Object.freeze({ path: object.path, byte_count: bytes.byteLength, sha256: hash(bytes) });
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  const core = Object.freeze({
    schema_version: "tivdoc-local-backup-manifest-v0.7.0" as const,
    backup_id: input.backup_id,
    source_kind: source.kind,
    created_at: new Date(input.created_at).toISOString(),
    watermark: input.watermark,
    key_version: input.key_version,
    entries: Object.freeze(entries),
    aggregate_sha256: aggregate(entries),
  });
  const manifest = Object.freeze({ ...core, manifest_sha256: hash(canonicalManifestCore(core)) });
  return Object.freeze({ manifest, objects });
}

export function verifyLocalBackup(bundle: BackupBundle, expectedKeyVersion?: string): BackupVerification {
  const errors = new Set<string>();
  const { manifest } = bundle;
  if (manifest.schema_version !== "tivdoc-local-backup-manifest-v0.7.0") errors.add("BACKUP_SCHEMA_INVALID");
  if (!OPAQUE.test(manifest.backup_id) || !OPAQUE.test(manifest.watermark) || !OPAQUE.test(manifest.key_version) || Number.isNaN(Date.parse(manifest.created_at))) {
    errors.add("BACKUP_METADATA_INVALID");
  }
  if (!(["local_filesystem_fixture", "local_memory_fixture"] as const).includes(manifest.source_kind)) errors.add("BACKUP_SOURCE_KIND_INVALID");
  if (expectedKeyVersion !== undefined && manifest.key_version !== expectedKeyVersion) errors.add("BACKUP_KEY_VERSION_MISMATCH");
  const { manifest_sha256: ignored, ...core } = manifest;
  void ignored;
  if (!SHA256.test(manifest.manifest_sha256) || hash(canonicalManifestCore(core)) !== manifest.manifest_sha256) errors.add("BACKUP_MANIFEST_HASH_MISMATCH");
  if (manifest.entries.length === 0) errors.add("BACKUP_EMPTY_MANIFEST");
  const paths = new Set<string>();
  let byteCount = 0;
  for (const entry of manifest.entries) {
    try {
      assertSafePath(entry.path);
    } catch {
      errors.add("BACKUP_PATH_UNSAFE");
    }
    if (paths.has(entry.path)) errors.add("BACKUP_DUPLICATE_PATH");
    paths.add(entry.path);
    const bytes = bundle.objects.get(entry.path);
    if (!Number.isSafeInteger(entry.byte_count) || entry.byte_count < 0) errors.add("BACKUP_LENGTH_INVALID");
    if (!bytes) {
      errors.add("BACKUP_OBJECT_MISSING");
      continue;
    }
    byteCount += bytes.byteLength;
    if (bytes.byteLength !== entry.byte_count) errors.add("BACKUP_LENGTH_MISMATCH");
    if (!SHA256.test(entry.sha256) || hash(bytes) !== entry.sha256) errors.add("BACKUP_OBJECT_HASH_MISMATCH");
  }
  if ([...bundle.objects.keys()].some((path) => !paths.has(path))) errors.add("BACKUP_UNMANIFESTED_OBJECT");
  if (aggregate(manifest.entries) !== manifest.aggregate_sha256) errors.add("BACKUP_AGGREGATE_MISMATCH");
  const errorCodes = [...errors].sort();
  return Object.freeze({
    valid: errorCodes.length === 0,
    status: errorCodes.length === 0 ? "VERIFIED_LOCAL_FIXTURE" : "REJECTED_CORRUPT",
    error_codes: Object.freeze(errorCodes),
    object_count: manifest.entries.length,
    byte_count: byteCount,
    manifest_sha256: manifest.manifest_sha256,
  });
}

export function planLocalRestore(bundle: BackupBundle, targetKind: RestorePlan["target_kind"], expectedKeyVersion: string): RestorePlan {
  const verification = verifyLocalBackup(bundle, expectedKeyVersion);
  if (!verification.valid) throw new Error(`RESTORE_REFUSED:${verification.error_codes.join(",")}`);
  return Object.freeze({
    schema_version: "tivdoc-local-restore-plan-v0.7.0",
    backup_id: bundle.manifest.backup_id,
    manifest_sha256: bundle.manifest.manifest_sha256,
    target_kind: targetKind,
    dry_run: true,
    mutation_applied: false,
    object_count: verification.object_count,
    byte_count: verification.byte_count,
  });
}

export async function restoreLocalFixture(
  bundle: BackupBundle,
  target: LocalRestoreTargetAdapter,
  expectedKeyVersion: string,
): Promise<LocalRestoreReceipt> {
  const pinned = cloneBundle(bundle);
  const verification = verifyLocalBackup(pinned, expectedKeyVersion);
  if (!verification.valid) throw new Error(`RESTORE_REFUSED:${verification.error_codes.join(",")}`);
  if (!(await target.isEmpty())) throw new Error("RESTORE_TARGET_NOT_EMPTY");
  for (const entry of pinned.manifest.entries) {
    const bytes = pinned.objects.get(entry.path);
    if (!bytes) throw new Error("RESTORE_SOURCE_CHANGED_AFTER_VERIFY");
    await target.write(entry.path, bytes);
  }
  const restored = await target.list();
  const restoredByPath = new Map(restored.map((object) => [object.path, object.bytes]));
  if (restored.length !== pinned.manifest.entries.length) throw new Error("RESTORE_POST_VERIFY_COUNT_MISMATCH");
  for (const entry of pinned.manifest.entries) {
    const bytes = restoredByPath.get(entry.path);
    if (!bytes || bytes.byteLength !== entry.byte_count || hash(bytes) !== entry.sha256) {
      throw new Error("RESTORE_POST_VERIFY_HASH_MISMATCH");
    }
  }
  const core = Object.freeze({
    schema_version: "tivdoc-local-restore-receipt-v0.7.0" as const,
    backup_id: pinned.manifest.backup_id,
    manifest_sha256: pinned.manifest.manifest_sha256,
    target_kind: target.kind,
    status: "VERIFIED_LOCAL_FIXTURE_RESTORE" as const,
    object_count: verification.object_count,
    byte_count: verification.byte_count,
  });
  return Object.freeze({ ...core, receipt_sha256: hash(JSON.stringify(core)) });
}

export function cloneBundle(bundle: BackupBundle): BackupBundle {
  return Object.freeze({
    manifest: JSON.parse(JSON.stringify(bundle.manifest)) as BackupManifest,
    objects: new Map([...bundle.objects].map(([path, bytes]) => [path, Uint8Array.from(bytes)])),
  });
}

export function sourceCapability(kind: BackupSourceKind): Readonly<{
  implemented: true;
  locally_verified: true;
  dynamic_database_verified: false;
  production_rpo_rto_claimed: false;
  blocker_code: "ISOLATED_DATABASE_BACKUP_RESTORE_TARGET_UNAVAILABLE";
}> {
  void kind;
  return Object.freeze({
    implemented: true,
    locally_verified: true,
    dynamic_database_verified: false,
    production_rpo_rto_claimed: false,
    blocker_code: "ISOLATED_DATABASE_BACKUP_RESTORE_TARGET_UNAVAILABLE",
  });
}
