// L7-5 / D4. The delta is a shadow quantity, not a finding.
//
// For each shadow spec whose output is a paid component of a payslip, the
// month's PAID figure is mapped like any input — a canonical fact path, a
// versioned transformation, a registry, preparation with its refusal codes —
// and the delta is `entitlement − paid` in the output's own unit: minor
// units of the currency for money, days for a day count. The entitlement is
// what the spec produced after its own rounding; the subtraction is exact
// integer arithmetic and rounds nothing again.
//
// Sign convention: POSITIVE means the spec's entitlement exceeds what the
// payslip paid (the month paid less than the draft computes); negative means
// the payslip paid more. Zero means they agree. None of these is a claim: the
// parameters are drafts, the facts are synthetic, and the object says so on
// every instance — `kind: synthetic_shadow_delta`, `is_finding: false`,
// `delivery_allowed: false`. It is never shaped like a Finding, never stored
// in a findings table, never returned on a customer-facing route; the guard
// test beside this file proves the Finding contract rejects it.
//
// Where a spec has no paid component the delta is `not_applicable` with the
// reason named: a capped wage and a day count accrued are not paid lines;
// the sick day rate prices ONE day and the payslip's sick pay covers an
// absence, and totalling the days would need the day-one rate the L5-4
// reading refused to invent.
import { z } from "zod";
import type { FactPath } from "../facts/fact-paths.ts";
import type { RuleSpecPackage } from "../legal-operations/rulespec.ts";
import {
  registerRuleInputMappingRegistry,
  type RegisteredRuleInputMappingRegistry,
  type RuleInputMapping,
} from "../rule-input/mapping-registry.ts";
import type { PreparedRuleInputs } from "../rule-input/preparation.ts";
import { transformationAccepts } from "../rule-input/transformations.ts";
import { DRAFT_SHADOW_SPECS, DRAFT_SHADOW_REGISTRY_VERSION } from "./draft-shadow-specs.ts";

export const SYNTHETIC_SHADOW_DELTA_KIND = "synthetic_shadow_delta" as const;
export const DELTA_SIGN_CONVENTION = "positive_means_entitlement_exceeds_paid" as const;

const digits = z.string().regex(/^-?(?:0|[1-9]\d*)$/u);

export const syntheticShadowDeltaSchema = z.discriminatedUnion("status", [
  z.object({
    kind: z.literal(SYNTHETIC_SHADOW_DELTA_KIND),
    status: z.literal("computed"),
    is_finding: z.literal(false),
    delivery_allowed: z.literal(false),
    shadow_id: z.string(),
    paid_fact_path: z.string(),
    paid_source_fact_id: z.string(),
    unit: z.enum(["currency.ILS.minor_units", "calendar_days"]),
    entitlement: digits,
    paid: digits,
    delta: digits,
    sign_convention: z.literal(DELTA_SIGN_CONVENTION),
    entitlement_rounding: z.string(),
  }).strict(),
  z.object({
    kind: z.literal(SYNTHETIC_SHADOW_DELTA_KIND),
    status: z.literal("not_applicable"),
    is_finding: z.literal(false),
    delivery_allowed: z.literal(false),
    shadow_id: z.string(),
    reason: z.string(),
  }).strict(),
  z.object({
    kind: z.literal(SYNTHETIC_SHADOW_DELTA_KIND),
    status: z.literal("paid_refused"),
    is_finding: z.literal(false),
    delivery_allowed: z.literal(false),
    shadow_id: z.string(),
    paid_fact_path: z.string(),
    rejection_codes: z.array(z.string()).min(1).readonly(),
  }).strict(),
]);

export type SyntheticShadowDelta = z.infer<typeof syntheticShadowDeltaSchema>;

type PaidComponent = Readonly<{
  input_id: string;
  fact_path: FactPath;
  transformation_id: string;
  expected_output: RuleInputMapping["expected_output"];
  unit: "currency.ILS.minor_units" | "calendar_days";
}>;

type PaidSource = PaidComponent | Readonly<{ not_applicable: string }>;

const MONEY: Pick<PaidComponent, "expected_output" | "unit" | "transformation_id"> = {
  expected_output: { kind: "money", currency: "ILS" },
  unit: "currency.ILS.minor_units",
  transformation_id: "canonical.money.identity",
};

