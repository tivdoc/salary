// L11-2 / D2 (run 11). Owner-recorded resolutions of the six open decisions.
//
// On 5 September 2026 a labour lawyer approved an opinion on the six open
// legal decisions (the evidence L11-1 stored, pinned here by its sha256). The
// owner recorded the opinion's selected branches as resolutions — one per
// decision, in `private.legal_decision_resolutions` on the reference tenant —
// and this module is the same six, in code, so the report and the shadow can
// treat the selected branch as the DEFAULT without reaching for the database.
//
// What a resolution is: the branch the report and the shadow run as default.
// What it is not: an attestation. Its status is `owner_recorded`; the lawyer
// has no reviewer identity; no source is reviewed, no parameter leaves draft,
// no RuleSpec activates, and every other branch is still computed and shown.
// `attested` is a status a registered reviewer identity would set at the
// /operations screen; nothing here can produce it, and the test beside this
// file proves the registry cannot carry it.
//
// The opinion names decisions and branches in its own words. Where the name
// differs from the register's, the mapping is on the record (`decision_key`
// and `opinion_branch_label` beside `decision_id` and `selected_branch`) and
// in the state document; no decision was registered twice.
import { canonicalSha256 } from "../rule-runtime/canonical.ts";
import { APPROVAL_RECORD_SHA256, APPROVED_ON, LEGAL_OPINION_SHA256 } from "../legal-knowledge/owner-evidence.ts";

export const RESOLUTION_BASIS = "lawyer_approved_opinion" as const;
/** External review #1, finding 5: the basis a re-recorded revision may carry. */
export const RESOLUTION_BASIS_EXTERNAL_REVIEW = "external_review_correction" as const;
export const RESOLUTION_STATUS_OWNER_RECORDED = "owner_recorded" as const;
export const RESOLUTION_RECORDED_BY = "owner_action" as const;
/** The errata appendix (docs/legal/errata-external-review-1.he.md), LF-normalised sha256: the evidence a revision-2 resolution rests on. */
export const ERRATA_EXTERNAL_REVIEW_1_SHA256 = "49b06b078ecdbb6d61e2ad0306a3c7b18e9bf5b3b62e513e001fb8ff3bec77f5" as const;
/** The owner's instruction as received (external review #1 response, 5.9.2026, section ד' item 5), hashed canonically: no file carries it. */
export const EXTERNAL_REVIEW_1_INSTRUCTION_SHA256 = canonicalSha256({
  source: "external review #1 response, 5.9.2026, section ד', item 5",
  instruction: "re-record working_time_daily_threshold as conditional_on_schedule (applicability facts: days per week, regular day length; known patterns 8 / 8.6-7.6 / 9; otherwise refusal); the previous resolution stays in history with basis superseded_by_external_review_2026-09-05; append-only, never edited",
  received_as: "chat message; recorded by the engineer as a draft",
});
/** The sentinel a resolution selects when the branch depends on the case's schedule facts (finding 5). */
export const CONDITIONAL_ON_SCHEDULE = "conditional_on_schedule" as const;
export const SUPERSEDED_BY_EXTERNAL_REVIEW_1 = "superseded_by_external_review_2026-09-05" as const;
export const LEGAL_DECISION_RESOLUTION_SCHEMA = "tivdoc-legal-decision-resolution-v0" as const;

const DECISION = "legal.reference.il.decision";

export type OwnerRecordedResolution = Readonly<{
  /** The name the opinion and the run brief use. */
  decision_key: string;
  /** The decision register's id. */
  decision_id: string;
  /** The branch as the register names it — what the report and the shadow run as default. */
  selected_branch: string;
  /** The branch as the opinion names it. */
  opinion_branch_label: string;
  basis: typeof RESOLUTION_BASIS | typeof RESOLUTION_BASIS_EXTERNAL_REVIEW;
  evidence_sha256: string;
  approval_record_sha256: string;
  approved_on: string;
  approver_identity: null;
  status: typeof RESOLUTION_STATUS_OWNER_RECORDED;
  recorded_by: typeof RESOLUTION_RECORDED_BY;
  mapping_note: string;
  /** Finding 5: absent or 1 on a first resolution; a re-recording names the revision it supersedes and why. */
  revision?: number;
  supersedes_revision?: number;
  supersession_basis?: string;
  /** For a conditional selection: the branch that runs until the case's schedule facts are wired in (the superseded selection). */
  fallback_branch?: string;
}>;

