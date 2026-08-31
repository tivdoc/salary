import type { P8Dependency } from "./contracts";

/** Consumer-owned seam. P8 does not reproduce P3 review-workspace/corpus logic. */
export interface P3ReviewWorkspaceIntegrationPort {
  capability(): Readonly<{ integrated: true; receipt_sha256: string }>;
}

/** Consumer-owned seam. P8 does not reproduce P4 RuleSpec/golden/GT/shadow logic. */
export interface P4QualityShadowIntegrationPort {
  capability(): Readonly<{ integrated: true; receipt_sha256: string }>;
}

/** A public fixture may run only after an independent provenance gate says it is eligible. */
export interface PublicFixtureProvenancePort {
  eligibleFixture(): Readonly<{ fixture_id: string; provenance_sha256: string; eligible: true }> | null;
}

export function pendingDependencies(publicFixture: PublicFixtureProvenancePort): readonly P8Dependency[] {
  const dependencies: P8Dependency[] = [
    {
      lane: "P3",
      status: "PENDING_NOT_IN_INTEGRATION_BASE",
      blocker_code: "P3_REVIEW_WORKSPACE_AND_CORPUS_ADAPTER_NOT_IN_BASE",
      required_adapter: "P3ReviewWorkspaceIntegrationPort",
      affected_acceptance_ids: ["V07-P8-SYNTHETIC", "V07-P8-ADVERSARIAL", "V07-P8-VISUAL"],
    },
    {
      lane: "P4",
      status: "PENDING_NOT_IN_INTEGRATION_BASE",
      blocker_code: "P4_RULESPEC_GOLDEN_GT_SHADOW_ADAPTER_NOT_IN_BASE",
      required_adapter: "P4QualityShadowIntegrationPort",
      affected_acceptance_ids: ["V07-P8-SYNTHETIC", "V07-P8-ADVERSARIAL", "V07-P8-VISUAL"],
    },
  ];
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
    status: "PENDING_NOT_IN_INTEGRATION_BASE",
    blocker_code: "NATIVE_VISUAL_ROUTE_REQUIRES_P3_P4_INTEGRATION",
    required_adapter: "post_merge_browser_and_pdf_visual_verifier",
    affected_acceptance_ids: ["V07-P8-VISUAL"],
  });
  return Object.freeze(dependencies.map((item) => Object.freeze({ ...item, affected_acceptance_ids: Object.freeze([...item.affected_acceptance_ids]) })));
}

export const NO_ELIGIBLE_PUBLIC_FIXTURE: PublicFixtureProvenancePort = Object.freeze({
  eligibleFixture: () => null,
});

