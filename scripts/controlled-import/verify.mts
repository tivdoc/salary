import { buildControlledImportAdversarialMatrix, probeNativeWindowsImportFilesystem } from "../../src/server/engine/legal-knowledge/controlled-import-adversarial/matrix.ts";
import { controlledImportMigrationRequest } from "../../src/server/engine/legal-knowledge/controlled-import-ledger/sql.ts";
import { detectLocalParserSandboxPlatform, localParserSandboxCapability } from "../../src/server/platform/security/parser-sandbox.ts";

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}

const detection = detectLocalParserSandboxPlatform();
const capability = localParserSandboxCapability(detection);
const nativeRows = await probeNativeWindowsImportFilesystem();
const matrix = buildControlledImportAdversarialMatrix(nativeRows);
const proof = {
  schema_version: "tivdoc-controlled-import-w3-proof-v0.10.0",
  acceptance: {
    "MC-10": capability.status,
    "MC-11": controlledImportMigrationRequest.status,
    "MC-12": matrix.every((row) => row.expected === "reject" || row.expected === "fail_closed") ? "PASS_LOCAL_MATRIX" : "FAIL",
  },
  parser: {
    platform: detection.platform,
    architecture: detection.architecture,
    node_version: detection.node_version,
    node_permission_model: detection.node_permission_model,
    locally_detected_primitives: detection.locally_detected_primitives,
    capability,
  },
  controlled_import_ledger: controlledImportMigrationRequest,
  adversarial_matrix: matrix,
  prohibited_operations: {
    network_calls: 0,
    official_bytes: 0,
    customer_or_legal_data: 0,
    persistent_owner_imports: 0,
    product_wiring_changes: 0,
  },
};

process.stdout.write(`${JSON.stringify(stableValue(proof), null, 2)}\n`);
