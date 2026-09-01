import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { contained, type DynamicPostgresPaths } from "./paths.mts";
import { type CommandRunner, runSafeCommand } from "./process.mts";

export const PINNED_POSTGRES_VERSION = "17.11" as const;
export const PINNED_EDB_ARCHIVE_URL =
  "https://get.enterprisedb.com/postgresql/postgresql-17.11-2-windows-x64-binaries.zip" as const;
export const PINNED_EDB_ARCHIVE_SHA256 =
  "2f868d77832f5cbc62182a0ca57f02df14d33d85ce0d0bbaaeb0de3a7029bd2b" as const;
export const PINNED_DISTRIBUTION_FILE_COUNT = 20_383 as const;
export const PINNED_DISTRIBUTION_BYTES = 904_941_738 as const;
export const PINNED_DISTRIBUTION_TREE_SHA256 =
  "1fabdc14b0bad1f57191a42bcd0c6ddc30a6ac7997540c81bca4b0793285fb66" as const;

export const REQUIRED_POSTGRES_BINARIES = Object.freeze([
  "postgres",
  "initdb",
  "pg_ctl",
  "psql",
  "createdb",
  "dropdb",
  "pg_dump",
  "pg_restore",
  "pg_isready",
] as const);

export type PostgresBinaryName = (typeof REQUIRED_POSTGRES_BINARIES)[number];

export const PINNED_BINARY_SHA256: Readonly<Record<PostgresBinaryName, string>> = Object.freeze({
  postgres: "3204f6811b3e1f8bb89ad94ca7dd7bcb38c7f665c50d532bce463650c4e7d2c5",
  initdb: "537a0801bb41d1a560e0bfb2bec0a4e344dc4ad034ed61648fdf542746e3f649",
  pg_ctl: "23f114eaa965f41c65ca5c1c7d147afc87750f80fd9c2386c6658d7be20d7bf7",
  psql: "54ea051e4e57bc2361b5081f522a2a3f51d5ddaf75e83543e70bd62f86be6299",
  createdb: "6d787ea1a15b939cfafa211ae5b864901498dd9e9ff10ba17a95a068667fa76c",
  dropdb: "b44eaa9d67dbbc556f8efb207aa184b0d482a94523f35a0c702f534924d2786c",
  pg_dump: "4c36682e3ad65e3f85e2643690c4209533be7d872e1a977b11a2dcedb3c203f2",
  pg_restore: "06a1af33738f49724342b66183d68837d0eb2c227bce0829c84884db6443d558",
  pg_isready: "6bc65c291aaec9c3762c43dcf06e97921fb12c09a651e8f634cb38ab7d4af2de",
});

export type PinnedBinaryProvenance = Readonly<{
  schema_version: "tivdoc-pinned-postgresql-provenance-v0.9.1";
  postgres_version: typeof PINNED_POSTGRES_VERSION;
  architecture: "x64";
  source_kind: "edb_official_windows_binaries_zip";
  source_url: string;
  source_sha256: string;
  source_integrity: "PINNED_SHA256_OFFICIAL_HTTPS";
  distribution_file_count: typeof PINNED_DISTRIBUTION_FILE_COUNT;
  distribution_bytes: typeof PINNED_DISTRIBUTION_BYTES;
  distribution_tree_sha256: typeof PINNED_DISTRIBUTION_TREE_SHA256;
  binary_sha256: Readonly<Record<PostgresBinaryName, string>>;
}>;

export type PinnedPostgresBinaries = Readonly<{
  schema_version: "tivdoc-pinned-postgresql-binaries-v0.9.1";
  postgres_version: typeof PINNED_POSTGRES_VERSION;
  architecture: "x64";
  source_kind: PinnedBinaryProvenance["source_kind"];
  source_url: string;
  source_sha256: string;
  source_integrity: "PINNED_SHA256_OFFICIAL_HTTPS";
  distribution_file_count: typeof PINNED_DISTRIBUTION_FILE_COUNT;
  distribution_bytes: typeof PINNED_DISTRIBUTION_BYTES;
  distribution_tree_sha256: typeof PINNED_DISTRIBUTION_TREE_SHA256;
  executable_paths: Readonly<Record<PostgresBinaryName, string>>;
  binary_sha256: Readonly<Record<PostgresBinaryName, string>>;
  version_output: string;
  credentials_emitted: 0;
}>;

