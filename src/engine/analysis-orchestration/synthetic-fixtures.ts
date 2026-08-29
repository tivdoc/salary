import type { EmploymentSnapshot } from "../facts/snapshot.ts";
import type { RuleInputMappingRegistry } from "../rule-input/mapping-registry.ts";
import type {
  RuntimeExecutionPolicy,
  SyntheticRuleDefinition,
} from "../rule-runtime/contracts.ts";
import type { SyntheticVerticalSliceRequest } from "./synthetic-vertical-slice.ts";

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const ANALYSIS_RUN_ID = "22222222-2222-4222-8222-222222222222";
const SNAPSHOT_ID = "33333333-3333-4333-8333-333333333333";
const ALPHA_FACT_ID = "44444444-4444-4444-8444-444444444444";
const BETA_FACT_ID = "55555555-5555-4555-8555-555555555555";
const ALPHA_SOURCE_ID = "66666666-6666-4666-8666-666666666666";
const BETA_SOURCE_ID = "77777777-7777-4777-8777-777777777777";

const commonFact = {
  case_id: CASE_ID,
  status: "confirmed" as const,
  confidence: 1,
  conflicting_fact_ids: [],
  resolution: null,
  created_at: "2040-01-01T00:00:00.000Z",
};

export const syntheticCanonicalSnapshot: EmploymentSnapshot = {
  snapshot_id: SNAPSHOT_ID,
  case_id: CASE_ID,
  analysis_run_id: ANALYSIS_RUN_ID,
  schema_version: "1.0.0",
  facts: [
    {
      ...commonFact,
      fact_id: BETA_FACT_ID,
      path: "work.overtime_hours",
      value: { amount: "1", unit: "hours_per_pay_period" },
      provenance: [
        {
          source_type: "derived",
          source_reference: {
            kind: "fact_derivation",
            derivation_id: "synthetic.beta.seed",
            fact_ids: [BETA_SOURCE_ID],
          },
        },
      ],
    },
    {
      ...commonFact,
      fact_id: ALPHA_FACT_ID,
      path: "work.regular_hours",
      value: { amount: "2.675", unit: "hours_per_pay_period" },
      provenance: [
        {
          source_type: "derived",
          source_reference: {
            kind: "fact_derivation",
            derivation_id: "synthetic.alpha.seed",
            fact_ids: [ALPHA_SOURCE_ID],
          },
        },
      ],
    },
  ],
  created_at: "2040-01-01T00:05:00.000Z",
};

export const syntheticRuleInputMappingRegistry: RuleInputMappingRegistry = {
  registry_id: "synthetic.vertical.mapping",
  registry_version: "1.0.0",
  mappings: [
    {
      input_id: "signal.beta",
      runtime_fact_path: "synthetic.signal.beta",
      fact_path: "work.overtime_hours",
      minimum_confidence: 0.9,
      max_age_seconds: 7_200,
      expected_output: { kind: "decimal", unit: "hours_per_pay_period" },
      transformation: {
        transformation_id: "canonical.hours.amount",
        transformation_version: "1.0.0",
      },
    },
    {
      input_id: "signal.alpha",
      runtime_fact_path: "synthetic.signal.alpha",
      fact_path: "work.regular_hours",
      minimum_confidence: 0.9,
      max_age_seconds: 7_200,
      expected_output: { kind: "decimal", unit: "hours_per_pay_period" },
      transformation: {
        transformation_id: "canonical.hours.amount",
        transformation_version: "1.0.0",
      },
    },
  ],
};

export const syntheticVerticalRule: SyntheticRuleDefinition = {
  runtime_kind: "synthetic_only",
  rule_id: "synthetic.vertical.product",
  rule_version: "1.0.0",
  formula_id: "synthetic.vertical.product",
  formula_version: "1.0.0",
  inputs: [
    {
      input_id: "signal.alpha",
      fact_path: "synthetic.signal.alpha",
      value_kind: "decimal",
      unit: "hours_per_pay_period",
      currency: null,
    },
    {
      input_id: "signal.beta",
      fact_path: "synthetic.signal.beta",
      value_kind: "decimal",
      unit: "hours_per_pay_period",
      currency: null,
    },
  ],
  operations: [
    {
      step_id: "signal.product",
      operation: "decimal.multiply",
      left_ref: "signal.alpha",
      right_ref: "signal.beta",
      result_unit: "synthetic.point",
    },
    {
      step_id: "signal.rounded",
      operation: "decimal.round",
      input_ref: "signal.product",
      scale: 2,
      mode: "half_even",
      result_unit: "synthetic.point",
    },
  ],
  output_ref: "signal.rounded",
  required_legal_evidence: [],
};

export const syntheticVerticalPolicy: RuntimeExecutionPolicy = {
  policy_version: "1.0.0",
  minimum_confidence_basis_points: 9_000,
  max_inputs: 8,
  max_steps: 8,
  max_decimal_digits: 64,
};

export const successfulSyntheticVerticalRequest: SyntheticVerticalSliceRequest = {
  request_id: "synthetic:vertical:request:001",
  employment_snapshot: syntheticCanonicalSnapshot,
  mapping_registry: syntheticRuleInputMappingRegistry,
  rule: syntheticVerticalRule,
  execution_policy: syntheticVerticalPolicy,
  prepared_at: "2040-01-01T01:00:00.000Z",
  requested_at: "2040-01-01T01:00:01.000Z",
};
