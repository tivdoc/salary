import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { assertCredentialFreeEvidence } from "./credential-scan.mts";
import { writeDeterministicStoreZip } from "./deterministic-zip.mts";

export type EvidencePayload = Readonly<Record<string, unknown>>;

export type DynamicEvidenceReceipt = Readonly<{
  schema_version: "tivdoc-canonical-postgresql-dynamic-evidence-v0.9.1";
  final_root: string;
  manifest_path: string;
  manifest_sha256: string;
  zip_path: string;
  zip_sha256: string;
  zip_byte_count: number;
  repeat_build_zip_sha256: string;
  repeat_build_match: true;
  payload_file_count: number;
  payload_set_sha256: string;
  independent_verifier_output_path: string;
  independent_verifier_output_sha256: string;
  independent_verifier_output_byte_count: number;
  wrapper_sha256: string;
  credentials_recorded: 0;
  status: "PASS";
}>;

const ZIP_NAME = "tivdoc-canonical-postgresql-dynamic-v0.9.1.zip";
const MAX_EVIDENCE_PAYLOAD_BYTES = 16 * 1024 * 1024;

export async function buildDynamicEvidence(input: Readonly<{
  repository_root: string;
  final_root: string;
  payloads: Readonly<Record<string, EvidencePayload>>;
}>): Promise<DynamicEvidenceReceipt> {
  const repositoryRoot = path.resolve(input.repository_root);
  const finalRoot = path.resolve(input.final_root);
  const requiredRoot = path.resolve(repositoryRoot, "output", "canonical-postgresql-dynamic-v0.9.1", "final");
  if (finalRoot !== requiredRoot) throw new Error("DYNAMIC_EVIDENCE_ROOT_UNSAFE");
  await assertSafeEvidenceDestination(repositoryRoot, finalRoot);
  await rm(finalRoot, { recursive: true, force: true });
  await mkdir(finalRoot, { recursive: true });
  await assertSafeEvidenceDestination(repositoryRoot, finalRoot);

  const payloadNames = Object.keys(input.payloads).sort();
  if (payloadNames.length === 0 || new Set(payloadNames).size !== payloadNames.length) {
    throw new Error("DYNAMIC_EVIDENCE_PAYLOAD_SET_INVALID");
  }
  for (const name of payloadNames) {
    assertSafePayloadName(name);
    const serialized = `${JSON.stringify(input.payloads[name], null, 2)}\n`;
    assertCredentialFreeEvidence(serialized);
    if (Buffer.byteLength(serialized, "utf8") > MAX_EVIDENCE_PAYLOAD_BYTES) {
      throw new Error("DYNAMIC_EVIDENCE_PAYLOAD_TOO_LARGE");
    }
    await writeFile(path.join(finalRoot, name), serialized, "utf8");
  }

  const payloadFiles = [] as Array<Readonly<{ path: string; sha256: string; byte_count: number }>>;
  for (const name of payloadNames) {
    const absolute = path.join(finalRoot, name);
    const bytes = await readFile(absolute);
    payloadFiles.push(Object.freeze({ path: name, sha256: sha256(bytes), byte_count: bytes.byteLength }));
  }
  const payloadSet = Buffer.from(payloadFiles.map((entry) =>
    `${entry.path}\0${entry.sha256}\0${entry.byte_count}\n`).join(""), "utf8");
  const manifest = Object.freeze({
    schema_version: "tivdoc-canonical-postgresql-dynamic-evidence-manifest-v0.9.1",
    payload_files: Object.freeze(payloadFiles),
    payload_file_count: payloadFiles.length,
    payload_bytes: payloadFiles.reduce((sum, entry) => sum + entry.byte_count, 0),
    payload_set_sha256: sha256(payloadSet),
    self_reference_rule: "manifest, wrapper, ZIP and verifier output are excluded from payload hashes; manifest is included in ZIP",
  });
  const manifestName = "evidence-manifest.json";
  const manifestPath = path.join(finalRoot, manifestName);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const manifestSha256 = await sha256File(manifestPath);

  const entries = Object.freeze([...payloadNames, manifestName]);
  const zipPath = path.join(finalRoot, ZIP_NAME);
  const repeatPath = path.resolve(repositoryRoot, ".tmp", "postgresql-dynamic-v0.9.1", "evidence-repeat.zip");
  await mkdir(path.dirname(repeatPath), { recursive: true });
  await rm(repeatPath, { force: true });
  await writeDeterministicStoreZip({ root: finalRoot, output: zipPath, entries });
  await writeDeterministicStoreZip({ root: finalRoot, output: repeatPath, entries });
  const zipSha256 = await sha256File(zipPath);
  const repeatSha256 = await sha256File(repeatPath);
  await rm(repeatPath, { force: true });
  if (zipSha256 !== repeatSha256) throw new Error("DYNAMIC_EVIDENCE_REPEAT_BUILD_MISMATCH");
  const zipMetadata = await stat(zipPath);

  const wrapperBase = Object.freeze({
    schema_version: "tivdoc-canonical-postgresql-dynamic-evidence-wrapper-v0.9.1",
    manifest_path: manifestName,
    manifest_sha256: manifestSha256,
    zip_path: ZIP_NAME,
    zip_sha256: zipSha256,
    zip_byte_count: zipMetadata.size,
    repeat_build_zip_sha256: repeatSha256,
    repeat_build_match: true,
    wrapper_excluded_from_manifest_and_zip: true,
    independent_verifier_output_excluded_from_manifest_and_zip: true,
  });
  const wrapperName = "evidence-wrapper-receipt.json";
  const wrapperPath = path.join(finalRoot, wrapperName);
  await writeFile(wrapperPath, `${JSON.stringify({
    ...wrapperBase,
    independent_verifier_output_path: "independent-verifier-output.json",
    independent_verifier_output_sha256: null,
    independent_verifier_output_byte_count: null,
    outer_receipt_complete: false,
  }, null, 2)}\n`, "utf8");

  const verifierOutputName = "independent-verifier-output.json";
  const verifierScript = path.resolve(repositoryRoot, "scripts", "canonical-persistence-v091", "evidence", "verify.mts");
  const verifierArgs = [
    "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
    "--experimental-strip-types",
    verifierScript,
    finalRoot,
  ];
  const bootstrapVerifier = spawnSync(process.execPath, [...verifierArgs, "--bootstrap-wrapper"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  });
  if (bootstrapVerifier.status !== 0 || bootstrapVerifier.error || bootstrapVerifier.stderr.trim() !== "") {
    throw new Error("DYNAMIC_EVIDENCE_INDEPENDENT_VERIFIER_FAILED");
  }
  const bootstrapVerifierValue = JSON.parse(bootstrapVerifier.stdout) as Readonly<Record<string, unknown>>;
  assertExactVerifierKeys(bootstrapVerifierValue);
  if (bootstrapVerifierValue.verification_mode !== "BOOTSTRAP"
      || bootstrapVerifierValue.status !== "BOOTSTRAP_PASS") {
    throw new Error("DYNAMIC_EVIDENCE_INDEPENDENT_VERIFIER_FAILED");
  }
  const finalVerifierCandidate = Object.freeze({
    ...bootstrapVerifierValue,
    verification_mode: "FINAL",
    status: "PASS",
  });
  const verifierOutputPath = path.join(finalRoot, verifierOutputName);
  const verifierOutputBytes = Buffer.from(`${JSON.stringify(finalVerifierCandidate, null, 2)}\n`, "utf8");
  await writeFile(verifierOutputPath, verifierOutputBytes);
  const verifierOutputSha256 = sha256(verifierOutputBytes);
  await writeFile(wrapperPath, `${JSON.stringify({
    ...wrapperBase,
    independent_verifier_output_path: verifierOutputName,
    independent_verifier_output_sha256: verifierOutputSha256,
    independent_verifier_output_byte_count: verifierOutputBytes.byteLength,
    outer_receipt_complete: true,
  }, null, 2)}\n`, "utf8");
  const finalVerifier = spawnSync(process.execPath, verifierArgs, {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  });
  if (finalVerifier.status !== 0 || finalVerifier.error || finalVerifier.stderr.trim() !== "") {
    throw new Error("DYNAMIC_EVIDENCE_FINAL_INDEPENDENT_VERIFIER_FAILED");
  }
  const finalVerifierValue = JSON.parse(finalVerifier.stdout) as Readonly<Record<string, unknown>>;
  assertExactVerifierKeys(finalVerifierValue);
  const finalVerifierBytes = Buffer.from(`${JSON.stringify(finalVerifierValue, null, 2)}\n`, "utf8");
  if (finalVerifierValue.verification_mode !== "FINAL" || finalVerifierValue.status !== "PASS"
      || !finalVerifierBytes.equals(verifierOutputBytes)
      || sha256(finalVerifierBytes) !== verifierOutputSha256) {
    throw new Error("DYNAMIC_EVIDENCE_FINAL_INDEPENDENT_VERIFIER_MISMATCH");
  }
  await writeFile(verifierOutputPath, finalVerifierBytes);
  const wrapperSha256 = await sha256File(wrapperPath);

  return Object.freeze({
    schema_version: "tivdoc-canonical-postgresql-dynamic-evidence-v0.9.1",
    final_root: finalRoot,
    manifest_path: manifestPath,
    manifest_sha256: manifestSha256,
    zip_path: zipPath,
    zip_sha256: zipSha256,
    zip_byte_count: zipMetadata.size,
    repeat_build_zip_sha256: repeatSha256,
    repeat_build_match: true,
    payload_file_count: payloadFiles.length,
    payload_set_sha256: manifest.payload_set_sha256,
    independent_verifier_output_path: verifierOutputPath,
    independent_verifier_output_sha256: verifierOutputSha256,
    independent_verifier_output_byte_count: verifierOutputBytes.byteLength,
    wrapper_sha256: wrapperSha256,
    credentials_recorded: 0,
    status: "PASS",
  });
}

