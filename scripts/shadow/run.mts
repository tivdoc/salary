import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { canonicalSha256, canonicalStringify } from "../../src/engine/rule-runtime/canonical.ts";
import { OfflineShadowControlPlane } from "../../src/server/engine/shadow/control-plane.ts";
import { readOfflineShadowFlags } from "../../src/server/engine/shadow/flags.ts";
import { buildSyntheticShadowDefinition, SyntheticMechanicsShadowEvaluator } from "../../src/server/engine/shadow/synthetic-fixtures.ts";

const mode = process.argv[2] ?? "all";
if (!["verify", "synthetic", "real-blocked", "all"].includes(mode)) { console.error("usage: run.mts verify|synthetic|real-blocked|all"); process.exit(2); }
readOfflineShadowFlags({}, process.env.NODE_ENV);
if (process.env.NODE_ENV === "production") throw new Error("SHADOW_TEST_OR_OFFLINE_MODE_FORBIDDEN_IN_PRODUCTION");
const repo = path.resolve(import.meta.dirname, "../..");
const output = path.join(repo, "output/overnight-v0.7/p4/shadow");
function write(name: string, value: unknown) { mkdirSync(output, { recursive: true }); const bytes = `${canonicalStringify(value)}\n`; const target = path.join(output, name); writeFileSync(target, bytes, "utf8"); return { path: path.relative(repo, target).replaceAll("\\", "/"), sha256: createHash("sha256").update(bytes, "utf8").digest("hex"), byte_count: Buffer.byteLength(bytes) }; }

async function execute(catalogMode: "synthetic_test" | "real_inactive") {
  const evaluator = new SyntheticMechanicsShadowEvaluator();
  const plane = new OfflineShadowControlPlane({ flags: { enabled: true, synthetic_enabled: true, public_enabled: false }, evaluator, now: () => "2042-01-01T00:00:00.000Z" });
  const definition = plane.registerDefinition(buildSyntheticShadowDefinition(catalogMode));
  const scheduled = plane.schedule({ definition_id: definition.definition_id, run_id: `shadow.run.${catalogMode}.script`, idempotency_key: `shadow-script-${catalogMode}-0001` });
  const run = await plane.execute(scheduled.run_id);
  const replay = plane.replay(run.run_id);
  if (run.state !== "completed" || replay.run_sha256 !== run.run_sha256 || run.slots.length !== 7) throw new Error("SHADOW_SCRIPT_VERIFICATION_FAILED");
  return { definition, run, replay_sha256: replay.run_sha256, audit: plane.auditEvents(), evaluator_calls: evaluator.calls };
}

const synthetic = mode === "real-blocked" ? null : await execute("synthetic_test");
const real = mode === "synthetic" ? null : await execute("real_inactive");
if (real && real.run.slots.some((slot) => slot.baseline.status !== "blocked_legal_readiness" || slot.candidate.status !== "blocked_legal_readiness" || slot.baseline.amount !== null || slot.candidate.amount !== null || slot.baseline.finding_count !== 0 || slot.candidate.finding_count !== 0 || slot.baseline.customer_report_count !== 0 || slot.candidate.customer_report_count !== 0)) throw new Error("SHADOW_REAL_BLOCKED_INVARIANT_FAILED");
const artifacts = [synthetic ? write("synthetic-run.json", synthetic) : null, real ? write("real-blocked-run.json", real) : null].filter(Boolean);
const receipt = { schema_version: "tivdoc-offline-shadow-receipt-v0.7.0", status: "PASS", command: mode, synthetic_run_sha256: synthetic?.run.run_sha256 ?? null, real_blocked_run_sha256: real?.run.run_sha256 ?? null, real_money_outputs: 0, real_findings: 0, customer_reports: 0, promotion_thresholds: null, promotion_eligible: false, network_calls: 0, artifacts, blockers: ["SHADOW_PROMOTION_THRESHOLDS_UNSET", "LEGAL_SOURCE_CORPUS_INCOMPLETE", "CUSTOMER_SHADOW_NOT_AUTHORIZED"] };
const manifest = { ...receipt, receipt_sha256: canonicalSha256(receipt) };
const manifestArtifact = write("manifest.json", manifest);
console.log(JSON.stringify({ ...manifest, manifest_artifact: manifestArtifact }));
