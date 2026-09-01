import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { contained, type DynamicPostgresPaths } from "./paths.mts";
import {
  PINNED_POSTGRES_VERSION,
  REQUIRED_POSTGRES_BINARIES,
  type PinnedPostgresBinaries,
  type PinnedPostgresProvisioningReceipt,
  type PostgresBinaryName,
} from "./pinned-binaries.mts";
import { type CommandRunner, runSafeCommand } from "./process.mts";

const INSTALLER_URL = "https://get.enterprisedb.com/postgresql/postgresql-17.11-1-windows-x64.exe";
const INSTALLER_BYTES = 373_033_224;
const INSTALLER_SHA256 = "f104c552d8495a6f20738c2a03f643164bc64b9985363329e314dec24559f0b7";
const DISTRIBUTION_FILES = 20_569;
const DISTRIBUTION_BYTES = 948_935_114;
const DISTRIBUTION_TREE_SHA256 = "bd43ff63eac0a3592b495af1a31da9d532ab553846f9a6cf4fab1d76b98cc7d9";
const AUTHENTICODE_SUBJECT = "CN=EnterpriseDB Corporation, O=EnterpriseDB Corporation, L=Wilmington, S=Delaware, C=US";
const AUTHENTICODE_ISSUER = "CN=DigiCert Trusted G4 Code Signing RSA4096 SHA384 2021 CA1, O=\"DigiCert, Inc.\", C=US";
const AUTHENTICODE_THUMBPRINT = "7BEDD1269FCCF7A5D95F18274750B79893C06C70";
const BINARY_SHA256: Readonly<Record<PostgresBinaryName, string>> = Object.freeze({
  postgres: "4125c1e963072d929f6468a449ad184b26d3be7d97cae3181c3d613dace49c8d",
  initdb: "6978bdb96e1e515285eb7bbf8915c4a254644107b1fcb44917e52f707dbe798a",
  pg_ctl: "5afdea4f4860b52cd03cee4c51be5d034a51f7ed63312acc3b6abee9006fa0ba",
  psql: "5bb3fad8a7ff555abff37921a24ee3d9e377c15408b5e7267aa9245596965ca0",
  createdb: "1e8322a28156e0c33a668a2a9a1cf3c8f24e36951e461c8f3bfa60dfb0a80ef9",
  dropdb: "10fabb879e3dcef64f23484b35c508a7665c6a00d7feae0c0cf87ffbe9eb0a30",
  pg_dump: "ff766351cc88b0ea2bc7b6e365777cb51f792b16000688a378f64124810ffa88",
  pg_restore: "ae002028451e79240eaad9838d9eb0b644436a05decb3888468a529bf881ac6c",
  pg_isready: "15242279c66680141586747a475090d70f83874cc19dc63709be6b57b0ba411c",
});

type AuthenticodeReceipt = Readonly<{
  schema_version: "tivdoc-postgresql-installer-authenticode-v0.10.0";
  status: "Valid";
  subject: string;
  issuer: string;
  thumbprint: string;
}>;

/**
 * Selects the locally cached EDB installer distribution only after byte-exact
 * tree, executable, source-installer and Authenticode verification. This path
 * exists for Windows Smart App Control hosts that reject the unsigned DLLs in
 * the otherwise pinned EDB ZIP. It never starts or reuses a system service.
 */