export type PinnedPostgresProvisioningReceipt = Readonly<{
  schema_version: "tivdoc-pinned-postgresql-provisioning-v0.9.1";
  action: "REEXTRACTED_VERIFIED_DISTRIBUTION" | "DOWNLOADED_AND_REEXTRACTED_VERIFIED_DISTRIBUTION";
  final_source_url: typeof PINNED_EDB_ARCHIVE_URL;
  archive_size_bytes: 340722468;
  downloaded_bytes: 0 | 340722468;
  archive_sha256: typeof PINNED_EDB_ARCHIVE_SHA256;
  source_integrity: "PINNED_SHA256_OFFICIAL_HTTPS";
  extract_only: true;
  extraction_launcher: "DOTNET_VALIDATED_ZIP_ARCHIVE";
  archive_root: "pgsql";
  archive_entries: number;
  extracted_files: number;
  uncompressed_bytes: number;
  distribution_file_count: typeof PINNED_DISTRIBUTION_FILE_COUNT;
  distribution_bytes: typeof PINNED_DISTRIBUTION_BYTES;
  distribution_tree_sha256: typeof PINNED_DISTRIBUTION_TREE_SHA256;
  fresh_extract: true;
  distribution_reused: false;
  reparse_points_detected: 0;
  windows_token_elevated: false;
  administrator_privileges_used: false;
  system_install_performed: false;
  credentials_emitted: 0;
  status: "PASS";
}>;

const PINNED_ARCHIVE_BYTES = 340_722_468 as const;
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

/**
 * Makes the advertised verification command reproducible on a clean Windows
 * checkout. Existing artifacts are never trusted implicitly: the exact
 * official archive and every required executable are revalidated before use.
 */
