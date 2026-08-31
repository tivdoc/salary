import { canonicalSha256 } from "../../../engine/rule-runtime/canonical";
import { buildOfflineGroundTruthWorkspace, existingPublicBenchmarkProvenanceInventory } from "../../../engine/extraction-ground-truth/overnight-v07/workspace";
import { buildBlankGoldenCaseTemplates } from "../../../engine/legal-quality/golden-case-templates";
import { buildSevenRuleSpecAuthoringSkeletons, lintRuleSpecForActivation } from "../../../engine/legal-quality/rulespec-authoring";
import { loadCurrentP3Corpus } from "../../engine/legal-knowledge/overnight-v07/corpus";
import { verifyP3ReviewWorkspace } from "../../engine/legal-knowledge/overnight-v07/workspace";
import { OfflineShadowControlPlane } from "../../engine/shadow/control-plane";
import { buildSyntheticShadowDefinition, SyntheticMechanicsShadowEvaluator } from "../../engine/shadow/synthetic-fixtures";
import path from "node:path";
import type { P8Dependency } from "./contracts";

/** A public fixture may run only after an independent provenance gate says it is eligible. */
export interface PublicFixtureProvenancePort {
  eligibleFixture(): Readonly<{ fixture_id: string; provenance_sha256: string; eligible: true }> | null;
}

export function pendingDependencies(publicFixture: PublicFixtureProvenancePort): readonly P8Dependency[] {
  const dependencies: P8Dependency[] = [];
  if (publicFixture.eligibleFixture() === null) {
    dependencies.push({
      lane: "public_fixture",
      status: "SKIPPED_NO_ELIGIBLE_PROVENANCE",
      blocker_code: "PUBLIC_FIXTURE_PROVENANCE_NOT_ELIGIBLE",
      required_adapter: "PublicFixtureProvenancePort",
      affected_acceptance_ids: ["V07-P8-PUBLIC-FIXTURE"],
    });
  }
  dependencies.push({
    lane: "native_visual",
    status: "SKIPPED_BLOCKED",
    blocker_code: "NATIVE_VISUAL_VERIFICATION_EXECUTED_OUTSIDE_UNIT_HARNESS",
    required_adapter: "browser_and_poppler_visual_receipt",
    affected_acceptance_ids: ["V07-P8-VISUAL"],
  });
  return Object.freeze(dependencies.map((item) => Object.freeze({ ...item, affected_acceptance_ids: Object.freeze([...item.affected_acceptance_ids]) })));
}

export const NO_ELIGIBLE_PUBLIC_FIXTURE: PublicFixtureProvenancePort = Object.freeze({
  eligibleFixture: () => null,
});

export async function verifyIntegratedP3P4(repositoryRoot = process.cwd()) {
  const corpus = await loadCurrentP3Corpus({ repository_root: repositoryRoot, corpus_state_root: repositoryRoot });
  const workspace = await verifyP3ReviewWorkspace(path.join(repositoryRoot, "output", "overnight-v0.7", "p3", "run-c", "review-workspace"));
  const skeletons = buildSevenRuleSpecAuthoringSkeletons();
  const skeletonReports = skeletons.map(lintRuleSpecForActivation);
  const golden = buildBlankGoldenCaseTemplates();
  const groundTruth = buildOfflineGroundTruthWorkspace();
  const publicInventory = existingPublicBenchmarkProvenanceInventory();
  const syntheticShadow = await executeShadow("synthetic_test");
  const realShadow = await executeShadow("real_inactive");
  const realBlocked = realShadow.slots.every((slot) => slot.baseline.status === "blocked_legal_readiness" && slot.candidate.status === "blocked_legal_readiness" && slot.baseline.amount === null && slot.candidate.amount === null && slot.baseline.finding_count === 0 && slot.candidate.finding_count === 0 && slot.baseline.customer_report_count === 0 && slot.candidate.customer_report_count === 0);
  const p3 = Object.freeze({ integrated: workspace.passed && corpus.inventory.readiness.ready_topic_count === 0 && corpus.inventory.decisions.active_sources === 0, inventory_sha256: corpus.inventory.inventory_sha256, workspace_artifact_count: workspace.artifact_count, topic_count: workspace.topic_count, active_sources: corpus.inventory.decisions.active_sources, ready_topics: corpus.inventory.readiness.ready_topic_count });
  const p4 = Object.freeze({ integrated: skeletons.length === 7 && skeletonReports.every((report) => !report.activation_allowed && !report.execution_allowed) && golden.length === 42 && groundTruth.workflow.locked_ground_truth.status === "locked_ground_truth" && publicInventory.every((item) => item.reuse_status === "excluded_pending_explicit_approval") && syntheticShadow.slots.length === 7 && realShadow.slots.length === 7 && realBlocked, skeleton_count: skeletons.length, golden_template_count: golden.length, ground_truth_workspace_sha256: groundTruth.workspace_sha256, synthetic_shadow_sha256: syntheticShadow.run_sha256, real_blocked_shadow_sha256: realShadow.run_sha256, real_money_outputs: 0, real_findings: 0, customer_reports: 0 });
  return Object.freeze({ p3, p4, receipt_sha256: canonicalSha256({ p3, p4 }) });
}

async function executeShadow(catalogMode: "synthetic_test" | "real_inactive") {
  const evaluator = new SyntheticMechanicsShadowEvaluator();
  const plane = new OfflineShadowControlPlane({ flags: { enabled: true, synthetic_enabled: true, public_enabled: false }, evaluator, now: () => "2040-01-01T00:00:00.000Z" });
  const definition = plane.registerDefinition(buildSyntheticShadowDefinition(catalogMode));
  const scheduled = plane.schedule({ definition_id: definition.definition_id, run_id: `p8.shadow.${catalogMode}`, idempotency_key: `p8-shadow-${catalogMode}-0001` });
  const run = await plane.execute(scheduled.run_id);
  if (run.state !== "completed" || plane.replay(run.run_id).run_sha256 !== run.run_sha256) throw new Error("P8_SHADOW_REPLAY_FAILED");
  return run;
}

