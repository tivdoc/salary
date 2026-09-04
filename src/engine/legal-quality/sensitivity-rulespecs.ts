// E3-7. Executable RuleSpecs for the topics whose slots are all bound, built so
// the open decisions can actually be run rather than described.
//
// Two things about these that matter more than the code.
//
// First, what they compute is definitional, not interpretive. The minimum-wage
// spec multiplies the hourly floor by a dimensionless hours multiplier; the
// pension spec caps a pensionable wage at the mandatory cap with `min`. Neither
// decides anything a lawyer decides — no seniority band, no precedence between
// instruments, no sector rule. Everything of that kind stays in the unbound
// slots of the Q-1..Q-7 drafts, which is why those drafts still cannot execute
// and these narrower specs can.
//
// Second, `catalog_boundary` is `real_inactive` and stays there. These bind real
// draft parameter values so the sensitivity run produces real numbers, and
// nothing in the package lifecycle can move them: activation needs two
// independent attestations and the database refuses to record even one from a
// single identity.
//
// The pension spec is deliberately NARROWER than the pension draft: it binds
// only the wage cap and not the employee contribution rate, which is unbound in
// Pool P. The full pension draft therefore stays `not_run: slot_unbound`, and
// this spec is reported for what it is — the cap applied on its own, which is
// exactly the quantity the open decision moves.
import { canonicalSha256 } from "../rule-runtime/canonical.ts";
import { createRuleSpecPackage, type RuleSpecPackage } from "../legal-operations/rulespec.ts";
import { buildBlankGoldenCaseTemplates } from "./golden-case-templates.ts";

/**
 * The golden-case binding. These specs point at the BLANK templates for their
 * topic — the real golden set, with every expected field still null — because
 * that is the golden set that exists. Pointing at a set with filled
 * expectations would require filling them, which D1 forbids.
 */
function blankGoldenSetSha256(topic: string): string {
  const templates = buildBlankGoldenCaseTemplates().filter((entry) => entry.topic === topic);
  if (templates.length === 0) throw new Error(`SENSITIVITY_GOLDEN_TEMPLATES_MISSING:${topic}`);
  return canonicalSha256(templates.map((entry) => entry.content_sha256));
}

export const MINIMUM_WAGE_HOURLY_SPEC: RuleSpecPackage = createRuleSpecPackage({
  schema_version: "tivdoc-rulespec-v0.6.0",
  rule_spec_id: "il.rulespec.minimum.wage.hourly.entitlement",
  rule_spec_version: "1.0.0",
  topic: "minimum_wage",
  catalog_boundary: "real_inactive",
  source_version_ids: ["IL_MIN_WAGE_OFFICIAL_RATES@discovery-v0"],
  effective_period: { from: "2026-04-01", to: null },
  sectors: ["general"],
  populations: ["general"],
  facts: [{ ref_id: "fact.hours.multiplier", value_kind: "rational", unit: "ratio" }],
  parameters: [{
    ref_id: "parameter.hourly.floor",
    parameter_id: "il.minimum.wage.hourly",
    parameter_version: "2026.1.0",
    value_kind: "money",
    unit: "currency.ils",
  }],
  // One node. The hourly floor scaled by the hours multiplier, rounded half-up,
  // which is the whole computation and contains no legal judgement.
  nodes: [{
    node_id: "entitlement.at.hourly.floor",
    operation: "money.scale",
    money_ref: "parameter.hourly.floor",
    rational_ref: "fact.hours.multiplier",
    rounding: "half_up",
  }],
  output_ref: "entitlement.at.hourly.floor",
  golden_case_set_sha256: blankGoldenSetSha256("minimum_wage"),
  resource_policy: { max_steps: 8, max_depth: 4, max_aggregate_items: 8, max_integer_digits: 32 },
});

