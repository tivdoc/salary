import { z } from "zod";

import { isoDateSchema, isoTimestampSchema } from "../domain/primitives.ts";
import { frozen, legalOperationsSha256 } from "../legal-operations/canonical.ts";
import {
  BINDING_DIMENSIONS,
  assessDependencyInvalidation,
} from "../legal-operations/state-machine.ts";
import {
  createRuleSpecDependencyManifest,
  changedRuleSpecDependencyDimensions,
  RULESPEC_DEPENDENCY_DIMENSIONS,
} from "../legal-operations/rulespec-lifecycle.ts";
import {
  createRuleSpecPackage,
  executeRuleSpec,
  executeRuleSpecAtomic,
  type RuleSpecDraft,
  type RuleSpecPackage,
} from "../legal-operations/rulespec.ts";
import {
  SYNTHETIC_CURRENCY,
  SYNTHETIC_POPULATION,
  SYNTHETIC_SECTOR,
  SYNTHETIC_SEVEN_TOPIC_FIXTURES,
  syntheticBindings,
} from "../legal-operations/synthetic-fixtures.ts";
import { WAVE3_TOPICS, type Wave3Topic } from "../wave3/contracts.ts";

export const SYNTHETIC_PROPERTY_REPORT_SCHEMA =
  "tivdoc-seven-topic-synthetic-property-report-v0.10.2" as const;

const syntheticId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{2,199}$/u);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);

export const syntheticApplicabilityCandidateSchema = z.object({
  candidate_id: syntheticId,
  topic: z.enum(WAVE3_TOPICS),
  catalog_boundary: z.literal("synthetic_test_only"),
  scope_mode: z.enum(["general", "specific"]),
  effective_from: isoDateSchema,
  effective_to: isoDateSchema.nullable(),
  sectors: z.array(syntheticId).readonly(),
  populations: z.array(syntheticId).readonly(),
  geographies: z.array(syntheticId).readonly(),
  dependency_sha256: sha256,
  activation_allowed: z.literal(false),
}).strict().superRefine((candidate, context) => {
  if (candidate.effective_to !== null && candidate.effective_to < candidate.effective_from) {
    context.addIssue({ code: "custom", message: "synthetic_applicability_interval_inverted" });
  }
  const emptyScope = candidate.sectors.length === 0
    && candidate.populations.length === 0
    && candidate.geographies.length === 0;
  if ((candidate.scope_mode === "general") !== emptyScope) {
    context.addIssue({ code: "custom", message: "synthetic_applicability_scope_mode_invalid" });
  }
}).readonly();

export const syntheticApplicabilityContextSchema = z.object({
  topic: z.enum(WAVE3_TOPICS),
  target_date: isoDateSchema,
  sector: syntheticId,
  population: syntheticId,
  geography: syntheticId,
}).strict().readonly();

export const syntheticFactStateSchema = z.object({
  fact_id: syntheticId,
  state: z.enum(["confirmed", "missing", "conflicted", "unconfirmed", "stale", "low_confidence"]),
  confidence_basis_points: z.number().int().min(0).max(10_000).nullable(),
  observed_at: isoTimestampSchema.nullable(),
  content_sha256: sha256.nullable(),
  synthetic_test_only: z.literal(true),
}).strict().superRefine((fact, context) => {
  const hasMaterial = fact.confidence_basis_points !== null
    && fact.observed_at !== null
    && fact.content_sha256 !== null;
  if (fact.state === "confirmed" && !hasMaterial) {
    context.addIssue({ code: "custom", message: "synthetic_confirmed_fact_material_required" });
  }
  if (fact.state === "missing" && (fact.confidence_basis_points !== null
      || fact.observed_at !== null || fact.content_sha256 !== null)) {
    context.addIssue({ code: "custom", message: "synthetic_missing_fact_must_remain_unknown" });
  }
}).readonly();

export type SyntheticApplicabilityCandidate = z.infer<typeof syntheticApplicabilityCandidateSchema>;
export type SyntheticFactState = z.infer<typeof syntheticFactStateSchema>;

