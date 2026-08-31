import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

type ManifestEntry = Readonly<{ path: string; sha256: string; byte_count: number }>;
type EvidenceManifest = Readonly<{
  schema_version: "tivdoc-canonical-postgresql-evidence-manifest-v0.9.0";
  payload_files: readonly ManifestEntry[];
  payload_file_count: number;
  payload_bytes: number;
  payload_set_sha256: string;
  self_reference_rule: string;
}>;
type WrapperReceipt = Readonly<{
  schema_version: "tivdoc-canonical-postgresql-evidence-wrapper-v0.9.0";
  manifest_path: "evidence-manifest.json";
  manifest_sha256: string;
  zip_path: "tivdoc-canonical-postgresql-persistence-v0.9.0.zip";
  zip_sha256: string;
  zip_byte_count: number;
  wrapper_excluded_from_manifest_and_zip: true;
}>;

const finalRoot = path.resolve(process.argv[2] ?? path.join(process.cwd(), "output", "canonical-postgresql-persistence-v0.9.0", "final"));
const manifestPath = path.join(finalRoot, "evidence-manifest.json");
const wrapperPath = path.join(finalRoot, "evidence-wrapper-receipt.json");
const manifestBytes = await readFile(manifestPath);
const manifest = parseJson<EvidenceManifest>(manifestBytes, "EVIDENCE_MANIFEST_JSON_INVALID");
const wrapper = parseJson<WrapperReceipt>(await readFile(wrapperPath), "EVIDENCE_WRAPPER_JSON_INVALID");
assert(manifest.schema_version === "tivdoc-canonical-postgresql-evidence-manifest-v0.9.0", "EVIDENCE_MANIFEST_SCHEMA_INVALID");
assert(wrapper.schema_version === "tivdoc-canonical-postgresql-evidence-wrapper-v0.9.0", "EVIDENCE_WRAPPER_SCHEMA_INVALID");
assert(wrapper.wrapper_excluded_from_manifest_and_zip === true, "EVIDENCE_WRAPPER_SELF_REFERENCE_RULE_INVALID");
assert(wrapper.manifest_path === "evidence-manifest.json", "EVIDENCE_MANIFEST_PATH_INVALID");
assert(wrapper.zip_path === "tivdoc-canonical-postgresql-persistence-v0.9.0.zip", "EVIDENCE_ZIP_PATH_INVALID");
assert(sha256(manifestBytes) === wrapper.manifest_sha256, "EVIDENCE_MANIFEST_HASH_MISMATCH");

const payloadPaths = manifest.payload_files.map((entry) => entry.path);
const normalizedPaths = payloadPaths.map(normalizeRelative);
assert(new Set(normalizedPaths).size === normalizedPaths.length, "EVIDENCE_PAYLOAD_NORMALIZED_PATH_DUPLICATE");
assert(JSON.stringify(payloadPaths) === JSON.stringify([...payloadPaths].sort()), "EVIDENCE_PAYLOAD_ORDER_INVALID");
assert(manifest.payload_file_count === manifest.payload_files.length, "EVIDENCE_PAYLOAD_COUNT_MISMATCH");
let payloadBytes = 0;
let parsedJsonFiles = 0;
for (const entry of manifest.payload_files) {
  assertSafeRelative(entry.path);
  const absolute = path.resolve(finalRoot, entry.path);
  assert(absolute.startsWith(`${finalRoot}${path.sep}`), "EVIDENCE_PAYLOAD_PATH_ESCAPE");
  const bytes = await readFile(absolute);
  assert(bytes.byteLength === entry.byte_count, `EVIDENCE_BYTE_COUNT_MISMATCH:${entry.path}`);
  assert(sha256(bytes) === entry.sha256, `EVIDENCE_HASH_MISMATCH:${entry.path}`);
  if (entry.path.endsWith(".json")) {
    parseJson(bytes, `EVIDENCE_JSON_INVALID:${entry.path}`);
    parsedJsonFiles += 1;
  }
  payloadBytes += bytes.byteLength;
}
assert(payloadBytes === manifest.payload_bytes, "EVIDENCE_TOTAL_BYTES_MISMATCH");
const payloadSet = Buffer.from(manifest.payload_files.map((entry) => `${entry.path}\0${entry.sha256}\0${entry.byte_count}\n`).join(""), "utf8");
assert(sha256(payloadSet) === manifest.payload_set_sha256, "EVIDENCE_PAYLOAD_SET_HASH_MISMATCH");

