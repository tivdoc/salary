import { canonicalSha256, deepFreeze } from "../../../engine/rule-runtime/canonical.ts";
import { WAVE3_TOPICS } from "../../../engine/wave3/contracts.ts";
import { createShadowDefinition, type OfflineShadowEvaluationPort, type ShadowExperimentDefinition, type ShadowSlotEvaluation } from "./contracts.ts";

export function buildSyntheticShadowDefinition(catalogMode: "synthetic_test" | "real_inactive" = "synthetic_test"): ShadowExperimentDefinition {
  const bundleContent = { fixture: "synthetic.shadow.bundle.v07", revision: 1, values: "legally_neutral" };
  return createShadowDefinition({
    schema_version: "tivdoc-offline-shadow-definition-v0.7.0",
    definition_id: `shadow.definition.${catalogMode}`,
    definition_version: "0.7.0",
    execution_mode: "offline",
    catalog_mode: catalogMode,
    baseline_engine_version: "engine.synthetic.baseline.v1",
    candidate_engine_version: "engine.synthetic.candidate.v2",
    bundles: [{
      bundle_id: "synthetic.shadow.bundle.v07",
      bundle_version: "0.7.0",
      bundle_sha256: canonicalSha256(bundleContent),
      classification: "deterministic_synthetic",
      provenance_sha256: canonicalSha256({ classification: "deterministic_synthetic", generated: true, customer_material: false }),
      sealed: true,
      customer_material: false,
      public_approval_sha256: null,
    }],
    topics: [...WAVE3_TOPICS],
    retry_policy: { max_attempts: 2 },
    promotion_thresholds: null,
    network_allowed: false,
    external_persistence_allowed: false,
    delivery_allowed: false,
  });
}

export class SyntheticMechanicsShadowEvaluator implements OfflineShadowEvaluationPort {
  readonly #failuresRemaining: number;
  #failures: number;
  calls = 0;

  constructor(failures = 0) {
    this.#failuresRemaining = failures;
    this.#failures = failures;
  }

  async evaluate(input: Parameters<OfflineShadowEvaluationPort["evaluate"]>[0]): Promise<ShadowSlotEvaluation> {
    this.calls += 1;
    if (this.#failures > 0) { this.#failures -= 1; throw new Error("SHADOW_SYNTHETIC_INJECTED_FAILURE"); }
    const status = input.definition.catalog_mode === "real_inactive" ? "blocked_legal_readiness" as const : "synthetic_mechanics_complete" as const;
    const payload = {
      topic: input.topic,
      status,
      amount: null,
      finding_count: 0 as const,
      customer_report_count: 0 as const,
      blocker_codes: status === "blocked_legal_readiness" ? ["LEGAL_SOURCE_CORPUS_INCOMPLETE", "REAL_RULES_INACTIVE"] : [],
      engine_version: input.engine_version,
      bundle_sha256: input.bundle.bundle_sha256,
    };
    return deepFreeze({ topic: payload.topic, status: payload.status, amount: null, finding_count: 0, customer_report_count: 0, blocker_codes: payload.blocker_codes, result_sha256: canonicalSha256(payload) });
  }

  configuredFailures() { return this.#failuresRemaining; }
}