export async function ensurePinnedPostgresBinaries(
  paths: DynamicPostgresPaths,
  runner: CommandRunner = runSafeCommand,
): Promise<Readonly<{
  binaries: PinnedPostgresBinaries;
  provisioning: PinnedPostgresProvisioningReceipt;
}>> {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("DYNAMIC_POSTGRESQL_ENVIRONMENT_BLOCKED:PINNED_WINDOWS_X64_DISTRIBUTION_REQUIRED");
  }
  const powershell = await resolveTrustedPowerShell();
  await assertUnelevatedWindows(paths.repository_root, powershell, runner);
  await ensurePinnedDirectoryRoots(paths);
  const archive = contained(paths.tools_root, resolve(
    paths.tools_root,
    "downloads",
    "postgresql-17.11-2-windows-x64-binaries.zip",
  ));
  const archiveExisted = await pathExists(archive);
  if (archiveExisted) {
    const metadata = await lstat(archive);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
      || metadata.size !== PINNED_ARCHIVE_BYTES
      || await sha256File(archive) !== PINNED_EDB_ARCHIVE_SHA256) {
      throw new Error("POSTGRES_PINNED_SOURCE_ARCHIVE_MISMATCH");
    }
    contained(await realpath(dirname(archive)), await realpath(archive));
  } else {
    await downloadPinnedArchive(archive);
  }

  const stagingRoot = contained(paths.tools_root, resolve(
    paths.tools_root,
    `.extracting-${process.pid}-${randomBytes(8).toString("hex")}`,
  ));
  if (await pathExists(stagingRoot)) throw new Error("POSTGRES_EXTRACT_STAGING_COLLISION");
  let extraction: ArchiveExtractionReceipt;
  try {
    extraction = await extractPinnedArchive(archive, stagingRoot, paths.repository_root, powershell, runner);
    await verifyFreshExtractedDistribution(stagingRoot, paths);
  } catch (error) {
    // Never traverse an unverified reparse point while cleaning a failed
    // extraction. A suspect staging tree is intentionally left for review.
    if (await pathExists(stagingRoot)) {
      await assertNoReparseTree(stagingRoot, paths.tools_root);
      await rm(stagingRoot, { recursive: true, force: true });
    }
    throw error;
  }

  if (await pathExists(paths.distribution_root)) {
    await assertNoReparseTree(paths.distribution_root, paths.tools_root);
    await rm(paths.distribution_root, { recursive: true, force: true });
  }
  await rename(stagingRoot, paths.distribution_root);
  await assertNoReparseTree(paths.distribution_root, paths.tools_root);

  const provenancePath = contained(paths.tools_root, resolve(paths.tools_root, "provenance.json"));
  if (await pathExists(provenancePath)) {
    const metadata = await lstat(provenancePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      throw new Error("POSTGRES_PROVENANCE_FILE_UNSAFE");
    }
    contained(await realpath(paths.tools_root), await realpath(provenancePath));
  }
  const provenance: PinnedBinaryProvenance = Object.freeze({
    schema_version: "tivdoc-pinned-postgresql-provenance-v0.9.1",
    postgres_version: PINNED_POSTGRES_VERSION,
    architecture: "x64",
    source_kind: "edb_official_windows_binaries_zip",
    source_url: PINNED_EDB_ARCHIVE_URL,
    source_sha256: PINNED_EDB_ARCHIVE_SHA256,
    source_integrity: "PINNED_SHA256_OFFICIAL_HTTPS",
    distribution_file_count: PINNED_DISTRIBUTION_FILE_COUNT,
    distribution_bytes: PINNED_DISTRIBUTION_BYTES,
    distribution_tree_sha256: PINNED_DISTRIBUTION_TREE_SHA256,
    binary_sha256: PINNED_BINARY_SHA256,
  });
  await writeProvenanceSafely(paths.tools_root, provenancePath, provenance);
  const binaries = await inspectPinnedPostgresBinaries(paths, runner);
  return Object.freeze({
    binaries,
    provisioning: provisioningReceipt(archiveExisted
      ? "REEXTRACTED_VERIFIED_DISTRIBUTION"
      : "DOWNLOADED_AND_REEXTRACTED_VERIFIED_DISTRIBUTION", extraction),
  });
}