export async function inspectAuthenticodeInstalledPostgresRuntime(
  paths: DynamicPostgresPaths,
  runner: CommandRunner = runSafeCommand,
): Promise<Readonly<{
  binaries: PinnedPostgresBinaries;
  provisioning: PinnedPostgresProvisioningReceipt;
}>> {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("POSTGRES_AUTHENTICODE_RUNTIME_REQUIRES_WINDOWS_X64");
  }
  const distributionRoot = contained(paths.tools_root, resolve(paths.tools_root, "17.11-1-signed"));
  const binariesRoot = contained(distributionRoot, resolve(distributionRoot, "bin"));
  const installer = contained(paths.tools_root, resolve(
    paths.tools_root,
    "downloads",
    "postgresql-17.11-1-windows-x64.exe",
  ));
  const installerMetadata = await lstat(installer);
  if (!installerMetadata.isFile() || installerMetadata.isSymbolicLink()
      || installerMetadata.nlink !== 1 || installerMetadata.size !== INSTALLER_BYTES
      || await sha256File(installer) !== INSTALLER_SHA256) {
    throw new Error("POSTGRES_AUTHENTICODE_INSTALLER_INTEGRITY_INVALID");
  }
  contained(await realpath(paths.tools_root), await realpath(installer));
  const authenticode = await inspectAuthenticode(installer, paths.repository_root, runner);
  if (authenticode.status !== "Valid" || authenticode.subject !== AUTHENTICODE_SUBJECT
      || authenticode.issuer !== AUTHENTICODE_ISSUER
      || authenticode.thumbprint !== AUTHENTICODE_THUMBPRINT) {
    throw new Error("POSTGRES_AUTHENTICODE_INSTALLER_SIGNATURE_INVALID");
  }
  const distribution = await inspectDistributionTree(distributionRoot, paths.tools_root);
  for (const requiredDirectory of ["lib", "share"] as const) {
    const metadata = await lstat(contained(distributionRoot, resolve(distributionRoot, requiredDirectory)));
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`POSTGRES_AUTHENTICODE_RUNTIME_DIRECTORY_INVALID:${requiredDirectory}`);
    }
  }
  const executablePaths = {} as Record<PostgresBinaryName, string>;
  const actualHashes = {} as Record<PostgresBinaryName, string>;
  for (const name of REQUIRED_POSTGRES_BINARIES) {
    const executable = contained(binariesRoot, resolve(binariesRoot, `${name}.exe`));
    const metadata = await lstat(executable);
    const digest = metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1
      ? await sha256File(executable) : "";
    if (digest !== BINARY_SHA256[name]) throw new Error(`POSTGRES_AUTHENTICODE_BINARY_INVALID:${name}`);
    executablePaths[name] = await realpath(executable);
    actualHashes[name] = digest;
  }
  const version = await runner({
    executable: executablePaths.postgres,
    args: Object.freeze(["--version"]),
    cwd: paths.repository_root,
    timeout_ms: 5_000,
  });
  const versionOutput = `${version.stdout}\n${version.stderr}`.trim().split(/\r?\n/u, 1)[0] ?? "";
  if (!new RegExp(`^postgres \\(PostgreSQL\\) ${PINNED_POSTGRES_VERSION}(?:\\s|$)`, "u").test(versionOutput)) {
    throw new Error("POSTGRES_AUTHENTICODE_BINARY_VERSION_INVALID");
  }
  const binaries: PinnedPostgresBinaries = Object.freeze({
    schema_version: "tivdoc-pinned-postgresql-binaries-v0.9.1",
    postgres_version: PINNED_POSTGRES_VERSION,
    architecture: "x64",
    source_kind: "edb_authenticode_signed_windows_installer",
    source_url: INSTALLER_URL,
    source_sha256: INSTALLER_SHA256,
    source_integrity: "PINNED_SHA256_AND_VALID_AUTHENTICODE",
    distribution_file_count: distribution.file_count,
    distribution_bytes: distribution.bytes,
    distribution_tree_sha256: distribution.tree_sha256,
    executable_paths: Object.freeze(executablePaths),
    binary_sha256: Object.freeze(actualHashes),
    version_output: versionOutput,
    credentials_emitted: 0,
  });
  const provisioning: PinnedPostgresProvisioningReceipt = Object.freeze({
    schema_version: "tivdoc-pinned-postgresql-provisioning-v0.9.1",
    action: "REUSED_AUTHENTICODE_VERIFIED_INSTALLER_DISTRIBUTION",
    final_source_url: INSTALLER_URL,
    archive_size_bytes: INSTALLER_BYTES,
    downloaded_bytes: 0,
    archive_sha256: INSTALLER_SHA256,
    source_integrity: "PINNED_SHA256_AND_VALID_AUTHENTICODE",
    extract_only: false,
    extraction_launcher: "PREEXISTING_AUTHENTICODE_VERIFIED_INSTALLER",
    archive_root: "installer_distribution",
    archive_entries: 1,
    extracted_files: DISTRIBUTION_FILES,
    uncompressed_bytes: DISTRIBUTION_BYTES,
    distribution_file_count: distribution.file_count,
    distribution_bytes: distribution.bytes,
    distribution_tree_sha256: distribution.tree_sha256,
    fresh_extract: false,
    distribution_reused: true,
    reparse_points_detected: 0,
    windows_token_elevated: false,
    administrator_privileges_used: false,
    system_install_performed: false,
    credentials_emitted: 0,
    authenticode_status: authenticode.status,
    authenticode_subject: authenticode.subject,
    authenticode_issuer: authenticode.issuer,
    authenticode_thumbprint: authenticode.thumbprint,
    status: "PASS",
  });
  return Object.freeze({ binaries, provisioning });
}

