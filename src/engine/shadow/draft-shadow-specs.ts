// L7-2 / D2. The seven draft topics in the form the offline shadow executes
// them, and — beside each spec — the registry that says where every one of
// its inputs comes from in the canonical fact model.
//
// Most specs are the sensitivity specs themselves, unchanged: the shadow does
// not compute anything the sensitivity report does not. Three are shadow
// FORMS of a sensitivity spec, written so their inputs are facts a payslip
// month actually carries rather than a multiplier a fixture typed:
//
// - the pension cap applied to a WAGE (`min(wage, cap)`) instead of to a
//   multiplier of the cap;
// - the employee contribution on that capped wage;
// - convalescence PAY: the 1988 band days for the completed years, divided by
//   one day to a ratio, applied to the 2026 day rate.
//
// Nothing here is a fact typed into a spec. Every `facts` entry of every spec
// has exactly one mapping, the mapping names a canonical fact path and a
// versioned transformation, and preparation (`prepareRuleInputs`) is the only
// way a value reaches the executor. A slot whose fact is missing, conflicted,
// unconfirmed, stale or of the wrong shape is a rejection, and the case does
// not run.
import { buildBlankGoldenCaseTemplates } from "../legal-quality/golden-case-templates.ts";
import {
  CONVALESCENCE_DAILY_RATE_SPEC,
  CONVALESCENCE_DAYS_SPEC,
  MINIMUM_WAGE_HOURLY_SPEC,
  PENSION_CONTRIBUTION_SPEC,
  PENSION_WAGE_CAP_SPEC,
  REST_DAY_OVERTIME_ADDITIVE_SPEC,
  REST_DAY_OVERTIME_COMPOSITION_DECISION,
  REST_DAY_OVERTIME_MULTIPLICATIVE_SPEC,
  SENSITIVITY_SPECS,
  SICK_PAY_ACCRUAL_SPEC,
  SICK_PAY_DAILY_RATE_SPEC,
  TRAVEL_DAILY_CAP_SPEC,
  VACATION_SENIORITY_BAND_SPEC,
  WORKING_TIME_OVERTIME_FROM_HOURS_WORKED_SPEC,
  WORKING_TIME_OVERTIME_SPEC,
  type SensitivityBinding,
  type SensitivitySpec,
} from "../legal-quality/sensitivity-rulespecs.ts";
import { createRuleSpecPackage, type RuleSpecPackage } from "../legal-operations/rulespec.ts";
import type { FactPath } from "../facts/fact-paths.ts";
import { canonicalSha256 } from "../rule-runtime/canonical.ts";
import {
  registerRuleInputMappingRegistry,
  type RegisteredRuleInputMappingRegistry,
  type RuleInputMapping,
} from "../rule-input/mapping-registry.ts";
import { transformationAccepts } from "../rule-input/transformations.ts";

function blankGoldenSetSha256(topic: string): string {
  const templates = buildBlankGoldenCaseTemplates().filter((entry) => entry.topic === topic);
  if (templates.length === 0) throw new Error(`SHADOW_GOLDEN_TEMPLATES_MISSING:${topic}`);
  return canonicalSha256(templates.map((entry) => entry.content_sha256));
}

const POLICY = { max_steps: 8, max_depth: 4, max_aggregate_items: 8, max_integer_digits: 32 } as const;

/** The mandatory cap applied to a pensionable wage: the smaller of the two. */
export const PENSION_WAGE_CAP_SHADOW_SPEC: RuleSpecPackage = createRuleSpecPackage({
  schema_version: "tivdoc-rulespec-v0.6.0",
  rule_spec_id: "il.rulespec.pension.wage.cap.on.wage",
  rule_spec_version: "1.0.0",
  topic: "pension",
  catalog_boundary: "real_inactive",
  source_version_ids: ["IL_AVERAGE_WAGE_OFFICIAL_RATES@discovery-v0"],
  effective_period: { from: "2026-01-01", to: null },
  sectors: ["general"],
  populations: ["general"],
  facts: [{ ref_id: "fact.pensionable.wage", value_kind: "money", unit: "currency.ils" }],
  parameters: [{ ref_id: "parameter.wage.cap", parameter_id: "il.pension.mandatory.wage.cap", parameter_version: "2026.1.0", value_kind: "money", unit: "currency.ils" }],
  nodes: [{ node_id: "pensionable.wage.capped", operation: "min", refs: ["fact.pensionable.wage", "parameter.wage.cap"] }],
  output_ref: "pensionable.wage.capped",
  golden_case_set_sha256: blankGoldenSetSha256("pension"),
  resource_policy: POLICY,
});

