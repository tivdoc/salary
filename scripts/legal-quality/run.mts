import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { buildSevenRuleSpecAuthoringSkeletons, lintRuleSpecForActivation } from "../../src/engine/legal-quality/rulespec-authoring.ts";
import { BlankGoldenImportLedger, buildBlankGoldenCaseTemplates, diffGoldenTemplateVersions } from "../../src/engine/legal-quality/golden-case-templates.ts";
import { canonicalSha256, canonicalStringify } from "../../src/engine/rule-runtime/canonical.ts";

const mode = process.argv[2] ?? "all";
const output = path.resolve(import.meta.dirname, "../../output/overnight-v0.7/p4/legal-quality");

function write(relative: string, value: unknown) {
  const target = path.join(output, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  const bytes = `${canonicalStringify(value)}\n`;
  writeFileSync(target, bytes, { encoding: "utf8", flag: "w" });
  return { path: path.relative(path.resolve(import.meta.dirname, "../.."), target).replaceAll("\\", "/"), sha256: createHash("sha256").update(bytes, "utf8").digest("hex"), byte_count: Buffer.byteLength(bytes) };
}

function skeletons() {
  const values = buildSevenRuleSpecAuthoringSkeletons();
  const reports = values.map(lintRuleSpecForActivation);
  if (values.length !== 7 || reports.some((item) => item.activation_allowed || item.execution_allowed)) throw new Error("RULESPEC_SKELETON_VERIFICATION_FAILED");
  const artifacts = values.map((value) => write(`rulespec-skeletons/${value.topic}.json`, value));
  return { count: values.length, activation_allowed: 0, artifacts, reports_sha256: canonicalSha256(reports) };
}

function golden() {
  const templates = buildBlankGoldenCaseTemplates();
  if (templates.length !== 42) throw new Error("GOLDEN_TEMPLATE_COUNT_MISMATCH");
  const ledger = new BlankGoldenImportLedger();
  const first = ledger.importBlank({ template: templates[0], idempotency_key: "script-golden-import-0001", reason_code: "BLANK_TEMPLATE_GENERATED" });
  const replay = ledger.importBlank({ template: templates[0], idempotency_key: "script-golden-import-0001", reason_code: "BLANK_TEMPLATE_GENERATED" });
  const invalidated = ledger.invalidateDependency({ template_id: templates[0].template_id, expected_template_sha256: templates[0].content_sha256, dependency_sha256: "d".repeat(64), idempotency_key: "script-golden-invalidate-0001", reason_code: "DEPENDENCY_MUTATED" });
  const diff = diffGoldenTemplateVersions(templates, templates.slice(0, -1));
  const artifacts = templates.map((value) => write(`golden-templates/${value.topic}/${value.scenario}.json`, value));
  return { count: templates.length, approvals: 0, artifacts, mechanics: { first, replay, invalidated, event_count: ledger.events().length, diff } };
}

if (!["skeletons", "golden", "verify", "all"].includes(mode)) { console.error("usage: run.mts skeletons|golden|verify|all"); process.exit(2); }
const receipt = { schema_version: "tivdoc-legal-quality-receipt-v0.7.0", status: "PASS", command: mode, skeletons: mode === "golden" ? null : skeletons(), golden: mode === "skeletons" ? null : golden(), blockers: ["RULE_LEGAL_APPROVAL_REQUIRED", "HUMAN_LEGAL_SOURCE_REVIEW_REQUIRED", "NUMERIC_DUAL_ATTESTATION_REQUIRED"] };
const manifest = { ...receipt, receipt_sha256: canonicalSha256(receipt) };
const artifact = write("manifest.json", manifest);
console.log(JSON.stringify({ ...manifest, manifest_artifact: artifact }));
