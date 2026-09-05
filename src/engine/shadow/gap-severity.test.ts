import { describe, expect, it } from "vitest";
import { SENSITIVITY_SPECS } from "../legal-quality/sensitivity-rulespecs.ts";
import {
  classifyGapFromDeltas,
  GAP_SEVERITY_CLASSES,
  GAP_SEVERITY_DECISIONS,
  GAP_SEVERITY_DIMENSIONS_NOT_COMPUTED,
  GAP_SEVERITY_SENTENCE_HE,
  gapSeverityDecision,
} from "./gap-severity.ts";

describe("L11-3 / D3.2: gap severity is a class on the finding, never a suppression", () => {
  it("below both figures is a statutory violation", () => {
    expect(classifyGapFromDeltas({ statutory_delta: "500", order_delta: "900", order_bound: true }))
      .toEqual({ class: "statutory_violation", gap_under: ["statute", "order"], statutory_delta: "500", order_delta: "900" });
  });

  it("between the statutory figure and the order figure is an order entitlement — under one reading only, whichever it is", () => {
    // Hourly wage: ÷182 pays more than ÷186, so a payment at the statute is short under the order alone.
    expect(classifyGapFromDeltas({ statutory_delta: "0", order_delta: "400", order_bound: true }))
      .toMatchObject({ class: "order_entitlement", gap_under: ["order"] });
    // Daily threshold: 8 hours yields more overtime than 8.6, so the same interval is short under the statute alone.
    expect(classifyGapFromDeltas({ statutory_delta: "300", order_delta: "-100", order_bound: true }))
      .toMatchObject({ class: "order_entitlement", gap_under: ["statute"] });
  });

  it("meeting both entitlements is no gap; a gap is never hidden by the class", () => {
    expect(classifyGapFromDeltas({ statutory_delta: "0", order_delta: "-250", order_bound: true })).toMatchObject({ class: "no_gap", gap_under: [] });
    expect(classifyGapFromDeltas({ statutory_delta: "-1", order_delta: "-1", order_bound: true })).toMatchObject({ class: "no_gap" });
  });

  it("an unbound order figure states only the statutory side", () => {
    expect(classifyGapFromDeltas({ statutory_delta: "700", order_delta: null, order_bound: false }))
      .toEqual({ class: "order_figure_unbound", gap_under: ["statute"], statutory_delta: "700", order_delta: null });
    expect(classifyGapFromDeltas({ statutory_delta: "-700", order_delta: null, order_bound: false })).toMatchObject({ class: "order_figure_unbound", gap_under: [] });
  });

  it("a branch that did not run is not comparable", () => {
    expect(classifyGapFromDeltas({ statutory_delta: null, order_delta: "5", order_bound: true })).toMatchObject({ class: "not_comparable" });
    expect(GAP_SEVERITY_CLASSES).toContain("not_comparable");
  });

  it("names the two decisions it applies to with branches the sensitivity set knows, and the weekly dimension as not computed", () => {
    expect(GAP_SEVERITY_DECISIONS.map((entry) => entry.decision_id.replace(/^.*decision\./u, ""))).toEqual(["min_wage_hourly_divisor", "working_time_daily_threshold"]);
    for (const entry of GAP_SEVERITY_DECISIONS) {
      const specs = SENSITIVITY_SPECS.filter((spec) => spec.decision_id === entry.decision_id);
      const known = new Set(specs.flatMap((spec) => [...spec.branches.map(([branch]) => branch), ...(spec.unbound_branches ?? []).map((unbound) => unbound.branch)]));
      expect(known.has(entry.statutory_branch), entry.statutory_branch).toBe(true);
      expect(known.has(entry.order_branch), entry.order_branch).toBe(true);
      expect(gapSeverityDecision(entry.decision_id)).toBe(entry);
    }
    expect(gapSeverityDecision("legal.reference.il.decision.pension_wage_cap_section")).toBeNull();
    expect(GAP_SEVERITY_DIMENSIONS_NOT_COMPUTED.map((entry) => entry.dimension)).toEqual(["weekly overtime threshold"]);
    expect(GAP_SEVERITY_SENTENCE_HE).toContain("הפרה סטטוטורית");
    expect(GAP_SEVERITY_SENTENCE_HE).toContain("זכות מכוח צו הרחבה");
  });
});
