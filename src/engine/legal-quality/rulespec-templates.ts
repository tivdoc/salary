// R-2. Seven blank RuleSpec templates, one per topic — structure only.
//
// These are built ON the seven authoring skeletons that already exist in
// `rulespec-authoring.ts`, not beside them: every template carries the
// skeleton's id and content hash as its provenance, and takes its fact paths
// from the skeleton rather than declaring a second, drifting list. What the
// skeleton did not carry is the R-2 slot vocabulary — the named, individually
// addressable holes a lawyer's decisions get poured into — and that is what
// this module adds.
//
// Nothing here is executable and nothing here is legal content. Every slot is
// unbound; a template with an unbound parameter slot is refused by
// `assertRuleSpecTemplateBindable`, and the executor itself refuses a package
// whose declared parameters have no supplied values (`RULESPEC_INPUT_MISSING`)
// — so the refusal is real machinery, not a label.
import { z } from "zod";
import { factSourceTypeSchema } from "../facts/contracts.ts";
import { canonicalSha256, deepFreeze } from "../rule-runtime/canonical.ts";
import { WAVE3_TOPICS, type Wave3Topic } from "../wave3/contracts.ts";
import { buildRuleSpecAuthoringSkeleton } from "./rulespec-authoring.ts";

export const RULESPEC_TEMPLATE_SCHEMA = "tivdoc-rulespec-template-v0.8.0" as const;

// Provenance a rule is allowed to accept for an input. Reused from the fact
// registry's own `factSourceTypeSchema` rather than redeclared here, so a
// template cannot allow a provenance the fact model does not have: documented
// (read off a customer artifact), declared (asserted by a person), derived
// (computed by the engine from other facts) and inferred (produced by an agent).
// The allowance is per-input and explicit, never a default — accepting someone's
// word for a fact the law wants evidence of is how a wrong answer becomes a
// confident one. `inferred` is forbidden on every input of every template: an
// agent's guess is not a basis for a monetary claim.
export const factProvenanceSchema = factSourceTypeSchema;
export type FactProvenance = z.infer<typeof factProvenanceSchema>;

const idSchema = z.string().regex(/^[a-z][a-z0-9._:-]{2,159}$/u);
const shaSchema = z.string().regex(/^[a-f0-9]{64}$/u);

// Units a slot may declare. A closed list so a typo fails at build time rather
// than becoming a silently wrong computation later.
export const RULESPEC_SLOT_UNITS = [
  "currency.ils", "ratio", "hours", "hours_per_week", "hours_per_month",
  "days", "days_per_month", "calendar_days", "months", "count",
] as const;

const inputSlotSchema = z.object({
  input_id: idSchema,
  fact_path: idSchema,
  // Allowed provenances, listed positively. An empty list would mean "no
  // provenance is acceptable", which is not a rule — so at least one.
  provenance_allowed: z.array(factProvenanceSchema).min(1).readonly(),
  provenance_forbidden: z.array(factProvenanceSchema).min(1).readonly(),
  missing_blocker_code: z.literal("BLOCKED_MISSING_FACT"),
  conflicted_blocker_code: z.literal("BLOCKED_CONFLICTED_FACT"),
}).strict().readonly();

const parameterSlotSchema = z.object({
  slot_id: idSchema,
  parameter_id: idSchema,
  unit: z.enum(RULESPEC_SLOT_UNITS),
  // Where the dossier records an open legal question, the slot names the
  // decision whose branches fill it. Q-1..Q-7 must then carry BOTH branches;
  // it is not the template's job to pick one.
  decision_id: idSchema.nullable(),
  bound_parameter_version_id: z.null(),
}).strict().readonly();

const citationSlotSchema = z.object({
  slot_id: idSchema,
  // Which computation step this clause is supposed to support. Naming the step
  // is what stops a citation from being decorative.
  supports_step: idSchema,
  source_version_id: z.null(),
  pinpoint: z.null(),
  verified: z.literal(false),
}).strict().readonly();

const outputSlotSchema = z.object({
  output_id: idSchema,
  unit: z.enum(RULESPEC_SLOT_UNITS),
  trace_required: z.literal(true),
}).strict().readonly();

