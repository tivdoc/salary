import type {EmploymentSnapshot} from '../facts/snapshot.ts';
import {employmentSnapshotSchema} from '../facts/snapshot.ts';
import {sourceTraceFixture} from '../calculations/source-trace.fixtures.ts';
import {createSourceCalculationTrace} from '../calculations/source-trace.ts';
import {createRuleSpecPackage} from '../legal-operations/rulespec.ts';
import {legalOperationsSha256} from '../legal-operations/canonical.ts';
import {createSourceMonetaryComparison} from './source-comparison.ts';

/** Synthetic arithmetic only: expected is the same recorded figure +/- one
 * minor unit. This is deliberately not a meaningful legal entitlement rule. */
export function sourceComparisonFixture(direction:'positive'|'negative'|'zero'='positive',provided?:EmploymentSnapshot){
 const start=sourceTraceFixture(provided);
 const facts=provided??employmentSnapshotSchema.parse({...start.input.facts,facts:start.input.facts.facts.map(f=>({...f,provenance:[{source_type:'documented',source_reference:{kind:'document',document_id:'77777777-7777-4777-8777-777777777777',locator:{page:1}},read_by:'machine',verified:false}]}))});
 const {input}=sourceTraceFixture(facts),{content_sha256,...seed}=input.rule;void content_sha256;
 const rule=createRuleSpecPackage({...seed,nodes:[direction==='negative'?{node_id:'result.amount',operation:'subtract',left_ref:'fact.salary',right_ref:'parameter.amount'}:seed.nodes[0],
  {node_id:'result.difference',operation:'subtract',left_ref:'result.amount',right_ref:'fact.salary'}],output_ref:'result.difference'});
 const {candidate_sha256,...candidate}=input.parameters[0];void candidate_sha256;
 const parameterSeed={...candidate,value:{kind:'money' as const,value:{currency:input.parameters[0].value.kind==='money'?input.parameters[0].value.value.currency:'XTS',minor_units:direction==='zero'?0:1}},bindings:{...candidate.bindings,rule_spec_sha256:rule.content_sha256}};
 const parameters=[{...parameterSeed,candidate_sha256:legalOperationsSha256(parameterSeed)}];
 const traceInput={...input,facts,rule,parameters},trace=createSourceCalculationTrace(traceInput);
 return {traceInput,trace,comparison:createSourceMonetaryComparison({trace,expectedRef:'result.amount',recordedRef:'fact.salary'})};
}
