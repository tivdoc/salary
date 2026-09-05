// L7-5 / D4. The delta: entitlement − paid, exact, signed, in the output's
// unit — and never a Finding.
import { describe, expect, it } from "vitest";
import { findingSchema } from "../findings/contracts.ts";
import { executeRuleSpecAtomic } from "../legal-operations/rulespec.ts";
import { prepareRuleInputs } from "../rule-input/preparation.ts";
import { createCanonicalRuleInputSnapshot } from "../rule-input/snapshot.ts";
import { DRAFT_SHADOW_SPECS } from "./draft-shadow-specs.ts";
import { bridgePreparedInputs } from "./prepared-input-bridge.ts";
import { SYNTHETIC_CORPUS, syntheticCase } from "./synthetic-corpus.ts";
import {
  DELTA_SIGN_CONVENTION,
  PAID_COMPONENTS,
  PAID_COMPONENT_BINDINGS,
  computeSyntheticDelta,
  paidComponentBinding,
  syntheticShadowDeltaSchema,
  type SyntheticShadowDelta,
} from "./synthetic-delta.ts";
import { SYNTHETIC_PREPARED_AT } from "./synthetic-payslip-month.ts";
import { testParametersFor } from "./test-support.ts";

function deltaFor(caseId: string, shadowId: string): SyntheticShadowDelta {
  const entry = syntheticCase(caseId);
  const spec = DRAFT_SHADOW_SPECS.find((candidate) => candidate.shadow_id === shadowId)!;
  const snapshot = createCanonicalRuleInputSnapshot(entry.snapshot);
  const prepared = prepareRuleInputs(snapshot, spec.input_mappings, SYNTHETIC_PREPARED_AT);
  const outcome = executeRuleSpecAtomic({ rule: spec.spec, facts: bridgePreparedInputs(prepared, spec.input_mappings), parameters: testParametersFor(spec) } as never);
  if (!outcome.execution) throw new Error(outcome.error_code ?? "no execution");
  const binding = paidComponentBinding(shadowId);
  const paid = binding ? prepareRuleInputs(snapshot, binding.registry, SYNTHETIC_PREPARED_AT) : prepareRuleInputs(snapshot, spec.input_mappings, SYNTHETIC_PREPARED_AT);
  return computeSyntheticDelta({ shadow_id: shadowId, spec: spec.spec, entitlement: outcome.execution.output as never, paid });
}

describe("paid components", () => {
  it("every shadow spec declares its paid component or the reason it has none", () => {
    expect(Object.keys(PAID_COMPONENTS).sort()).toEqual(DRAFT_SHADOW_SPECS.map((entry) => entry.shadow_id).sort());
    expect(PAID_COMPONENT_BINDINGS.map((entry) => entry.shadow_id)).toEqual([
      "minimum.wage.hourly.entitlement",
      "working.time.overtime.pay",
      "working.time.overtime.from.hours.worked",
      "working.time.overtime.five.day.norm",
      "working.time.rest.day.overtime.additive",
      "pension.employee.contribution.on.wage",
      "pension.employer.contribution.on.wage",
      "pension.severance.contribution.on.wage",
      "travel.daily.cap.entitlement",
      "convalescence.pay.by.seniority",
      "vacation.seniority.band.entitlement",
    ]);
    for (const binding of PAID_COMPONENT_BINDINGS) {
      expect(binding.registry.registry.registry_id).toBe(`legal.draft.shadow.paid.${binding.shadow_id}`);
      expect(binding.registry.registry.mappings).toHaveLength(1);
      expect(binding.registry.registry.mappings[0].fact_path).toBe(binding.component.fact_path);
    }
  });
});