const before = parseJson<{ capabilities: readonly { capability: string }[] }>(await readFile(path.join(finalRoot, "ledger-before.json")), "LEDGER_BEFORE_INVALID");
const after = parseJson<{ capabilities: readonly { capability: string; status: string }[] }>(await readFile(path.join(finalRoot, "ledger-after.json")), "LEDGER_AFTER_INVALID");
const acceptance = parseJson<{ counts: { capabilities_total: number; adapters_implemented: number; composition_bindings: number } }>(await readFile(path.join(finalRoot, "acceptance-receipt.json")), "ACCEPTANCE_RECEIPT_INVALID");
const beforeIds = before.capabilities.map((entry) => entry.capability);
const afterIds = after.capabilities.map((entry) => entry.capability);
assert(beforeIds.length === 14 && new Set(beforeIds).size === 14, "LEDGER_BEFORE_DENOMINATOR_INVALID");
assert(JSON.stringify(beforeIds) === JSON.stringify(afterIds), "LEDGER_CAPABILITY_RECONCILIATION_MISMATCH");
assert(acceptance.counts.capabilities_total === 14, "ACCEPTANCE_CAPABILITY_DENOMINATOR_INVALID");
assert(acceptance.counts.adapters_implemented === after.capabilities.filter((entry) => entry.status === "POSTGRESQL_ADAPTER_IMPLEMENTED").length, "ACCEPTANCE_ADAPTER_COUNT_CONTRADICTION");
assert(acceptance.counts.composition_bindings <= acceptance.counts.adapters_implemented, "ACCEPTANCE_BINDING_COUNT_CONTRADICTION");

const zipPath = path.join(finalRoot, wrapper.zip_path);
const zipBytes = await readFile(zipPath);
assert(zipBytes.byteLength === wrapper.zip_byte_count, "EVIDENCE_ZIP_BYTE_COUNT_MISMATCH");
assert(sha256(zipBytes) === wrapper.zip_sha256, "EVIDENCE_ZIP_HASH_MISMATCH");
assert((await stat(zipPath)).isFile(), "EVIDENCE_ZIP_NOT_FILE");
const listing = spawnSync("tar", ["-tf", zipPath], { encoding: "utf8", windowsHide: true });
assert(listing.status === 0, `EVIDENCE_ZIP_LIST_FAILED:${listing.stderr ?? ""}`);
const archivePaths = (listing.stdout ?? "").split(/\r?\n/u).filter(Boolean).map(normalizeRelative);
archivePaths.forEach(assertSafeRelative);
assert(new Set(archivePaths).size === archivePaths.length, "EVIDENCE_ZIP_PATH_DUPLICATE");
const expectedArchivePaths = [...payloadPaths, "evidence-manifest.json"].map(normalizeRelative);
assert(JSON.stringify(archivePaths) === JSON.stringify(expectedArchivePaths), "EVIDENCE_ZIP_CONTENT_SET_OR_ORDER_MISMATCH");

process.stdout.write(`${JSON.stringify(Object.freeze({
  schema_version: "tivdoc-canonical-postgresql-independent-verifier-v0.9.0",
  status: "PASS",
  payload_file_count: manifest.payload_file_count,
  payload_bytes: manifest.payload_bytes,
  parsed_json_files: parsedJsonFiles,
  payload_set_sha256: manifest.payload_set_sha256,
  manifest_sha256: wrapper.manifest_sha256,
  zip_sha256: wrapper.zip_sha256,
  normalized_path_duplicates: 0,
  prohibited_self_references: 0,
  ledger_capabilities_reconciled: 14,
}))}\n`);

function normalizeRelative(value: string): string {
  return path.posix.normalize(value.replaceAll("\\", "/"));
}

function assertSafeRelative(value: string): void {
  assert(value.length > 0 && value.length <= 240, "EVIDENCE_PAYLOAD_PATH_LENGTH_INVALID");
  const normalized = normalizeRelative(value);
  assert(normalized === value, "EVIDENCE_PAYLOAD_PATH_NOT_NORMALIZED");
  assert(!path.isAbsolute(value) && !value.includes("\\") && !value.split("/").includes(".."), "EVIDENCE_PAYLOAD_PATH_UNSAFE");
  assert(!["evidence-manifest.json", "evidence-wrapper-receipt.json", "tivdoc-canonical-postgresql-persistence-v0.9.0.zip", "independent-verifier-stdout.jsonl", "independent-verifier-stderr.txt"].includes(value), "EVIDENCE_SELF_REFERENCE_FORBIDDEN");
}

function parseJson<T>(bytes: Uint8Array, code: string): T {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as T;
  } catch {
    throw new Error(code);
  }
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function assert(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}