export async function inspectPinnedPostgresBinaries(
  paths: DynamicPostgresPaths,
  runner: CommandRunner = runSafeCommand,
): Promise<PinnedPostgresBinaries> {
  await assertPinnedDirectoryRoots(paths);
  await assertNoReparseTree(paths.distribution_root, paths.tools_root);
  const distribution = await verifyPinnedDistributionTree(paths.distribution_root, paths.tools_root);
  const executablePaths = {} as Record<PostgresBinaryName, string>;
  const actualHashes = {} as Record<PostgresBinaryName, string>;
  const realDistributionRoot = await realpath(paths.distribution_root);
  for (const requiredDirectory of ["lib", "share"] as const) {
    const path = contained(paths.distribution_root, resolve(paths.distribution_root, requiredDirectory));
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`POSTGRES_DISTRIBUTION_DIRECTORY_UNSAFE:${requiredDirectory}`);
    }
  }
  const sourceArchive = contained(paths.tools_root, resolve(
    paths.tools_root,
    "downloads",
    "postgresql-17.11-2-windows-x64-binaries.zip",
  ));
  const sourceMetadata = await lstat(sourceArchive);
  if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink() || sourceMetadata.nlink !== 1
    || sourceMetadata.size !== PINNED_ARCHIVE_BYTES
    || await sha256File(sourceArchive) !== PINNED_EDB_ARCHIVE_SHA256) {
    throw new Error("POSTGRES_PINNED_SOURCE_ARCHIVE_MISMATCH");
  }
  const provenancePath = contained(paths.tools_root, resolve(paths.tools_root, "provenance.json"));
  const provenanceMetadata = await lstat(provenancePath);
  if (!provenanceMetadata.isFile() || provenanceMetadata.isSymbolicLink()) {
    throw new Error("POSTGRES_PROVENANCE_FILE_UNSAFE");
  }
  if (provenanceMetadata.nlink !== 1) throw new Error("POSTGRES_PROVENANCE_FILE_UNSAFE");
  const provenance = parseProvenance(await readFile(provenancePath, "utf8"));

  for (const name of REQUIRED_POSTGRES_BINARIES) {
    const path = contained(paths.binaries_root, resolve(paths.binaries_root, `${name}.exe`));
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`POSTGRES_BINARY_UNSAFE:${name}`);
    const resolved = await realpath(path);
    contained(realDistributionRoot, resolved);
    const digest = await sha256File(resolved);
    if (digest !== PINNED_BINARY_SHA256[name]) {
      throw new Error(`POSTGRES_BINARY_HASH_MISMATCH:${name}`);
    }
    executablePaths[name] = resolved;
    actualHashes[name] = digest;
    if (provenance.binary_sha256[name] !== digest) {
      throw new Error(`POSTGRES_PROVENANCE_BINARY_HASH_MISMATCH:${name}`);
    }
  }

  const version = await runner({
    executable: executablePaths.postgres,
    args: Object.freeze(["--version"]),
    cwd: paths.repository_root,
    timeout_ms: 5_000,
  });
  const versionOutput = `${version.stdout}\n${version.stderr}`.trim().split(/\r?\n/, 1)[0] ?? "";
  if (!new RegExp(`^postgres \\(PostgreSQL\\) ${PINNED_POSTGRES_VERSION}(?:\\s|$)`).test(versionOutput)) {
    throw new Error("POSTGRES_BINARY_VERSION_MISMATCH");
  }

  return Object.freeze({
    schema_version: "tivdoc-pinned-postgresql-binaries-v0.9.1",
    postgres_version: PINNED_POSTGRES_VERSION,
    architecture: "x64",
    source_kind: "edb_official_windows_binaries_zip",
    source_url: PINNED_EDB_ARCHIVE_URL,
    source_sha256: PINNED_EDB_ARCHIVE_SHA256,
    source_integrity: "PINNED_SHA256_OFFICIAL_HTTPS",
    distribution_file_count: distribution.file_count,
    distribution_bytes: distribution.bytes,
    distribution_tree_sha256: distribution.tree_sha256,
    executable_paths: Object.freeze(executablePaths),
    binary_sha256: Object.freeze(actualHashes),
    version_output: versionOutput,
    credentials_emitted: 0,
  });
}

type ArchiveExtractionReceipt = Readonly<{
  schema_version: "tivdoc-postgresql-official-archive-extract-v0.9.1";
  archive_root: "pgsql";
  archive_entries: number;
  extracted_files: number;
  uncompressed_bytes: number;
  path_escape_entries: 0;
  link_entries: 0;
  status: "PASS";
}>;