export function resolveSyntheticApplicability(input: Readonly<{
  candidates: readonly unknown[];
  context: unknown;
}>) {
  const context = syntheticApplicabilityContextSchema.parse(input.context);
  const candidates = input.candidates.map((candidate) => syntheticApplicabilityCandidateSchema.parse(candidate));
  if (candidates.length === 0 || candidates.some((candidate) => candidate.topic !== context.topic)) {
    throw new Error("SYNTHETIC_APPLICABILITY_CANDIDATE_SET_INVALID");
  }
  const temporal = candidates.filter((candidate) => candidate.effective_from <= context.target_date
    && (candidate.effective_to === null || context.target_date <= candidate.effective_to));
  if (temporal.length === 0) return frozen({
    status: "blocked" as const,
    selected_candidate_id: null,
    equivalent_candidate_ids: [] as readonly string[],
    blocker_codes: ["TEMPORAL_GAP"] as const,
    activation_allowed: false as const,
  });
  const scoped = temporal.filter((candidate) => candidate.scope_mode === "general" || (
    candidate.sectors.includes(context.sector)
    && candidate.populations.includes(context.population)
    && candidate.geographies.includes(context.geography)
  ));
  if (scoped.length === 0) return frozen({
    status: "blocked" as const,
    selected_candidate_id: null,
    equivalent_candidate_ids: [] as readonly string[],
    blocker_codes: ["SCOPE_MISMATCH"] as const,
    activation_allowed: false as const,
  });
  const specific = scoped.filter((candidate) => candidate.scope_mode === "specific");
  const ranked = specific.length > 0 ? specific : scoped.filter((candidate) => candidate.scope_mode === "general");
  if (new Set(ranked.map((candidate) => candidate.dependency_sha256)).size > 1) return frozen({
    status: "blocked" as const,
    selected_candidate_id: null,
    equivalent_candidate_ids: ranked.map((candidate) => candidate.candidate_id).sort(),
    blocker_codes: ["TEMPORAL_OVERLAP_CONFLICT"] as const,
    activation_allowed: false as const,
  });
  const ordered = [...ranked].sort((left, right) => left.candidate_id.localeCompare(right.candidate_id));
  return frozen({
    status: "selected" as const,
    selected_candidate_id: ordered[0].candidate_id,
    equivalent_candidate_ids: ordered.map((candidate) => candidate.candidate_id),
    blocker_codes: [] as readonly string[],
    selected_dependency_sha256: ordered[0].dependency_sha256,
    precedence: ordered[0].scope_mode === "specific" ? "sector_population_geography_specific" as const : "general" as const,
    activation_allowed: false as const,
  });
}

export function assessSyntheticFactReadiness(input: Readonly<{
  facts: readonly unknown[];
  as_of: string;
  maximum_age_days: number;
  minimum_confidence_basis_points: number;
}>) {
  const asOf = isoTimestampSchema.parse(input.as_of);
  if (!Number.isSafeInteger(input.maximum_age_days) || input.maximum_age_days < 0
      || !Number.isSafeInteger(input.minimum_confidence_basis_points)
      || input.minimum_confidence_basis_points < 0 || input.minimum_confidence_basis_points > 10_000) {
    throw new Error("SYNTHETIC_FACT_READINESS_POLICY_INVALID");
  }
  const facts = input.facts.map((fact) => syntheticFactStateSchema.parse(fact));
  if (new Set(facts.map((fact) => fact.fact_id)).size !== facts.length) {
    throw new Error("SYNTHETIC_FACT_ID_DUPLICATED");
  }
  const blockers = new Set<string>();
  const asOfMs = Date.parse(asOf);
  for (const fact of facts) {
    if (fact.state !== "confirmed") blockers.add(`FACT_${fact.state.toUpperCase()}`);
    if (fact.state === "confirmed") {
      if (fact.confidence_basis_points! < input.minimum_confidence_basis_points) {
        blockers.add("FACT_LOW_CONFIDENCE");
      }
      if (asOfMs - Date.parse(fact.observed_at!) > input.maximum_age_days * 86_400_000) {
        blockers.add("FACT_STALE");
      }
    }
  }
  const blockerCodes = [...blockers].sort();
  return frozen({
    status: blockerCodes.length === 0 ? "ready" as const : "blocked" as const,
    blocker_codes: blockerCodes,
    evaluated_fact_count: facts.length,
    facts_sha256: legalOperationsSha256([...facts].sort((left, right) => left.fact_id.localeCompare(right.fact_id))),
    legal_conclusion: null,
    monetary_result: null,
    activation_allowed: false as const,
  });
}

type PropertyResult = Readonly<{
  property_id: string;
  topic: Wave3Topic;
  category: string;
  dimension: string | null;
  expected: string;
  observed: string;
  passed: boolean;
  partial_output_visible: false;
  result_sha256: string;
}>;

