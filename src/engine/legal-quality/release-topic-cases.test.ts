import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {executeRuleSpecAtomic,type RuleSpecInputValue} from '../legal-operations/rulespec.ts';
import {MINIMUM_WAGE_HOURLY_SPEC,WORKING_TIME_OVERTIME_SPEC,CONVALESCENCE_DAILY_RATE_SPEC,VACATION_SENIORITY_BAND_SPEC} from './sensitivity-rulespecs.ts';
import {PENSION_CONTRIBUTION_SHADOW_SPEC} from '../shadow/draft-shadow-specs.ts';
import {TRAVEL_ACTUAL_COST_SPEC,SICK_PAY_ACTUAL_WAGE_SPEC} from './release-rulespecs.ts';
const money=(ref_id:string,minor_units:number):RuleSpecInputValue=>({ref_id,value:{kind:'money',currency:'ILS',minor_units}});
const ratio=(ref_id:string,n:number,d=1):RuleSpecInputValue=>({ref_id,value:{kind:'rational',numerator:String(n),denominator:String(d),unit:'ratio'}});
const integer=(ref_id:string,value:number,unit:string):RuleSpecInputValue=>({ref_id,value:{kind:'integer',value,unit}});
const data=JSON.parse(readFileSync('docs/release-evidence/P04-ai-expectations.json','utf8')) as {case_count:number;cases:{id:string;topic:string;input:number;expected:number}[]};
function run(topic:string,value:number,missing=false){
 const r=(ref:string)=>ratio(ref,value*2,2);
 const lanes={
 minimum_wage:{rule:MINIMUM_WAGE_HOURLY_SPEC,facts:[r('fact.hours.multiplier')],parameters:[money('parameter.hourly.floor',3540)]},
 working_time:{rule:WORKING_TIME_OVERTIME_SPEC,facts:[integer('fact.overtime.hours.day',value,'hours'),money('fact.regular.hourly.wage',3000)],parameters:[ratio('parameter.rate.first',5,4),ratio('parameter.rate.second',3,2)]},
 pension:{rule:PENSION_CONTRIBUTION_SHADOW_SPEC,facts:[money('fact.pensionable.wage',value)],parameters:[money('parameter.wage.cap',1376900),ratio('parameter.employee.share',6,100)]},
 travel:{rule:TRAVEL_ACTUAL_COST_SPEC,facts:[r('fact.workdays.multiplier'),money('fact.daily.fare',1200),money('fact.monthly.pass',20000)],parameters:[money('parameter.daily.cap',2260)]},
 convalescence:{rule:CONVALESCENCE_DAILY_RATE_SPEC,facts:[r('fact.convalescence.days.multiplier')],parameters:[money('parameter.daily.rate',45150)]},
 vacation:{rule:VACATION_SENIORITY_BAND_SPEC,facts:[integer('fact.seniority.year',value,'count.years')],parameters:[integer('parameter.days.years.1.to.5',16,'calendar_days'),integer('parameter.days.year.6',18,'calendar_days'),integer('parameter.days.year.7',21,'calendar_days'),integer('parameter.increment.per.year',1,'calendar_days_per_year'),integer('parameter.days.cap',28,'calendar_days')]},
 sick_leave:{rule:SICK_PAY_ACTUAL_WAGE_SPEC,facts:[integer('fact.absence.day.index',value,'days'),money('fact.daily.wage',40000)],parameters:[ratio('parameter.rate.days.2.to.3',1,2)]},
 };
 const lane=lanes[topic as keyof typeof lanes];return executeRuleSpecAtomic({...lane,...missing?{facts:[]}: {}});
}
describe('P04 AI-authored research worksheets, not human ground truth',()=>{
 it.each(data.cases)('$id matches an independently authored expectation',c=>{
  const result=run(c.topic,c.input);expect(result.error_code).toBeNull();const out=result.execution?.output;
  expect(out?.kind==='money'?Number(out.minor_units):out?.kind==='integer'?out.value:null).toBe(c.expected);
 });
 it.each([...new Set(data.cases.map(c=>c.topic))])('%s refuses missing inputs with no partial output',topic=>{
  const result=run(topic,1,true);expect(result.error_code).toBe('RULESPEC_INPUT_MISSING');expect(result.execution).toBeNull();
 });
});