async function inspectAuthenticode(
  installer: string,
  repositoryRoot: string,
  runner: CommandRunner,
): Promise<AuthenticodeReceipt> {
  const powershell = resolve("C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const metadata = await lstat(powershell);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (await realpath(powershell)).toLowerCase() !== powershell.toLowerCase()) {
    throw new Error("POSTGRES_AUTHENTICODE_TRUSTED_POWERSHELL_INVALID");
  }
  const script = resolve(repositoryRoot, "scripts", "canonical-persistence-v091", "foundation", "inspect-authenticode.ps1");
  const result = await runner({
    executable: powershell,
    args: Object.freeze([
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", script, "-InstallerPath", installer,
    ]),
    cwd: repositoryRoot,
    timeout_ms: 30_000,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error("POSTGRES_AUTHENTICODE_RECEIPT_INVALID");
  }
  if (!isRecord(parsed) || parsed.schema_version !== "tivdoc-postgresql-installer-authenticode-v0.10.0"
      || parsed.status !== "Valid" || typeof parsed.subject !== "string"
      || typeof parsed.issuer !== "string" || typeof parsed.thumbprint !== "string") {
    throw new Error("POSTGRES_AUTHENTICODE_RECEIPT_INVALID");
  }
  return Object.freeze(parsed as AuthenticodeReceipt);
}

async function inspectDistributionTree(
  distributionRoot: string,
  approvedParent: string,
): Promise<Readonly<{ file_count: number; bytes: number; tree_sha256: string }>> {
  const realParent = await realpath(approvedParent);
  const realRoot = await realpath(distributionRoot);
  contained(realParent, realRoot);
  const files: Array<Readonly<{ relative: string; absolute: string; size: number }>> = [];
  const walk = async (current: string, relativeParent = ""): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const relative = relativeParent ? `${relativeParent}/${entry.name}` : entry.name;
      const absolute = contained(distributionRoot, resolve(current, entry.name));
      const metadata = await lstat(absolute);
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) await walk(absolute, relative);
      else if (metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1) {
        contained(realRoot, await realpath(absolute));
        files.push(Object.freeze({ relative, absolute, size: metadata.size }));
      } else throw new Error("POSTGRES_AUTHENTICODE_DISTRIBUTION_ENTRY_INVALID");
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
  if (files.length !== DISTRIBUTION_FILES || bytes !== DISTRIBUTION_BYTES
      || treeSha256 !== DISTRIBUTION_TREE_SHA256) {
    throw new Error("POSTGRES_AUTHENTICODE_DISTRIBUTION_TREE_INVALID");
  }
  return Object.freeze({ file_count: files.length, bytes, tree_sha256: treeSha256 });
}

async function sha256File(file: string): Promise<string> {
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk: Buffer) => hash.update(chunk));
    stream.on("error", rejectPromise);
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
