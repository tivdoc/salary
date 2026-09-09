import {z} from 'zod';
import {employmentSnapshotSchema,type EmploymentSnapshot} from '../facts/snapshot.ts';
import type {CanonicalFact} from '../facts/contracts.ts';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {frozen,legalOperationsSha256} from '../legal-operations/canonical.ts';
import {parameterCandidateSchema,type ParameterCandidate} from '../legal-operations/contracts.ts';
import {createRuleSpecPackage,type RuleSpecPackage} from '../legal-operations/rulespec.ts';
import {MINIMUM_WAGE_HOURLY_SPEC} from '../legal-quality/sensitivity-rulespecs.ts';
import {createSourceCalculationTrace,type SourceCalculationTrace} from './source-trace.ts';
import {createSourceMonetaryComparison,type SourceMonetaryComparison} from '../findings/source-comparison.ts';

/** A comparison policy for one QA scenario, never an active legal catalog.
 * The archived hashes identify existing dossier records. Their raw historical
 * HTML/PDF bytes were not reverified against the fresh page in this review. */
export const DEV_MINIMUM_WAGE_POLICY=frozen({
 schemaVersion:'tivdoc-dev-minimum-wage-policy-v1',
 engineeringOnly:true,activationAllowed:false,pricingAllowed:false,
 topic:'minimum_wage',month:'2026-06',currency:'ILS',
 hourlyRateMinor:3540,maximumRegularHours:182,maximumHoursDecimalPlaces:4,
 parameterIdentity:'il.minimum_wage.hourly',parameterVersion:'2026.1.0',
 parameterState:'derived_engineering_binding_not_registered_or_attested',
 source:{
  sourceVersionId:'IL_MIN_WAGE_OFFICIAL_RATES@discovery-v0',
  authorityRole:'official_implementation',independentlyOperative:false,
  url:'https://www.btl.gov.il/Mediniyut/GeneralData/Pages/%D7%A9%D7%9B%D7%A8%20%D7%9E%D7%99%D7%A0%D7%99%D7%9E%D7%95%D7%9D.aspx',
  accessedDate:'2026-09-09',effectiveFrom:'2026-04-01',
  locator:'logical-page-1; IL_MIN_WAGE_OFFICIAL_RATES@discovery-v0#0002-ec7402f2ab89',
  archivedArtifactSha256:'1d8c2d67faabc435f66b76ccf45dda94d5c16a96c534f6bc7732d4f70366946b',
  archivedParsedSha256:'d4c01a484bb0b8ca6efeca33f839204346c26da118a3a1577eb68dfab34cdd1d',
  dossierPath:'src/engine/legal-knowledge/review-dossier/minimum-wage-evidence.v0.4.json',
  dossierSha256:'1354756f6b87ec1454a93b0e96cc7c4020946143d6174bf1183bfec90945ce19',
  archivedRawBytesReverified:false,
 },
 parentRule:{id:MINIMUM_WAGE_HOURLY_SPEC.rule_spec_id,version:MINIMUM_WAGE_HOURLY_SPEC.rule_spec_version,sha256:MINIMUM_WAGE_HOURLY_SPEC.content_sha256},
 sourceReviewPath:'docs/dev-financial-flow-source-review.md',
 requiredScenarioAssumptions:[
  'synthetic_adult_hourly_employee_general_182_framework',
  'one_complete_known_payroll_period_june_2026',
  'recorded_base_component_covers_exactly_the_regular_hours',
  'no_other_eligible_regular_pay_components_or_special_regime',
 ],
 semantics:'expected_minus_recorded_component_not_proven_unpaid_debt',
 humanAttestations:[],legalGoldenApproval:false,
} as const);

const {content_sha256:parentHash,...parentRule}=MINIMUM_WAGE_HOURLY_SPEC;
void parentHash;
/** Keep the input's actual hours_per_month unit; only the RuleSpec explicitly
 * divides by one of that unit to create the dimensionless scaling operand. */