function assertSafePayloadName(name: string): void {
  if (!/^[a-z0-9][a-z0-9-]{1,80}\.json$/u.test(name)
      || ["evidence-manifest.json", "evidence-wrapper-receipt.json", ZIP_NAME,
        "independent-verifier-output.json"].includes(name)) {
    throw new Error("DYNAMIC_EVIDENCE_PAYLOAD_NAME_UNSAFE");
  }
}

function assertExactVerifierKeys(value: Readonly<Record<string, unknown>>): void {
  const expected = [
    "schema_version", "verification_mode", "status", "payload_file_count", "payload_bytes",
    "payload_set_sha256", "manifest_sha256", "zip_sha256", "zip_entry_bytes_verified",
    "deterministic_rebuild_match", "repeat_build_match", "real_postgresql_connection_attempts",
    "capability_count", "atomicity_boundary_count", "concurrency_case_count",
    "regression_command_count", "credentials_detected",
  ].sort();
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expected)) {
    throw new Error("DYNAMIC_EVIDENCE_VERIFIER_RECEIPT_KEYS_INVALID");
  }
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function assertSafeEvidenceDestination(repositoryRoot: string, finalRoot: string): Promise<void> {
  const repositoryMetadata = await lstat(repositoryRoot);
  if (!repositoryMetadata.isDirectory() || repositoryMetadata.isSymbolicLink()
      || !samePhysicalPath(await realpath(repositoryRoot), repositoryRoot)) {
    throw new Error("DYNAMIC_EVIDENCE_REPOSITORY_ROOT_UNSAFE");
  }
  const relative = path.relative(repositoryRoot, finalRoot);
  if (relative !== path.join("output", "canonical-postgresql-dynamic-v0.9.1", "final")) {
    throw new Error("DYNAMIC_EVIDENCE_ROOT_UNSAFE");
  }
  let current = repositoryRoot;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (isErrno(error, "ENOENT")) break;
      throw error;
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()
        || !samePhysicalPath(await realpath(current), current)) {
      throw new Error("DYNAMIC_EVIDENCE_REPARSE_POINT_FORBIDDEN");
    }
  }
}

function samePhysicalPath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isErrno(value: unknown, code: string): value is NodeJS.ErrnoException {
  return typeof value === "object" && value !== null && "code" in value
    && (value as NodeJS.ErrnoException).code === code;
}
