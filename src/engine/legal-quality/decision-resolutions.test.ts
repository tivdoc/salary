import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { APPROVAL_RECORD_SHA256, LEGAL_OPINION_SHA256 } from "../legal-knowledge/owner-evidence.ts";
import { DRAFT_SHADOW_SPECS } from "../shadow/draft-shadow-specs.ts";
import { branchesOf } from "../shadow/draft-shadow-run.ts";
import {
  defaultBranchOf,
  OWNER_RECORDED_RESOLUTIONS,
  BASE_RULES,
  CONDITIONAL_ON_SCHEDULE,
  ERRATA_EXTERNAL_REVIEW_1_SHA256,
  EXTERNAL_REVIEW_1_INSTRUCTION_SHA256,
  RESOLUTION_HISTORY,
  conditionalSelection,
  REJECTED_BRANCHES,
  resolutionFor,
  resolutionSha256,
  RESOLUTION_STATUS_OWNER_RECORDED,
} from "./decision-resolutions.ts";
import { SENSITIVITY_SPECS } from "./sensitivity-rulespecs.ts";

const decisionIds = [...new Set(SENSITIVITY_SPECS.map((entry) => entry.decision_id).filter((id): id is string => id !== null))];

describe("L11-2 / D2: six owner-recorded resolutions, each a default and nothing more", () => {
  it("names six of the sensitivity set's decisions once each; the seventh (L11-4 / D3.5, rest_day_daily_threshold) is open and unresolved", () => {
    expect(OWNER_RECORDED_RESOLUTIONS).toHaveLength(6);
    expect(new Set(OWNER_RECORDED_RESOLUTIONS.map((entry) => entry.decision_id)).size).toBe(6);
    expect(new Set(OWNER_RECORDED_RESOLUTIONS.map((entry) => entry.decision_key)).size).toBe(6);
    const resolved = new Set(OWNER_RECORDED_RESOLUTIONS.map((entry) => entry.decision_id));
    for (const id of resolved) expect(decisionIds).toContain(id);
    expect(decisionIds.filter((id) => !resolved.has(id))).toEqual(["legal.reference.il.decision.rest_day_daily_threshold"]);
    expect(resolutionFor("legal.reference.il.decision.rest_day_daily_threshold")).toBeNull();
  });

  it("lists the retired multiplicative branch once, with its reason, its regression guard and no place in the sensitivity set", () => {
    expect(REJECTED_BRANCHES).toEqual([expect.objectContaining({ decision_id: "legal.reference.il.decision.rest_day_overtime_composition", branch: "multiplicative", reason: "multiplicative — not a separate composition: the fixed contractual premium enters the base of the rest-day and overtime rates under §18 of the Hours of Work and Rest Law (ע\"ע 38313-03-18); the base rule regular_wage_includes_fixed_contractual_premiums carries it" })]);
    expect(SENSITIVITY_SPECS.some((entry) => entry.composition_branch === "multiplicative")).toBe(false);
    expect(SENSITIVITY_SPECS.filter((entry) => entry.decision_id?.endsWith("rest_day_overtime_composition")).map((entry) => entry.composition_branch)).toEqual(["additive"]);
  });

  it("selects a branch the decision's specs know — bound, composition, or named unbound — never one they do not", () => {
    for (const resolution of OWNER_RECORDED_RESOLUTIONS) {
      const entries = SENSITIVITY_SPECS.filter((entry) => entry.decision_id === resolution.decision_id);
      const known = new Set(entries.flatMap((entry) => [
        ...entry.branches.map(([branch]) => branch),
        ...(entry.composition_branch ? [entry.composition_branch] : []),
        ...(entry.unbound_branches ?? []).map((entry) => entry.branch),
      ]));
      // Finding 5: a conditional selection names no branch itself; its fallback must be one the specs know.
      const named = resolution.selected_branch === CONDITIONAL_ON_SCHEDULE ? resolution.fallback_branch ?? "" : resolution.selected_branch;
      expect(known.has(named), `${resolution.decision_key} → ${named}`).toBe(true);
    }
  });

  it("rests on the stored evidence by hash, is owner_recorded, and carries no approver", () => {
    for (const resolution of OWNER_RECORDED_RESOLUTIONS) {
      if ((resolution.revision ?? 1) > 1) {
        // Finding 5: a re-recorded revision rests on the errata appendix and the owner's instruction, and names its lineage.
        expect(resolution.basis).toBe("external_review_correction");
        expect(resolution.evidence_sha256).toBe(ERRATA_EXTERNAL_REVIEW_1_SHA256);
        expect(resolution.approval_record_sha256).toBe(EXTERNAL_REVIEW_1_INSTRUCTION_SHA256);
        expect(resolution.supersedes_revision).toBe((resolution.revision ?? 1) - 1);
        expect(resolution.supersession_basis).toBe("superseded_by_external_review_2026-09-05");
      } else {
        expect(resolution.basis).toBe("lawyer_approved_opinion");
        expect(resolution.evidence_sha256).toBe(LEGAL_OPINION_SHA256);
        expect(resolution.approval_record_sha256).toBe(APPROVAL_RECORD_SHA256);
      }
      expect(resolution.approved_on).toBe("2026-09-05");
      expect(resolution.status).toBe(RESOLUTION_STATUS_OWNER_RECORDED);
      expect(resolution.approver_identity).toBeNull();
      expect(resolution.recorded_by).toBe("owner_action");
      expect(resolution.mapping_note.length).toBeGreaterThan(40);
      expect(resolutionSha256(resolution)).toMatch(/^[a-f0-9]{64}$/u);
    }
  });

  it("the module cannot produce the status attested: the word appears in prose only, never as a value", () => {
    const source = readFileSync(path.join(process.cwd(), "src", "engine", "legal-quality", "decision-resolutions.ts"), "utf8");
    const code = source.split("\n").filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*")).join("\n");
    expect(code).not.toMatch(/["'`]attested["'`]/u);
    expect(OWNER_RECORDED_RESOLUTIONS.every((entry) => entry.status === "owner_recorded")).toBe(true);
  });

  it("records the brief's mapping where the opinion's name differs from the register's", () => {
    const byKey = Object.fromEntries(OWNER_RECORDED_RESOLUTIONS.map((entry) => [entry.decision_key, entry]));
    expect(byKey.hourly_wage_divisor.decision_id).toBe("legal.reference.il.decision.min_wage_hourly_divisor");
    expect(byKey.hourly_wage_divisor.selected_branch).toBe("182");
    expect(byKey.hourly_wage_divisor.opinion_branch_label).toBe("order_182");
    expect(byKey.pension_wage_cap_source.selected_branch).toBe("section2");
    expect(byKey.pension_2011_2016_precedence.selected_branch).toBe("order_2016_2017_rates");
    expect(byKey.rest_day_overtime_composition.selected_branch).toBe("additive");
    expect(byKey.convalescence_rate_period.decision_id).toBe("legal.reference.il.decision.convalescence_2026_rate_period");
    expect(byKey.convalescence_rate_period.selected_branch).toBe("havraa_year");
    expect(byKey.working_time_daily_threshold.selected_branch).toBe("conditional_on_schedule");
    expect(byKey.working_time_daily_threshold.revision).toBe(2);
    expect(byKey.working_time_daily_threshold.fallback_branch).toBe("administrative");
  });
});

describe("L11-2 / D2: the default branch — the one thing a resolution changes", () => {
  it("moves the default to the selected branch when it is bound, and keeps every branch listed", () => {
    const cap = SENSITIVITY_SPECS.find((entry) => entry.decision_id?.endsWith("pension_wage_cap_section"))!;
    const chosen = defaultBranchOf(cap);
    expect(chosen).toMatchObject({ branch: "section2", source: "owner_recorded_resolution", selected_branch: "section2", selected_bound: true });
    expect(cap.branches.map(([branch]) => branch)).toEqual(["section1", "section2"]);
  });

  it("keeps the first listed branch as default where the resolution selects it", () => {
    const hourly = SENSITIVITY_SPECS.find((entry) => entry.decision_id?.endsWith("min_wage_hourly_divisor"))!;
    expect(defaultBranchOf(hourly)).toMatchObject({ branch: "182", source: "owner_recorded_resolution", selected_bound: true });
  });

  it("L12-2 / D2: the daily threshold's selected branch is bound and executes as the default; a composition member asked alone reports its own branch", () => {
    const entries = SENSITIVITY_SPECS.filter((entry) => entry.decision_id?.endsWith("working_time_daily_threshold"));
    const siblings = entries.map((entry) => entry.composition_branch).filter((name): name is string => typeof name === "string");
    expect(siblings).toEqual(["statute", "administrative"]);
    expect(defaultBranchOf(entries[0], { composition_branches: siblings })).toMatchObject({ branch: "administrative", source: "conditional_on_schedule", selected_branch: "conditional_on_schedule", selected_bound: false });
    expect(defaultBranchOf(entries[0])).toMatchObject({ branch: "statute", source: "composition_member", selected_branch: "conditional_on_schedule", selected_bound: null });
    expect(defaultBranchOf(entries[1])).toMatchObject({ branch: "administrative", source: "composition_member", selected_branch: "conditional_on_schedule", selected_bound: null });
  });

  it("runs the first bound branch and says so when the selected branch is named but unbound", () => {
    const shape = { decision_id: "legal.reference.il.decision.working_time_daily_threshold", branches: [["statute", "1951.1.0"]] as ReadonlyArray<readonly [string, string]>, unbound_branches: [{ branch: "administrative", reason: "a shape for the test: the branch named and not bound" }] };
    expect(defaultBranchOf(shape)).toMatchObject({ branch: "statute", source: "conditional_on_schedule", selected_branch: "conditional_on_schedule", selected_bound: false });
  });

  it("falls back to the first listed branch only where no resolution exists, and to nothing where there is no decision", () => {
    expect(defaultBranchOf({ decision_id: "legal.reference.il.decision.nothing_recorded", branches: [["a", "1.0.0"], ["b", "2.0.0"]] }))
      .toMatchObject({ branch: "a", source: "first_listed", resolution: null });
    expect(defaultBranchOf({ decision_id: null, branches: [] })).toMatchObject({ branch: null, source: "single" });
  });

  it("refuses a resolution whose branch the spec does not know at all", () => {
    const hourly = SENSITIVITY_SPECS.find((entry) => entry.decision_id?.endsWith("min_wage_hourly_divisor"))!;
    expect(() => defaultBranchOf({ ...hourly, branches: [["999", "9.9.9"]] })).toThrow(/RESOLUTION_BRANCH_UNKNOWN/u);
  });

  it("the shadow's primary policy runs the default branch, and its all policy still runs every branch", () => {
    for (const spec of DRAFT_SHADOW_SPECS) {
      const all = branchesOf(spec, "all");
      const primary = branchesOf(spec, "primary");
      expect(primary).toHaveLength(1);
      expect(all).toContain(primary[0]);
      if (spec.decision_id !== null && spec.branches.length > 0) {
        expect(primary[0]).toBe(defaultBranchOf(spec).branch);
        expect(all).toEqual(spec.branches.map(([branch]) => branch));
      }
    }
    const cap = DRAFT_SHADOW_SPECS.find((spec) => spec.decision_id?.endsWith("pension_wage_cap_section"))!;
    expect(branchesOf(cap, "primary")).toEqual(["section2"]);
    expect(resolutionFor(cap.decision_id)?.selected_branch).toBe("section2");
  });
  // External review #1, finding 6: the base rule under Q4, named and cited, unbound until its judgment is in the corpus.
  it("registers the §18 base rule as a textual rule with its citation, unbound while the judgment is outside the corpus", () => {
    expect(BASE_RULES).toHaveLength(1);
    const rule = BASE_RULES[0]!;
    expect(rule.rule_id).toBe("regular_wage_includes_fixed_contractual_premiums");
    expect(rule.decision_id).toBe("legal.reference.il.decision.rest_day_overtime_composition");
    expect(rule.citation).toEqual({ law: expect.stringContaining("שעות עבודה ומנוחה"), section: "18", judgment: "ע\"ע 38313-03-18", judgment_in_corpus: false });
    expect(rule.parameter_kind).toBe("textual");
    expect(rule.parameter_version_id).toBeNull();
    expect(rule.binding_status).toBe("unbound_source_not_acquirable_through_controlled_path");
    // The rejected multiplicative branch names the same rule as the reason it is not a separate composition.
    expect(REJECTED_BRANCHES[0]!.reason).toContain(rule.rule_id);
    expect(REJECTED_BRANCHES[0]!.reason).toContain("§18");
  });
});

describe("external review #1, finding 5: the daily threshold re-recorded as conditional on the schedule, append-only", () => {
  it("keeps revision 1 in history exactly as recorded — same selection, same hash fields, never edited", () => {
    expect(RESOLUTION_HISTORY).toHaveLength(1);
    const first = RESOLUTION_HISTORY[0]!;
    expect(first).toMatchObject({ decision_key: "working_time_daily_threshold", selected_branch: "administrative", revision: 1, basis: "lawyer_approved_opinion" });
    expect(first.supersedes_revision).toBeUndefined();
    // Its hash is the one the database stored on 5.9.2026: the lineage fields do not enter a first revision's hash.
    expect(resolutionSha256(first)).toBe(resolutionSha256({ ...first, revision: undefined }));
  });

  it("hashes a re-recorded revision with its lineage, so two revisions can never share a hash", () => {
    const latest = OWNER_RECORDED_RESOLUTIONS.find((entry) => entry.decision_key === "working_time_daily_threshold")!;
    expect(resolutionSha256(latest)).not.toBe(resolutionSha256(RESOLUTION_HISTORY[0]!));
    expect(resolutionSha256(latest)).not.toBe(resolutionSha256({ ...latest, supersession_basis: "something_else" }));
    expect(latest.evidence_sha256).toBe(ERRATA_EXTERNAL_REVIEW_1_SHA256);
    expect(latest.approval_record_sha256).toBe(EXTERNAL_REVIEW_1_INSTRUCTION_SHA256);
    expect(latest.approval_record_sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("selects by the schedule facts: 8 for a six-day week, 8.6-7.6 for a five-day week, a refusal for the nine-hour pattern and for missing or unknown facts", () => {
    expect(conditionalSelection({ days_per_week: 6, regular_day_hours: 8 })).toEqual({ branch: "statute", pattern: "8", refusal: null });
    expect(conditionalSelection({ days_per_week: 5, regular_day_hours: 8.6 })).toEqual({ branch: "administrative", pattern: "8.6-7.6", refusal: null });
    expect(conditionalSelection({ days_per_week: 5, regular_day_hours: 9 })).toEqual({ branch: null, pattern: "9", refusal: "branch_not_registered:9" });
    expect(conditionalSelection({ days_per_week: null, regular_day_hours: 8 })).toEqual({ branch: null, pattern: null, refusal: "schedule_facts_missing" });
    expect(conditionalSelection({ days_per_week: 4, regular_day_hours: 10 })).toEqual({ branch: null, pattern: null, refusal: "schedule_pattern_unknown:4d/10h" });
    expect(CONDITIONAL_ON_SCHEDULE).toBe("conditional_on_schedule");
  });
});
