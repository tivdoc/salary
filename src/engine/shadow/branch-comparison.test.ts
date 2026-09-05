// L7-7. A run per branch of every open decision, a deterministic diff per
// case, and no automatic acceptance anywhere.
import { describe, expect, it } from "vitest";
import { compareBranches } from "./branch-comparison.ts";
import { classifyGapFromDeltas } from "./gap-severity.ts";
import { runDraftShadow, type BoundDraftParameter } from "./draft-shadow-run.ts";
import { DRAFT_SHADOW_SPECS } from "./draft-shadow-specs.ts";
import { TEST_PARAMETER_VALUES } from "./test-support.ts";

/** Branch-aware test bindings: the decision's branch picks a different draft figure so the branches can differ. */
const BRANCH_VALUES: Readonly<Record<string, BoundDraftParameter["value"]>> = Object.freeze({
  "parameter.hourly.floor@186": { kind: "money", currency: "ILS", minor_units: 3_394 },
  "parameter.wage.cap@section2": { kind: "money", currency: "ILS", minor_units: 1_000_000 },
  "parameter.employee.share@order_2011_2014_row": { kind: "rational", numerator: "11", denominator: "200", unit: "ratio" },
});

const bindings = (spec: (typeof DRAFT_SHADOW_SPECS)[number], branch: string | null): readonly BoundDraftParameter[] =>
  spec.spec.parameters.map((declaration) => ({
    ref_id: declaration.ref_id,
    parameter_version_id: `${declaration.parameter_id}@${spec.branches.find(([name]) => name === branch)?.[1] ?? declaration.parameter_version}`,
    state: "draft",
    value: BRANCH_VALUES[`${declaration.ref_id}@${branch}`] ?? TEST_PARAMETER_VALUES[declaration.ref_id],
    provenance_grade: "text_verified",
  }));

