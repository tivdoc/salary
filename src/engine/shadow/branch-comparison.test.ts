// L7-7. A run per branch of every open decision, a deterministic diff per
// case, and no automatic acceptance anywhere.
import { describe, expect, it } from "vitest";
import { compareBranches } from "./branch-comparison.ts";
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
      ["convalescence_2026_rate_period", ["calendar_year_2026", "from_signature_2026_07"]],
      ["min_wage_hourly_divisor", ["182", "186"]],
      ["pension_2011_2016_precedence", ["order_2011_2014_row", "order_2016_2017_rates"]],
      ["pension_wage_cap_section", ["section1", "section2"]],
      ["rest_day_overtime_composition", ["additive", "multiplicative"]],
      ["working_time_daily_threshold", ["statute"]],
    ]);
  });

  it("a decision with an unbound branch names it, with its reason, and runs only the bound one", () => {
    const threshold = comparison.find((entry) => entry.decision_id.endsWith("working_time_daily_threshold"))!;
    expect(threshold.branches).toEqual(["statute"]);
    expect(threshold.unbound_branches).toEqual([expect.objectContaining({ branch: "administrative", reason: expect.stringContaining("BL-24") })]);
    expect(threshold.cases_differing).toBe(0);
    expect(threshold.cases.every((entry) => entry.by_branch.length === 1)).toBe(true);
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

  it("is deterministic in execution order", () => {
    const reversed = compareBranches([...run.executions].reverse());
    expect(reversed).toEqual(comparison);
  });
});
