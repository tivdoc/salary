import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {createRuleSpecPackage,type RuleSpecDraft} from '../../legal-operations/rulespec.ts';
import {documentReviewCalculationInputSchema,type DocumentReviewCalculationInput,type DocumentReviewOperand} from '../../document-review/calculations.ts';
import type {VacationEntitlementInput,VacationDecision} from './contracts.ts';
import {VACATION_SOURCE_REVIEW,VACATION_LEGAL_MANIFEST,vacationLegalSource} from './sources.ts';

type Node=RuleSpecDraft['nodes'][number];
type Binding={ref_id:string;operand:DocumentReviewOperand};
function integer(ref:string,value:number,unit:'calendar_days'|'days',amendment=false):Binding{
 return {ref_id:ref,operand:{id:ref,observation_id:ref,state:'observed',printed_value:String(value),representation:'integer',quantity_unit:unit,precision:'source_exact',
  source:vacationLegalSource(amendment?'amendment15':'law',amendment?2:1,amendment?'section 1; effective 2017-01-01':`section 3; ${ref}`)}};
}
const declaration=(b:Binding)=>({ref_id:b.ref_id,value_kind:b.operand.representation==='money_ils'?'money' as const:b.operand.representation==='boolean'?'boolean' as const:b.operand.representation==='integer'?'integer' as const:'rational' as const,
 unit:b.operand.representation==='money_ils'?'currency.ils':b.operand.representation==='boolean'?null:b.operand.quantity_unit});

function candidate(input:VacationEntitlementInput,checkId:string,facts:Binding[],parameters:Binding[],nodes:Node[],output:string,decisions:VacationDecision[],comparison=false):DocumentReviewCalculationInput{
 const expected=output;
 if(comparison){nodes=[...nodes,{node_id:'vacation.pay.difference',operation:'subtract',left_ref:expected,right_ref:'fact.recorded'}];output='vacation.pay.difference';}
 const rule=createRuleSpecPackage({schema_version:'tivdoc-rulespec-v0.6.0',rule_spec_id:`il.review.vacation.${checkId.split('.').slice(-2).join('.')}`,
  rule_spec_version:input.derived_seniority&&checkId.includes('.annual.')?'1.1.0':'1.0.0',topic:'vacation',catalog_boundary:'real_inactive',source_version_ids:VACATION_LEGAL_MANIFEST.map(s=>s.version_id),
  effective_period:VACATION_SOURCE_REVIEW.supported_period,sectors:['general_private_conditionally_assessed'],populations:['adult_21_59'],
  facts:facts.map(declaration),parameters:parameters.map(b=>({...declaration(b),parameter_id:`il.vacation.${b.ref_id}`,parameter_version:'1.0.0'})),nodes,output_ref:output,
  golden_case_set_sha256:canonicalSha256({annual_gross:[16,18,21,22,28],whole_year_100_of_200:8,part_year_100_of_240:6,
   quarter_wage_9000_calendar_days_5:'500.00',human_goldens:false}),resource_policy:{max_steps:32,max_depth:24,max_aggregate_items:16,max_integer_digits:64}});
 const operands=[...facts,...parameters].map((b,index)=>({...b.operand,id:`vacation.operand.${index}`}));
 const used=[...operands.map(o=>o.source),...decisions.flatMap(d=>d.sources)];
 const manifest=input.source_manifest.filter(m=>used.some(s=>s.document_id===m.document_id&&s.version_id===m.version_id));
 for(const law of VACATION_LEGAL_MANIFEST){const prior=input.source_manifest.find(m=>m.document_id===law.document_id);if(prior&&canonicalSha256(prior)!==canonicalSha256(law))throw Error('VACATION_LEGAL_MANIFEST_PIN');if(!manifest.some(m=>m.document_id===law.document_id))manifest.push(law);}
 const assumptions=input.conditional_assumptions?.filter(a=>decisions.some(d=>d.decision_id===a.decision_id));
 return documentReviewCalculationInputSchema.parse({schema_version:'document-review-calculation-input-v1',case_id:input.case_id,run_id:input.run_id,check_id:checkId,
  period:input.period,evaluated_at:input.evaluated_at,source_manifest:manifest,operands,remittance_status:input.remittance_status,input_basis_policy:'all-consumed-citations-v2',
  operation:{kind:'candidate_rule',rule,fact_bindings:facts.map((b,i)=>({ref_id:b.ref_id,operand_id:operands[i].id})),
   parameter_bindings:parameters.map((b,i)=>({ref_id:b.ref_id,operand_id:operands[facts.length+i].id})),
   required_decision_ids:decisions.map(d=>d.decision_id),decisions,expected_output_ref:expected,recorded_ref:null,
   ...(assumptions?.length?{conditional_assumptions:assumptions}:{}),
   ...(comparison?{comparison:{schema_version:'candidate-comparison-v1',expected_ref:expected,recorded_ref:'fact.recorded',difference_ref:output,recorded_basis:'document_allocation'}}:{})}});
}

/** Count / count derives a dimensionless multiplier; no count is relabelled
 * as calendar days. The increment after year seven remains visible in trace. */