/** The employee share on the capped pensionable wage. */
export const PENSION_CONTRIBUTION_SHADOW_SPEC: RuleSpecPackage = createRuleSpecPackage({
  schema_version: "tivdoc-rulespec-v0.6.0",
  rule_spec_id: "il.rulespec.pension.employee.contribution.on.wage",
  rule_spec_version: "1.0.0",
  topic: "pension",
  catalog_boundary: "real_inactive",
  source_version_ids: ["IL_GENERAL_PENSION_EXTENSION_ORDER_2011@discovery-v0", "IL_GENERAL_PENSION_INCREASE_EXTENSION_ORDER_2016@discovery-v0.2"],
  effective_period: { from: "2014-01-01", to: null },
  sectors: ["general"],
  populations: ["general"],
  facts: [{ ref_id: "fact.pensionable.wage", value_kind: "money", unit: "currency.ils" }],
  parameters: [
    { ref_id: "parameter.wage.cap", parameter_id: "il.pension.mandatory_wage_cap", parameter_version: "2026.1.0", value_kind: "money", unit: "currency.ils" },
    { ref_id: "parameter.employee.share", parameter_id: "il.pension.employee_contribution_rate", parameter_version: "2017.1.0", value_kind: "rational", unit: "ratio" },
  ],
  nodes: [
    { node_id: "pensionable.wage.capped", operation: "min", refs: ["fact.pensionable.wage", "parameter.wage.cap"] },
    { node_id: "employee.contribution", operation: "money.scale", money_ref: "pensionable.wage.capped", rational_ref: "parameter.employee.share", rounding: "half_up" },
  ],
  output_ref: "employee.contribution",
  golden_case_set_sha256: blankGoldenSetSha256("pension"),
  resource_policy: POLICY,
});

/** Convalescence pay: the 1988 band days for the completed years at the 2026 day rate. */
export const CONVALESCENCE_PAY_SHADOW_SPEC: RuleSpecPackage = createRuleSpecPackage({
  schema_version: "tivdoc-rulespec-v0.6.0",
  rule_spec_id: "il.rulespec.convalescence.pay.by.seniority",
  rule_spec_version: "1.0.0",
  topic: "convalescence",
  catalog_boundary: "real_inactive",
  source_version_ids: ["IL_CONVALESCENCE_EXTENSION_ORDER_1988@discovery-v0", "IL_CONVALESCENCE_EXTENSION_ORDER_2026@discovery-v0.2"],
  effective_period: { from: "2026-01-01", to: null },
  sectors: ["general"],
  populations: ["general"],
  facts: [{ ref_id: "fact.years.employed", value_kind: "integer", unit: "count.years" }],
  parameters: [
    ...CONVALESCENCE_DAYS_SPEC.parameters,
    { ref_id: "parameter.daily.rate", parameter_id: "il.convalescence.daily.rate", parameter_version: "2026.1.0", value_kind: "money", unit: "currency.ils" },
  ],
  nodes: [
    ...CONVALESCENCE_DAYS_SPEC.nodes,
    { node_id: "one.day", operation: "constant.integer", value: 1, unit: "days" },
    { node_id: "days.as.multiplier", operation: "divide", left_ref: "days.by.band", right_ref: "one.day" },
    { node_id: "convalescence.pay", operation: "money.scale", money_ref: "parameter.daily.rate", rational_ref: "days.as.multiplier", rounding: "half_up" },
  ],
  output_ref: "convalescence.pay",
  golden_case_set_sha256: blankGoldenSetSha256("convalescence"),
  resource_policy: POLICY,
});

// --- the input mappings -----------------------------------------------------

type ExpectedOutput = RuleInputMapping["expected_output"];

type InputSource = Readonly<{
  fact_path: FactPath;
  transformation_id: string;
  transformation_version?: string;
}>;

