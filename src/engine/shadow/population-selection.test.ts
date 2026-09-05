// L8-4 / D5. The population is a fact of the month; a spec whose parameter
// differs by population binds that population's registered figure; the
// record says which; a conflict is refused, not guessed.
import { describe, expect, it } from "vitest";
import { employmentPopulations } from "../facts/contracts.ts";
import { DRAFT_SHADOW_SPECS } from "./draft-shadow-specs.ts";
import { runDraftShadow } from "./draft-shadow-run.ts";
import { POPULATION_ABSENT, POPULATION_PARAMETER_SELECTIONS, parameterSlotsFor, populationOf } from "./population-selection.ts";
import { SYNTHETIC_CORPUS, syntheticCase } from "./synthetic-corpus.ts";
import { testBindings } from "./test-support.ts";

const MINIMUM_WAGE = DRAFT_SHADOW_SPECS.find((entry) => entry.shadow_id === "minimum.wage.hourly.entitlement")!;
const YOUTH = { population: "youth_16_17", source: "fact" } as const;

describe("the population fact", () => {
  it("is one of the populations batch 2 registered figures for; an adult is the general population", () => {
    expect(employmentPopulations).toEqual(["general", "youth_under_16", "youth_16_17", "youth_17_18", "apprentice"]);
  });

  it("is read from the month: declared in every golden month, absent in the edge months (an adult until a fact says otherwise)", () => {
    expect(populationOf(syntheticCase("synthetic.minimum_wage.golden.sector_population").snapshot)).toEqual(YOUTH);
    expect(populationOf(syntheticCase("synthetic.minimum_wage.golden.current").snapshot)).toEqual({ population: "general", source: "fact" });
    for (const entry of SYNTHETIC_CORPUS) {
      const binding = populationOf(entry.snapshot);
      expect(binding.source, entry.case_id).toBe(entry.family === "golden" ? "fact" : "absent");
      expect(binding.population, entry.case_id).toBe(entry.population);
    }
    expect(populationOf(syntheticCase("synthetic.working_time.edge.fractional_overtime_hour").snapshot)).toBe(POPULATION_ABSENT);
  });

  it("a conflicted population is refused before anything runs, with its own code", () => {
    const entry = syntheticCase("synthetic.minimum_wage.golden.sector_population");
    const facts = entry.snapshot.facts.map((fact) => (fact.path === "employment.population"
      ? { ...fact, value: null, status: "conflicted" as const, conflicting_fact_ids: ["00000000-0000-4000-8000-00000000000a", "00000000-0000-4000-8000-00000000000b"], resolution: null }
      : fact));
    const conflicted = { ...entry, snapshot: { ...entry.snapshot, facts } };
    expect(populationOf(conflicted.snapshot)).toEqual({ population: "general", source: "conflicted" });
    const run = runDraftShadow({ run_id: "shadow.run.population", bindings: testBindings, corpus: [conflicted] });
    expect(run.executions).toHaveLength(1);
    expect(run.executions[0]).toMatchObject({ status: "preparation_refused", rejection_codes: ["population.conflicted"], population: { population: "general", source: "conflicted" } });
    expect(run.refusals_by_reason).toEqual({ "preparation:population.conflicted": 1 });
  });
});