async function extractPinnedArchive(
  archivePath: string,
  prefix: string,
  cwd: string,
  powershell: string,
  runner: CommandRunner,
): Promise<ArchiveExtractionReceipt> {
  if (process.platform !== "win32") throw new Error("POSTGRES_EXTRACT_WINDOWS_REQUIRED");
  const script = resolve(cwd, "scripts", "canonical-persistence-v091", "foundation", "extract-official-archive.ps1");
  const result = await runner({
    executable: powershell,
    args: Object.freeze([
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", script, "-ArchivePath", archivePath, "-Prefix", prefix,
    ]),
    cwd,
    timeout_ms: 15 * 60_000,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error("POSTGRES_EXTRACT_OUTPUT_INVALID");
  }
  if (!isRecord(parsed)
    || parsed.schema_version !== "tivdoc-postgresql-official-archive-extract-v0.9.1"
    || parsed.archive_root !== "pgsql"
    || !Number.isSafeInteger(parsed.archive_entries) || Number(parsed.archive_entries) < 1
    || Number(parsed.archive_entries) > 30_000
    || !Number.isSafeInteger(parsed.extracted_files) || Number(parsed.extracted_files) < 1
    || !Number.isSafeInteger(parsed.uncompressed_bytes) || Number(parsed.uncompressed_bytes) < 1
    || Number(parsed.uncompressed_bytes) > 1_500_000_000
    || parsed.path_escape_entries !== 0
    || parsed.link_entries !== 0
    || parsed.status !== "PASS") {
    throw new Error("POSTGRES_EXTRACT_RECEIPT_INVALID");
  }
  return Object.freeze(parsed as ArchiveExtractionReceipt);
}

export function parseProvenance(raw: string): PinnedBinaryProvenance {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("POSTGRES_PROVENANCE_JSON_INVALID");
  }
  if (!isRecord(value)) throw new Error("POSTGRES_PROVENANCE_INVALID");
  const sourceKind = value.source_kind;
  if (value.schema_version !== "tivdoc-pinned-postgresql-provenance-v0.9.1"
    || value.postgres_version !== PINNED_POSTGRES_VERSION
    || value.architecture !== "x64"
    || sourceKind !== "edb_official_windows_binaries_zip"
    || value.source_integrity !== "PINNED_SHA256_OFFICIAL_HTTPS"
    || typeof value.source_url !== "string"
    || typeof value.source_sha256 !== "string"
    || !/^[0-9a-f]{64}$/i.test(value.source_sha256)
    || value.distribution_file_count !== PINNED_DISTRIBUTION_FILE_COUNT
    || value.distribution_bytes !== PINNED_DISTRIBUTION_BYTES
    || value.distribution_tree_sha256 !== PINNED_DISTRIBUTION_TREE_SHA256
    || !isRecord(value.binary_sha256)) {
    throw new Error("POSTGRES_PROVENANCE_INVALID");
  }
  if (!isApprovedEdbSource(value.source_url, sourceKind, value.source_sha256)) {
    throw new Error("POSTGRES_PROVENANCE_SOURCE_REJECTED");
  }
  const hashes = {} as Record<PostgresBinaryName, string>;
  for (const name of REQUIRED_POSTGRES_BINARIES) {
    const digest = value.binary_sha256[name];
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/i.test(digest)) {
      throw new Error(`POSTGRES_PROVENANCE_BINARY_HASH_INVALID:${name}`);
    }
    hashes[name] = digest.toLowerCase();
  }
  return Object.freeze({
    schema_version: "tivdoc-pinned-postgresql-provenance-v0.9.1",
    postgres_version: PINNED_POSTGRES_VERSION,
    architecture: "x64",
    source_kind: sourceKind,
    source_url: value.source_url,
    source_sha256: value.source_sha256.toLowerCase(),
    source_integrity: "PINNED_SHA256_OFFICIAL_HTTPS",
    distribution_file_count: PINNED_DISTRIBUTION_FILE_COUNT,
    distribution_bytes: PINNED_DISTRIBUTION_BYTES,
    distribution_tree_sha256: PINNED_DISTRIBUTION_TREE_SHA256,
    binary_sha256: Object.freeze(hashes),
  });
}

function isApprovedEdbSource(
  sourceUrl: string,
  sourceKind: PinnedBinaryProvenance["source_kind"],
  sourceSha256: string,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "get.enterprisedb.com" || parsed.search || parsed.hash) {
    return false;
  }
  return sourceUrl === PINNED_EDB_ARCHIVE_URL
    && sourceSha256.toLowerCase() === PINNED_EDB_ARCHIVE_SHA256;
}