/** Where each spec input ref comes from. One entry per distinct ref id across the specs. */
const INPUT_SOURCES: Readonly<Record<string, InputSource>> = Object.freeze({
  "fact.hours.multiplier": { fact_path: "work.regular_hours", transformation_id: "canonical.hours.count.as.multiplier" },
  "fact.workdays.multiplier": { fact_path: "work.workdays_in_month", transformation_id: "canonical.workdays.count.as.multiplier" },
  "fact.pensionable.wage": { fact_path: "pension.base_salary", transformation_id: "canonical.money.identity" },
  "fact.seniority.year": { fact_path: "employment.start_date", transformation_id: "canonical.seniority.whole.years" },
  "fact.years.employed": { fact_path: "employment.start_date", transformation_id: "canonical.seniority.whole.years" },
  "fact.months.employed": { fact_path: "employment.start_date", transformation_id: "canonical.seniority.whole.months" },
  "fact.absence.day.index": { fact_path: "leave.sick_absence", transformation_id: "canonical.absence.day.index" },
  "fact.overtime.hours.day": { fact_path: "work.overtime_hours", transformation_id: "canonical.hours.per.day.integer" },
  "fact.hours.worked.day": { fact_path: "work.hours_worked_day", transformation_id: "canonical.hours.per.day.integer" },
  "fact.rest.day.overtime.hours.day": { fact_path: "work.rest_day_overtime_hours", transformation_id: "canonical.hours.per.day.integer" },
  "fact.regular.hourly.wage": { fact_path: "compensation.hourly_rate", transformation_id: "canonical.money.identity" },
});

const MINIMUM_CONFIDENCE = 0.8;
const MAX_AGE_SECONDS = 31_536_000;

function expectedOutputOf(declaration: RuleSpecPackage["facts"][number]): ExpectedOutput {
  switch (declaration.value_kind) {
    case "money": {
      const match = /^currency.([a-z]{3})$/u.exec(declaration.unit ?? "");
      if (!match) throw new Error(`SHADOW_INPUT_CURRENCY_UNIT_MALFORMED:${declaration.ref_id}`);
      return { kind: "money", currency: match[1].toUpperCase() };
    }
    case "rational":
      return { kind: "rational", unit: declaration.unit! as never };
    case "integer":
      return { kind: "integer", unit: declaration.unit! as never };
    case "boolean":
      throw new Error(`SHADOW_INPUT_BOOLEAN_UNSUPPORTED:${declaration.ref_id}`);
  }
}

function runtimePath(refId: string): string {
  return `synthetic.${refId.replace(/^fact\./u, "")}`;
}

function mappingFor(declaration: RuleSpecPackage["facts"][number]): RuleInputMapping {
  const source = INPUT_SOURCES[declaration.ref_id];
  if (!source) throw new Error(`SHADOW_INPUT_SOURCE_MISSING:${declaration.ref_id}`);
  return {
    input_id: declaration.ref_id,
    runtime_fact_path: runtimePath(declaration.ref_id),
    fact_path: source.fact_path,
    minimum_confidence: MINIMUM_CONFIDENCE,
    max_age_seconds: MAX_AGE_SECONDS,
    expected_output: expectedOutputOf(declaration),
    transformation: { transformation_id: source.transformation_id, transformation_version: source.transformation_version ?? "1.0.0" },
  };
}

export const DRAFT_SHADOW_REGISTRY_VERSION = "2.0.0";

function registryFor(spec: RuleSpecPackage, extra: readonly RuleInputMapping[] = []): RegisteredRuleInputMappingRegistry {
  const mappings = [...spec.facts.map(mappingFor), ...extra];
  for (const mapping of mappings) {
    if (!transformationAccepts(mapping)) throw new Error(`SHADOW_MAPPING_TRANSFORMATION_MISMATCH:${spec.rule_spec_id}:${mapping.input_id}`);
  }
  return registerRuleInputMappingRegistry({
    registry_id: `legal.draft.shadow.${spec.rule_spec_id.replace(/^il\.rulespec\./u, "")}`,
    registry_version: DRAFT_SHADOW_REGISTRY_VERSION,
    mappings,
  });
}

export type DraftShadowSpec = Readonly<{
  shadow_id: string;
  topic: string;
  spec: RuleSpecPackage;
  /** The sensitivity spec this stands for, when the shadow form differs from it. */
  shadow_form_of: string | null;
  bindings: readonly SensitivityBinding[];
  decision_id: string | null;
  branches: ReadonlyArray<readonly [string, string]>;
  composition_branch: string | null;
  /** L7-9: branches named on the decision but not bound — never run, always shown. */
  unbound_branches: ReadonlyArray<Readonly<{ branch: string; reason: string }>>;
  input_mappings: RegisteredRuleInputMappingRegistry;
}>;

function sensitivityOf(spec: RuleSpecPackage): SensitivitySpec {
  const entry = SENSITIVITY_SPECS.find((candidate) => candidate.spec.rule_spec_id === spec.rule_spec_id);
  if (!entry) throw new Error(`SHADOW_SENSITIVITY_SPEC_MISSING:${spec.rule_spec_id}`);
  return entry;
}