describe("the selection", () => {
  it("names the four figures batch 2 registered, at 2026.1.0, for the minimum-wage hourly slot and nothing else", () => {
    expect(POPULATION_PARAMETER_SELECTIONS).toHaveLength(1);
    const [selection] = POPULATION_PARAMETER_SELECTIONS;
    expect(selection).toMatchObject({ shadow_id: "minimum.wage.hourly.entitlement", ref_id: "parameter.hourly.floor", fact_path: "employment.population" });
    expect(Object.entries(selection.by_population).map(([population, parameter]) => [population, `${parameter!.parameter_id}@${parameter!.parameter_version}`])).toEqual([
      ["youth_under_16", "il.minimum_wage.youth_under16.hourly@2026.1.0"],
      ["youth_16_17", "il.minimum_wage.youth_16_17.hourly@2026.1.0"],
      ["youth_17_18", "il.minimum_wage.youth_17_18.hourly@2026.1.0"],
      ["apprentice", "il.minimum_wage.apprentice.hourly@2026.1.0"],
    ]);
    expect(selection.branch_independent_reason).toContain("published by BTL");
  });

  it("a youth month binds its population's figure under both branches; an adult month binds the branch's version", () => {
    for (const branch of ["182", "186"]) {
      const [youth] = parameterSlotsFor(MINIMUM_WAGE, branch, YOUTH);
      expect(youth).toEqual({ ref_id: "parameter.hourly.floor", parameter_id: "il.minimum_wage.youth_16_17.hourly", parameter_version: "2026.1.0", selected_by_population: true });
    }
    expect(parameterSlotsFor(MINIMUM_WAGE, "182", POPULATION_ABSENT)[0]).toEqual({ ref_id: "parameter.hourly.floor", parameter_id: "il.minimum_wage.hourly", parameter_version: "2026.1.0", selected_by_population: false });
    expect(parameterSlotsFor(MINIMUM_WAGE, "186", { population: "general", source: "fact" })[0].parameter_version).toBe("2026.2.0");
    // No branch named on a spec that carries a decision: the version the spec declares.
    expect(parameterSlotsFor(MINIMUM_WAGE, null, POPULATION_ABSENT)[0].parameter_version).toBe(MINIMUM_WAGE.spec.parameters[0].parameter_version);
  });

  it("no other spec has a population-selected slot: a youth binds exactly what an adult binds", () => {
    for (const spec of DRAFT_SHADOW_SPECS) {
      if (spec.shadow_id === MINIMUM_WAGE.shadow_id) continue;
      for (const branch of spec.branches.length > 0 ? spec.branches.map(([name]) => name) : [spec.composition_branch]) {
        expect(parameterSlotsFor(spec, branch, YOUTH), `${spec.shadow_id}/${branch}`).toEqual(parameterSlotsFor(spec, branch, POPULATION_ABSENT));
        expect(parameterSlotsFor(spec, branch, YOUTH).every((slot) => !slot.selected_by_population)).toBe(true);
      }
    }
  });

  it("the youth month runs on the youth figure, and the record says which population bound it", () => {
    const entry = syntheticCase("synthetic.minimum_wage.golden.sector_population");
    const run = runDraftShadow({ run_id: "shadow.run.youth", bindings: testBindings, corpus: [entry], branch_policy: "all" });
    expect(run.executions).toHaveLength(2);
    for (const execution of run.executions) {
      expect(execution.status).toBe("ran");
      expect(execution.population).toEqual(YOUTH);
      expect(execution.parameter_version_ids).toEqual(["il.minimum_wage.youth_16_17.hourly@2026.1.0"]);
      // 91 hours at the youth 16–17 hourly of 27.93 = 2,541.63; the month paid 3,000.00.
      expect(execution.output).toEqual({ kind: "money", currency: "ILS", minor_units: 254_163 });
      expect(execution.delta).toMatchObject({ status: "computed", entitlement: "254163", paid: "300000", delta: "-45837" });
    }
    // The adult month of the same topic binds the branch's figure, and the branches differ.
    const adult = runDraftShadow({ run_id: "shadow.run.adult", bindings: testBindings, corpus: [syntheticCase("synthetic.minimum_wage.golden.current")], branch_policy: "all" });
    expect(adult.executions.map((execution) => execution.parameter_version_ids[0])).toEqual(["il.minimum_wage.hourly@2026.1.0", "il.minimum_wage.hourly@2026.2.0"]);
    expect(adult.executions.every((execution) => execution.population.population === "general" && execution.population.source === "fact")).toBe(true);
  });
});
