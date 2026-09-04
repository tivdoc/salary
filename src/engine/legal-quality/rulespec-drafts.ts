// Q-1 … Q-7. One draft RuleSpec per topic, filled from the R-2 templates.
//
// A draft binds only parameters that actually exist as `draft` rows in the
// governance database — never a value typed in here, never a plausible-looking
// id. Where the dossier records an open legal question the draft carries BOTH
// branches, because picking one silently is the single thing this whole
// apparatus exists to prevent. Where nothing is registered yet, the slot stays
// unbound and says why in its own words; R-2's refusal is what makes that safe,
// since a spec with an unbound slot cannot be executed at all.
//
// Nothing here is operative, nothing is approved, and no draft carries a
// number. The values live in the governance database behind two attestations
// this repository cannot produce.
import { z } from "zod";
import { canonicalSha256, deepFreeze } from "../rule-runtime/canonical.ts";
import { WAVE3_TOPICS, type Wave3Topic } from "../wave3/contracts.ts";
import {
  buildRuleSpecTemplate,
  ruleSpecTemplateSchema,
  type RuleSpecTemplate,
} from "./rulespec-templates.ts";

export const RULESPEC_DRAFT_SCHEMA = "tivdoc-rulespec-draft-v0.8.0" as const;

const idSchema = z.string().regex(/^[a-z][a-z0-9._:-]{2,159}$/u);
const shaSchema = z.string().regex(/^[a-f0-9]{64}$/u);
// `parameter_id@parameter_version` — the same identity the governance database
// keys a candidate by, so a binding is checkable against it without
// interpretation.
const parameterVersionIdSchema = z.string().regex(/^[a-z][a-z0-9._]{2,159}@[0-9]+(\.[0-9]+){0,2}$/u);

const boundSlotSchema = z.object({
  slot_id: idSchema,
  parameter_id: idSchema,
  bound: z.literal(true),
  // Every registered version of this parameter. Which one applies is decided
  // at execution time by the effective period, not chosen here.
  parameter_version_ids: z.array(parameterVersionIdSchema).min(1).readonly(),
  // Both branches of an open decision, keyed by branch. A draft that carried
  // one branch would be a decision this system has no standing to make.
  decision_id: idSchema.nullable(),
  decision_branches: z.array(z.object({
    branch: z.string().min(1).max(64),
    parameter_version_id: parameterVersionIdSchema,
  }).strict()).readonly(),
}).strict().readonly();

const unboundSlotSchema = z.object({
  slot_id: idSchema,
  parameter_id: idSchema,
  bound: z.literal(false),
  slot_unbound: z.string().min(10).max(400),
  decision_id: idSchema.nullable(),
}).strict().readonly();

export const ruleSpecDraftSchema = z.object({
  schema_version: z.literal(RULESPEC_DRAFT_SCHEMA),
  draft_id: idSchema,
  draft_version: z.literal("0.8.0"),
  topic: z.enum(WAVE3_TOPICS),
  state: z.literal("draft"),
  operative: z.literal(false),
  catalog_boundary: z.literal("real_inactive"),
  tenant_id: z.literal("legal.reference.il"),
  // The template this draft fills, pinned by hash. A template edit invalidates
  // every draft built on it rather than silently changing what the draft meant.
  template: z.object({ template_id: idSchema, template_content_sha256: shaSchema }).strict(),
  parameter_slots: z.array(z.union([boundSlotSchema, unboundSlotSchema])).min(1).readonly(),
  // Still unbound, all of them: a citation is verified by a person reading the
  // clause, an effective period and a sector/population are legal judgements,
  // and precedence between instruments is the hardest judgement of the three.
  citation_slots_bound: z.literal(0),
  rounding_policy_bound: z.literal(false),
  effective_period_bound: z.literal(false),
  sector_population_bound: z.literal(false),
  precedence_bound: z.literal(false),
  attestations: z.literal(0),
  content_sha256: shaSchema,
}).strict().readonly();

export type RuleSpecDraft = z.infer<typeof ruleSpecDraftSchema>;

type Registration = Readonly<{
  parameter_id: string;
  versions: readonly string[];
  decision_id?: string;
  branches?: ReadonlyArray<readonly [string, string]>;
}>;

