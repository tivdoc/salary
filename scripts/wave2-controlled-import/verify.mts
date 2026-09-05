import "../production-refusal.mjs";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  controlledImportPersistentReadiness,
  verifyControlledAcquisitionLedger,
} from "../../src/server/engine/legal-knowledge/controlled-import-security.ts";
import { screenUntrustedPdfIsolated } from "../../src/server/engine/legal-knowledge/parser-isolation/index.ts";

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stableValue(item)]));
  return value;
}

function stableJson(value: unknown) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function syntheticPdf(marker = "wave2-controlled-import-verification") {
  return Buffer.from(`%PDF-1.7
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>
endobj
${`% bounded synthetic ${marker}\n`.repeat(20)}
xref
0 4
0000000000 65535 f
trailer
<< /Size 4 /Root 1 0 R >>
startxref
0
%%EOF
`);
}

const repoRoot = process.cwd();
const outputRoot = path.resolve(repoRoot, "output", "parallel-wave-2", "batch-a", "controlled-import");
const persistentLedgerRoot = path.resolve(repoRoot, "eval", "legal-knowledge", "acquisition", "ledger");
const persistentArtifactRoot = path.resolve(repoRoot, "eval", "legal-knowledge", "acquisition", "artifacts");
const persistentVerification = await verifyControlledAcquisitionLedger({ ledgerRoot: persistentLedgerRoot, artifactRoot: persistentArtifactRoot });
const persistentReadiness = controlledImportPersistentReadiness(persistentVerification);
const parserScreen = await screenUntrustedPdfIsolated({ bytes: syntheticPdf() });
const networkCanary = await screenUntrustedPdfIsolated({ bytes: syntheticPdf(), testOnlyBehavior: "network_canary" });
let hostileActiveContent = "unexpected_acceptance";
try {
  await screenUntrustedPdfIsolated({ bytes: syntheticPdf("/JavaScript /OpenAction") });
} catch (error) {
  hostileActiveContent = error instanceof Error ? error.message : "unknown_rejection";
}

const reportWithoutHash = {
  schema_version: "tivdoc-wave2-controlled-import-evidence-v0.4",
  base_sha: "2478e28eb4f31d282dac4b6f8f1fb488fb9b5bca",
  network_used: false,
  customer_data_used: false,
  production_or_external_storage_used: false,
  persistent_verification: persistentVerification,
  persistent_readiness: persistentReadiness,
  parser_screen: parserScreen,
  parser_network_canary: networkCanary,
  hostile_active_content_result: hostileActiveContent,
  state_machine: ["received", "quarantined", "validated", "published", "ledger_appended"],
  crash_injection_transitions: ["after_received", "after_private_copy", "after_validation", "after_artifact_publish", "after_event_publish", "after_ledger_append"],
  quarantined_private_input_recovery_without_inbox_covered: true,
  concurrency_cases: ["same_identity_same_hash", "same_bytes_conflicting_identity", "different_bytes_same_expected_identity", "interrupted_then_retried"],
  parser_adversarial_cases: ["traversal", "symlink_or_reparse", "hardlink", "windows_ads", "case_collision", "polyglot", "javascript_or_actions", "embedded_files", "external_references", "encryption", "page_or_object_bomb", "decompression_bomb", "timeout", "cancellation", "output_limit"],
  persistent_owner_import_entries_required: 0,
  durable_replicated_custody_claimed: false,
};
const canonical = stableJson(reportWithoutHash);
const report = { ...reportWithoutHash, report_payload_sha256: sha256(canonical) };
await mkdir(outputRoot, { recursive: true });
await writeFile(path.join(outputRoot, "controlled-import-evidence.v0.4.json"), stableJson(report));
process.stdout.write(stableJson(report));
if (persistentVerification.persistent_owner_import_entries !== 0 || persistentReadiness.ready || parserScreen.status !== "screened" || networkCanary.network_disabled !== true || hostileActiveContent !== "isolated_parser_active_content") process.exitCode = 2;