describe("the delta", () => {
  it("is entitlement − paid in minor units, positive when the draft computes more than the month paid", () => {
    // 182 h × 34.68 = 6,311.76; paid 6,400.00 → −88.24
    const wage = deltaFor("synthetic.minimum_wage.golden.current", "minimum.wage.hourly.entitlement");
    expect(wage).toMatchObject({ status: "computed", unit: "currency.ILS.minor_units", entitlement: "631176", paid: "640000", delta: "-8824", sign_convention: DELTA_SIGN_CONVENTION, entitlement_rounding: "money.scale:half_up" });
    // 4 overtime hours on 40.00 = 220.00; paid 200.00 → +20.00
    const overtime = deltaFor("synthetic.working_time.golden.current", "working.time.overtime.pay");
    expect(overtime).toMatchObject({ status: "computed", entitlement: "22000", paid: "20000", delta: "2000", paid_fact_path: "compensation.overtime_pay" });
    // Employee share 6% of the capped 13,788 = 827.28; the month paid 20.00 less.
    const pension = deltaFor("synthetic.pension.golden.current", "pension.employee.contribution.on.wage");
    expect(pension).toMatchObject({ status: "computed", entitlement: "82728", paid: "80728", delta: "2000", paid_fact_path: "pension.contributions" });
    // L8-3 / D4. Employer share 6.5% of the capped 13,788 = 896.22; the month paid 65/60 of its short employee figure, 874.55.
    const employer = deltaFor("synthetic.pension.golden.current", "pension.employer.contribution.on.wage");
    expect(employer).toMatchObject({ status: "computed", entitlement: "89622", paid: "87455", delta: "2167", paid_fact_path: "pension.contributions" });
    // Severance 6% of the capped wage = 827.28; the month paid 10.00 less, against its own fact.
    const severance = deltaFor("synthetic.pension.golden.current", "pension.severance.contribution.on.wage");
    expect(severance).toMatchObject({ status: "computed", entitlement: "82728", paid: "81728", delta: "1000", paid_fact_path: "pension.severance_contribution" });
  });

  it("agrees exactly when the month paid the draft's figure — zero, not a rounding residue", () => {
    const travel = deltaFor("synthetic.travel.golden.sector_population", "travel.daily.cap.entitlement");
    expect(travel).toMatchObject({ status: "computed", entitlement: "24860", paid: "24860", delta: "0" });
    const convalescence = deltaFor("synthetic.convalescence.golden.effective_date_boundary", "convalescence.pay.by.seniority");
    expect(convalescence).toMatchObject({ status: "computed", entitlement: "225750", paid: "270900", delta: "-45150" });
  });

  it("is a day count for vacation, in the output's unit", () => {
    const vacation = deltaFor("synthetic.vacation.golden.current", "vacation.seniority.band.entitlement");
    expect(vacation).toMatchObject({ status: "computed", unit: "calendar_days", entitlement: "16", paid: "14", delta: "2", entitlement_rounding: "band.lookup:none" });
  });

  it("does not round again: the entitlement is the spec's rounded output and the subtraction is exact", () => {
    // 1 overtime hour on 33.33 at 1.25 = 41.6625 → half_up 41.66; paid 200.00.
    const rounding = deltaFor("synthetic.working_time.golden.parameter_rounding_boundary", "working.time.overtime.pay");
    expect(rounding).toMatchObject({ status: "computed", entitlement: "4166", paid: "20000", delta: "-15834" });
  });

  it("says why when there is no paid component", () => {
    for (const shadowId of ["pension.wage.cap.on.wage", "convalescence.days.by.seniority", "sick.pay.accrual", "sick.pay.daily.rate"]) {
      const entry = SYNTHETIC_CORPUS.find((candidate) => candidate.family === "golden" && candidate.scenario === "current" && candidate.shadow_ids.includes(shadowId))!;
      const delta = deltaFor(entry.case_id, shadowId);
      expect(delta.status, shadowId).toBe("not_applicable");
      if (delta.status === "not_applicable") expect(delta.reason.length).toBeGreaterThan(10);
    }
  });

  it("refuses the delta when the paid figure is refused, and carries the codes", () => {
    const entry = syntheticCase("synthetic.working_time.golden.current");
    const spec = DRAFT_SHADOW_SPECS.find((candidate) => candidate.shadow_id === "working.time.overtime.pay")!;
    const snapshot = createCanonicalRuleInputSnapshot({ ...entry.snapshot, facts: entry.snapshot.facts.filter((fact) => fact.path !== "compensation.overtime_pay") });
    const prepared = prepareRuleInputs(snapshot, spec.input_mappings, SYNTHETIC_PREPARED_AT);
    const outcome = executeRuleSpecAtomic({ rule: spec.spec, facts: bridgePreparedInputs(prepared, spec.input_mappings), parameters: testParametersFor(spec) } as never);
    const paid = prepareRuleInputs(snapshot, paidComponentBinding("working.time.overtime.pay")!.registry, SYNTHETIC_PREPARED_AT);
    const delta = computeSyntheticDelta({ shadow_id: "working.time.overtime.pay", spec: spec.spec, entitlement: outcome.execution!.output as never, paid });
    expect(delta).toMatchObject({ status: "paid_refused", paid_fact_path: "compensation.overtime_pay", rejection_codes: ["fact.missing"] });
  });
});

