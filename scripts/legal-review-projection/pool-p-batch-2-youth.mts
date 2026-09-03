// Pool P batch 2 (Addendum 5): P-7..P-10, youth and apprentice minimum wage.
//
// The regulation (D-7) establishes the four percentages (70/75/83/60% of
// the adult minimum wage) and the 173-hour basis; the actual per-agora
// monthly and hourly amounts are read from BTL's own published historical
// rate spreadsheet (D-1b), NOT computed here by multiplying the adult rate
// by the percentage — doing that arithmetic independently would have
// produced a figure one agora off BTL's own published number for three of
// the four categories (5348.40 vs BTL's 5348.39, 4832.89 vs 4832.88,
// 4510.70 vs 4510.69 — rounding-method drift, not an error in either
// figure, but a real reason to bind to the published table rather than
// re-derive), and the research dossier's own summary table (sourced from
// an explanatory site, kolzchut) shows yet a third rounding for the hourly
// figures (26.07/27.94/30.92/22.35) that disagrees with BTL's own table
// (26.07/27.93/30.91/22.34) on three of four rows. BTL is the official
// implementation source and wins.
import { buildCandidate, citation, importPoolPBatch } from "./pool-p-parameter-import.mts";

const D7 = { source_id: "IL_MIN_WAGE_YOUTH_APPRENTICES_REGULATIONS_1987", source_version: "discovery-v0" };
const D1B = { source_id: "IL_MIN_WAGE_OFFICIAL_RATES_HISTORY_XLSX", source_version: "discovery-v0" };

const regulationChunk = "IL_MIN_WAGE_YOUTH_APPRENTICES_REGULATIONS_1987@discovery-v0#0001-de946f823e40";
const tableChunk = "IL_MIN_WAGE_OFFICIAL_RATES_HISTORY_XLSX@discovery-v0#0002-db77695e709f";

const CATEGORIES = [
  {
    id: "youth_under16", population: "youth_under_16",
    regulationMustContain: ["70%"], regulationLocator: "Minimum Wage Regulations (Working Youth and Apprentices) 1987, §4(a): a working youth who has not yet turned 16 — 70% of the adult minimum wage",
    monthly: 451069, hourly: 2607,
  },
  {
    id: "youth_16_17", population: "youth_16_17",
    regulationMustContain: ["75%"], regulationLocator: "§4(b): a working youth who has turned 16 but not yet 17 — 75% of the adult minimum wage",
    monthly: 483288, hourly: 2793,
  },
  {
    id: "youth_17_18", population: "youth_17_18",
    regulationMustContain: ["83%"], regulationLocator: "§4(c): a working youth who has turned 17 (but not yet 18) — 83% of the adult minimum wage",
    monthly: 534839, hourly: 3091,
  },
  {
    id: "apprentice", population: "apprentice",
    regulationMustContain: ["60%"], regulationLocator: "§5: an apprentice employed full-time — 60% of the adult minimum wage",
    monthly: 386631, hourly: 2234,
  },
] as const;

const candidates = CATEGORIES.flatMap((category) => {
  const regulation = citation(D7, regulationChunk, category.regulationLocator, category.regulationMustContain);
  const table = citation(D1B, tableChunk, `BTL historical minimum-wage rate spreadsheet, ${category.id} column, row 1.04.2026`,
    [(category.monthly / 100).toFixed(2)]);
  const shared = {
    topic: "minimum_wage" as const,
    effective_from: "2026-04-01",
    effective_to: null,
    sectors: ["general"],
    populations: [category.population],
    support_roles: ["primary_binding" as const, "official_implementation" as const],
    citations: [regulation, table],
  };
  return [
    buildCandidate({
      ...shared,
      parameter_id: `il.minimum_wage.${category.id}.monthly`,
      parameter_version: "2026.1.0",
      value: { kind: "money", value: { currency: "ILS", minor_units: category.monthly } },
      unit: "currency.ils",
      rounding_policy: "exact",
    }),
    buildCandidate({
      ...shared,
      parameter_id: `il.minimum_wage.${category.id}.hourly`,
      parameter_version: "2026.1.0",
      value: { kind: "money", value: { currency: "ILS", minor_units: category.hourly } },
      unit: "currency.ils",
      rounding_policy: "exact",
    }),
  ];
});

await importPoolPBatch("batch-2-youth", candidates);
