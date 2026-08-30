import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { bytesSha256, canonicalLegalOperationsJson, frozen, legalOperationsSha256 } from "../../src/engine/legal-operations/canonical.ts";
import { realCatalogStatusMatrix, syntheticSevenTopicCatalogMatrix } from "../../src/engine/legal-operations/catalog.ts";
import { buildAllReviewPacketBundles, buildOwnerHandoffIndex } from "../../src/engine/legal-operations/review-packets.ts";
import { SYNTHETIC_CATALOG_TIMESTAMP } from "../../src/engine/legal-operations/synthetic-fixtures.ts";
import { runLegalOperationsAcceptanceMatrix } from "../../src/server/engine/legal-operations/acceptance.ts";

const DEFAULT_OUTPUT = "output/parallel-wave-3/workers/w2-legal-operations";
const args = process.argv.slice(2);
const command = args[0] ?? "verify";
const outputIndex = args.indexOf("--output");
const output = resolve(outputIndex >= 0 && args[outputIndex + 1] ? args[outputIndex + 1] : DEFAULT_OUTPUT);

async function writeJson(path: string, value: unknown) {
  const content = canonicalLegalOperationsJson(value);
  await writeFile(path, content, "utf8");
  return bytesSha256(Buffer.from(content, "utf8"));
}

async function buildPackets() {
  const packetDirectory = resolve(output, "review-packets");
  await mkdir(packetDirectory, { recursive: true });
  const files: Array<{ path: string; sha256: string }> = [];
  for (const bundle of buildAllReviewPacketBundles()) {
    const jsonRelativePath = `review-packets/${bundle.topic}.review-packet.json`;
    const markdownRelativePath = `review-packets/${bundle.topic}.review-packet.md`;
    const decisionRelativePath = `review-packets/${bundle.topic}.blank-decision.json`;
    const jsonPath = resolve(packetDirectory, `${bundle.topic}.review-packet.json`);
    const markdownPath = resolve(packetDirectory, `${bundle.topic}.review-packet.md`);
    const decisionPath = resolve(packetDirectory, `${bundle.topic}.blank-decision.json`);
    await writeFile(jsonPath, bundle.json, "utf8");
    await writeFile(markdownPath, bundle.markdown, "utf8");
    await writeFile(decisionPath, bundle.blank_decision_json, "utf8");
    files.push(
      { path: jsonRelativePath, sha256: bytesSha256(Buffer.from(bundle.json, "utf8")) },
      { path: markdownRelativePath, sha256: bytesSha256(Buffer.from(bundle.markdown, "utf8")) },
      { path: decisionRelativePath, sha256: bytesSha256(Buffer.from(bundle.blank_decision_json, "utf8")) },
    );
  }
  const handoff = buildOwnerHandoffIndex("review-packets");
  const handoffPath = resolve(output, "owner-handoff-index.json");
  files.push({ path: "owner-handoff-index.json", sha256: await writeJson(handoffPath, handoff) });
  const manifest = frozen({ schema_version: "tivdoc-legal-operations-packet-manifest-v0.6.0", generated_at: SYNTHETIC_CATALOG_TIMESTAMP, packet_count: 7, file_count: files.length, files, passed: files.length === 22 });
  const manifestPath = resolve(output, "review-packet-manifest.json");
  await writeJson(manifestPath, manifest);
  return frozen({ ...manifest, manifest_path: "review-packet-manifest.json", manifest_sha256: legalOperationsSha256(manifest) });
}

async function verify() {
  await mkdir(output, { recursive: true });
  const packets = await buildPackets();
  const acceptance = await runLegalOperationsAcceptanceMatrix();
  const acceptancePath = resolve(output, "acceptance-matrix.json");
  const acceptanceFileSha256 = await writeJson(acceptancePath, acceptance.report);
  const strictReadiness = frozen({
    schema_version: "tivdoc-legal-operations-strict-readiness-evidence-v0.6.0",
    ready_count: acceptance.report.real_catalog.ready_count,
    active_parameter_count: acceptance.report.real_catalog.active_parameter_count,
    active_rule_count: acceptance.report.real_catalog.active_rule_count,
    expected_exit_code: 2,
    passed: acceptance.report.real_catalog.passed && acceptance.report.real_catalog.ready_count === 0 && acceptance.report.real_catalog.active_parameter_count === 0 && acceptance.report.real_catalog.active_rule_count === 0,
  });
  const strictReadinessPath = resolve(output, "strict-readiness-summary.json");
  const strictReadinessFileSha256 = await writeJson(strictReadinessPath, strictReadiness);
  const evidence = frozen({
    schema_version: "tivdoc-wave3-w2-evidence-v0.6.0",
    generated_at: SYNTHETIC_CATALOG_TIMESTAMP,
    packets,
    acceptance_matrix_path: "acceptance-matrix.json",
    acceptance_matrix_file_sha256: acceptanceFileSha256,
    acceptance_matrix_sha256: acceptance.report_sha256,
    strict_readiness_path: "strict-readiness-summary.json",
    strict_readiness_file_sha256: strictReadinessFileSha256,
    strict_readiness: strictReadiness,
    passed: packets.passed && acceptance.report.passed && strictReadiness.passed,
  });
  await writeJson(resolve(output, "evidence-summary.json"), evidence);
  return evidence;
}

async function main() {
  if (command === "build-packets") return buildPackets();
  if (command === "verify") return verify();
  if (command === "status") return realCatalogStatusMatrix();
  if (command === "strict-readiness") {
    const status = await realCatalogStatusMatrix();
    process.stdout.write(canonicalLegalOperationsJson(status));
    process.exit(status.ready_count === 0 && status.passed ? 2 : 1);
  }
  if (command === "synthetic-demo") return syntheticSevenTopicCatalogMatrix();
  if (["import", "propose-activation", "activate", "revoke", "supersede"].includes(command)) {
    const acceptance = await runLegalOperationsAcceptanceMatrix();
    return frozen({ schema_version: "tivdoc-legal-operations-command-demonstration-v0.6.0", requested_command: command, append_only_service_verified: acceptance.report.passed, fixture_results: acceptance.report.fixture_results });
  }
  throw new Error(`UNKNOWN_LEGAL_OPERATIONS_COMMAND:${command}`);
}

main().then((result) => process.stdout.write(canonicalLegalOperationsJson(result))).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
