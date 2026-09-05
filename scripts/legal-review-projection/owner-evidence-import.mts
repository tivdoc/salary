// L11-1 / D1 (run 11). Stores the two owner-evidence files — the lawyer-approved
// opinion on the six open decisions and the record of its approval — as
// immutable evidence artifacts, after the one gate D1 names: the opinion's
// sha256 must equal the value the approval record carries. If it does not,
// the run is refused (`BLOCKED_EVIDENCE_MISMATCH`) and nothing is stored.
//
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \
//     scripts/legal-review-projection/owner-evidence-import.mts --from <folder>
//
// Exactly two files are read from the folder, by their exact names; the folder
// is never listed and nothing else in it is opened. The artifacts land under
// the git-ignored evidence tree (`eval/legal-knowledge/artifacts/<SOURCE>/
// <version>/<sha256>.md`), the ledger record under the manifests, and the
// receipt under output/next. Nothing from the folder enters the repository.
import "../production-refusal.mjs";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  BLOCKED_EVIDENCE_MISMATCH,
  OWNER_EVIDENCE_FILES,
  OWNER_EVIDENCE_SOURCE_VERSION,
  ownerEvidenceRecord,
  ownerEvidenceRecordSchema,
  verifyOwnerEvidence,
  type OwnerEvidenceKey,
  type OwnerEvidenceRecord,
} from "../../src/engine/legal-knowledge/owner-evidence.ts";
import { storeImmutableLegalArtifact } from "../../src/server/engine/legal-knowledge/artifacts.ts";

const ARTIFACT_ROOT = path.join("eval", "legal-knowledge", "artifacts");
const LEDGER = path.join("eval", "legal-knowledge", "manifests", "owner-evidence.json");
const RECEIPT_ROOT = path.join("output", "next", "pool-q");
const RECEIPT = path.join(RECEIPT_ROOT, "owner-evidence-import.json");
const LEDGER_SCHEMA = "tivdoc-owner-evidence-ledger-v1";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

function folderArgument(): string {
  const index = process.argv.indexOf("--from");
  const folder = index >= 0 ? process.argv[index + 1] : undefined;
  if (!folder) throw new Error("USAGE: owner-evidence-import.mts --from <folder>");
  return folder;
}

type Ledger = { schema_version: string; records: OwnerEvidenceRecord[] };

function readLedger(): Ledger {
  if (!existsSync(LEDGER)) return { schema_version: LEDGER_SCHEMA, records: [] };
  const parsed = JSON.parse(readFileSync(LEDGER, "utf8")) as Ledger;
  return { schema_version: LEDGER_SCHEMA, records: parsed.records.map((record) => ownerEvidenceRecordSchema.parse(record)) };
}

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const folder = folderArgument();
  const bytes = {} as Record<OwnerEvidenceKey, Uint8Array>;
  for (const expected of OWNER_EVIDENCE_FILES) {
    const file = path.join(folder, expected.filename);
    if (!existsSync(file)) {
      const receipt = { schema_version: "tivdoc-owner-evidence-import-v1", unit: "L11-1 / D1", status: "BLOCKED_EVIDENCE_MISSING", missing: expected.filename, stored: 0 };
      writeFileSync(RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
      console.log(`L11_1_OWNER_EVIDENCE ${JSON.stringify(receipt)}`);
      process.exitCode = 2;
      return;
    }
    bytes[expected.key] = readFileSync(file);
  }

  // --- The gate, before anything else.
  const verification = verifyOwnerEvidence(bytes);
  if (!verification.ok) {
    const receipt = {
      schema_version: "tivdoc-owner-evidence-import-v1", unit: "L11-1 / D1",
      status: BLOCKED_EVIDENCE_MISMATCH, mismatches: verification.mismatches, stored: 0,
      note: "The opinion's bytes do not match the digest the approval record names, or the record does not name it. Nothing was stored.",
    };
    writeFileSync(RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    console.log(`L11_1_OWNER_EVIDENCE ${JSON.stringify({ status: receipt.status, mismatches: receipt.mismatches.length })}`);
    process.exitCode = 2;
    return;
  }

  // --- Store, then record. An artifact already present with the same bytes is
  // fine (the store is idempotent by content); different bytes at the same
  // address would be immutable_artifact_mismatch, which is not caught.
  const acquiredAt = new Date().toISOString();
  const ledger = readLedger();
  const stored: Array<{ key: OwnerEvidenceKey; created: boolean; artifact_path: string; artifact_sha256: string; byte_count: number; ledger: "appended" | "already_present" }> = [];
  for (const expected of OWNER_EVIDENCE_FILES) {
    const result = await storeImmutableLegalArtifact({
      root: ARTIFACT_ROOT, sourceId: expected.source_id, sourceVersion: OWNER_EVIDENCE_SOURCE_VERSION,
      artifactSha256: expected.sha256, extension: "md", bytes: bytes[expected.key],
    });
    const artifactPath = path.relative(process.cwd(), result.path).replaceAll("\\", "/");
    const existing = ledger.records.find((record) => record.artifact_sha256 === expected.sha256);
    if (!existing) ledger.records.push(ownerEvidenceRecord({ expectation: expected, acquired_at: acquiredAt, artifact_path: artifactPath }));
    stored.push({
      key: expected.key, created: result.created, artifact_path: artifactPath, artifact_sha256: expected.sha256,
      byte_count: bytes[expected.key].byteLength, ledger: existing ? "already_present" : "appended",
    });
  }
  ledger.records.sort((left, right) => left.key.localeCompare(right.key));
  mkdirSync(path.dirname(LEDGER), { recursive: true });
  const ledgerText = `${JSON.stringify(ledger, null, 2)}\n`;
  writeFileSync(LEDGER, ledgerText, "utf8");

  const receipt = {
    schema_version: "tivdoc-owner-evidence-import-v1",
    unit: "L11-1 / D1",
    status: "stored",
    gate: { opinion_sha256_matches_recorded_value: true, approval_record_names_opinion_sha256: true },
    files_read: OWNER_EVIDENCE_FILES.map((entry) => entry.filename),
    nothing_else_read_from_folder: true,
    folder_listed: false,
    stored,
    ledger: { path: LEDGER.replaceAll("\\", "/"), sha256: sha256(ledgerText), records: ledger.records.length },
    source_grade: "owner_evidence",
    attestation: "none",
    approver_identity: null,
    counters: { reviewed_sources: 0, active_parameters: 0, active_rules: 0, attestations: 0, findings: 0 },
  };
  writeFileSync(RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  console.log(`L11_1_OWNER_EVIDENCE ${JSON.stringify({
    status: receipt.status,
    stored: stored.map((entry) => `${entry.key}:${entry.artifact_sha256.slice(0, 16)}:${entry.created ? "created" : "present"}`),
    ledger_sha256: receipt.ledger.sha256.slice(0, 16),
  })}`);
}

await main();