export const DEV_MINIMUM_WAGE_RULE:RuleSpecPackage=createRuleSpecPackage({
 ...parentRule,
 rule_spec_id:'il.rulespec.minimum.wage.hourly.dev.comparison',rule_spec_version:'1.0.0',
 effective_period:{from:'2026-06-01',to:'2026-06-30'},
 facts:[
  {ref_id:'fact.regular.hours',value_kind:'rational',unit:'hours_per_month'},
  {ref_id:'fact.recorded.base.pay',value_kind:'money',unit:'currency.ils'},
 ],
 parameters:[{ref_id:'parameter.hourly.floor',parameter_id:DEV_MINIMUM_WAGE_POLICY.parameterIdentity,
  parameter_version:DEV_MINIMUM_WAGE_POLICY.parameterVersion,value_kind:'money',unit:'currency.ils'}],
 nodes:[
  {node_id:'unit.one.regular.hour',operation:'constant.rational',value:'1',unit:'hours_per_month'},
  {node_id:'regular.hours.multiplier',operation:'divide',left_ref:'fact.regular.hours',right_ref:'unit.one.regular.hour'},
  {node_id:'expected.regular.pay',operation:'money.scale',money_ref:'parameter.hourly.floor',rational_ref:'regular.hours.multiplier',rounding:'half_up'},
  {node_id:'expected.minus.recorded',operation:'subtract',left_ref:'expected.regular.pay',right_ref:'fact.recorded.base.pay'},
 ],
 output_ref:'expected.minus.recorded',
});

const parameterSeed={
 schema_version:'tivdoc-parameter-candidate-v0.6.0' as const,
 parameter_id:DEV_MINIMUM_WAGE_POLICY.parameterIdentity,parameter_version:DEV_MINIMUM_WAGE_POLICY.parameterVersion,
 topic:'minimum_wage' as const,value:{kind:'money' as const,value:{currency:'ILS',minor_units:DEV_MINIMUM_WAGE_POLICY.hourlyRateMinor}},
 unit:'currency.ils',rounding_policy:'exact' as const,
 effective_from:DEV_MINIMUM_WAGE_POLICY.source.effectiveFrom,effective_to:null,
 sectors:['general'],populations:['general'],
 // This legacy candidate field names its source. The support role and policy
 // explicitly deny independent operative force; no activation is manufactured.
 operative_source_version_ids:[DEV_MINIMUM_WAGE_POLICY.source.sourceVersionId],
 support_roles:['official_implementation' as const],
 bindings:{
  source_bytes_sha256:legalOperationsSha256({recordedArtifact:DEV_MINIMUM_WAGE_POLICY.source.archivedArtifactSha256,
   recordedParsed:DEV_MINIMUM_WAGE_POLICY.source.archivedParsedSha256,rawBytesReverified:false}),
  citations_sha256:legalOperationsSha256(DEV_MINIMUM_WAGE_POLICY.source),
  interval_sha256:legalOperationsSha256({from:DEV_MINIMUM_WAGE_POLICY.source.effectiveFrom,to:null}),
  scope_sha256:legalOperationsSha256(DEV_MINIMUM_WAGE_POLICY.requiredScenarioAssumptions),
  parameter_set_sha256:legalOperationsSha256({id:DEV_MINIMUM_WAGE_POLICY.parameterIdentity,version:DEV_MINIMUM_WAGE_POLICY.parameterVersion,
   value:DEV_MINIMUM_WAGE_POLICY.hourlyRateMinor,currency:'ILS',state:DEV_MINIMUM_WAGE_POLICY.parameterState}),
  rule_spec_sha256:DEV_MINIMUM_WAGE_RULE.content_sha256,
  golden_cases_sha256:DEV_MINIMUM_WAGE_RULE.golden_case_set_sha256,
  reviewer_decisions_sha256:legalOperationsSha256({engineeringOnly:true,humanAttestations:[],activationAllowed:false}),
 },
 decision_id:'legal.reference.il.decision.min_wage_hourly_divisor',branch:'182',
};
export const DEV_MINIMUM_WAGE_PARAMETER:ParameterCandidate=frozen(parameterCandidateSchema.parse({
 ...parameterSeed,candidate_sha256:legalOperationsSha256(parameterSeed),
}));

export type DevMinimumWageField='work.regular_hours'|'compensation.base_monthly_salary';
export type DevMinimumWageResult=
 | Readonly<{state:'missing_input';fields:readonly DevMinimumWageField[]}>
 | Readonly<{state:'calculated';expectedMinor:number;recordedMinor:number;gapMinor:number;
   trace:SourceCalculationTrace;comparison:SourceMonetaryComparison;policy:typeof DEV_MINIMUM_WAGE_POLICY}>;

const requiredFields:readonly DevMinimumWageField[]=['work.regular_hours','compensation.base_monthly_salary'];
const hoursSchema=z.object({amount:z.string().regex(/^(0|[1-9]\d{0,2})(?:\.\d{1,4})?$/u),unit:z.literal('hours_per_month')}).strict();
const baseSchema=z.object({currency:z.literal('ILS'),minor_units:z.number().int().safe().nonnegative()}).strict();