const common = {
  basis: RESOLUTION_BASIS,
  evidence_sha256: LEGAL_OPINION_SHA256,
  approval_record_sha256: APPROVAL_RECORD_SHA256,
  approved_on: APPROVED_ON,
  approver_identity: null,
  status: RESOLUTION_STATUS_OWNER_RECORDED,
  recorded_by: RESOLUTION_RECORDED_BY,
} as const;

export const OWNER_RECORDED_RESOLUTIONS: readonly OwnerRecordedResolution[] = Object.freeze([
  {
    ...common,
    decision_key: "hourly_wage_divisor",
    decision_id: `${DECISION}.min_wage_hourly_divisor`,
    selected_branch: "182",
    opinion_branch_label: "order_182",
    mapping_note:
      "The opinion's order_182 is the register's branch 182 (il.minimum_wage.hourly@2026.1.0: the monthly rate ÷ 182, from 1.4.2018; ÷ 186 before that date). Branch 186 (2026.2.0) stays computed as the statutory floor: a gap between the two figures is classed order_entitlement, a gap below the 186 figure statutory_violation (D3.2).",
  },
  {
    ...common,
    decision_key: "pension_wage_cap_source",
    decision_id: `${DECISION}.pension_wage_cap_section`,
    selected_branch: "section2",
    opinion_branch_label: "nii_section_2_benefits",
    mapping_note:
      "The opinion's nii_section_2_benefits — the National Insurance Law 'סעיף 2 – לעניין גמלאות' figure, 13,769 for 2026 (the opinion states 12,536 and 13,316 for 2024 and 2025; those years are not registered here) — is the register's branch section2 (il.pension.mandatory_wage_cap@2026.2.0). Branch section1 (2026.1.0, 13,566) stays computed; the minimum-wage base is the §1 figure (D3.1).",
  },
  {
    ...common,
    decision_key: "pension_2011_2016_precedence",
    decision_id: `${DECISION}.pension_2011_2016_precedence`,
    selected_branch: "order_2016_2017_rates",
    opinion_branch_label: "overlay",
    mapping_note:
      "The opinion's overlay — contribution rates from the 2016 order (6 / 6.5 / 6 from 1.1.2017), everything else from the 2011 order — is the register's branch order_2016_2017_rates (the rate parameters at 2017.1.0); the rate is the spec's only decision-dependent binding. Branch order_2011_2014_row (2014.2.0) stays computed.",
  },
  {
    ...common,
    decision_key: "rest_day_overtime_composition",
    decision_id: `${DECISION}.rest_day_overtime_composition`,
    selected_branch: "additive",
    opinion_branch_label: "additive",
    mapping_note:
      "Same name in the opinion and the register. The multiplicative branch is retired (D3.3): kept as a regression fixture, removed from the sensitivity table, listed once under branches examined and rejected — multiplicative — not a separate composition: the fixed contractual premium enters the base of the rest-day and overtime rates under §18 of the Hours of Work and Rest Law (ע\"ע 38313-03-18); the base rule regular_wage_includes_fixed_contractual_premiums carries it.",
  },
  {
    ...common,
    decision_key: "convalescence_rate_period",
    decision_id: `${DECISION}.convalescence_2026_rate_period`,
    selected_branch: "havraa_year",
    opinion_branch_label: "havraa_year",
    mapping_note:
      "The opinion's havraa_year — 451.50 is the rate for the convalescence year 2026, 1.7.2025 to 30.6.2026, known from the order's publication on 18.8.2026 and retroactive — is neither registered branch (calendar_year_2026 at 2026.1.0, from_signature_2026_07 at 2026.2.0). It is a new branch of the same decision, bound in D3.4 to il.convalescence.daily_rate@2026.3.0 beside a rate table keyed by convalescence year with knowledge time; while unbound it is listed as selected and unbound and the first bound branch runs. Both earlier branches stay computed.",
  },
  {
    // External review #1, finding 5: revision 2. Revision 1 (the opinion's
    // "administrative") is in RESOLUTION_HISTORY below, untouched.
    decision_key: "working_time_daily_threshold",
    decision_id: `${DECISION}.working_time_daily_threshold`,
    selected_branch: CONDITIONAL_ON_SCHEDULE,
    opinion_branch_label: "administrative (the opinion); conditional on the schedule (external review #1)",
    basis: RESOLUTION_BASIS_EXTERNAL_REVIEW,
    evidence_sha256: ERRATA_EXTERNAL_REVIEW_1_SHA256,
    approval_record_sha256: EXTERNAL_REVIEW_1_INSTRUCTION_SHA256,
    approved_on: "2026-09-05",
    approver_identity: null,
    status: RESOLUTION_STATUS_OWNER_RECORDED,
    recorded_by: RESOLUTION_RECORDED_BY,
    revision: 2,
    supersedes_revision: 1,
    supersession_basis: SUPERSEDED_BY_EXTERNAL_REVIEW_1,
    fallback_branch: "administrative",
    mapping_note:
      "Re-recorded after the external review #1 (5.9.2026): the daily overtime threshold is not one branch for every worker but a function of the schedule — the applicability facts are days per week and the regular day's length; known patterns are 8 hours (six-day week, §2(א) of the 1951 law), 8.6 on the regular day and 7.6 on the short day (five-day week under the 2018 42-hour order as the steering committee read it) and 9 hours (a nine-hour pattern, no branch registered); any other schedule, or missing facts, is a refusal rather than a default. Until the case's schedule facts are wired into the comparison, the branch the superseded revision selected (administrative) runs where it is bound and the report says so. Revision 1 stays in history with basis superseded_by_external_review_2026-09-05.",
  },
]);