/** The paid component of each shadow spec — or why it has none. */
export const PAID_COMPONENTS: Readonly<Record<string, PaidSource>> = Object.freeze({
  "minimum.wage.hourly.entitlement": { ...MONEY, input_id: "paid.gross.salary", fact_path: "compensation.gross_salary" },
  "working.time.overtime.pay": { ...MONEY, input_id: "paid.overtime.pay", fact_path: "compensation.overtime_pay" },
  "working.time.overtime.from.hours.worked": { ...MONEY, input_id: "paid.overtime.pay", fact_path: "compensation.overtime_pay" },
  "working.time.rest.day.overtime.additive": { ...MONEY, input_id: "paid.weekly.rest.pay", fact_path: "compensation.weekly_rest_pay" },
  // L11-4 / D3.3: the multiplicative rest-day reading is retired from the set; its paid component went with it.
  "pension.wage.cap.on.wage": { not_applicable: "a capped pensionable wage is a base, not a paid line" },
  // L8-3 / D4 retracts what stood here: "the employer share is not a
  // registered parameter". It is — `il.pension.employer_contribution_rate` at
  // 2014.2.0 and 2017.1.0, batch 13, bound in the P line's draft on both
  // branches of the precedence decision. What was missing was the shadow spec
  // that computes it; both sides of the contribution fact are compared now,
  // and the severance component against its own fact.
  "pension.employee.contribution.on.wage": { ...MONEY, input_id: "paid.pension.employee.contribution", fact_path: "pension.contributions", transformation_id: "canonical.pension.employee.contribution" },
  "pension.employer.contribution.on.wage": { ...MONEY, input_id: "paid.pension.employer.contribution", fact_path: "pension.contributions", transformation_id: "canonical.pension.employer.contribution" },
  "pension.severance.contribution.on.wage": { ...MONEY, input_id: "paid.pension.severance.contribution", fact_path: "pension.severance_contribution", transformation_id: "canonical.pension.severance.contribution" },
  "travel.daily.cap.entitlement": { ...MONEY, input_id: "paid.travel.reimbursement", fact_path: "travel.reimbursement" },
  "convalescence.days.by.seniority": { not_applicable: "a day count; the pay form carries the delta" },
  "convalescence.pay.by.seniority": { ...MONEY, input_id: "paid.convalescence.payment", fact_path: "convalescence.payment" },
  "vacation.seniority.band.entitlement": { input_id: "paid.vacation.days", fact_path: "leave.vacation_days_paid", transformation_id: "canonical.leave.days.integer", expected_output: { kind: "integer", unit: "calendar_days" }, unit: "calendar_days" },
  "sick.pay.accrual": { not_applicable: "days accrued are a balance, not a paid line" },
  "sick.pay.daily.rate": { not_applicable: "the spec prices one day; the payslip's sick pay covers an absence, and the total needs the day-one rate the L5-4 reading refused to invent" },
});

function isComponent(source: PaidSource): source is PaidComponent {
  return "input_id" in source;
}

function paidRegistry(shadowId: string, component: PaidComponent): RegisteredRuleInputMappingRegistry {
  const mapping: RuleInputMapping = {
    input_id: component.input_id,
    runtime_fact_path: `synthetic.${component.input_id.replace(/^paid\./u, "paid.")}`,
    fact_path: component.fact_path,
    minimum_confidence: 0.8,
    max_age_seconds: 31_536_000,
    expected_output: component.expected_output,
    transformation: { transformation_id: component.transformation_id, transformation_version: "1.0.0" },
  };
  if (!transformationAccepts(mapping)) throw new Error(`SHADOW_PAID_MAPPING_TRANSFORMATION_MISMATCH:${shadowId}`);
  return registerRuleInputMappingRegistry({
    registry_id: `legal.draft.shadow.paid.${shadowId}`,
    registry_version: DRAFT_SHADOW_REGISTRY_VERSION,
    mappings: [mapping],
  });
}

export type PaidComponentBinding = Readonly<{
  shadow_id: string;
  component: PaidComponent;
  registry: RegisteredRuleInputMappingRegistry;
}>;

