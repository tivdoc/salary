// E3-6 (D1). Synthetic scenario INPUTS, 7 topics x 6 scenarios.
//
// The split D1 draws is the one that matters: a golden case template is blank
// by design in its EXPECTED half, because the expected answer is a legal
// determination and only a person may write one. Its INPUT half — hours, dates,
// sector, population, employment fraction — is synthetic data with no legal
// content, and authoring it is what lets the machinery run at all.
//
// So there is no `expected` field anywhere in this file, not even null-valued,
// and the type has no room for one. A fixture that could hold an expectation
// would eventually hold one.
//
// The `missing_conflicted_facts` scenario carries a deliberately absent or
// conflicted input, because a fail-closed refusal nobody exercises is a claim
// rather than a property.
import { z } from "zod";
import { canonicalSha256, deepFreeze } from "../rule-runtime/canonical.ts";
import { WAVE3_TOPICS, type Wave3Topic } from "../wave3/contracts.ts";
import { GOLDEN_SCENARIOS } from "./golden-case-templates.ts";

export const SCENARIO_FIXTURE_SCHEMA = "tivdoc-scenario-input-fixture-v0.9.0" as const;

const idSchema = z.string().regex(/^[a-z][a-z0-9._:-]{2,159}$/u);
const shaSchema = z.string().regex(/^[a-f0-9]{64}$/u);

// The rule runtime's own input value shape, restated here so a fixture cannot
// carry a value the executor would not accept.
const inputValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("rational"), numerator: z.string().regex(/^-?\d+$/u), denominator: z.string().regex(/^[1-9]\d*$/u), unit: idSchema }).strict(),
  z.object({ kind: z.literal("money"), currency: z.string().regex(/^[A-Z]{3}$/u), minor_units: z.number().int().safe() }).strict(),
  z.object({ kind: z.literal("integer"), value: z.number().int().safe(), unit: idSchema }).strict(),
  z.object({ kind: z.literal("boolean"), value: z.boolean() }).strict(),
]);

export const scenarioFixtureSchema = z.object({
  schema_version: z.literal(SCENARIO_FIXTURE_SCHEMA),
  fixture_id: idSchema,
  topic: z.enum(WAVE3_TOPICS),
  scenario: z.enum(GOLDEN_SCENARIOS),
  synthetic: z.literal(true),
  legal_ground_truth: z.literal(false),
  // Scenario framing. Synthetic dates and labels; none of them is a claim
  // about what the law says for that date or that population.
  as_of: z.iso.date(),
  sector: idSchema,
  population: idSchema,
  inputs: z.array(z.object({ ref_id: idSchema, value: inputValueSchema }).strict()).readonly(),
  // Refs the scenario deliberately withholds, and refs it deliberately supplies
  // twice with different values. Both are ways a real case arrives broken, and
  // both must reach a fail-closed refusal rather than a guess.
  omitted_refs: z.array(idSchema).readonly(),
  conflicted_refs: z.array(idSchema).readonly(),
  note: z.string().min(20).max(400),
  content_sha256: shaSchema,
}).strict().readonly();

export type ScenarioFixture = z.infer<typeof scenarioFixtureSchema>;

const RATIO = (numerator: string, denominator = "1") =>
  ({ kind: "rational" as const, numerator, denominator, unit: "ratio" });

type Seed = Readonly<{ ref_id: string; per_scenario: Readonly<Record<string, ReturnType<typeof RATIO>>> }>;