async function downloadPinnedArchive(destination: string): Promise<void> {
  const partial = `${destination}.partial`;
  if (await pathExists(partial)) throw new Error("POSTGRES_DOWNLOAD_PARTIAL_REQUIRES_MANUAL_REVIEW");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(PINNED_EDB_ARCHIVE_URL, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: Object.freeze({ "User-Agent": "tivdoc-postgresql-dynamic-verifier-v0.9.1" }),
    });
    if (response.status !== 200 || response.url !== PINNED_EDB_ARCHIVE_URL || !response.body) {
      throw new Error("POSTGRES_DOWNLOAD_SOURCE_OR_REDIRECT_REJECTED");
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (contentLength !== PINNED_ARCHIVE_BYTES) throw new Error("POSTGRES_DOWNLOAD_SIZE_HEADER_MISMATCH");
    let received = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.byteLength;
        if (received > PINNED_ARCHIVE_BYTES) callback(new Error("POSTGRES_DOWNLOAD_SIZE_LIMIT_EXCEEDED"));
        else callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      limiter,
      createWriteStream(partial, { flags: "wx", mode: 0o600 }),
    );
    if (received !== PINNED_ARCHIVE_BYTES || await sha256File(partial) !== PINNED_EDB_ARCHIVE_SHA256) {
      throw new Error("POSTGRES_DOWNLOAD_INTEGRITY_MISMATCH");
    }
    await rename(partial, destination);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function provisioningReceipt(
  action: PinnedPostgresProvisioningReceipt["action"],
  extraction: ArchiveExtractionReceipt,
): PinnedPostgresProvisioningReceipt {
  return Object.freeze({
    schema_version: "tivdoc-pinned-postgresql-provisioning-v0.9.1",
    action,
    final_source_url: PINNED_EDB_ARCHIVE_URL,
    archive_size_bytes: PINNED_ARCHIVE_BYTES,
    downloaded_bytes: action === "REEXTRACTED_VERIFIED_DISTRIBUTION" ? 0 : PINNED_ARCHIVE_BYTES,
    archive_sha256: PINNED_EDB_ARCHIVE_SHA256,
    source_integrity: "PINNED_SHA256_OFFICIAL_HTTPS",
    extract_only: true,
    extraction_launcher: "DOTNET_VALIDATED_ZIP_ARCHIVE",
    archive_root: extraction.archive_root,
    archive_entries: extraction.archive_entries,
    extracted_files: extraction.extracted_files,
    uncompressed_bytes: extraction.uncompressed_bytes,
    distribution_file_count: PINNED_DISTRIBUTION_FILE_COUNT,
    distribution_bytes: PINNED_DISTRIBUTION_BYTES,
    distribution_tree_sha256: PINNED_DISTRIBUTION_TREE_SHA256,
    fresh_extract: true,
    distribution_reused: false,
    reparse_points_detected: 0,
    windows_token_elevated: false,
    administrator_privileges_used: false,
    system_install_performed: false,
    credentials_emitted: 0,
    status: "PASS",
  });
}

async function ensurePinnedDirectoryRoots(paths: DynamicPostgresPaths): Promise<void> {
  const repositoryRoot = await assertOrdinaryDirectory(paths.repository_root, "POSTGRES_REPOSITORY_ROOT_UNSAFE");
  const dotTools = contained(paths.repository_root, resolve(paths.repository_root, ".tools"));
  await ensureOrdinaryChildDirectory(paths.repository_root, repositoryRoot, dotTools);
  const realDotTools = await realpath(dotTools);
  await ensureOrdinaryChildDirectory(dotTools, realDotTools, paths.tools_root);
  const realToolsRoot = await realpath(paths.tools_root);
  const downloadsRoot = contained(paths.tools_root, resolve(paths.tools_root, "downloads"));
  await ensureOrdinaryChildDirectory(paths.tools_root, realToolsRoot, downloadsRoot);
}

async function assertPinnedDirectoryRoots(paths: DynamicPostgresPaths): Promise<void> {
  const repositoryRoot = await assertOrdinaryDirectory(paths.repository_root, "POSTGRES_REPOSITORY_ROOT_UNSAFE");
  const dotTools = contained(paths.repository_root, resolve(paths.repository_root, ".tools"));
  const realDotTools = await assertOrdinaryDirectory(dotTools, "POSTGRES_TOOLS_ROOT_UNSAFE");
  contained(repositoryRoot, realDotTools);
  const realToolsRoot = await assertOrdinaryDirectory(paths.tools_root, "POSTGRES_TOOLS_ROOT_UNSAFE");
  contained(realDotTools, realToolsRoot);
  const downloadsRoot = contained(paths.tools_root, resolve(paths.tools_root, "downloads"));
  const realDownloadsRoot = await assertOrdinaryDirectory(downloadsRoot, "POSTGRES_DOWNLOAD_ROOT_UNSAFE");
  contained(realToolsRoot, realDownloadsRoot);
}

