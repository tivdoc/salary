// L8-4 / D5. The population a payslip month belongs to, and the parameter it
// selects.
//
// Until this unit the corpus's `sector_population` months carried a
// population as a LABEL ("youth_16_17") and ran on the general figure: the
// fact model had no path for it. Now `employment.population` is a fact — an
// adult, or a working youth by the age band the 1987 youth regulations use,
// or an apprentice — and a spec whose parameter differs by population names,
// here, which registered parameter each population binds. The selection is a
// binding-time concern: the spec, its nodes and its content hash are
// unchanged; the execution record says which population bound which figure.
//
// Batch 2 registered one figure per population at 2026.1.0, read from BTL's
// published table (which rounds the hourly its own way). The hourly-divisor
// decision's branches derive the ADULT hourly from the monthly by 182 or 186;
// they do not derive the youth figures, which are published as such. So a
// youth month binds the same figure under both branches, and the comparison
// shows no difference — not agreement, just one published figure.
import { employmentPopulations } from "../facts/contracts.ts";
import type { EmploymentSnapshot } from "../facts/snapshot.ts";
import type { DraftShadowSpec } from "./draft-shadow-specs.ts";

export type EmploymentPopulation = (typeof employmentPopulations)[number];

/** Where the population came from: the fact, or its absence (an adult until a fact says otherwise), or a conflict the run refuses on. */
export type PopulationBinding = Readonly<{
  population: EmploymentPopulation;
  source: "fact" | "absent" | "conflicted";
}>;

export const POPULATION_ABSENT: PopulationBinding = Object.freeze({ population: "general", source: "absent" });

export type PopulationSelectedParameter = Readonly<{ parameter_id: string; parameter_version: string }>;

export type PopulationParameterSelection = Readonly<{
  shadow_id: string;
  ref_id: string;
  fact_path: "employment.population";
  /** The registered parameter each non-general population binds in this slot; general keeps the spec's own binding. */
  by_population: Readonly<Partial<Record<Exclude<EmploymentPopulation, "general">, PopulationSelectedParameter>>>;
  branch_independent_reason: string;
}>;

const YOUTH_VERSION = "2026.1.0";

export const POPULATION_PARAMETER_SELECTIONS: readonly PopulationParameterSelection[] = Object.freeze([
  {
    shadow_id: "minimum.wage.hourly.entitlement",
    ref_id: "parameter.hourly.floor",
    fact_path: "employment.population",
    by_population: {
      youth_under_16: { parameter_id: "il.minimum_wage.youth_under16.hourly", parameter_version: YOUTH_VERSION },
      youth_16_17: { parameter_id: "il.minimum_wage.youth_16_17.hourly", parameter_version: YOUTH_VERSION },
      youth_17_18: { parameter_id: "il.minimum_wage.youth_17_18.hourly", parameter_version: YOUTH_VERSION },
      apprentice: { parameter_id: "il.minimum_wage.apprentice.hourly", parameter_version: YOUTH_VERSION },
    },
    branch_independent_reason:
      "The hourly-divisor decision derives the adult hourly from the monthly (182 or 186); the youth and apprentice hourly figures are published by BTL as such and registered once, so both branches bind the same figure.",
  },
]);

/** The population a snapshot declares: its `employment.population` fact, or absent, or conflicted. */
export function populationOf(snapshot: EmploymentSnapshot): PopulationBinding {
  const facts = snapshot.facts.filter((fact) => fact.path === "employment.population");
  if (facts.length === 0) return POPULATION_ABSENT;
  const conflicted = facts.some((fact) => fact.status === "conflicted" || fact.value === null);
  if (conflicted || facts.length > 1) return Object.freeze({ population: "general", source: "conflicted" });
  const value = facts[0].value as { population?: unknown } | null;
  const population = value?.population;
  if (typeof population !== "string" || !employmentPopulations.includes(population as EmploymentPopulation)) {
    return Object.freeze({ population: "general", source: "conflicted" });
  }
  return Object.freeze({ population: population as EmploymentPopulation, source: "fact" });
}

export type ParameterSlot = Readonly<{
  ref_id: string;
  parameter_id: string;
  parameter_version: string;
  /** True when the population, not the spec's binding, chose this parameter. */
  selected_by_population: boolean;
}>;

/**
 * The parameter each slot of a spec binds under a branch for a population:
 * the spec's binding (its fixed version, or the branch's), replaced in a
 * population-selected slot by that population's registered parameter.
 */
export function parameterSlotsFor(spec: DraftShadowSpec, branch: string | null, population: PopulationBinding): readonly ParameterSlot[] {
  const branchVersion = spec.branches.find(([name]) => name === branch)?.[1] ?? null;
  const selection = POPULATION_PARAMETER_SELECTIONS.find((candidate) => candidate.shadow_id === spec.shadow_id) ?? null;
  return spec.spec.parameters.map((declaration) => {
    const binding = spec.bindings.find((candidate) => candidate.ref_id === declaration.ref_id);
    if (!binding) throw new Error(`SHADOW_BINDING_MISSING:${spec.shadow_id}:${declaration.ref_id}`);
    const selected = selection && selection.ref_id === declaration.ref_id && population.population !== "general"
      ? selection.by_population[population.population] ?? null
      : null;
    if (selected) return { ref_id: declaration.ref_id, parameter_id: selected.parameter_id, parameter_version: selected.parameter_version, selected_by_population: true };
    // The binding's fixed version, else the branch's, else — when no branch was
    // named on a spec that carries a decision — the version the spec itself
    // declares, which is what the executor ran on before branches existed.
    const version = binding.parameter_version ?? branchVersion ?? declaration.parameter_version;
    return { ref_id: declaration.ref_id, parameter_id: binding.parameter_id, parameter_version: version, selected_by_population: false };
  });
}

/** Every population the corpus can select a parameter for, general included: what a binder must be able to bind. */
export function selectablePopulations(): readonly EmploymentPopulation[] {
  return employmentPopulations;
}