// One multiplier per topic — the dimensionless scalar the topic's rule applies
// to its money parameter. Named for what the computation does with it rather
// than for what a person would call it, because in the engine's type system it
// is a ratio and calling it "hours" while declaring it a ratio would be the
// kind of quiet mislabelling this codebase spends its time avoiding.
const TOPIC_MULTIPLIER: Readonly<Record<Wave3Topic, Seed>> = Object.freeze({
  minimum_wage: {
    ref_id: "fact.hours.multiplier",
    per_scenario: {
      current: RATIO("182"),
      effective_date_boundary: RATIO("182"),
      sector_population: RATIO("91"),
      missing_conflicted_facts: RATIO("182"),
      precedence_overlap: RATIO("186"),
      // 1000/7 hours is not a real roster; it is chosen so the money scaling
      // cannot come out exact and the rounding policy has to decide.
      parameter_rounding_boundary: RATIO("1000", "7"),
    },
  },
  travel: {
    ref_id: "fact.workdays.multiplier",
    per_scenario: {
      current: RATIO("22"), effective_date_boundary: RATIO("22"), sector_population: RATIO("11"),
      missing_conflicted_facts: RATIO("22"), precedence_overlap: RATIO("22"),
      parameter_rounding_boundary: RATIO("100", "3"),
    },
  },
  pension: {
    ref_id: "fact.pensionable.wage.multiplier",
    per_scenario: {
      current: RATIO("1"), effective_date_boundary: RATIO("1"), sector_population: RATIO("1", "2"),
      missing_conflicted_facts: RATIO("1"), precedence_overlap: RATIO("1"),
      parameter_rounding_boundary: RATIO("1", "3"),
    },
  },
  working_time: {
    ref_id: "fact.overtime.hours.multiplier",
    per_scenario: {
      current: RATIO("10"), effective_date_boundary: RATIO("10"), sector_population: RATIO("5"),
      missing_conflicted_facts: RATIO("10"), precedence_overlap: RATIO("12"),
      parameter_rounding_boundary: RATIO("10", "3"),
    },
  },
  convalescence: {
    ref_id: "fact.convalescence.days.multiplier",
    per_scenario: {
      current: RATIO("5"), effective_date_boundary: RATIO("5"), sector_population: RATIO("6"),
      missing_conflicted_facts: RATIO("5"), precedence_overlap: RATIO("7"),
      parameter_rounding_boundary: RATIO("5", "3"),
    },
  },
  vacation: {
    ref_id: "fact.employment.fraction",
    per_scenario: {
      current: RATIO("1"), effective_date_boundary: RATIO("1"), sector_population: RATIO("1", "2"),
      missing_conflicted_facts: RATIO("1"), precedence_overlap: RATIO("1"),
      parameter_rounding_boundary: RATIO("2", "3"),
    },
  },
  sick_leave: {
    ref_id: "fact.months.employed.multiplier",
    per_scenario: {
      current: RATIO("12"), effective_date_boundary: RATIO("12"), sector_population: RATIO("6"),
      missing_conflicted_facts: RATIO("12"), precedence_overlap: RATIO("12"),
      parameter_rounding_boundary: RATIO("100", "7"),
    },
  },
});

const SCENARIO_FRAMING: Readonly<Record<string, Readonly<{ as_of: string; sector: string; population: string; note: string }>>> = Object.freeze({
  current: {
    as_of: "2026-06-01", sector: "general", population: "general",
    note: "An ordinary period well inside one effective interval, so nothing about dates or scope is in question and only the parameter value moves.",
  },
  effective_date_boundary: {
    as_of: "2026-04-01", sector: "general", population: "general",
    note: "The first day of a new effective interval. The same inputs on the day before and the day of must select different parameter versions.",
  },
  sector_population: {
    as_of: "2026-06-01", sector: "general", population: "youth_16_17",
    note: "A population with its own parameter. A rule that ignores population would return the general figure and look correct.",
  },
  missing_conflicted_facts: {
    as_of: "2026-06-01", sector: "general", population: "general",
    note: "One required input is withheld and one is supplied twice with different values. Both must reach a fail-closed refusal, never a guess or a default.",
  },
  precedence_overlap: {
    as_of: "2026-06-01", sector: "general", population: "general",
    note: "Two instruments plausibly cover the same period and scope. Which governs is a legal judgement, so the spec must refuse rather than pick.",
  },
  parameter_rounding_boundary: {
    as_of: "2026-06-01", sector: "general", population: "general",
    note: "A multiplier chosen so the money scaling cannot come out exact, forcing the rounding policy to decide and putting it in the trace.",
  },
});

function unsignedFixture(topic: Wave3Topic, scenario: typeof GOLDEN_SCENARIOS[number]) {
  const seed = TOPIC_MULTIPLIER[topic];
  const framing = SCENARIO_FRAMING[scenario];
  const missing = scenario === "missing_conflicted_facts";
  return {
    schema_version: SCENARIO_FIXTURE_SCHEMA,
    fixture_id: `scenario.${topic}.${scenario}`,
    topic,
    scenario,
    synthetic: true as const,
    legal_ground_truth: false as const,
    as_of: framing.as_of,
    sector: framing.sector,
    population: framing.population,
    // The missing/conflicted scenario supplies nothing: the refusal is the
    // whole content of the case, and supplying a value and then also omitting
    // it would be two different tests wearing one name.
    inputs: missing ? [] : [{ ref_id: seed.ref_id, value: seed.per_scenario[scenario] }],
    omitted_refs: missing ? [seed.ref_id] : [],
    conflicted_refs: missing ? [seed.ref_id] : [],
    note: framing.note,
  };
}

export function buildScenarioFixture(topic: Wave3Topic, scenario: typeof GOLDEN_SCENARIOS[number]): ScenarioFixture {
  const content = unsignedFixture(topic, scenario);
  return deepFreeze(scenarioFixtureSchema.parse({ ...content, content_sha256: canonicalSha256(content) })) as ScenarioFixture;
}

/** All forty-two, in topic then scenario order. */
export function buildAllScenarioFixtures(): readonly ScenarioFixture[] {
  return deepFreeze(WAVE3_TOPICS.flatMap((topic) =>
    GOLDEN_SCENARIOS.map((scenario) => buildScenarioFixture(topic, scenario)))) as readonly ScenarioFixture[];
}

export function scenarioFixture(topic: Wave3Topic, scenario: string): ScenarioFixture | null {
  return buildAllScenarioFixtures().find((entry) => entry.topic === topic && entry.scenario === scenario) ?? null;
}