function fromSensitivity(spec: RuleSpecPackage): DraftShadowSpec {
  const entry = sensitivityOf(spec);
  return {
    shadow_id: spec.rule_spec_id.replace(/^il\.rulespec\./u, ""),
    topic: spec.topic,
    spec,
    shadow_form_of: null,
    bindings: entry.bindings,
    decision_id: entry.decision_id,
    branches: entry.branches,
    composition_branch: entry.composition_branch ?? null,
    unbound_branches: entry.unbound_branches ?? [],
    input_mappings: registryFor(spec),
  };
}

function shadowForm(spec: RuleSpecPackage, of: RuleSpecPackage, bindings: readonly SensitivityBinding[]): DraftShadowSpec {
  const entry = sensitivityOf(of);
  return {
    shadow_id: spec.rule_spec_id.replace(/^il\.rulespec\./u, ""),
    topic: spec.topic,
    spec,
    shadow_form_of: of.rule_spec_id,
    bindings,
    decision_id: entry.decision_id,
    branches: entry.branches,
    composition_branch: null,
    unbound_branches: entry.unbound_branches ?? [],
    input_mappings: registryFor(spec),
  };
}

const CONVALESCENCE_PAY_BINDINGS: readonly SensitivityBinding[] = [
  ...sensitivityOf(CONVALESCENCE_DAYS_SPEC).bindings,
  ...sensitivityOf(CONVALESCENCE_DAILY_RATE_SPEC).bindings,
];

/**
 * The executable set, in the order the report lists topics. Thirteen specs
 * over seven topics; ten are the sensitivity specs verbatim, three are shadow
 * forms whose inputs are payslip facts.
 */
export const DRAFT_SHADOW_SPECS: readonly DraftShadowSpec[] = Object.freeze([
  fromSensitivity(MINIMUM_WAGE_HOURLY_SPEC),
  fromSensitivity(WORKING_TIME_OVERTIME_SPEC),
  fromSensitivity(WORKING_TIME_OVERTIME_FROM_HOURS_WORKED_SPEC),
  { ...fromSensitivity(REST_DAY_OVERTIME_ADDITIVE_SPEC), decision_id: REST_DAY_OVERTIME_COMPOSITION_DECISION },
  { ...fromSensitivity(REST_DAY_OVERTIME_MULTIPLICATIVE_SPEC), decision_id: REST_DAY_OVERTIME_COMPOSITION_DECISION },
  shadowForm(PENSION_WAGE_CAP_SHADOW_SPEC, PENSION_WAGE_CAP_SPEC, sensitivityOf(PENSION_WAGE_CAP_SPEC).bindings),
  shadowForm(PENSION_CONTRIBUTION_SHADOW_SPEC, PENSION_CONTRIBUTION_SPEC, sensitivityOf(PENSION_CONTRIBUTION_SPEC).bindings),
  fromSensitivity(TRAVEL_DAILY_CAP_SPEC),
  fromSensitivity(CONVALESCENCE_DAYS_SPEC),
  shadowForm(CONVALESCENCE_PAY_SHADOW_SPEC, CONVALESCENCE_DAILY_RATE_SPEC, CONVALESCENCE_PAY_BINDINGS),
  fromSensitivity(VACATION_SENIORITY_BAND_SPEC),
  fromSensitivity(SICK_PAY_ACCRUAL_SPEC),
  fromSensitivity(SICK_PAY_DAILY_RATE_SPEC),
]);

export const DRAFT_SHADOW_TOPICS: readonly string[] = Object.freeze([...new Set(DRAFT_SHADOW_SPECS.map((entry) => entry.topic))]);

/** Every input slot of every shadow spec, with the mapping that binds it. */
export function boundInputSlots(): ReadonlyArray<Readonly<{ shadow_id: string; ref_id: string; mapping: RuleInputMapping }>> {
  return DRAFT_SHADOW_SPECS.flatMap((entry) =>
    entry.spec.facts.map((declaration) => {
      const mapping = entry.input_mappings.registry.mappings.find((candidate) => candidate.input_id === declaration.ref_id);
      if (!mapping) throw new Error(`SHADOW_INPUT_SLOT_UNBOUND:${entry.shadow_id}:${declaration.ref_id}`);
      return { shadow_id: entry.shadow_id, ref_id: declaration.ref_id, mapping };
    }),
  );
}