async function ensureOrdinaryChildDirectory(
  lexicalParent: string,
  realParent: string,
  child: string,
): Promise<void> {
  contained(lexicalParent, child);
  if (!await pathExists(child)) await mkdir(child, { recursive: false });
  const realChild = await assertOrdinaryDirectory(child, "POSTGRES_DIRECTORY_REPARSE_POINT_REJECTED");
  contained(realParent, realChild);
}

async function assertOrdinaryDirectory(candidate: string, code: string): Promise<string> {
  const metadata = await lstat(candidate);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(code);
  return await realpath(candidate);
}

async function assertNoReparseTree(candidate: string, approvedParent: string): Promise<void> {
  const realApprovedParent = await assertOrdinaryDirectory(approvedParent, "POSTGRES_TOOLS_ROOT_UNSAFE");
  const realRoot = await assertOrdinaryDirectory(candidate, "POSTGRES_DISTRIBUTION_ROOT_UNSAFE");
  contained(realApprovedParent, realRoot);
  const pending = [candidate];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const entryPath = contained(candidate, resolve(current, entry.name));
      const metadata = await lstat(entryPath);
      if (metadata.isSymbolicLink()) throw new Error("POSTGRES_DISTRIBUTION_REPARSE_POINT_REJECTED");
      const resolvedEntry = await realpath(entryPath);
      contained(realRoot, resolvedEntry);
      if (metadata.isDirectory()) pending.push(entryPath);
      else if (!metadata.isFile()) throw new Error("POSTGRES_DISTRIBUTION_ENTRY_UNSAFE");
    }
  }
}

async function verifyFreshExtractedDistribution(
  distributionRoot: string,
  paths: DynamicPostgresPaths,
): Promise<void> {
  await assertNoReparseTree(distributionRoot, paths.tools_root);
  await verifyPinnedDistributionTree(distributionRoot, paths.tools_root);
  for (const requiredDirectory of ["lib", "share"] as const) {
    await assertOrdinaryDirectory(
      contained(distributionRoot, resolve(distributionRoot, requiredDirectory)),
      `POSTGRES_DISTRIBUTION_DIRECTORY_UNSAFE:${requiredDirectory}`,
    );
  }
  const binariesRoot = contained(distributionRoot, resolve(distributionRoot, "bin"));
  await assertOrdinaryDirectory(binariesRoot, "POSTGRES_DISTRIBUTION_BINARY_ROOT_UNSAFE");
  for (const name of REQUIRED_POSTGRES_BINARIES) {
    const executable = contained(binariesRoot, resolve(binariesRoot, `${name}.exe`));
    const metadata = await lstat(executable);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`POSTGRES_BINARY_UNSAFE:${name}`);
    if (await sha256File(executable) !== PINNED_BINARY_SHA256[name]) {
      throw new Error(`POSTGRES_BINARY_HASH_MISMATCH:${name}`);
    }
  }
}

type DistributionTreeReceipt = Readonly<{
  file_count: typeof PINNED_DISTRIBUTION_FILE_COUNT;
  bytes: typeof PINNED_DISTRIBUTION_BYTES;
  tree_sha256: typeof PINNED_DISTRIBUTION_TREE_SHA256;
}>;