export function vacationAnnualCalculation(input:VacationEntitlementInput,decisions:VacationDecision[],prorate?:{wholeYear:boolean;workdays:DocumentReviewOperand}){
 if(!input.seniority_year&&!input.derived_seniority)throw Error('VACATION_SENIORITY_REQUIRED');
 const facts:Binding[]=input.seniority_year?[{ref_id:'fact.seniority',operand:input.seniority_year}]:[],parameters=[integer('parameter.first.five',16,'calendar_days',true),integer('parameter.year.six',18,'calendar_days'),integer('parameter.year.seven',21,'calendar_days'),integer('parameter.increment',1,'calendar_days'),integer('parameter.cap',28,'calendar_days')];
 // Opt-in calendar extraction is explicit in the RuleSpec and source-bound
 // decision trace. No computed seniority is called an observed document cell.
 const derived:Node[]=input.seniority_year?[]:[{node_id:'source.employment.start.year',operation:'constant.integer',value:Number(input.derived_seniority!.employment_start.slice(0,4)),unit:'count'},
  {node_id:'source.reference.year',operation:'constant.integer',value:2026,unit:'count'},{node_id:'source.year.offset',operation:'subtract',left_ref:'source.reference.year',right_ref:'source.employment.start.year'},
  {node_id:'source.year.one',operation:'constant.integer',value:1,unit:'count'},{node_id:'fact.seniority',operation:'add',refs:['source.year.offset','source.year.one']}];
 const nodes:Node[]=[...derived,{node_id:'boundary.seven',operation:'constant.integer',value:7,unit:'count'},
  {node_id:'count.one',operation:'constant.integer',value:1,unit:'count'},
  {node_id:'years.after.seven',operation:'subtract',left_ref:'fact.seniority',right_ref:'boundary.seven'},
  {node_id:'year.multiplier',operation:'divide',left_ref:'years.after.seven',right_ref:'count.one'},
  {node_id:'days.added',operation:'multiply',left_ref:'parameter.increment',right_ref:'year.multiplier'},
  {node_id:'days.uncapped',operation:'add',refs:['parameter.year.seven','days.added']},
  {node_id:'days.capped',operation:'min',refs:['days.uncapped','parameter.cap']},
  {node_id:'ratio.one',operation:'constant.integer',value:1,unit:'ratio'},
  {node_id:'days.capped.rational',operation:'divide',left_ref:'days.capped',right_ref:'ratio.one'},
  {node_id:'days.after.seven',operation:'rational.floor',input_ref:'days.capped.rational'},
  {node_id:'annual.gross.days',operation:'band.lookup',input_ref:'fact.seniority',bands:[
   {from_inclusive:1,to_exclusive:6,value_ref:'parameter.first.five'},{from_inclusive:6,to_exclusive:7,value_ref:'parameter.year.six'},
   {from_inclusive:7,to_exclusive:8,value_ref:'parameter.year.seven'},{from_inclusive:8,to_exclusive:null,value_ref:'days.after.seven'}]}];
 let output='annual.gross.days';
 if(prorate){facts.push({ref_id:'fact.workdays',operand:prorate.workdays});
  parameters.push(integer('parameter.annual.threshold',prorate.wholeYear?200:240,'days'));
  nodes.push({node_id:'annual.capped.workdays',operation:'min',refs:['fact.workdays','parameter.annual.threshold']},
   {node_id:'annual.workday.ratio',operation:'divide',left_ref:'annual.capped.workdays',right_ref:'parameter.annual.threshold'},
   {node_id:'annual.fractional.days',operation:'multiply',left_ref:'annual.gross.days',right_ref:'annual.workday.ratio'},
   {node_id:'annual.prorated.days',operation:'rational.floor',input_ref:'annual.fractional.days'});output='annual.prorated.days';}
 return candidate(input,`${input.check_prefix}.annual.${prorate?'prorated':'quota'}`,facts,parameters,nodes,output,decisions);
}

export function vacationPayCalculation(input:VacationEntitlementInput,decisions:VacationDecision[],compared=false){
 const p=input.leave_pay;if(!p?.wage)throw Error('VACATION_PAY_WAGE_REQUIRED');
 const facts:Binding[]=[{ref_id:'fact.wage',operand:p.wage}],parameters:Binding[]=[],nodes:Node[]=[];
 if(p.mode==='hourly_quarter'){
  if(!p.leave_calendar_days)throw Error('VACATION_PAY_DAYS_REQUIRED');facts.push({ref_id:'fact.leave.days',operand:p.leave_calendar_days});
  parameters.push({...integer('parameter.quarter.divisor',90,'calendar_days'),operand:{...integer('parameter.quarter.divisor',90,'calendar_days').operand,source:vacationLegalSource('law',3,'section 10(b)(2): quarter wage / 90; selected preceding quarter')}});
  nodes.push({node_id:'leave.quarter.ratio',operation:'divide',left_ref:'fact.leave.days',right_ref:'parameter.quarter.divisor'},
   {node_id:'vacation.pay.expected',operation:'money.scale',money_ref:'fact.wage',rational_ref:'leave.quarter.ratio',rounding:'half_up'});
 }else nodes.push({node_id:'vacation.pay.expected',operation:'aggregate.bounded',refs:['fact.wage']});
 if(compared){if(!p.recorded)throw Error('VACATION_RECORDED_REQUIRED');facts.push({ref_id:'fact.recorded',operand:p.recorded});}
 return candidate(input,`${input.check_prefix}.pay.${compared?'comparison':'expected'}`,facts,parameters,nodes,'vacation.pay.expected',decisions,compared);
}