/** One registry per shadow spec that has a paid component. */
export const PAID_COMPONENT_BINDINGS: readonly PaidComponentBinding[] = Object.freeze(
  DRAFT_SHADOW_SPECS.flatMap((entry) => {
    const source = PAID_COMPONENTS[entry.shadow_id];
    if (!source) throw new Error(`SHADOW_PAID_COMPONENT_UNDECLARED:${entry.shadow_id}`);
    return isComponent(source) ? [{ shadow_id: entry.shadow_id, component: source, registry: paidRegistry(entry.shadow_id, source) }] : [];
  }),
);

export function paidComponentBinding(shadowId: string): PaidComponentBinding | null {
  return PAID_COMPONENT_BINDINGS.find((entry) => entry.shadow_id === shadowId) ?? null;
}

type ExecutorOutput = Readonly<{ kind: string; [key: string]: unknown }>;

function outputRounding(spec: RuleSpecPackage): string {
  const node = spec.nodes.find((candidate) => candidate.node_id === spec.output_ref);
  return node && "rounding" in node ? `${node.operation}:${node.rounding}` : node ? `${node.operation}:none` : "none";
}

/** entitlement − paid, exact, in the output's unit; or why there is none. */
export function computeSyntheticDelta(input: Readonly<{
  shadow_id: string;
  spec: RuleSpecPackage;
  entitlement: ExecutorOutput;
  paid: PreparedRuleInputs;
}>): SyntheticShadowDelta {
  const binding = paidComponentBinding(input.shadow_id);
  if (binding === null) {
    const source = PAID_COMPONENTS[input.shadow_id];
    const reason = source && !isComponent(source) ? source.not_applicable : "no paid component declared";
    return syntheticShadowDeltaSchema.parse({ kind: SYNTHETIC_SHADOW_DELTA_KIND, status: "not_applicable", is_finding: false, delivery_allowed: false, shadow_id: input.shadow_id, reason });
  }
  if (input.paid.result.status !== "ready") {
    return syntheticShadowDeltaSchema.parse({
      kind: SYNTHETIC_SHADOW_DELTA_KIND, status: "paid_refused", is_finding: false, delivery_allowed: false,
      shadow_id: input.shadow_id, paid_fact_path: binding.component.fact_path, rejection_codes: input.paid.result.rejection_codes,
    });
  }
  const paidRef = input.paid.result.values.find((value) => value.input_id === binding.component.input_id);
  if (!paidRef) throw new Error(`SHADOW_PAID_VALUE_MISSING:${input.shadow_id}`);

  let entitlement: bigint;
  let paid: bigint;
  if (binding.component.unit === "currency.ILS.minor_units") {
    if (input.entitlement.kind !== "money" || input.entitlement.currency !== "ILS") throw new Error(`SHADOW_DELTA_ENTITLEMENT_NOT_ILS_MONEY:${input.shadow_id}`);
    if (paidRef.value.kind !== "money" || paidRef.value.value.currency !== "ILS") throw new Error(`SHADOW_DELTA_PAID_NOT_ILS_MONEY:${input.shadow_id}`);
    entitlement = BigInt(String(input.entitlement.minor_units));
    paid = BigInt(paidRef.value.value.minor_units);
  } else {
    if (input.entitlement.kind !== "integer" || input.entitlement.unit !== "calendar_days") throw new Error(`SHADOW_DELTA_ENTITLEMENT_NOT_DAYS:${input.shadow_id}`);
    if (paidRef.value.kind !== "integer") throw new Error(`SHADOW_DELTA_PAID_NOT_INTEGER:${input.shadow_id}`);
    entitlement = BigInt(String(input.entitlement.value));
    paid = BigInt(paidRef.value.value);
  }
  return syntheticShadowDeltaSchema.parse({
    kind: SYNTHETIC_SHADOW_DELTA_KIND,
    status: "computed",
    is_finding: false,
    delivery_allowed: false,
    shadow_id: input.shadow_id,
    paid_fact_path: binding.component.fact_path,
    paid_source_fact_id: paidRef.source_fact_id,
    unit: binding.component.unit,
    entitlement: entitlement.toString(),
    paid: paid.toString(),
    delta: (entitlement - paid).toString(),
    sign_convention: DELTA_SIGN_CONVENTION,
    entitlement_rounding: outputRounding(input.spec),
  });
}