async function verifyPinnedDistributionTree(
  distributionRoot: string,
  approvedParent: string,
): Promise<DistributionTreeReceipt> {
  await assertNoReparseTree(distributionRoot, approvedParent);
  const files: Array<Readonly<{ relative: string; absolute: string; size: number }>> = [];
  const walk = async (current: string, relativeParent = ""): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const relative = relativeParent ? `${relativeParent}/${entry.name}` : entry.name;
      const absolute = contained(distributionRoot, resolve(current, entry.name));
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) throw new Error("POSTGRES_DISTRIBUTION_REPARSE_POINT_REJECTED");
      if (metadata.isDirectory()) await walk(absolute, relative);
      else if (metadata.isFile()) {
        if (metadata.nlink !== 1) throw new Error("POSTGRES_DISTRIBUTION_HARDLINK_REJECTED");
        files.push(Object.freeze({ relative, absolute, size: metadata.size }));
      } else throw new Error("POSTGRES_DISTRIBUTION_ENTRY_UNSAFE");
    }
  };
  await walk(distributionRoot);
  const tree = createHash("sha256");
  let bytes = 0;
  for (const file of files) {
    tree.update(file.relative, "utf8");
    tree.update(Buffer.from([0]));
    tree.update(String(file.size), "ascii");
    tree.update(Buffer.from([0]));
    tree.update(await sha256File(file.absolute), "ascii");
    tree.update(Buffer.from([10]));
    bytes += file.size;
  }
  const treeSha256 = tree.digest("hex");
  if (files.length !== PINNED_DISTRIBUTION_FILE_COUNT
    || bytes !== PINNED_DISTRIBUTION_BYTES
    || treeSha256 !== PINNED_DISTRIBUTION_TREE_SHA256) {
    throw new Error("POSTGRES_DISTRIBUTION_TREE_MISMATCH");
  }
  return Object.freeze({
    file_count: PINNED_DISTRIBUTION_FILE_COUNT,
    bytes: PINNED_DISTRIBUTION_BYTES,
    tree_sha256: PINNED_DISTRIBUTION_TREE_SHA256,
  });
}

async function resolveTrustedPowerShell(): Promise<string> {
  const expected = resolve("C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const metadata = await lstat(expected);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("POSTGRES_TRUSTED_POWERSHELL_UNAVAILABLE");
  }
  const resolved = await realpath(expected);
  if (resolved.toLowerCase() !== expected.toLowerCase()) {
    throw new Error("POSTGRES_TRUSTED_POWERSHELL_PATH_MISMATCH");
  }
  return resolved;
}

async function assertUnelevatedWindows(
  repositoryRoot: string,
  powershell: string,
  runner: CommandRunner,
): Promise<void> {
  const script = resolve(
    repositoryRoot,
    "scripts",
    "canonical-persistence-v091",
    "foundation",
    "assert-unelevated.ps1",
  );
  const result = await runner({
    executable: powershell,
    args: Object.freeze([
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
    ]),
    cwd: repositoryRoot,
    timeout_ms: 10_000,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error("POSTGRES_WINDOWS_TOKEN_RECEIPT_INVALID");
  }
  if (!isRecord(parsed)
    || parsed.schema_version !== "tivdoc-windows-token-elevation-v0.9.1"
    || parsed.elevated !== false
    || parsed.status !== "PASS") {
    throw new Error("DYNAMIC_POSTGRESQL_ENVIRONMENT_BLOCKED:ADMINISTRATOR_TOKEN_REJECTED");
  }
}

async function writeProvenanceSafely(
  toolsRoot: string,
  provenancePath: string,
  provenance: PinnedBinaryProvenance,
): Promise<void> {
  const temporary = contained(toolsRoot, resolve(
    toolsRoot,
    `.provenance-${process.pid}-${randomBytes(8).toString("hex")}.json`,
  ));
  await writeFile(temporary, `${JSON.stringify(provenance, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  try {
    if (await pathExists(provenancePath)) {
      const metadata = await lstat(provenancePath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
        throw new Error("POSTGRES_PROVENANCE_FILE_UNSAFE");
      }
      contained(await realpath(toolsRoot), await realpath(provenancePath));
      await rm(provenancePath, { force: false });
    }
    await rename(temporary, provenancePath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function executableBasenames(receipt: PinnedPostgresBinaries): readonly string[] {
  return Object.freeze(REQUIRED_POSTGRES_BINARIES.map((name) => basename(receipt.executable_paths[name])));
}