/**
 * Finding 5: the superseded revisions, exactly as they were recorded. A
 * superseded row is never edited; its hash is the hash it was stored with.
 */
export const RESOLUTION_HISTORY: readonly OwnerRecordedResolution[] = Object.freeze([
  {
    ...common,
    decision_key: "working_time_daily_threshold",
    decision_id: `${DECISION}.working_time_daily_threshold`,
    selected_branch: "administrative",
    opinion_branch_label: "administrative",
    revision: 1,
    mapping_note:
      "Same name in the opinion and the register. The branch is unbound (BL-24): its figures — 8.6 hours on four days and 7.6 on the short day of a five-day week, 8 / 7 on a six-day week, weekly threshold 42 with 45 as the statutory floor — come from the 24.4.2018 steering-committee interpretation of the 42-hour order as reported by kolzchut (grade agreement_interpretation after D3.6, not administrative), and no official artifact carries them, so it does not run. The statute branch (8, §2(א) of the 1951 law) stays computed and is the statutory floor.",
  },
]);

/** The fields the database row and the registry hash identically. */
export function resolutionSha256(resolution: OwnerRecordedResolution): string {
  return canonicalSha256({
    schema_version: LEGAL_DECISION_RESOLUTION_SCHEMA,
    decision_id: resolution.decision_id,
    decision_key: resolution.decision_key,
    selected_branch: resolution.selected_branch,
    basis: resolution.basis,
    evidence_sha256: resolution.evidence_sha256,
    approval_record_sha256: resolution.approval_record_sha256,
    approved_on: resolution.approved_on,
    approver_identity: null,
    status: resolution.status,
    recorded_by: resolution.recorded_by,
    // Finding 5: a re-recorded revision hashes its lineage too; a first revision hashes exactly what it always did.
    ...((resolution.revision ?? 1) > 1 ? { revision: resolution.revision, supersedes_revision: resolution.supersedes_revision, supersession_basis: resolution.supersession_basis } : {}),
  });
}

/** Finding 5: the schedule facts a conditional selection needs, and what each known pattern selects. */
export type ScheduleFacts = Readonly<{ days_per_week: number | null; regular_day_hours: number | null }>;
export type ConditionalSelection = Readonly<{ branch: string | null; pattern: "8" | "8.6-7.6" | "9" | null; refusal: string | null }>;
export const CONDITIONAL_SCHEDULE_PATTERNS = Object.freeze([
  { pattern: "8", days_per_week: 6, regular_day_hours: 8, branch: "statute", note: "six-day week: 8 hours a day, §2(א) of the Hours of Work and Rest Law 1951" },
  { pattern: "8.6-7.6", days_per_week: 5, regular_day_hours: 8.6, branch: "administrative", note: "five-day week: 8.6 on the regular day and 7.6 on the short day, the 2018 42-hour order as the steering committee read it" },
  { pattern: "9", days_per_week: 5, regular_day_hours: 9, branch: null, note: "nine-hour pattern: no branch registered; a refusal until one is" },
] as const);

