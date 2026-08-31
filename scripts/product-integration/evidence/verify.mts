import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

type ManifestEntry = Readonly<{ path: string; sha256: string; byte_count: number }>;
type EvidenceManifest = Readonly<{
  schema_version: "tivdoc-product-integration-evidence-manifest-v0.8.0";
  payload_files: readonly ManifestEntry[];
  payload_file_count: number;
  payload_bytes: number;
  payload_set_sha256: string;
  self_reference_rule: string;
}>;
type WrapperReceipt = Readonly<{
  schema_version: "tivdoc-product-integration-evidence-wrapper-v0.8.0";
  manifest_path: string;
  manifest_sha256: string;
  zip_path: string;
  zip_sha256: string;
  zip_byte_count: number;
  wrapper_excluded_from_manifest_and_zip: true;
}>;

const finalRoot = path.resolve(process.argv[2] ?? path.join(process.cwd(), "output", "product-integration-v0.8.0", "final"));
const manifestPath = path.join(finalRoot, "evidence-manifest.json");
const wrapperPath = path.join(finalRoot, "evidence-wrapper-receipt.json");
const manifestBytes = await readFile(manifestPath);
const manifest = JSON.parse(manifestBytes.toString("utf8")) as EvidenceManifest;
const wrapper = JSON.parse(await readFile(wrapperPath, "utf8")) as WrapperReceipt;
assert(manifest.schema_version === "tivdoc-product-integration-evidence-manifest-v0.8.0", "EVIDENCE_MANIFEST_SCHEMA_INVALID");
assert(wrapper.schema_version === "tivdoc-product-integration-evidence-wrapper-v0.8.0", "EVIDENCE_WRAPPER_SCHEMA_INVALID");
assert(wrapper.wrapper_excluded_from_manifest_and_zip === true, "EVIDENCE_WRAPPER_SELF_REFERENCE_RULE_INVALID");
assert(wrapper.manifest_path === "evidence-manifest.json", "EVIDENCE_MANIFEST_PATH_INVALID");
assert(wrapper.zip_path === "tivdoc-product-integration-v0.8.0.zip", "EVIDENCE_ZIP_PATH_INVALID");
assert(sha256(manifestBytes) === wrapper.manifest_sha256, "EVIDENCE_MANIFEST_HASH_MISMATCH");

const sortedPaths = manifest.payload_files.map((entry) => entry.path);
assert(new Set(sortedPaths).size === sortedPaths.length, "EVIDENCE_PAYLOAD_PATH_DUPLICATE");
assert(JSON.stringify(sortedPaths) === JSON.stringify([...sortedPaths].sort()), "EVIDENCE_PAYLOAD_ORDER_INVALID");
assert(manifest.payload_file_count === manifest.payload_files.length, "EVIDENCE_PAYLOAD_COUNT_MISMATCH");
let payloadBytes = 0;
for (const entry of manifest.payload_files) {
  assertSafeRelative(entry.path);
  const absolute = path.resolve(finalRoot, entry.path);
  assert(absolute.startsWith(`${finalRoot}${path.sep}`), "EVIDENCE_PAYLOAD_PATH_ESCAPE");
  const bytes = await readFile(absolute);
  assert(bytes.byteLength === entry.byte_count, `EVIDENCE_BYTE_COUNT_MISMATCH:${entry.path}`);
  assert(sha256(bytes) === entry.sha256, `EVIDENCE_HASH_MISMATCH:${entry.path}`);
  payloadBytes += bytes.byteLength;
}
assert(payloadBytes === manifest.payload_bytes, "EVIDENCE_TOTAL_BYTES_MISMATCH");
assert(sha256(Buffer.from(manifest.payload_files.map((entry) => `${entry.path}\0${entry.sha256}\0${entry.byte_count}\n`).join(""), "utf8")) === manifest.payload_set_sha256, "EVIDENCE_PAYLOAD_SET_HASH_MISMATCH");

const zipPath = path.join(finalRoot, wrapper.zip_path);
const zipBytes = await readFile(zipPath);
assert(zipBytes.byteLength === wrapper.zip_byte_count, "EVIDENCE_ZIP_BYTE_COUNT_MISMATCH");
assert(sha256(zipBytes) === wrapper.zip_sha256, "EVIDENCE_ZIP_HASH_MISMATCH");
const zipInfo = await stat(zipPath);
assert(zipInfo.isFile(), "EVIDENCE_ZIP_NOT_FILE");

const receipt = Object.freeze({
  schema_version: "tivdoc-product-integration-independent-verifier-v0.8.0",
  status: "PASS",
  payload_file_count: manifest.payload_file_count,
  payload_bytes: manifest.payload_bytes,
  payload_set_sha256: manifest.payload_set_sha256,
  manifest_sha256: wrapper.manifest_sha256,
  zip_sha256: wrapper.zip_sha256,
  prohibited_self_references: 0,
});
process.stdout.write(`${JSON.stringify(receipt)}\n`);

function assertSafeRelative(value: string): void {
  assert(value.length > 0 && value.length <= 240, "EVIDENCE_PAYLOAD_PATH_LENGTH_INVALID");
  assert(!path.isAbsolute(value) && !value.includes("\\") && !value.split("/").includes(".."), "EVIDENCE_PAYLOAD_PATH_UNSAFE");
  assert(!["evidence-manifest.json", "evidence-wrapper-receipt.json", "tivdoc-product-integration-v0.8.0.zip"].includes(value), "EVIDENCE_SELF_REFERENCE_FORBIDDEN");
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function assert(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}