export const ruleSpecTemplateSchema = z.object({
  schema_version: z.literal(RULESPEC_TEMPLATE_SCHEMA),
  template_id: idSchema,
  template_version: z.literal("0.8.0"),
  topic: z.enum(WAVE3_TOPICS),
  state: z.literal("non_operative"),
  catalog_boundary: z.literal("real_inactive"),
  // Provenance back to the skeleton this template extends. If the skeleton
  // changes, this hash stops matching and the template must be rebuilt — the
  // two cannot silently diverge.
  derived_from: z.object({ skeleton_id: idSchema, skeleton_content_sha256: shaSchema }).strict(),
  inputs: z.array(inputSlotSchema).min(1).max(64).readonly(),
  parameter_slots: z.array(parameterSlotSchema).min(1).max(64).readonly(),
  citation_slots: z.array(citationSlotSchema).min(1).max(64).readonly(),
  rounding_policy_slot: z.object({ slot_id: idSchema, policy: z.null() }).strict(),
  effective_period_slot: z.object({ slot_id: idSchema, from: z.null(), to: z.null() }).strict(),
  sector_population_slot: z.object({
    slot_id: idSchema, sectors: z.array(idSchema).max(0).readonly(), populations: z.array(idSchema).max(0).readonly(),
  }).strict(),
  // Which rule wins when two apply to the same period, sector and population.
  // Left unbound: precedence between a law, an extension order and a permit is
  // a legal judgement, not something a template may assume.
  precedence_slot: z.object({ slot_id: idSchema, precedence: z.null() }).strict(),
  outputs: z.array(outputSlotSchema).min(1).max(16).readonly(),
  content_sha256: shaSchema,
}).strict().readonly();

export type RuleSpecTemplate = z.infer<typeof ruleSpecTemplateSchema>;

type SlotSeed = Readonly<{ name: string; parameter_id: string; unit: RuleSpecTemplate["parameter_slots"][number]["unit"]; decision_id?: string }>;
type OutputSeed = Readonly<{ name: string; unit: RuleSpecTemplate["outputs"][number]["unit"] }>;

// The two open decisions that actually exist as rows in the governance
// database, not invented ids. A slot may only name a decision that is real;
// the test below proves this list is exactly what the P-pool registered.
export const OPEN_DECISION_MIN_WAGE_HOURLY_DIVISOR = "legal.reference.il.decision.min_wage_hourly_divisor";
export const OPEN_DECISION_PENSION_WAGE_CAP_SECTION = "legal.reference.il.decision.pension_wage_cap_section";

const PARAMETER_SLOTS_BY_TOPIC: Readonly<Record<Wave3Topic, readonly SlotSeed[]>> = Object.freeze({
  minimum_wage: [
    { name: "monthly_floor", parameter_id: "il.minimum_wage.monthly", unit: "currency.ils" },
    { name: "hourly_floor", parameter_id: "il.minimum_wage.hourly", unit: "currency.ils", decision_id: OPEN_DECISION_MIN_WAGE_HOURLY_DIVISOR },
  ],
  working_time: [
    { name: "weekly_overtime_threshold", parameter_id: "il.working_time.weekly_overtime_threshold_hours", unit: "hours_per_week" },
    { name: "overtime_first_tier_rate", parameter_id: "il.working_time.overtime_rate_first_tier", unit: "ratio" },
  ],
  pension: [
    { name: "mandatory_wage_cap", parameter_id: "il.pension.mandatory_wage_cap", unit: "currency.ils", decision_id: OPEN_DECISION_PENSION_WAGE_CAP_SECTION },
    { name: "employee_contribution_rate", parameter_id: "il.pension.employee_contribution_rate", unit: "ratio" },
  ],
  travel: [
    { name: "daily_cap", parameter_id: "il.travel.daily_reimbursement_cap", unit: "currency.ils" },
  ],
  convalescence: [
    { name: "daily_rate", parameter_id: "il.convalescence.daily_rate", unit: "currency.ils" },
    { name: "reduction_wage_threshold", parameter_id: "il.convalescence.partial_reduction_wage_threshold", unit: "currency.ils" },
  ],
  vacation: [
    { name: "calendar_days_early_seniority", parameter_id: "il.vacation.calendar_days_years_1_to_4", unit: "calendar_days" },
    { name: "full_year_threshold", parameter_id: "il.vacation.full_year_relationship_minimum_days_threshold", unit: "days" },
  ],
  sick_leave: [
    { name: "monthly_accrual", parameter_id: "il.sick_pay.accrual_days_per_month", unit: "days_per_month" },
    { name: "accrual_cap", parameter_id: "il.sick_pay.accrual_cap_days", unit: "days" },
  ],
});