function assertSource(fact:CanonicalFact,allowIdentifiedAnswer:boolean){
 const documented=fact.provenance.some(source=>source.source_type==='documented'&&source.source_reference.locator?.page!==undefined);
 const identifiedAnswer=allowIdentifiedAnswer&&fact.provenance.some(source=>source.source_type==='declared'&&source.source_reference.kind==='case_request_answer');
 if(!documented&&!identifiedAnswer)throw Error('DEV_WAGE_FACT_SOURCE_REQUIRED');
}

function calculationId(facts:EmploymentSnapshot){
 const hash=canonicalSha256({kind:'dev-minimum-wage-comparison',facts,rule:DEV_MINIMUM_WAGE_RULE.content_sha256,
  parameter:DEV_MINIMUM_WAGE_PARAMETER.candidate_sha256,policy:DEV_MINIMUM_WAGE_POLICY});
 return `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`;
}

/** Pure engineering comparison. The coordinator must authenticate QA/DEV,
 * exact source/period, paid scope and any identified answer before constructing
 * this financial run's snapshot. This function neither queries nor authorizes
 * a case and never promotes an unconfirmed canonical fact. */
export function calculateDevMinimumWage(input:{facts:EmploymentSnapshot;month:string;calculatedAt:string}):DevMinimumWageResult{
 if(input.month!==DEV_MINIMUM_WAGE_POLICY.month)throw Error('DEV_WAGE_MONTH_UNSUPPORTED');
 z.iso.datetime({offset:true}).parse(input.calculatedAt);
 const facts=employmentSnapshotSchema.parse(input.facts);
 const fields=requiredFields.filter(path=>{
  const fact=facts.facts.find(item=>item.path===path);
  return !fact||fact.value===null||fact.status!=='confirmed'||fact.conflicting_fact_ids.length>0;
 });
 if(fields.length)return frozen({state:'missing_input' as const,fields});
 const hoursFact=facts.facts.find(fact=>fact.path==='work.regular_hours')!;
 const baseFact=facts.facts.find(fact=>fact.path==='compensation.base_monthly_salary')!;
 assertSource(hoursFact,true);assertSource(baseFact,false);
 const hours=hoursSchema.parse(hoursFact.value),base=baseSchema.parse(baseFact.value);
 const [whole,fraction='']=hours.amount.split('.'),denominator=BigInt(10)**BigInt(fraction.length);
 const numerator=BigInt(whole+fraction);
 if(numerator<=BigInt(0)||numerator>BigInt(DEV_MINIMUM_WAGE_POLICY.maximumRegularHours)*denominator)throw Error('DEV_WAGE_HOURS_OUTSIDE_SCENARIO');
 const trace=createSourceCalculationTrace({
  calculationId:calculationId(facts),caseId:facts.case_id,analysisRunId:facts.analysis_run_id,calculatedAt:input.calculatedAt,
  catalogSha256:canonicalSha256({policy:DEV_MINIMUM_WAGE_POLICY,rule:DEV_MINIMUM_WAGE_RULE.content_sha256,parameter:DEV_MINIMUM_WAGE_PARAMETER.candidate_sha256}),
  facts,rule:DEV_MINIMUM_WAGE_RULE,parameters:[DEV_MINIMUM_WAGE_PARAMETER],bindings:[
   {input_id:'fact.regular.hours',source:{kind:'fact',fact_id:hoursFact.fact_id,value_path:[]}},
   {input_id:'fact.recorded.base.pay',source:{kind:'fact',fact_id:baseFact.fact_id,value_path:[]}},
   {input_id:'parameter.hourly.floor',source:{kind:'parameter',parameter_id:DEV_MINIMUM_WAGE_PARAMETER.parameter_id,parameter_version:DEV_MINIMUM_WAGE_PARAMETER.parameter_version}},
  ],
 });
 const comparison=createSourceMonetaryComparison({trace,expectedRef:'expected.regular.pay',recordedRef:'fact.recorded.base.pay'});
 if(comparison.recorded.minor_units!==base.minor_units)throw Error('DEV_WAGE_RECORDED_BINDING');
 return frozen({state:'calculated' as const,expectedMinor:comparison.expected.minor_units,recordedMinor:comparison.recorded.minor_units,
  gapMinor:comparison.signed_difference.minor_units,trace,comparison,policy:DEV_MINIMUM_WAGE_POLICY});
}