function result(
  topic: Wave3Topic,
  category: string,
  dimension: string | null,
  expected: string,
  observed: string,
  detail: unknown,
): PropertyResult {
  const body = {
    property_id: `synthetic.property.${topic}.${category}.${dimension ?? "default"}`,
    topic,
    category,
    dimension,
    expected,
    observed,
    passed: expected === observed,
    partial_output_visible: false as const,
  };
  return frozen({ ...body, result_sha256: legalOperationsSha256({ ...body, detail }) });
}

function candidate(
  topic: Wave3Topic,
  id: string,
  options: Readonly<{
    scope?: "general" | "specific";
    from?: string;
    to?: string | null;
    dependency?: string;
    sector?: string;
    population?: string;
    geography?: string;
  }> = {},
): SyntheticApplicabilityCandidate {
  const scope = options.scope ?? "general";
  return syntheticApplicabilityCandidateSchema.parse({
    candidate_id: `syn.applicability.${topic}.${id}`,
    topic,
    catalog_boundary: "synthetic_test_only",
    scope_mode: scope,
    effective_from: options.from ?? "2040-01-01",
    effective_to: options.to === undefined ? "2040-12-31" : options.to,
    sectors: scope === "specific" ? [options.sector ?? SYNTHETIC_SECTOR] : [],
    populations: scope === "specific" ? [options.population ?? SYNTHETIC_POPULATION] : [],
    geographies: scope === "specific" ? [options.geography ?? "synthetic.geography"] : [],
    dependency_sha256: options.dependency ?? legalOperationsSha256({ synthetic_test_only: true, topic, id }),
    activation_allowed: false,
  });
}

function context(topic: Wave3Topic, targetDate = "2040-06-01") {
  return {
    topic,
    target_date: targetDate,
    sector: SYNTHETIC_SECTOR,
    population: SYNTHETIC_POPULATION,
    geography: "synthetic.geography",
  } as const;
}

function draft(rule: RuleSpecPackage): RuleSpecDraft {
  const { content_sha256: omitted, ...body } = rule;
  void omitted;
  return body;
}

function mutatedRule(rule: RuleSpecPackage, dimension: typeof RULESPEC_DEPENDENCY_DIMENSIONS[number]) {
  const body = draft(rule);
  if (dimension === "source_versions") return createRuleSpecPackage({
    ...body,
    source_version_ids: [...body.source_version_ids, `syn.source.${rule.topic}.additional@1.0.0`],
  });
  if (dimension === "effective_period") return createRuleSpecPackage({
    ...body,
    effective_period: { ...body.effective_period, from: "2040-01-02" },
  });
  if (dimension === "sectors") return createRuleSpecPackage({
    ...body,
    sectors: [...body.sectors, "synthetic.sector.additional"],
  });
  if (dimension === "populations") return createRuleSpecPackage({
    ...body,
    populations: [...body.populations, "synthetic.population.additional"],
  });
  if (dimension === "parameter_versions") return createRuleSpecPackage({
    ...body,
    parameters: body.parameters.map((parameter, index) => index === 0
      ? { ...parameter, parameter_version: "2.0.0" }
      : parameter),
  });
  if (dimension === "golden_case_set") return createRuleSpecPackage({
    ...body,
    golden_case_set_sha256: legalOperationsSha256({ synthetic_test_only: true, mutation: dimension }),
  });
  if (dimension === "resource_policy") return createRuleSpecPackage({
    ...body,
    resource_policy: { ...body.resource_policy, max_integer_digits: body.resource_policy.max_integer_digits + 1 },
  });
  return createRuleSpecPackage({
    ...body,
    nodes: body.nodes.map((node, index) => index === 0 && node.operation === "money.scale"
      ? { ...node, rounding: node.rounding === "exact" ? "half_even" as const : "exact" as const }
      : node),
  });
}

function roundingRule(rule: RuleSpecPackage, rounding: "exact" | "toward_zero" | "half_up" | "half_even") {
  const body = draft(rule);
  return createRuleSpecPackage({
    ...body,
    nodes: body.nodes.map((node) => node.operation === "money.scale" ? { ...node, rounding } : node),
  });
}