const OUTPUTS_BY_TOPIC: Readonly<Record<Wave3Topic, readonly OutputSeed[]>> = Object.freeze({
  minimum_wage: [{ name: "shortfall", unit: "currency.ils" }],
  working_time: [{ name: "overtime_due", unit: "currency.ils" }],
  pension: [{ name: "contribution_shortfall", unit: "currency.ils" }],
  travel: [{ name: "reimbursement_due", unit: "currency.ils" }],
  convalescence: [{ name: "payment_due", unit: "currency.ils" }],
  vacation: [{ name: "entitlement_days", unit: "days" }],
  sick_leave: [{ name: "entitlement_days", unit: "days" }],
});

// Which inputs a rule may take on someone's word. A period read off a payslip
// is documented; hours worked may legitimately be declared where no document
// records them; nothing on these paths may be engine-derived, because deriving
// a fact the law wants evidence of is how a wrong answer becomes confident.
const DECLARABLE_FACT_PATHS = new Set<string>(["work.regular_hours", "work.overtime_hours", "work.workdays"]);

function unsignedTemplate(topic: Wave3Topic) {
  const skeleton = buildRuleSpecAuthoringSkeleton(topic);
  const slots = PARAMETER_SLOTS_BY_TOPIC[topic];
  const outputs = OUTPUTS_BY_TOPIC[topic];
  return {
    schema_version: RULESPEC_TEMPLATE_SCHEMA,
    template_id: `rulespec.template.${topic}`,
    template_version: "0.8.0" as const,
    topic,
    state: "non_operative" as const,
    catalog_boundary: "real_inactive" as const,
    derived_from: { skeleton_id: skeleton.skeleton_id, skeleton_content_sha256: skeleton.content_sha256 },
    inputs: skeleton.available_fact_paths.map((factPath) => ({
      input_id: `input.${topic}.${factPath.replaceAll(".", "_")}`,
      fact_path: factPath,
      provenance_allowed: DECLARABLE_FACT_PATHS.has(factPath)
        ? (["documented", "declared"] as const)
        : (["documented"] as const),
      provenance_forbidden: DECLARABLE_FACT_PATHS.has(factPath)
        ? (["derived", "inferred"] as const)
        : (["declared", "derived", "inferred"] as const),
      missing_blocker_code: "BLOCKED_MISSING_FACT" as const,
      conflicted_blocker_code: "BLOCKED_CONFLICTED_FACT" as const,
    })),
    parameter_slots: slots.map((slot) => ({
      slot_id: `slot.${topic}.${slot.name}`,
      parameter_id: slot.parameter_id,
      unit: slot.unit,
      decision_id: slot.decision_id ?? null,
      bound_parameter_version_id: null,
    })),
    // One citation slot per parameter slot plus one for the applicability
    // guard: every step that could be challenged names the clause that
    // supports it, and none of them is filled here.
    citation_slots: [
      { slot_id: `citation.${topic}.applicability`, supports_step: `step.${topic}.applicability`, source_version_id: null, pinpoint: null, verified: false as const },
      ...slots.map((slot) => ({
        slot_id: `citation.${topic}.${slot.name}`,
        supports_step: `step.${topic}.${slot.name}`,
        source_version_id: null,
        pinpoint: null,
        verified: false as const,
      })),
    ],
    rounding_policy_slot: { slot_id: `slot.${topic}.rounding_policy`, policy: null },
    effective_period_slot: { slot_id: `slot.${topic}.effective_period`, from: null, to: null },
    sector_population_slot: { slot_id: `slot.${topic}.sector_population`, sectors: [] as never[], populations: [] as never[] },
    precedence_slot: { slot_id: `slot.${topic}.precedence`, precedence: null },
    outputs: outputs.map((output) => ({
      output_id: `output.${topic}.${output.name}`,
      unit: output.unit,
      trace_required: true as const,
    })),
  };
}