// Exactly what Pool P registered, as it registered it. This list is checked
// against the live governance database by
// `scripts/legal-review-projection/rulespec-draft-binding-proof.mts`; a drift
// in either direction is a failure there rather than a silently wrong draft
// here.
export const REGISTERED_DRAFT_PARAMETERS: readonly Registration[] = Object.freeze([
  // L4-1 / D2. The 2023, 2024 and 2025 revisions moved from `.1.0` to `.2.0`.
  // The values are identical; what changed is that the citations now point at
  // the table-aware chunks, where the figure sits beside the column header that
  // names it, instead of at a bare row. The `.1.0` rows are `superseded` in the
  // database and nothing may bind to them — the draft-binding proof checks
  // exactly that, and is what caught this list when it still named them.
  // 2026.1.0 is unchanged: its citation always pointed at the header chunk.
  { parameter_id: "il.minimum_wage.monthly", versions: ["2023.2.0", "2024.2.0", "2025.2.0", "2026.1.0"] },
  {
    parameter_id: "il.minimum_wage.hourly", versions: ["2026.1.0", "2026.2.0"],
    decision_id: "legal.reference.il.decision.min_wage_hourly_divisor",
    branches: [["182", "2026.1.0"], ["186", "2026.2.0"]],
  },
  { parameter_id: "il.minimum_wage.daily_6day", versions: ["2026.1.0"] },
  { parameter_id: "il.minimum_wage.daily_5day", versions: ["2026.1.0"] },
  { parameter_id: "il.minimum_wage.youth_under16.monthly", versions: ["2026.1.0"] },
  { parameter_id: "il.minimum_wage.youth_under16.hourly", versions: ["2026.1.0"] },
  { parameter_id: "il.minimum_wage.youth_16_17.monthly", versions: ["2026.1.0"] },
  { parameter_id: "il.minimum_wage.youth_16_17.hourly", versions: ["2026.1.0"] },
  { parameter_id: "il.minimum_wage.youth_17_18.monthly", versions: ["2026.1.0"] },
  { parameter_id: "il.minimum_wage.youth_17_18.hourly", versions: ["2026.1.0"] },
  { parameter_id: "il.minimum_wage.apprentice.monthly", versions: ["2026.1.0"] },
  { parameter_id: "il.minimum_wage.apprentice.hourly", versions: ["2026.1.0"] },
  { parameter_id: "il.working_time.weekly_overtime_threshold_hours", versions: ["2018.1.0"] },
  // L7-9 (batch 16 / D6): §2's eight hours, bound through the lexicon. The
  // decision working_time_daily_threshold has one bound branch (statute) and
  // one unbound (administrative, BL-24), so it is carried on the spec and in
  // the decision register rather than as a two-branch slot here.
  { parameter_id: "il.working_time.daily_overtime_threshold_hours", versions: ["1951.1.0"] },
  {
    parameter_id: "il.pension.mandatory_wage_cap", versions: ["2026.1.0", "2026.2.0"],
    decision_id: "legal.reference.il.decision.pension_wage_cap_section",
    branches: [["section1", "2026.1.0"], ["section2", "2026.2.0"]],
  },
  { parameter_id: "il.travel.daily_reimbursement_cap", versions: ["2016.1.0"] },
  { parameter_id: "il.convalescence.2024_partial_reduction_wage_threshold", versions: ["2024.1.0"] },
  // L6-7 (batch 15 / D1): the 2025 threshold, read from the typeset page
  // (inferred_visual), paired with the 2024 one.
  { parameter_id: "il.convalescence.2025_partial_reduction_wage_threshold", versions: ["2025.1.0"] },
  // L6-6 (batch 14 / D4, P-29): the 1988 order's six seniority bands, text-verified
  // from the table-aware chunk of its page 3.
  { parameter_id: "il.convalescence.days_year_1", versions: ["1988.1.0"] },
  { parameter_id: "il.convalescence.days_years_2_to_3", versions: ["1988.1.0"] },
  { parameter_id: "il.convalescence.days_years_4_to_10", versions: ["1988.1.0"] },
  { parameter_id: "il.convalescence.days_years_11_to_15", versions: ["1988.1.0"] },
  { parameter_id: "il.convalescence.days_years_16_to_19", versions: ["1988.1.0"] },
  { parameter_id: "il.convalescence.days_years_20_and_above", versions: ["1988.1.0"] },
  { parameter_id: "il.vacation.full_year_relationship_minimum_days_threshold", versions: ["1.0.0"] },
  { parameter_id: "il.vacation.partial_year_relationship_minimum_days_threshold", versions: ["1.0.0"] },
  // B-7: the corrected scope. `il.vacation.calendar_days_years_1_to_4` is
  // registered and carries the right number against the wrong band — amendment
  // 15 moved the seniority band from four years to five in the same clause that
  // moved 14 to 16, and a citation check cannot see a scope disagreement. The
  // candidate table is append-only, so the mis-scoped row cannot be corrected;
  // it is listed in SUPERSEDED_BY_SCOPE below and nothing binds to it.
  { parameter_id: "il.vacation.calendar_days_years_1_to_5", versions: ["2017.1.0"] },
  { parameter_id: "il.vacation.calendar_days_interim_2016", versions: ["2016.1.0"] },
  { parameter_id: "il.sick_pay.accrual_days_per_month", versions: ["1.0.0"] },
  { parameter_id: "il.sick_pay.accrual_cap_days", versions: ["1.0.0"] },
  // L4-1 (batch 8): the unamended vacation bands and the 2011 pension order's
  // last row, read from the table-aware chunks with the column reading proven
  // by the sum. The 2014 contribution rates are the last row THAT instrument
  // states; whether a later instrument governs is the open precedence
  // question registered in L5-6, and binding them here binds a draft, not an
  // answer.
  { parameter_id: "il.vacation.calendar_days_year_6", versions: ["1951.1.0"] },
  { parameter_id: "il.vacation.calendar_days_year_7", versions: ["1951.1.0"] },
  { parameter_id: "il.vacation.calendar_days_years_8_and_above_cap", versions: ["1951.1.0"] },
  // L6-5 (batch 13 / D7): the 2014 rows re-registered as 2014.2.0 on the
  // precedence decision (2014.1.0 superseded naming them), beside the 2016
  // order's 2017 rows read from the page image (inferred_visual). The draft
  // carries both branches; the executor runs both.
  {
    parameter_id: "il.pension.employer_contribution_rate", versions: ["2014.2.0", "2017.1.0"],
    decision_id: "legal.reference.il.decision.pension_2011_2016_precedence",
    branches: [["order_2011_2014_row", "2014.2.0"], ["order_2016_2017_rates", "2017.1.0"]],
  },
  {
    parameter_id: "il.pension.employee_contribution_rate", versions: ["2014.2.0", "2017.1.0"],
    decision_id: "legal.reference.il.decision.pension_2011_2016_precedence",
    branches: [["order_2011_2014_row", "2014.2.0"], ["order_2016_2017_rates", "2017.1.0"]],
  },
  {
    parameter_id: "il.pension.severance_contribution_rate", versions: ["2014.2.0", "2017.1.0"],
    decision_id: "legal.reference.il.decision.pension_2011_2016_precedence",
    branches: [["order_2011_2014_row", "2014.2.0"], ["order_2016_2017_rates", "2017.1.0"]],
  },
  // L5-4 (batch 9): figures the law states as words, bound through the lexicon.
  { parameter_id: "il.sick_pay.rate_days_2_to_3", versions: ["1.0.0"] },
  { parameter_id: "il.vacation.calendar_days_increment_per_year_from_year_8", versions: ["1951.1.0"] },
  // L5-5..L5-7 (batch 10): figures inside instrument selections. The 2026
  // convalescence rate carries a period decision; the figure is the same on
  // both branches.
  {
    parameter_id: "il.convalescence.daily_rate", versions: ["2023.1.0", "2026.1.0", "2026.2.0"],
    decision_id: "legal.reference.il.decision.convalescence_2026_rate_period",
    branches: [["calendar_year_2026", "2026.1.0"], ["from_signature_2026_07", "2026.2.0"]],
  },
  { parameter_id: "il.working_time.daily_hours_cap_including_overtime", versions: ["2018.1.0"] },
  { parameter_id: "il.working_time.weekly_overtime_hours_cap", versions: ["2018.1.0"] },
  { parameter_id: "il.working_time.weekly_hours_cap_including_overtime", versions: ["2018.1.0"] },
  // L6-3 (batch 11 / D1): the 1951 premiums, read from the page image and
  // registered inferred_visual — the draft binds them as drafts, and the row,
  // the report and the rendering all show the grade. Attestation needs
  // visual_confirmed against the very page and reading.
  { parameter_id: "il.working_time.overtime_rate_first_tier", versions: ["1951.1.0"] },
  { parameter_id: "il.working_time.overtime_rate_second_tier", versions: ["1951.1.0"] },
  { parameter_id: "il.working_time.weekly_rest_rate", versions: ["1951.1.0"] },
]);

