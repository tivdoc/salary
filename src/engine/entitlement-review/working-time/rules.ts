import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {createRuleSpecPackage,type RuleSpecDraft} from '../../legal-operations/rulespec.ts';
import {documentReviewCalculationInputSchema,type DocumentReviewOperand,type DocumentReviewCalculationInput} from '../../document-review/calculations.ts';
import type {WorkingTimeEntitlementInput,WorkingTimeWorkday,WorkingTimeDecision} from './contracts.ts';
import {sourceNumber,transformedHours,type TimeReading} from './time-source.ts';
import {WORKING_TIME_CATALOG,WORKING_TIME_PINNED_LEGAL_DOCUMENTS,workingTimeLegalSource} from './source-policy.ts';

export type WorkingDayReading={day:WorkingTimeWorkday;readings:TimeReading[];sevenHourDay:boolean;noWork:boolean};
type Candidate=Extract<DocumentReviewCalculationInput['operation'],{kind:'candidate_rule'}>;
export function buildWorkingTimeRule(input:WorkingTimeEntitlementInput,current:WorkingDayReading,prior:WorkingDayReading[],weekly:boolean,restKnown:boolean,decisions:WorkingTimeDecision[],comparison=true){
 const operands:DocumentReviewOperand[]=[],facts:RuleSpecDraft['facts'][number][]=[],nodes:RuleSpecDraft['nodes'][number][]=[],bindings:Candidate['fact_bindings']=[];
 const known=new Map<string,string>();
 const preconditions:string[]=[];
 const fact=(o:DocumentReviewOperand)=>{const sha=canonicalSha256(o),existing=known.get(sha);if(existing)return existing;
  const id=`wt.source.${operands.length}`,ref_id=`fact.${id}`;operands.push({...o,id});
  facts.push({ref_id,value_kind:o.representation==='money_ils'?'money':'rational',unit:o.representation==='money_ils'?'currency.ils':o.quantity_unit});
  bindings.push({ref_id,operand_id:id});known.set(sha,ref_id);return ref_id;};
 const aggregate=(node_id:string,refs:string[])=>{if(!refs.length)return 'wt.zero';nodes.push({node_id,operation:'aggregate.bounded',refs});return node_id;};
 nodes.push({node_id:'wt.zero',operation:'constant.rational',value:'0',unit:'hours'},{node_id:'wt.hour',operation:'constant.rational',value:'1',unit:'hours'});
 const wage=fact(input.regular_hourly_wage);
 const daily=(d:WorkingDayReading,index:number)=>{
  const prefix=`wt.day.${index}`;
  if(d.noWork)return {hours:'wt.zero',regular:'wt.zero',rest:'wt.zero'};
  const hours=aggregate(prefix+'.hours',d.readings.map((r,i)=>fact(transformedHours(r,'minutes',`duration.${index}.${i}`))));
  let limit=d.sevenHourDay?'parameter.daily.seven':fact(d.day.ordinary_limit);
  if(d.sevenHourDay&&sourceNumber(d.day.ordinary_limit,'hours')!==null){
   nodes.push({node_id:prefix+'.limit',operation:'min',refs:['parameter.daily.seven',fact(d.day.ordinary_limit)]});limit=prefix+'.limit';
  }
  if(d.sevenHourDay&&d.day.kind.value!=='pre_rest'){
   const night=aggregate(prefix+'.night',d.readings.map((r,i)=>fact(transformedHours(r,'night_minutes',`night.${index}.${i}`))));
   nodes.push({node_id:prefix+'.is.night',operation:'compare.gte',left_ref:night,right_ref:'parameter.night.minimum'});preconditions.push(prefix+'.is.night');
  }
  nodes.push({node_id:prefix+'.regular',operation:'min',refs:[hours,limit]});
  return {hours,regular:prefix+'.regular',rest:restKnown&&d===current?aggregate(prefix+'.rest',d.readings.map((r,i)=>fact(transformedHours(r,'rest_minutes',`rest.${index}.${i}`)))):'wt.zero'};
 };
 const priorRegular=prior.map((d,i)=>daily(d,i).regular),currentRefs=daily(current,prior.length);
 let regular=currentRefs.regular;
 if(weekly){const sum=aggregate('wt.prior.regular',priorRegular);
  nodes.push({node_id:'wt.week.remaining.raw',operation:'subtract',left_ref:'parameter.week.limit',right_ref:sum},
   {node_id:'wt.week.remaining',operation:'max',refs:['wt.week.remaining.raw','wt.zero']},
   {node_id:'wt.regular',operation:'min',refs:[currentRefs.regular,'wt.week.remaining']});regular='wt.regular';}
 nodes.push({node_id:'wt.ot',operation:'subtract',left_ref:currentRefs.hours,right_ref:regular},
  {node_id:'wt.first',operation:'min',refs:['wt.ot','parameter.first.hours']},
  {node_id:'wt.later',operation:'subtract',left_ref:'wt.ot',right_ref:'wt.first'},
  {node_id:'wt.first.extra',operation:'multiply',left_ref:'wt.first',right_ref:'parameter.first.extra'},
  {node_id:'wt.later.extra',operation:'multiply',left_ref:'wt.later',right_ref:'parameter.later.extra'},
  {node_id:'wt.rest.extra',operation:'multiply',left_ref:currentRefs.rest,right_ref:'parameter.rest.extra'},
  {node_id:'wt.weighted',operation:'add',refs:[currentRefs.hours,'wt.first.extra','wt.later.extra','wt.rest.extra']},
  {node_id:'wt.factor',operation:'divide',left_ref:'wt.weighted',right_ref:'wt.hour'},
  {node_id:'wt.required',operation:'money.scale',money_ref:wage,rational_ref:'wt.factor',rounding:'half_up'});
 let recorded:string|null=null;
 if(comparison){
 if(current.day.recorded_pay)recorded=fact(current.day.recorded_pay);
 else {
  const groups=new Map<string,string[]>();
  for(const [i,a]of (current.day.payroll_allocations??[]).entries()){
   const hours=fact(a.hours),rate=fact(a.hourly_rate);let weighted=hours;
   if(a.percentage){weighted=`wt.allocated.${i}.weighted`;nodes.push({node_id:weighted,operation:'multiply',left_ref:hours,right_ref:fact(a.percentage)});}
   const refs=groups.get(rate)??[];refs.push(weighted);groups.set(rate,refs);
  }
  const pays:string[]=[];
  for(const [i,[rate,refs]]of [...groups].entries()){
   const prefix=`wt.allocated.group.${i}`,hours=aggregate(prefix+'.hours',refs);
   nodes.push({node_id:prefix+'.factor',operation:'divide',left_ref:hours,right_ref:'wt.hour'},
    {node_id:prefix+'.pay',operation:'money.scale',money_ref:rate,rational_ref:prefix+'.factor',rounding:'half_up'});pays.push(prefix+'.pay');
  }
  if(!pays.length)throw Error('WORKING_TIME_ALLOCATION_REQUIRED');
  nodes.push({node_id:'wt.recorded',operation:'aggregate.bounded',refs:pays});recorded='wt.recorded';
 }
 nodes.push({node_id:'wt.difference',operation:'subtract',left_ref:'wt.required',right_ref:recorded});
 }
 const defs=[['night.minimum','2','hours','law',1,'1: at least two actual working hours at night'],['daily.seven','7','hours','law',1,'2(b): night/pre-rest day'],['week.limit','42','hours','week',1,'2.1: weekly ordinary hours'],
  ['first.hours','2','hours','law',4,'16(a): first two overtime hours'],['first.extra','25','ratio','law',4,'16(a): addition above ordinary wage'],
  ['later.extra','50','ratio','law',4,'16(a): later addition above ordinary wage'],['rest.extra','50','ratio','rest',33,'50: additive statutory weekly-rest premium']] as const;
 const parameters:RuleSpecDraft['parameters'][number][]=[],parameterBindings:Candidate['parameter_bindings']=[];
 for(const [key,value,unit,source,page,locator]of defs){const id='legal.'+key;operands.push({id,observation_id:'wt.law.'+key,state:'observed',printed_value:value,
  representation:unit==='ratio'?'percent':'decimal_quantity',quantity_unit:unit,precision:'source_exact',source:workingTimeLegalSource(source,page,locator)});
  parameters.push({ref_id:'parameter.'+key,parameter_id:'il.review.wt.'+key,parameter_version:'1.0.0',value_kind:'rational',unit});parameterBindings.push({ref_id:'parameter.'+key,operand_id:id});}
 const rule=createRuleSpecPackage({schema_version:'tivdoc-rulespec-v0.6.0',rule_spec_id:WORKING_TIME_CATALOG.rule_spec_id,rule_spec_version:comparison?'1.0.0':'1.1.0',topic:'working_time',
  catalog_boundary:'real_inactive',source_version_ids:WORKING_TIME_PINNED_LEGAL_DOCUMENTS.map(d=>d.version_id),effective_period:WORKING_TIME_CATALOG.supported_work_period,
  sectors:['ordinary_explicitly_assessed'],populations:['adult_hourly_explicitly_assessed'],facts,parameters,nodes,output_ref:comparison?'wt.difference':'wt.required',
  golden_case_set_sha256:canonicalSha256({vectors:[{daily_hours:10,limit:8,wage:40,required:420},{night_hours:10,limit:7,wage:40,required:440},
   {rest_night_hours:10,wage:40,required:640},{week:[10,10,10,10,10,8,0],limits:[8,8,8,8,8,7,0],wage:40,required:2520}]}),
  resource_policy:{max_steps:128,max_depth:32,max_aggregate_items:32,max_integer_digits:64}});
 const consumedSources=[...operands.map(o=>o.source),...decisions.flatMap(d=>d.sources)];
 const manifest=input.source_manifest.filter(m=>consumedSources.some(s=>m.document_id===s.document_id&&m.version_id===s.version_id));
 for(const d of WORKING_TIME_PINNED_LEGAL_DOCUMENTS){const existing=manifest.find(m=>m.document_id===d.document_id);
  if(existing&&canonicalSha256(existing)!==canonicalSha256(d))throw Error('WORKING_TIME_LEGAL_PIN');if(!existing)manifest.push(d);}
 return documentReviewCalculationInputSchema.parse({schema_version:'document-review-calculation-input-v1',case_id:input.case_id,run_id:input.run_id,
  check_id:`${input.check_id_prefix}.${current.day.id}${comparison?'':'.expected'}`,period:{from:current.day.date,to:current.readings.map(r=>r.interval.end_at.slice(0,10)).sort().at(-1)??current.day.date},
  evaluated_at:input.evaluated_at,source_manifest:manifest,operands,remittance_status:'not_assessed',operation:{kind:'candidate_rule',rule,fact_bindings:bindings,parameter_bindings:parameterBindings,
   required_decision_ids:decisions.map(d=>d.decision_id),decisions,expected_output_ref:'wt.required',recorded_ref:null,
   ...(preconditions.length?{execution_preconditions:preconditions}:{}),
   ...(comparison?{comparison:{schema_version:'candidate-comparison-v1',expected_ref:'wt.required',recorded_ref:recorded!,difference_ref:'wt.difference',recorded_basis:current.day.recorded_pay?'document_amount':'document_allocation'}}:{}),
   ...(input.conditional_assumptions?.filter(a=>decisions.some(d=>d.decision_id===a.decision_id)).length?{conditional_assumptions:input.conditional_assumptions.filter(a=>decisions.some(d=>d.decision_id===a.decision_id))}:{})}});
}