export function buildRuleSpecTemplate(topic: Wave3Topic): RuleSpecTemplate {
  const content = unsignedTemplate(topic);
  return deepFreeze(ruleSpecTemplateSchema.parse({ ...content, content_sha256: canonicalSha256(content) })) as RuleSpecTemplate;
}

export function buildSevenRuleSpecTemplates(): readonly RuleSpecTemplate[] {
  return deepFreeze(WAVE3_TOPICS.map(buildRuleSpecTemplate)) as readonly RuleSpecTemplate[];
}

export type RuleSpecTemplateBindingRefusal = Readonly<{
  code: "RULESPEC_TEMPLATE_PARAMETER_SLOT_UNBOUND" | "RULESPEC_TEMPLATE_CITATION_SLOT_UNBOUND"
    | "RULESPEC_TEMPLATE_ROUNDING_UNBOUND" | "RULESPEC_TEMPLATE_PERIOD_UNBOUND"
    | "RULESPEC_TEMPLATE_SECTOR_POPULATION_UNBOUND" | "RULESPEC_TEMPLATE_PRECEDENCE_UNBOUND"
    | "RULESPEC_TEMPLATE_CONTENT_HASH_MISMATCH";
  slot_id: string;
}>;

// Every reason this template cannot be executed, all of them, in a stable
// order. Returning the full list rather than the first one is what makes the
// refusal usable: an author sees everything still missing, not one hole at a
// time.
export function ruleSpecTemplateBindingRefusals(template: RuleSpecTemplate): readonly RuleSpecTemplateBindingRefusal[] {
  const refusals: RuleSpecTemplateBindingRefusal[] = [];
  const { content_sha256: expected, ...content } = template;
  if (canonicalSha256(content) !== expected) {
    refusals.push({ code: "RULESPEC_TEMPLATE_CONTENT_HASH_MISMATCH", slot_id: template.template_id });
  }
  for (const slot of template.parameter_slots) {
    if (slot.bound_parameter_version_id === null) refusals.push({ code: "RULESPEC_TEMPLATE_PARAMETER_SLOT_UNBOUND", slot_id: slot.slot_id });
  }
  for (const slot of template.citation_slots) {
    if (slot.source_version_id === null || slot.pinpoint === null || !slot.verified) {
      refusals.push({ code: "RULESPEC_TEMPLATE_CITATION_SLOT_UNBOUND", slot_id: slot.slot_id });
    }
  }
  if (template.rounding_policy_slot.policy === null) refusals.push({ code: "RULESPEC_TEMPLATE_ROUNDING_UNBOUND", slot_id: template.rounding_policy_slot.slot_id });
  if (template.effective_period_slot.from === null) refusals.push({ code: "RULESPEC_TEMPLATE_PERIOD_UNBOUND", slot_id: template.effective_period_slot.slot_id });
  if (template.sector_population_slot.sectors.length === 0 || template.sector_population_slot.populations.length === 0) {
    refusals.push({ code: "RULESPEC_TEMPLATE_SECTOR_POPULATION_UNBOUND", slot_id: template.sector_population_slot.slot_id });
  }
  if (template.precedence_slot.precedence === null) refusals.push({ code: "RULESPEC_TEMPLATE_PRECEDENCE_UNBOUND", slot_id: template.precedence_slot.slot_id });
  return deepFreeze(refusals) as readonly RuleSpecTemplateBindingRefusal[];
}

export function assertRuleSpecTemplateBindable(template: RuleSpecTemplate): void {
  const refusals = ruleSpecTemplateBindingRefusals(template);
  if (refusals.length > 0) throw new Error(refusals[0].code);
}
