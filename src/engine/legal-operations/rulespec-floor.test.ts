import {it,expect} from 'vitest';
import {createRuleSpecPackage,executeRuleSpec,refs,type RuleSpecInputValue} from './rulespec.ts';
const rule=createRuleSpecPackage({schema_version:'tivdoc-rulespec-v0.6.0',rule_spec_id:'synthetic.floor',rule_spec_version:'1.0.0',topic:'vacation',catalog_boundary:'synthetic_test_only',source_version_ids:['synthetic.source@v0'],effective_period:{from:'2040-01-01',to:null},sectors:['synthetic.sector'],populations:['synthetic.population'],
 facts:[{ref_id:'fact.fraction',value_kind:'rational',unit:'calendar_days'}],parameters:[],nodes:[{node_id:'whole.days',operation:'rational.floor',input_ref:'fact.fraction'}],output_ref:'whole.days',golden_case_set_sha256:'0'.repeat(64),resource_policy:{max_steps:2,max_depth:2,max_aggregate_items:2,max_integer_digits:32}});
const run=(numerator:string,denominator='2')=>executeRuleSpec({rule,parameters:[],facts:[{ref_id:'fact.fraction',value:{kind:'rational',numerator,denominator,unit:'calendar_days'}}]});
it.each([['0',0],['1',0],['3',1],['-1',-1],['-2',-1],['-3',-2]])('floors exact signed rational %s/2 to %s without changing its unit',(n,expected)=>{
 expect(run(n).output).toEqual({kind:'integer',value:expected,unit:'calendar_days'});expect(refs(rule.nodes[0])).toEqual(['fact.fraction']);
});
it('refuses unsafe integer output instead of losing precision',()=>{expect(()=>run('9007199254740992','1')).toThrow('RULESPEC_INTEGER_OVERFLOW');});
it('retains resource and missing-input guards for the new operation',()=>{
 expect(()=>executeRuleSpec({rule,parameters:[],facts:[]})).toThrow('RULESPEC_INPUT_MISSING');
 expect(()=>run('9'.repeat(33),'1')).toThrow();
});
it('does not coerce a non-rational value into a count',()=>{
 const {content_sha256:ignored,...draft}=rule;void ignored;
 expect(()=>createRuleSpecPackage({...draft,facts:[{ref_id:'fact.fraction',value_kind:'money',unit:'currency.xts'}]})).toThrow('RULESPEC_FLOOR_REQUIRES_RATIONAL');
 const facts:RuleSpecInputValue[]=[{ref_id:'fact.fraction',value:{kind:'money',currency:'XTS',minor_units:12}}];
 expect(()=>executeRuleSpec({rule,facts,parameters:[]})).toThrow('RULESPEC_INPUT_TYPE_OR_UNIT_MISMATCH');
});
