import {z} from 'zod';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {createRuleSpecPackage,executeRuleSpec,type RuleSpecInputValue} from '../legal-operations/rulespec.ts';

/** AI research only: Annual Vacation Law 3(b)/(c), in gross calendar days.
 * No conversion to net workdays, redemption, monetary gap or price. The caller
 * must establish section 3 applicability and a complete calendar-year basis.
 * See docs/legal/vacation-proration-ai-decision-20260908.he.md. */
export const VACATION_PRORATION_RESEARCH_VERSION='ai.vacation.section3.proration.2026-09-08.v1';
export const VACATION_PRORATION_SPEC=createRuleSpecPackage({
 schema_version:'tivdoc-rulespec-v0.6.0',rule_spec_id:'il.rulespec.vacation.section3.proration',rule_spec_version:'1.0.0',
 topic:'vacation',catalog_boundary:'real_inactive',source_version_ids:['IL_ANNUAL_VACATION_LAW@discovery-v0'],
 effective_period:{from:'2017-01-01',to:'2026-12-31'},sectors:['general'],populations:['general'],
 facts:[{ref_id:'fact.full.calendar.year',value_kind:'boolean',unit:null},{ref_id:'fact.actual.workdays',value_kind:'integer',unit:'days'},{ref_id:'fact.annual.gross.days',value_kind:'integer',unit:'calendar_days'}],
 parameters:[{ref_id:'parameter.full.year.threshold',parameter_id:'il.vacation.section3.full_year_workdays',parameter_version:'1951.1.0',value_kind:'integer',unit:'days'},
  {ref_id:'parameter.partial.year.threshold',parameter_id:'il.vacation.section3.partial_year_workdays',parameter_version:'1951.1.0',value_kind:'integer',unit:'days'}],
 nodes:[{node_id:'threshold',operation:'select',condition_ref:'fact.full.calendar.year',when_true_ref:'parameter.full.year.threshold',when_false_ref:'parameter.partial.year.threshold'},
  {node_id:'capped.workdays',operation:'min',refs:['fact.actual.workdays','threshold']},
  {node_id:'workday.ratio',operation:'divide',left_ref:'capped.workdays',right_ref:'threshold'},
  {node_id:'fractional.days',operation:'multiply',left_ref:'fact.annual.gross.days',right_ref:'workday.ratio'},
  {node_id:'whole.calendar.days',operation:'rational.floor',input_ref:'fractional.days'}],
 output_ref:'whole.calendar.days',golden_case_set_sha256:canonicalSha256({research:VACATION_PRORATION_RESEARCH_VERSION,human_goldens:false}),
 resource_policy:{max_steps:8,max_depth:8,max_aggregate_items:8,max_integer_digits:32},
});
const inputSchema=z.object({calendarYear:z.number().int().min(2017).max(2026),annualGrossDays:z.number().int().refine(n=>[16,18,21,22,23,24,25,26,27,28].includes(n)),
 employmentRelation:z.enum(['whole_year','part_year']),actualWorkdays:z.number().int().min(0).max(366),completeYearEvidence:z.literal(true),section3Applicable:z.literal(true)}).strict();
const parameters:readonly RuleSpecInputValue[]=[{ref_id:'parameter.full.year.threshold',value:{kind:'integer',value:200,unit:'days'}},{ref_id:'parameter.partial.year.threshold',value:{kind:'integer',value:240,unit:'days'}}];
export function researchedVacationProration(candidate:unknown){
 const parsed=inputSchema.safeParse(candidate);
 if(!parsed.success)return {state:'refused' as const,reason:'incomplete_or_unsupported_annual_basis' as const};
 const input=parsed.data,leap=input.calendarYear%4===0&&(input.calendarYear%100!==0||input.calendarYear%400===0);
 if(input.actualWorkdays>(leap?366:365))return {state:'refused' as const,reason:'workdays_exceed_calendar_year' as const};
 const execution=executeRuleSpec({rule:VACATION_PRORATION_SPEC,parameters,facts:[
  {ref_id:'fact.full.calendar.year',value:{kind:'boolean',value:input.employmentRelation==='whole_year'}},
  {ref_id:'fact.actual.workdays',value:{kind:'integer',value:input.actualWorkdays,unit:'days'}},
  {ref_id:'fact.annual.gross.days',value:{kind:'integer',value:input.annualGrossDays,unit:'calendar_days'}},
 ]});
 return {state:'research_candidate' as const,author_kind:'ai' as const,human_attestation:null,activation_allowed:false as const,
  decision_version:VACATION_PRORATION_RESEARCH_VERSION,input_sha256:canonicalSha256(input),execution};
}