// Parameters that exist as draft rows but must never be bound, because
// something about them is known to be wrong and the append-only table cannot be
// corrected. This is not a blocklist of hypotheticals: every entry is a real
// row somebody could otherwise bind by id.
export const SUPERSEDED_BY_SCOPE: Readonly<Record<string, string>> = Object.freeze({
  "il.vacation.calendar_days_years_1_to_4":
    "Wrong population. Amendment 15 changed the seniority band from the first four years to the first five in the same clause that changed 14 days to 16, so the figure is right and the scope is not. Superseded by il.vacation.calendar_days_years_1_to_5@2017.1.0 (Pool P batch 7). The row cannot be removed — governance_parameter_versions is append-only.",
});

// Why each still-unregistered parameter is unregistered, in the words of the
// Pool P and Addendum 7 write-ups rather than a shrug. A slot with no reason
// here is a slot nobody has thought about, so building a draft for it fails.
// L6-3: empty. Every slot of every draft binds a registered draft parameter.
// The last unbound slot, the first overtime tier, bound through a visual
// citation once L6-1 proved the 1951 text authoritative for it.
const UNBOUND_REASONS: Readonly<Record<string, string>> = Object.freeze({});

function bindingFor(parameterId: string) {
  return REGISTERED_DRAFT_PARAMETERS.find((entry) => entry.parameter_id === parameterId) ?? null;
}

