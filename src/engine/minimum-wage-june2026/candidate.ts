import { parameterCandidateSchema, type ParameterCandidate } from '../legal-operations/contracts.ts';
import { createGoldenCaseSet, createRuleSpecPackage, type RuleSpecInputValue } from '../legal-operations/rulespec.ts';
import { legalOperationsSha256, frozen } from '../legal-operations/canonical.ts';
import { JUNE2026_MINIMUM_WAGE_POLICY as policy, JUNE2026_MINIMUM_WAGE_POLICY_SHA256, JUNE2026_MINIMUM_WAGE_SOURCES as sources } from './sources.ts';

const value = (minor: number) => ({kind: 'money' as const, currency: 'ILS', minor_units: minor});
const monthlyId = 'il.minimum_wage.monthly.june2026.candidate';
const divisorId = 'il.minimum_wage.hourly_divisor.june2026.candidate';
const version = '1.0.0';
export const componentInputId = (index: number) => `fact.component.${index + 1}`;

/** Each bounded arity is a distinct immutable RuleSpec package. Approval of one
 * hash would never authorize a changed number of operands or a new classifier.
 * The surrounding policy is separately hashed into every parameter binding. */
export function createJune2026MinimumWageCandidate(componentCount: number) {
  if (!Number.isInteger(componentCount) || componentCount < 1 || componentCount > policy.maximum_components) {
    throw new Error('JUNE2026_COMPONENT_COUNT_UNSUPPORTED');
  }
  const refs = Array.from({length: componentCount}, (_, index) => componentInputId(index));
  const ruleId = `il.rulespec.minimum.wage.june2026.components.${componentCount}`;
  // Dependency bindings include the exact arity rule hash. Reusing one
  // parameter version for different bindings would violate the append-only
  // registry's immutable-version contract even though the numeric value agrees.
  const parameterVersion = `1.0.${componentCount}`;
  const parameterInputs: RuleSpecInputValue[] = [
    {ref_id: 'parameter.monthly.floor', value: value(644385)},
    {ref_id: 'parameter.month.hours', value: {kind: 'rational', numerator: '182', denominator: '1', unit: 'hours_per_month'}},
  ];
  // Independently written rational results. No executor is called to generate
  // expected values, and no human approval is claimed for these arithmetic cases.
  const goldenCases = createGoldenCaseSet({
    schema_version: 'tivdoc-rulespec-golden-case-set-v0.6.0',
    golden_case_set_id: `il.minimum.wage.june2026.arithmetic.cases.${componentCount}`,
    rule_spec_id: ruleId, rule_spec_version: version,
    cases: [
      {case_id: 'one_hundred_hours', hours: '100', recorded: 330000, expected: 24058},
      {case_id: 'full_182_hours', hours: '182', recorded: 644385, expected: 0},
      {case_id: 'half_hour', hours: '0.5', recorded: 1600, expected: 170},
      {case_id: 'over_recorded', hours: '100', recorded: 360000, expected: -5942},
    ].map(entry => {
      const [integer, fraction = ''] = entry.hours.split('.');
      return {case_id: entry.case_id, facts: [
        {ref_id: 'fact.regular.hours', value: {kind: 'rational' as const, numerator: BigInt(integer + fraction).toString(), denominator: String(10 ** fraction.length), unit: 'hours_per_month'}},
        ...refs.map((ref_id, index) => ({ref_id, value: value(index === 0 ? entry.recorded : 0)})),
      ], parameters: parameterInputs, expected_output: value(entry.expected)};
    }),
  });
  const rule = createRuleSpecPackage({
    schema_version: 'tivdoc-rulespec-v0.6.0', rule_spec_id: ruleId, rule_spec_version: version,
    topic: 'minimum_wage', catalog_boundary: 'real_inactive',
    source_version_ids: sources.map(source => source.source_version_id),
    effective_period: {from: policy.period.start_date, to: policy.period.end_date},
    sectors: [policy.sector], populations: [policy.population],
    facts: [
      {ref_id: 'fact.regular.hours', value_kind: 'rational', unit: 'hours_per_month'},
      ...refs.map(ref_id => ({ref_id, value_kind: 'money' as const, unit: 'currency.ils'})),
    ],
    parameters: [
      {ref_id: 'parameter.monthly.floor', parameter_id: monthlyId, parameter_version: parameterVersion, value_kind: 'money', unit: 'currency.ils'},
      {ref_id: 'parameter.month.hours', parameter_id: divisorId, parameter_version: parameterVersion, value_kind: 'rational', unit: 'hours_per_month'},
    ],
    nodes: [
      {node_id: 'regular.month.fraction', operation: 'divide', left_ref: 'fact.regular.hours', right_ref: 'parameter.month.hours'},
      {node_id: 'expected.regular.pay', operation: 'money.scale', money_ref: 'parameter.monthly.floor', rational_ref: 'regular.month.fraction', rounding: 'half_up'},
      {node_id: 'recorded.eligible.pay', operation: 'aggregate.bounded', refs},
      {node_id: 'expected.minus.recorded', operation: 'subtract', left_ref: 'expected.regular.pay', right_ref: 'recorded.eligible.pay'},
    ], output_ref: 'expected.minus.recorded', golden_case_set_sha256: goldenCases.content_sha256,
    resource_policy: {max_steps: 4, max_depth: 3, max_aggregate_items: 32, max_integer_digits: 32},
  });
  const bindings = {
    source_bytes_sha256: legalOperationsSha256(sources.map(source => source.artifact_sha256)),
    citations_sha256: legalOperationsSha256(sources.map(source => ({source_version_id: source.source_version_id, locators: source.locators}))),
    interval_sha256: legalOperationsSha256(rule.effective_period),
    scope_sha256: JUNE2026_MINIMUM_WAGE_POLICY_SHA256,
    parameter_set_sha256: legalOperationsSha256(parameterInputs), rule_spec_sha256: rule.content_sha256,
    golden_cases_sha256: goldenCases.content_sha256,
    reviewer_decisions_sha256: legalOperationsSha256({human_attestations: [], ai_interpretation_policy_sha256: JUNE2026_MINIMUM_WAGE_POLICY_SHA256}),
  };
  const parameters: ParameterCandidate[] = parameterInputs.map((_, index) => {
    const seed = {
      schema_version: 'tivdoc-parameter-candidate-v0.6.0' as const,
      parameter_id: index === 0 ? monthlyId : divisorId, parameter_version: parameterVersion, topic: 'minimum_wage' as const,
      value: index === 0 ? {kind: 'money' as const, value: {currency: 'ILS', minor_units: 644385}}
        : {kind: 'rational' as const, numerator: '182', denominator: '1', unit: 'hours_per_month'},
      unit: index === 0 ? 'currency.ils' : 'hours_per_month', rounding_policy: 'exact' as const,
      effective_from: '2026-06-01', effective_to: '2026-06-30', sectors: [policy.sector], populations: [policy.population],
      operative_source_version_ids: sources.filter(source => source.role === 'primary_binding').map(source => source.source_version_id),
      support_roles: ['primary_binding' as const], bindings,
      decision_id: 'il.minimum.wage.june2026.unsigned.exact182', branch: 'monthly_times_hours_over_182',
    };
    return parameterCandidateSchema.parse({...seed, candidate_sha256: legalOperationsSha256(seed)});
  });
  return frozen({rule, parameters, goldenCases, parameterInputs, humanApproved: false, activationAllowed: false});
}