function runTopic(topic: Wave3Topic): readonly PropertyResult[] {
  const fixture = SYNTHETIC_SEVEN_TOPIC_FIXTURES.find((entry) => entry.topic === topic);
  if (!fixture) throw new Error("SYNTHETIC_TOPIC_FIXTURE_MISSING");
  const results: PropertyResult[] = [];
  const general = candidate(topic, "general");
  const specific = candidate(topic, "specific", { scope: "specific" });

  const positive = resolveSyntheticApplicability({ candidates: [general], context: context(topic) });
  results.push(result(topic, "positive", null, "selected", positive.status, positive));
  for (const [dimension, changed] of [
    ["sector", { sector: "synthetic.sector.other" }],
    ["population", { population: "synthetic.population.other" }],
    ["geography", { geography: "synthetic.geography.other" }],
  ] as const) {
    const negative = resolveSyntheticApplicability({ candidates: [specific], context: {
      ...context(topic), ...changed,
    } });
    results.push(result(topic, "negative_scope", dimension, "SCOPE_MISMATCH",
      negative.blocker_codes[0] ?? "NONE", negative));
  }
  for (const boundary of ["2040-01-01", "2040-12-31"] as const) {
    const boundaryResult = resolveSyntheticApplicability({ candidates: [general], context: context(topic, boundary) });
    results.push(result(topic, "temporal_boundary", boundary, "selected", boundaryResult.status, boundaryResult));
  }
  const gap = resolveSyntheticApplicability({ candidates: [general], context: context(topic, "2041-01-01") });
  results.push(result(topic, "temporal_gap", null, "TEMPORAL_GAP", gap.blocker_codes[0] ?? "NONE", gap));
  const overlap = resolveSyntheticApplicability({ candidates: [
    specific,
    candidate(topic, "specific.conflict", { scope: "specific", dependency: legalOperationsSha256({ topic, conflict: true }) }),
  ], context: context(topic) });
  results.push(result(topic, "temporal_overlap", null, "TEMPORAL_OVERLAP_CONFLICT",
    overlap.blocker_codes[0] ?? "NONE", overlap));
  const precedence = resolveSyntheticApplicability({ candidates: [general, specific], context: context(topic) });
  results.push(result(topic, "general_sector_precedence", null, "sector_population_geography_specific",
    "precedence" in precedence ? precedence.precedence : "blocked", precedence));

  const confirmedFact = {
    fact_id: `syn.fact.${topic}.confirmed`, state: "confirmed", confidence_basis_points: 9_500,
    observed_at: "2040-05-31T00:00:00.000Z", content_sha256: legalOperationsSha256({ topic, fact: true }),
    synthetic_test_only: true,
  } as const;
  const ready = assessSyntheticFactReadiness({ facts: [confirmedFact], as_of: "2040-06-01T00:00:00.000Z",
    maximum_age_days: 7, minimum_confidence_basis_points: 9_000 });
  results.push(result(topic, "fact_quality", "confirmed", "ready", ready.status, ready));
  for (const state of ["missing", "conflicted", "unconfirmed", "stale", "low_confidence"] as const) {
    const fact = state === "missing"
      ? { fact_id: `syn.fact.${topic}.${state}`, state, confidence_basis_points: null, observed_at: null,
        content_sha256: null, synthetic_test_only: true as const }
      : { ...confirmedFact, fact_id: `syn.fact.${topic}.${state}`, state,
        ...(state === "stale" ? { observed_at: "2039-01-01T00:00:00.000Z" } : {}),
        ...(state === "low_confidence" ? { confidence_basis_points: 1_000 } : {}) };
    const assessment = assessSyntheticFactReadiness({ facts: [fact], as_of: "2040-06-01T00:00:00.000Z",
      maximum_age_days: 7, minimum_confidence_basis_points: 9_000 });
    results.push(result(topic, "fact_quality", state, "blocked", assessment.status, assessment));
  }

  const executionVariants = [
    executeRuleSpec({ rule: fixture.rule, facts: fixture.facts, parameters: fixture.parameters,
      control: { locale: "en-US", time_zone: "UTC" } }),
    executeRuleSpec({ rule: fixture.rule, facts: [...fixture.facts].reverse(), parameters: [...fixture.parameters].reverse(),
      control: { locale: "he-IL", time_zone: "Asia/Jerusalem" } }),
  ];
  const invariant = new Set(executionVariants.map((execution) => execution.result_sha256)).size === 1;
  results.push(result(topic, "locale_timezone_input_order", null, "invariant", invariant ? "invariant" : "variant",
    executionVariants.map((execution) => execution.result_sha256)));

  const abort = new AbortController();
  abort.abort("synthetic cancellation");
  const cancelled = executeRuleSpecAtomic({ rule: fixture.rule, facts: fixture.facts, parameters: fixture.parameters,
    control: { signal: abort.signal } });
  const cancelledObserved = cancelled.status === "failed" && cancelled.execution === null
    && !cancelled.output_visible && !cancelled.partial_output_visible
    ? cancelled.error_code : "PARTIAL_OUTPUT_VISIBLE";
  results.push(result(topic, "cancellation", null, "RULESPEC_EXECUTION_CANCELLED",
    cancelledObserved ?? "NONE", cancelled));
  const limited = executeRuleSpecAtomic({ rule: fixture.rule, facts: fixture.facts, parameters: fixture.parameters,
    control: { max_steps: 0 } });
  const limitedObserved = limited.status === "failed" && limited.execution === null
    && !limited.output_visible && !limited.partial_output_visible
    ? limited.error_code : "PARTIAL_OUTPUT_VISIBLE";
  results.push(result(topic, "resource_limit", null, "RULESPEC_EXECUTION_RESOURCE_LIMIT_EXCEEDED",
    limitedObserved ?? "NONE", limited));

  const moneyFacts = [{ ref_id: "fact.signal", value: {
    kind: "rational" as const, numerator: "1", denominator: "2", unit: "ratio",
  } }];
  const moneyParameters = [{ ref_id: "parameter.amount", value: {
    kind: "money" as const, currency: SYNTHETIC_CURRENCY, minor_units: 101,
  } }];
  const roundingExpectations = {
    exact: "RULESPEC_EXACT_ROUNDING_REQUIRED",
    toward_zero: "50",
    half_up: "51",
    half_even: "50",
  } as const;
  for (const rounding of Object.keys(roundingExpectations) as Array<keyof typeof roundingExpectations>) {
    const outcome = executeRuleSpecAtomic({ rule: roundingRule(fixture.rule, rounding), facts: moneyFacts,
      parameters: moneyParameters });
    const observed = outcome.status === "failed" ? outcome.error_code
      : outcome.execution.output.kind === "money" ? String(outcome.execution.output.minor_units) : "NON_MONEY";
    results.push(result(topic, "integer_money_rounding", rounding, roundingExpectations[rounding], observed, outcome));
  }

  const bindingBaseline = syntheticBindings(topic, fixture.rule.content_sha256, fixture.golden_cases.content_sha256);
  for (const dimension of BINDING_DIMENSIONS) {
    const observed = { ...bindingBaseline, [dimension]: legalOperationsSha256({ topic, dimension, mutation: true }) };
    const changes = assessDependencyInvalidation(bindingBaseline, observed);
    results.push(result(topic, "dependency_binding_mutation", dimension, dimension,
      changes.length === 1 ? changes[0] : changes.join(","), changes));
  }
  const manifest = createRuleSpecDependencyManifest(fixture.rule);
  for (const dimension of RULESPEC_DEPENDENCY_DIMENSIONS) {
    const mutated = createRuleSpecDependencyManifest(mutatedRule(fixture.rule, dimension));
    const changes = changedRuleSpecDependencyDimensions(manifest, mutated);
    results.push(result(topic, "dependency_manifest_mutation", dimension, dimension,
      changes.length === 1 ? changes[0] : changes.join(","), changes));
  }
  return frozen(results);
}

export function runSyntheticSevenTopicPropertySuite() {
  const results = WAVE3_TOPICS.flatMap(runTopic)
    .sort((left, right) => left.property_id.localeCompare(right.property_id));
  const body = {
    schema_version: SYNTHETIC_PROPERTY_REPORT_SCHEMA,
    topic_count: WAVE3_TOPICS.length,
    topics: [...WAVE3_TOPICS],
    property_result_count: results.length,
    dependency_binding_dimensions: [...BINDING_DIMENSIONS],
    dependency_manifest_dimensions: [...RULESPEC_DEPENDENCY_DIMENSIONS],
    results,
    all_mechanical_properties_passed: results.every((entry) => entry.passed),
    partial_output_count: results.filter((entry) => entry.partial_output_visible).length,
    real_legal_values_created: 0 as const,
    genuine_human_approvals_created: 0 as const,
    activation_allowed: false as const,
    customer_shadow_allowed: false as const,
    human_golden_templates_remain_authoring_only: true as const,
  };
  return frozen({ ...body, report_sha256: legalOperationsSha256(body) });
}