function unsignedDraft(topic: Wave3Topic, template: RuleSpecTemplate) {
  const parameterSlots = template.parameter_slots.map((slot) => {
    const registration = bindingFor(slot.parameter_id);
    if (!registration) {
      const reason = UNBOUND_REASONS[slot.parameter_id];
      if (!reason) throw new Error(`RULESPEC_DRAFT_UNBOUND_SLOT_REASON_MISSING:${slot.parameter_id}`);
      return { slot_id: slot.slot_id, parameter_id: slot.parameter_id, bound: false as const, slot_unbound: reason, decision_id: slot.decision_id };
    }
    // A slot that names a decision must have branches, and a slot that does not
    // must have none. A mismatch means the template and the registry disagree
    // about whether a legal question is open, which is never a detail.
    if ((slot.decision_id === null) !== (registration.decision_id === undefined)) {
      throw new Error(`RULESPEC_DRAFT_DECISION_BINDING_MISMATCH:${slot.slot_id}`);
    }
    if (slot.decision_id !== null && slot.decision_id !== registration.decision_id) {
      throw new Error(`RULESPEC_DRAFT_DECISION_ID_MISMATCH:${slot.slot_id}`);
    }
    return {
      slot_id: slot.slot_id,
      parameter_id: slot.parameter_id,
      bound: true as const,
      parameter_version_ids: registration.versions.map((version) => `${slot.parameter_id}@${version}`),
      decision_id: slot.decision_id,
      decision_branches: (registration.branches ?? []).map(([branch, version]) => ({
        branch, parameter_version_id: `${slot.parameter_id}@${version}`,
      })),
    };
  });
  return {
    schema_version: RULESPEC_DRAFT_SCHEMA,
    draft_id: `rulespec.draft.${topic}`,
    draft_version: "0.8.0" as const,
    topic,
    state: "draft" as const,
    operative: false as const,
    catalog_boundary: "real_inactive" as const,
    tenant_id: "legal.reference.il" as const,
    template: { template_id: template.template_id, template_content_sha256: template.content_sha256 },
    parameter_slots: parameterSlots,
    citation_slots_bound: 0 as const,
    rounding_policy_bound: false as const,
    effective_period_bound: false as const,
    sector_population_bound: false as const,
    precedence_bound: false as const,
    attestations: 0 as const,
  };
}

export function buildRuleSpecDraft(topic: Wave3Topic): RuleSpecDraft {
  const template = ruleSpecTemplateSchema.parse(buildRuleSpecTemplate(topic));
  const content = unsignedDraft(topic, template);
  return deepFreeze(ruleSpecDraftSchema.parse({ ...content, content_sha256: canonicalSha256(content) })) as RuleSpecDraft;
}

export function buildSevenRuleSpecDrafts(): readonly RuleSpecDraft[] {
  return deepFreeze(WAVE3_TOPICS.map(buildRuleSpecDraft)) as readonly RuleSpecDraft[];
}

/** Every distinct `parameter_id@version` any draft binds. */
export function draftBoundParameterVersionIds(): readonly string[] {
  const ids = new Set<string>();
  for (const draft of buildSevenRuleSpecDrafts()) {
    for (const slot of draft.parameter_slots) {
      if (slot.bound) for (const id of slot.parameter_version_ids) ids.add(id);
    }
  }
  return Object.freeze([...ids].sort());
}
