import type {
  RuntimeExecutionInput,
  RuntimeExecutionPolicy,
  SyntheticRuleDefinition,
} from "./contracts.ts";

const SNAPSHOT_SHA = "a".repeat(64);
const PROVENANCE_SHA_ALPHA = "b".repeat(64);
const PROVENANCE_SHA_BETA = "c".repeat(64);
const ARTIFACT_SHA = "d".repeat(64);

export const syntheticRuntimePolicy: RuntimeExecutionPolicy = {
  policy_version: "1.0.0",
  minimum_confidence_basis_points: 9_000,
  max_inputs: 8,
  max_steps: 8,
  max_decimal_digits: 64,
};

const syntheticInputs = [
  {
    input_id: "signal.alpha",
    fact_path: "synthetic.signal.alpha",
    value_kind: "decimal" as const,
    unit: "synthetic.point",
    currency: null,
  },
  {
    input_id: "signal.beta",
    fact_path: "synthetic.signal.beta",
    value_kind: "decimal" as const,
    unit: "synthetic.point",
    currency: null,
  },
];

const syntheticOperations = [
  {
    step_id: "signal.product",
    operation: "decimal.multiply" as const,
    left_ref: "signal.alpha",
    right_ref: "signal.beta",
    result_unit: "synthetic.point",
  },
  {
    step_id: "signal.rounded",
    operation: "decimal.round" as const,
    input_ref: "signal.product",
    scale: 2,
    mode: "half_even" as const,
    result_unit: "synthetic.point",
  },
];

export const openSyntheticRule: SyntheticRuleDefinition = {
  runtime_kind: "synthetic_only",
  rule_id: "synthetic.prism.signal",
  rule_version: "1.0.0",
  formula_id: "synthetic.prism.product",
  formula_version: "1.0.0",
  inputs: syntheticInputs,
  operations: syntheticOperations,
  output_ref: "signal.rounded",
  required_legal_evidence: [],
};

export const guardedSyntheticRule: SyntheticRuleDefinition = {
  ...openSyntheticRule,
  rule_id: "synthetic.prism.guarded",
  required_legal_evidence: [
    {
      source_id: "SYNTHETIC_EVIDENCE_ONLY",
      source_version_id: "synthetic-source-version:1",
    },
  ],
};

const snapshot = {
  snapshot_id: "synthetic:snapshot:001",
  snapshot_version: "fixture-v1",
  snapshot_sha256: SNAPSHOT_SHA,
};

const alphaFact = {
  input_id: "signal.alpha",
  fact_id: "synthetic:fact:alpha",
  fact_path: "synthetic.signal.alpha",
  status: "confirmed" as const,
  confidence_basis_points: 10_000,
  value: { kind: "decimal" as const, value: "2.675", unit: "synthetic.point" },
  provenance: [
    {
      provenance_id: "synthetic:provenance:alpha",
      kind: "synthetic_fixture" as const,
      reference_sha256: PROVENANCE_SHA_ALPHA,
    },
  ],
  snapshot,
};

const betaFact = {
  input_id: "signal.beta",
  fact_id: "synthetic:fact:beta",
  fact_path: "synthetic.signal.beta",
  status: "confirmed" as const,
  confidence_basis_points: 10_000,
  value: { kind: "decimal" as const, value: "1", unit: "synthetic.point" },
  provenance: [
    {
      provenance_id: "synthetic:provenance:beta",
      kind: "synthetic_fixture" as const,
      reference_sha256: PROVENANCE_SHA_BETA,
    },
  ],
  snapshot,
};

export const successfulSyntheticExecution: RuntimeExecutionInput = {
  request: {
    request_id: "synthetic:request:success",
    rule_id: openSyntheticRule.rule_id,
    rule_version: openSyntheticRule.rule_version,
    input_snapshot: snapshot,
    legal_evidence: [],
    requested_at: "2026-08-29T00:00:00.000Z",
    execution_policy_version: syntheticRuntimePolicy.policy_version,
  },
  facts: [betaFact, alphaFact],
};

export const staleEvidenceSyntheticExecution: RuntimeExecutionInput = {
  request: {
    ...successfulSyntheticExecution.request,
    request_id: "synthetic:request:stale",
    rule_id: guardedSyntheticRule.rule_id,
    legal_evidence: [
      {
        source_id: "SYNTHETIC_EVIDENCE_ONLY",
        source_version_id: "synthetic-source-version:1",
        artifact_sha256: ARTIFACT_SHA,
        parsed_version_id: null,
        citation_id: null,
        review_state: "needs_review",
        activation_state: "inactive",
      },
    ],
  },
  facts: successfulSyntheticExecution.facts,
};

export const allSyntheticRules = [openSyntheticRule, guardedSyntheticRule] as const;