describe("the branch comparison", () => {
  const run = runDraftShadow({ run_id: "shadow.run.compare", bindings, branch_policy: "all" });
  const comparison = compareBranches(run.executions);

  it("covers every open decision the specs carry, with both branches of each", () => {
    expect(comparison.map((entry) => [entry.decision_id.replace(/^legal\.reference\.il\.decision\./u, ""), entry.branches])).toEqual([
      ["convalescence_2026_rate_period", ["calendar_year_2026", "from_signature_2026_07", "havraa_year"]],
      ["min_wage_hourly_divisor", ["182", "186"]],
      ["pension_2011_2016_precedence", ["order_2011_2014_row", "order_2016_2017_rates"]],
      ["pension_wage_cap_section", ["section1", "section2"]],
      ["rest_day_overtime_composition", ["additive"]],
      ["working_time_daily_threshold", ["administrative", "statute"]],
    ]);
  });

  it("a composition decision compares its two specs over one month, and the pension decision compares each of its three specs", () => {
    // L8-3 regression (caught on DEV): keying rows by spec and month made the
    // composition decision's two specs two rows with one branch each — 0/0.
    const composition = comparison.find((entry) => entry.decision_id.endsWith("rest_day_overtime_composition"))!;
    // L11-4 / D3.3: the multiplicative reading is retired; one branch, still keyed by the month.
    expect(composition.branches).toEqual(["additive"]);
    expect(composition.cases_compared).toBe(5);
    expect(composition.cases.filter((entry) => entry.comparable).every((entry) => entry.shadow_id === null && entry.by_branch.map((row) => row.shadow_id).sort().join(",") === "working.time.rest.day.overtime.additive")).toBe(true);
    const pension = comparison.find((entry) => entry.decision_id.endsWith("pension_2011_2016_precedence"))!;
    expect(new Set(pension.cases.map((entry) => entry.shadow_id))).toEqual(new Set(["pension.employee.contribution.on.wage", "pension.employer.contribution.on.wage", "pension.severance.contribution.on.wage"]));
    expect(pension.cases_compared).toBe(15);
  });

  it("L12-2 / D2: the daily threshold runs both bound computations, names the nine-hour reading as unbound, and separates the branches wherever the day exceeds eight hours", () => {
    const threshold = comparison.find((entry) => entry.decision_id.endsWith("working_time_daily_threshold"))!;
    expect(threshold.branches).toEqual(["administrative", "statute"]);
    expect(threshold.unbound_branches).toEqual([expect.objectContaining({ branch: "nine_hour_day", reason: expect.stringContaining("V12") })]);
    expect(threshold.cases_differing).toBeGreaterThan(0);
    expect(threshold.cases.filter((entry) => entry.comparable).every((entry) => entry.by_branch.length === 2)).toBe(true);
  });

  it("states a difference per case, exact and in the output's unit, and never accepts a branch", () => {
    for (const decision of comparison) {
      expect(decision.human_review_required).toBe(true);
      expect(decision.automatic_acceptance).toBe(false);
      expect(decision.cases_compared + decision.cases_not_comparable).toBe(decision.cases.length);
      for (const entry of decision.cases) {
        expect(entry.by_branch.map((row) => row.branch)).toEqual(decision.branches);
        if (entry.comparable) expect(entry.difference).toMatchObject({ amount: expect.stringMatching(/^\d+$/u) });
        else expect(entry.difference).toBeNull();
      }
    }
    const wage = comparison.find((entry) => entry.decision_id.endsWith("min_wage_hourly_divisor"))!;
    const current = wage.cases.find((entry) => entry.case_id === "synthetic.minimum_wage.golden.current")!;
    // 182 h × (34.68 − 33.94) = 134.68
    expect(current).toMatchObject({ comparable: true, differs: true, difference: { amount: "13468", unit: "ILS", kind: "money" } });
    expect(current.by_branch.map((row) => row.delta)).toEqual(["-8824", "-22292"]);
  });

  it("a case that refuses under a branch is shown as not comparable, with the refusal named", () => {
    const wage = comparison.find((entry) => entry.decision_id.endsWith("min_wage_hourly_divisor"))!;
    const refused = wage.cases.find((entry) => entry.case_id === "synthetic.minimum_wage.golden.missing_conflicted_facts")!;
    expect(refused).toMatchObject({ ran: false, comparable: false, differs: false, difference: null });
    expect(refused.by_branch.every((row) => row.refusal === "fact.conflicted")).toBe(true);
  });

  it("a decision whose branches carry the same figure differs nowhere, and says so by numbers", () => {
    const convalescence = comparison.find((entry) => entry.decision_id.endsWith("convalescence_2026_rate_period"))!;
    expect(convalescence.cases_differing).toBe(0);
    expect(convalescence.cases_compared).toBeGreaterThan(0);
  });

  it("L11-2 / D2: names the default branch on every decision and each branch's difference from it", () => {
    const cap = comparison.find((entry) => entry.decision_id.endsWith("pension_wage_cap_section"))!;
    expect(cap).toMatchObject({ default_branch: "section2", default_branch_source: "owner_recorded_resolution", selected_branch: "section2", selected_branch_bound: true, resolution_status: "owner_recorded" });
    for (const entry of cap.cases.filter((row) => row.comparable)) {
      const defaultRow = entry.by_branch.find((row) => row.is_default)!;
      expect(defaultRow.branch).toBe("section2");
      expect(defaultRow.difference_from_default).toEqual({ amount: "0", unit: "ILS" });
      expect(entry.by_branch.filter((row) => !row.is_default).every((row) => row.difference_from_default !== null)).toBe(true);
    }
    const threshold = comparison.find((entry) => entry.decision_id.endsWith("working_time_daily_threshold"))!;
    // External review #1, finding 5: the resolution is conditional on the schedule; the superseded selection (administrative) runs as the default until the case facts are wired in, and the source says so.
    expect(threshold).toMatchObject({ default_branch: "administrative", default_branch_source: "conditional_on_schedule", selected_branch: "conditional_on_schedule", selected_branch_bound: false });
    const composition = comparison.find((entry) => entry.decision_id.endsWith("rest_day_overtime_composition"))!;
    expect(composition.default_branch).toBe("additive");
  });

  it("L11-3 / D3.2: classes every hourly-wage case by its two deltas, and states the daily threshold's order figure as unbound", () => {
    const wage = comparison.find((entry) => entry.decision_id.endsWith("min_wage_hourly_divisor"))!;
    expect(wage.gap_severity).toMatchObject({ statutory_branch: "186", order_branch: "182" });
    for (const entry of wage.cases) {
      const statutory = entry.by_branch.find((row) => row.branch === "186")?.delta ?? null;
      const order = entry.by_branch.find((row) => row.branch === "182")?.delta ?? null;
      expect(entry.gap_severity).toMatchObject(classifyGapFromDeltas({ statutory_delta: statutory, order_delta: order, order_bound: true }));
      expect(entry.gap_severity?.default_branch).toBe("182");
      expect(entry.gap_severity?.class).not.toBe("order_figure_unbound");
    }
    expect(Object.values(wage.gap_severity!.counts).reduce((a, b) => a + b, 0)).toBe(wage.cases.length);
    // L12-2 / D2: the order figure is bound now. A month paid for the statute's
    // eight-hour day but short under nothing else is order_entitlement in the
    // statute's view and no gap in the default view — never statutory_violation.
    const threshold = comparison.find((entry) => entry.decision_id.endsWith("working_time_daily_threshold"))!;
    expect(threshold.cases.every((entry) => entry.gap_severity?.class !== "order_figure_unbound")).toBe(true);
    const current = threshold.cases.find((entry) => entry.case_id === "synthetic.working_time.golden.current")!;
    expect(current.gap_severity).toMatchObject({ class: "order_entitlement", gap_under: ["statute"], default_branch: "administrative", gap_under_default: false });
    expect(current.gap_severity?.class).not.toBe("statutory_violation");
    const cap = comparison.find((entry) => entry.decision_id.endsWith("pension_wage_cap_section"))!;
    expect(cap.gap_severity).toBeNull();
    expect(cap.cases.every((entry) => entry.gap_severity === null)).toBe(true);
  });

  it("L11-4 / D3.4: the havraa_year branch refuses a 2027 month as rate_not_published and tags a June 2026 shortfall as retroactive", () => {
    const convalescence = comparison.find((entry) => entry.decision_id.endsWith("convalescence_2026_rate_period"))!;
    expect(convalescence.default_branch).toBe("havraa_year");
    const unpublished = convalescence.cases.find((entry) => entry.case_id === "synthetic.convalescence.edge.havraa_year_2027_rate_not_published")!;
    expect(unpublished.comparable).toBe(false);
    expect(unpublished.by_branch.find((row) => row.branch === "havraa_year")).toMatchObject({ status: "preparation_refused", refusal: "rate_not_published" });
    expect(unpublished.by_branch.filter((row) => row.branch !== "havraa_year").every((row) => row.status === "ran")).toBe(true);
    const previous = convalescence.cases.find((entry) => entry.case_id === "synthetic.convalescence.edge.paid_at_previous_rate")!;
    const tagged = previous.by_branch.find((row) => row.branch === "havraa_year")!;
    expect(tagged).toMatchObject({ status: "ran", delta: "20100", retroactive_tag: "retroactive_update_2026-08-18", period: { start: "2026-06-01", end: "2026-06-30" } });
    expect(previous.by_branch.filter((row) => row.branch !== "havraa_year").every((row) => row.retroactive_tag === null)).toBe(true);
  });

  it("is deterministic in execution order", () => {
    const reversed = compareBranches([...run.executions].reverse());
    expect(reversed).toEqual(comparison);
  });
});