describe("classification guard — a delta is not a finding", () => {
  it("every delta says so on its face", () => {
    const delta = deltaFor("synthetic.working_time.golden.current", "working.time.overtime.pay");
    expect(delta.kind).toBe("synthetic_shadow_delta");
    expect(delta.is_finding).toBe(false);
    expect(delta.delivery_allowed).toBe(false);
    expect(syntheticShadowDeltaSchema.safeParse({ ...delta, is_finding: true }).success).toBe(false);
    expect(syntheticShadowDeltaSchema.safeParse({ ...delta, delivery_allowed: true }).success).toBe(false);
  });

  it("the Finding contract rejects a delta, and a delta dressed as a finding", () => {
    const delta = deltaFor("synthetic.working_time.golden.current", "working.time.overtime.pay");
    expect(findingSchema.safeParse(delta).success).toBe(false);
    const dressed = {
      finding_id: "11111111-1111-4111-8111-111111111111",
      case_id: "11111111-1111-4111-8111-111111111111",
      analysis_run_id: "11111111-1111-4111-8111-111111111111",
      category: "working_time",
      period: null,
      paid: { currency: "ILS", minor_units: 20_000 },
      expected: { currency: "ILS", minor_units: 22_000 },
      potential_gap: { currency: "ILS", minor_units: 2_000 },
      confidence: 0.9,
      confidence_tier: "high",
      fact_references: ["11111111-1111-4111-8111-111111111111"],
      evidence_references: [{ source_type: "declared", source_reference: { kind: "questionnaire_response", response_id: "11111111-1111-4111-8111-111111111111" } }],
      rule: { rule_id: "il.rulespec.working.time.overtime.pay", rule_version: "1.0.0" },
      calculation_trace: null,
      requires_confirmation: true,
      created_at: "2026-08-01T00:00:00.000Z",
      ...delta,
      status: "candidate",
    };
    // The strict Finding schema refuses the delta's own keys; stripping them would be a rewrite, not a delta.
    expect(findingSchema.safeParse(dressed).success).toBe(false);
  });

  it("no shadow module is imported by the findings engine or the customer portal", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const path = await import("node:path");
    const roots = ["src/engine/findings", "src/server/product/customer-portal", "src/app/portal"].filter((root) => {
      try { return statSync(root).isDirectory(); } catch { return false; }
    });
    const files: string[] = [];
    const walk = (dir: string) => { for (const name of readdirSync(dir)) { const full = path.join(dir, name); if (statSync(full).isDirectory()) walk(full); else if (/\.(?:ts|tsx|mts)$/u.test(name)) files.push(full); } };
    for (const root of roots) walk(root);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source.includes("engine/shadow/") || source.includes("synthetic_shadow_delta"), file).toBe(false);
    }
  });
});