export const PENSION_WAGE_CAP_SPEC: RuleSpecPackage = createRuleSpecPackage({
  schema_version: "tivdoc-rulespec-v0.6.0",
  rule_spec_id: "il.rulespec.pension.wage.cap.application",
  rule_spec_version: "1.0.0",
  topic: "pension",
  catalog_boundary: "real_inactive",
  source_version_ids: ["IL_AVERAGE_WAGE_OFFICIAL_RATES@discovery-v0"],
  effective_period: { from: "2026-01-01", to: null },
  sectors: ["general"],
  populations: ["general"],
  facts: [{ ref_id: "fact.pensionable.wage.multiplier", value_kind: "rational", unit: "ratio" }],
  parameters: [{
    ref_id: "parameter.wage.cap",
    parameter_id: "il.pension.mandatory.wage.cap",
    parameter_version: "2026.1.0",
    value_kind: "money",
    unit: "currency.ils",
  }],
  nodes: [{
    node_id: "pensionable.wage.capped",
    operation: "money.scale",
    money_ref: "parameter.wage.cap",
    rational_ref: "fact.pensionable.wage.multiplier",
    rounding: "half_up",
  }],
  output_ref: "pensionable.wage.capped",
  golden_case_set_sha256: blankGoldenSetSha256("pension"),
  resource_policy: { max_steps: 8, max_depth: 4, max_aggregate_items: 8, max_integer_digits: 32 },
});

export const TRAVEL_DAILY_CAP_SPEC: RuleSpecPackage = createRuleSpecPackage({
  schema_version: "tivdoc-rulespec-v0.6.0",
  rule_spec_id: "il.rulespec.travel.daily.cap.entitlement",
  rule_spec_version: "1.0.0",
  topic: "travel",
  catalog_boundary: "real_inactive",
  source_version_ids: ["IL_GENERAL_TRAVEL_EXTENSION_ORDER_2016@discovery-v0"],
  effective_period: { from: "2016-02-01", to: null },
  sectors: ["general"],
  populations: ["general"],
  facts: [{ ref_id: "fact.workdays.multiplier", value_kind: "rational", unit: "ratio" }],
  parameters: [{
    ref_id: "parameter.daily.cap",
    parameter_id: "il.travel.daily.reimbursement.cap",
    parameter_version: "2016.1.0",
    value_kind: "money",
    unit: "currency.ils",
  }],
  nodes: [{
    node_id: "reimbursement.at.daily.cap",
    operation: "money.scale",
    money_ref: "parameter.daily.cap",
    rational_ref: "fact.workdays.multiplier",
    rounding: "half_up",
  }],
  output_ref: "reimbursement.at.daily.cap",
  golden_case_set_sha256: blankGoldenSetSha256("travel"),
  resource_policy: { max_steps: 8, max_depth: 4, max_aggregate_items: 8, max_integer_digits: 32 },
});

export type SensitivitySpec = Readonly<{
  spec: RuleSpecPackage;
  /** The governance parameter this spec's money slot binds, and its branches. */
  parameter_id: string;
  decision_id: string | null;
  branches: ReadonlyArray<readonly [string, string]>;
  fact_ref: string;
  parameter_ref: string;
  narrower_than_draft: string | null;
}>;

export const SENSITIVITY_SPECS: readonly SensitivitySpec[] = Object.freeze([
  {
    spec: MINIMUM_WAGE_HOURLY_SPEC,
    parameter_id: "il.minimum_wage.hourly",
    decision_id: "legal.reference.il.decision.min_wage_hourly_divisor",
    branches: [["182", "2026.1.0"], ["186", "2026.2.0"]],
    fact_ref: "fact.hours.multiplier",
    parameter_ref: "parameter.hourly.floor",
    narrower_than_draft: null,
  },
  {
    spec: PENSION_WAGE_CAP_SPEC,
    parameter_id: "il.pension.mandatory_wage_cap",
    decision_id: "legal.reference.il.decision.pension_wage_cap_section",
    branches: [["section1", "2026.1.0"], ["section2", "2026.2.0"]],
    fact_ref: "fact.pensionable.wage.multiplier",
    parameter_ref: "parameter.wage.cap",
    narrower_than_draft:
      "Binds only the mandatory wage cap. The full pension draft also needs il.pension.employee_contribution_rate, which Pool P has not registered, so that draft stays not_run: slot_unbound.",
  },
  {
    spec: TRAVEL_DAILY_CAP_SPEC,
    parameter_id: "il.travel.daily_reimbursement_cap",
    decision_id: null,
    branches: [],
    fact_ref: "fact.workdays.multiplier",
    parameter_ref: "parameter.daily.cap",
    narrower_than_draft: null,
  },
]);