/** Which branch a conditional selection resolves to for a case, or why it refuses. Pure; the facts come from the case. */
export function conditionalSelection(facts: ScheduleFacts): ConditionalSelection {
  if (facts.days_per_week === null || facts.regular_day_hours === null) return { branch: null, pattern: null, refusal: "schedule_facts_missing" };
  const hit = CONDITIONAL_SCHEDULE_PATTERNS.find((entry) => entry.days_per_week === facts.days_per_week && Math.abs(entry.regular_day_hours - (facts.regular_day_hours ?? 0)) < 0.05);
  if (!hit) return { branch: null, pattern: null, refusal: `schedule_pattern_unknown:${facts.days_per_week}d/${facts.regular_day_hours}h` };
  if (hit.branch === null) return { branch: null, pattern: hit.pattern, refusal: `branch_not_registered:${hit.pattern}` };
  return { branch: hit.branch, pattern: hit.pattern, refusal: null };
}

export function resolutionFor(decisionId: string | null): OwnerRecordedResolution | null {
  if (decisionId === null) return null;
  return OWNER_RECORDED_RESOLUTIONS.find((entry) => entry.decision_id === decisionId) ?? null;
}

export type BranchShape = Readonly<{
  decision_id: string | null;
  branches: ReadonlyArray<readonly [string, string]>;
  composition_branch?: string | null;
  unbound_branches?: ReadonlyArray<Readonly<{ branch: string; reason: string }>>;
}>;

export type DefaultBranch = Readonly<{
  /** The branch that runs as default: null for a spec with no decision and no named branch. */
  branch: string | null;
  source: "single" | "first_listed" | "owner_recorded_resolution" | "first_bound_fallback" | "composition_member" | "conditional_on_schedule";
  /** What the resolution selected, when there is one. */
  selected_branch: string | null;
  /** Whether the selected branch is bound (runs) — null without a resolution. */
  selected_bound: boolean | null;
  resolution: OwnerRecordedResolution | null;
}>;

/**
 * Which branch a spec treats as default. A resolution moves the default to
 * its selected branch and nothing else; without one, the first listed branch
 * is the default exactly as before. A selected branch that is named on the
 * decision but not bound cannot run, so the first bound branch runs and the
 * result says so. A selected branch the spec does not know at all is an
 * error, never a silent fallback.
 */
export function defaultBranchOf(spec: BranchShape, options: Readonly<{ composition_branches?: readonly string[] }> = {}): DefaultBranch {
  const composition = spec.composition_branch ?? null;
  const names = spec.branches.length > 0 ? spec.branches.map(([branch]) => branch) : (options.composition_branches ?? (composition ? [composition] : []));
  const unbound = (spec.unbound_branches ?? []).map((entry) => entry.branch);
  const resolution = resolutionFor(spec.decision_id);
  if (resolution === null) {
    if (spec.decision_id === null || names.length === 0) return { branch: composition, source: "single", selected_branch: null, selected_bound: null, resolution: null };
    return { branch: names[0], source: "first_listed", selected_branch: null, selected_bound: null, resolution: null };
  }
  const selected = resolution.selected_branch;
  // Finding 5: a conditional selection has no single default. The branch the
  // superseded revision selected runs where it is bound (the first bound
  // branch otherwise), the source says the default is conditional, and the
  // case-level selection is conditionalSelection()'s — wired in by the
  // comparison as the schedule facts become available.
  if (selected === CONDITIONAL_ON_SCHEDULE) {
    if (composition !== null && options.composition_branches === undefined) {
      return { branch: composition, source: "composition_member", selected_branch: selected, selected_bound: null, resolution };
    }
    const bound = names.filter((name) => !unbound.includes(name));
    if (bound.length === 0) throw new Error(`RESOLUTION_NO_BOUND_BRANCH:${spec.decision_id}`);
    const fallback = resolution.fallback_branch !== undefined && bound.includes(resolution.fallback_branch) ? resolution.fallback_branch : bound[0];
    return { branch: fallback, source: "conditional_on_schedule", selected_branch: selected, selected_bound: false, resolution };
  }
  if (names.includes(selected)) return { branch: selected, source: "owner_recorded_resolution", selected_branch: selected, selected_bound: true, resolution };
  // L12-2: a composition member asked on its own (no sibling list) reports its
  // own branch; whether the selected branch is bound is its siblings' business.
  if (composition !== null && options.composition_branches === undefined && !unbound.includes(selected)) {
    return { branch: composition, source: "composition_member", selected_branch: selected, selected_bound: null, resolution };
  }
  if (unbound.includes(selected)) {
    if (names.length === 0) throw new Error(`RESOLUTION_NO_BOUND_BRANCH:${spec.decision_id}`);
    return { branch: names[0], source: "first_bound_fallback", selected_branch: selected, selected_bound: false, resolution };
  }
  throw new Error(`RESOLUTION_BRANCH_UNKNOWN:${spec.decision_id}:${selected}`);
}

