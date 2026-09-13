import {createRuleSpecPackage,type RuleSpecPackage} from '../legal-operations/rulespec.ts';
import {TRAVEL_DAILY_CAP_SPEC,SICK_PAY_DAILY_RATE_SPEC} from './sensitivity-rulespecs.ts';
function draftOf({content_sha256,...draft}:RuleSpecPackage){void content_sha256;return draft;}
/** D-008: the cap is not an entitlement. Both cheaper fares and actual attendance
 * are required. One-direction transport is represented by the validated fare. */
export const TRAVEL_ACTUAL_COST_SPEC=createRuleSpecPackage({
 ...draftOf(TRAVEL_DAILY_CAP_SPEC),rule_spec_id:'il.rulespec.travel.actual.cost',rule_spec_version:'1.0.0',
 facts:[{ref_id:'fact.workdays.multiplier',value_kind:'rational',unit:'ratio'},{ref_id:'fact.daily.fare',value_kind:'money',unit:'currency.ils'},{ref_id:'fact.monthly.pass',value_kind:'money',unit:'currency.ils'}],
 nodes:[{node_id:'daily.allowed',operation:'min',refs:['fact.daily.fare','parameter.daily.cap']},{node_id:'period.allowed',operation:'money.scale',money_ref:'daily.allowed',rational_ref:'fact.workdays.multiplier',rounding:'half_up'},{node_id:'cheapest.allowed',operation:'min',refs:['period.allowed','fact.monthly.pass']}],output_ref:'cheapest.allowed',
});
/** D-009: ordinary sick-pay branch only; applicability must exclude special
 * medical/collective arrangements. Actual wage is a fact, never minimum wage. */
export const SICK_PAY_ACTUAL_WAGE_SPEC=createRuleSpecPackage({
 ...draftOf(SICK_PAY_DAILY_RATE_SPEC),rule_spec_id:'il.rulespec.sick.pay.actual.wage',rule_spec_version:'1.0.0',
 facts:[...SICK_PAY_DAILY_RATE_SPEC.facts,{ref_id:'fact.daily.wage',value_kind:'money',unit:'currency.ils'}],
 parameters:SICK_PAY_DAILY_RATE_SPEC.parameters.filter(p=>p.ref_id!=='parameter.daily.wage'),
 nodes:[{node_id:'rate.zero',operation:'constant.rational',value:'0',unit:'ratio'},{node_id:'rate.full',operation:'constant.rational',value:'1',unit:'ratio'},
 {node_id:'rate.on.day',operation:'band.lookup',input_ref:'fact.absence.day.index',bands:[{from_inclusive:1,to_exclusive:2,value_ref:'rate.zero'},{from_inclusive:2,to_exclusive:4,value_ref:'parameter.rate.days.2.to.3'},{from_inclusive:4,to_exclusive:null,value_ref:'rate.full'}]},
 {node_id:'sick.pay.on.day',operation:'money.scale',money_ref:'fact.daily.wage',rational_ref:'rate.on.day',rounding:'half_up'}],
 source_version_ids:['IL_SICK_PAY_LAW@discovery-v0'],effective_period:{from:'2022-06-01',to:null},
});