/**
 * L11-4 / D3.3. Branches examined and rejected: named once, with the reason,
 * kept out of the sensitivity table and the shadow, kept as a regression
 * fixture so the computation cannot silently return.
 */
export type RejectedBranch = Readonly<{
  decision_id: string;
  branch: string;
  reason: string;
  retired_in: string;
  regression_guard: string;
  rule_spec_id: string;
}>;

export const REJECTED_BRANCHES: readonly RejectedBranch[] = Object.freeze([
  {
    decision_id: `${DECISION}.rest_day_overtime_composition`,
    branch: "multiplicative",
    reason: "multiplicative — not a separate composition: the fixed contractual premium enters the base of the rest-day and overtime rates under §18 of the Hours of Work and Rest Law (ע\"ע 38313-03-18); the base rule regular_wage_includes_fixed_contractual_premiums carries it",
    retired_in: "run 11 / D3.3, on the lawyer-approved opinion of 5.9.2026 (question 4)",
    regression_guard: "src/engine/legal-quality/working-time-spec.test.ts",
    rule_spec_id: "il.rulespec.working.time.rest.day.overtime.multiplicative",
  },
]);

/**
 * External review #1, finding 6. A base rule the opinion applies without
 * naming as a parameter: the regular wage that the rest-day and overtime
 * rates multiply includes a fixed contractual premium (§18 of the Hours of
 * Work and Rest Law, as read in ע"ע 38313-03-18). It is registered here as a
 * textual rule with its citation; it becomes a bound textual parameter only
 * when the judgment enters the corpus through the controlled path — which
 * refuses the hosts that carry it (court and law-firm sites are not
 * allowlisted; see controlled-import-security.test.ts, finding 9). Until
 * then the rule is named, cited and unbound, and the report says so.
 */
export type BaseRule = Readonly<{
  rule_id: string;
  decision_id: string;
  statement_he: string;
  statement_en: string;
  citation: Readonly<{ law: string; section: string; judgment: string; judgment_in_corpus: false }>;
  parameter_kind: "textual";
  parameter_version_id: string | null;
  binding_status: "unbound_source_not_acquirable_through_controlled_path";
}>;

export const BASE_RULES: readonly BaseRule[] = Object.freeze([
  {
    rule_id: "regular_wage_includes_fixed_contractual_premiums",
    decision_id: `${DECISION}.rest_day_overtime_composition`,
    statement_he: "השכר הרגיל שממנו נגזרים תעריפי המנוחה השבועית והשעות הנוספות כולל תוספת חוזית קבועה (סעיף 18 לחוק שעות עבודה ומנוחה; ע\"ע 38313-03-18).",
    statement_en: "The regular wage from which the rest-day and overtime rates are derived includes a fixed contractual premium (§18 of the Hours of Work and Rest Law; ע\"ע 38313-03-18).",
    citation: { law: "חוק שעות עבודה ומנוחה, התשי\"א-1951", section: "18", judgment: "ע\"ע 38313-03-18", judgment_in_corpus: false },
    parameter_kind: "textual",
    parameter_version_id: null,
    binding_status: "unbound_source_not_acquirable_through_controlled_path",
  },
]);

