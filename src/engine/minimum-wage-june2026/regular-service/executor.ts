import {canonicalSha256,deepFreeze} from '../../rule-runtime/canonical.ts';
import type {EmploymentSnapshot} from '../../facts/snapshot.ts';
import {createSourceCalculationTrace} from '../../calculations/source-trace.ts';
import {createSourceMonetaryComparison,sourceMonetaryComparisonV2Schema} from '../../findings/source-comparison.ts';
import {findingV2Schema} from '../../findings/contracts.ts';
import type {RuleSpecExecutorPort} from '../../wave3/contracts.ts';
import type {June2026AssessmentPacket} from '../assessment-packet.ts';
import {createJune2026MinimumWageCandidate} from '../candidate.ts';
import {assertJune2026RegularAuthority,type June2026RegularAuthority} from './authority.ts';
import {June2026RegularCatalog} from './catalog.ts';
import {resolveJune2026RegularEvidence} from './evidence.ts';
import {createJune2026RegularSourceAdmission} from './source-admission.ts';

export function june2026RegularId(seed:unknown){const s=canonicalSha256(seed);return `${s.slice(0,8)}-${s.slice(8,12)}-4${s.slice(13,16)}-a${s.slice(17,20)}-${s.slice(20,32)}`;}
/** Root loads the same persisted facts/packet immediately before execution;
 * source operands are selected from that snapshot, never from a report fixture. */
export class June2026RegularExecutor implements RuleSpecExecutorPort{
 readonly admission:ReturnType<typeof resolveJune2026RegularEvidence>;
 result:ReturnType<June2026RegularExecutor['materialize']>|null=null;
 constructor(private readonly input:{authority:June2026RegularAuthority;packet:June2026AssessmentPacket;facts:EmploymentSnapshot}){
  this.admission=resolveJune2026RegularEvidence(input);
 }
 private materialize(executionId:string,calculatedAt:string,catalogSha256:string){
  const {authority,packet}=this.input,c=createJune2026MinimumWageCandidate(1);
  const admission=this.admission;
  const facts=admission.effective_facts;
  if(!admission.execution_allowed||admission.preflight?.state!=='candidate_calculated')throw Error('JUNE_REGULAR_EVIDENCE_NOT_ADMITTED');
  const hours=facts.facts.find(f=>f.path==='work.regular_hours'),base=facts.facts.find(f=>f.path==='compensation.base_monthly_salary');
  if(!hours||!base)throw Error('JUNE_REGULAR_SOURCE_OPERANDS_MISSING');
  const trace=createSourceCalculationTrace({calculationId:executionId,caseId:facts.case_id,analysisRunId:facts.analysis_run_id,calculatedAt,
   catalogSha256,facts,rule:c.rule,parameters:c.parameters,bindings:[
    {input_id:'fact.regular.hours',source:{kind:'fact',fact_id:hours.fact_id,value_path:[]}},
    {input_id:'fact.component.1',source:{kind:'fact',fact_id:base.fact_id,value_path:[]}},
    ...c.rule.parameters.map(p=>({input_id:p.ref_id,source:{kind:'parameter' as const,parameter_id:p.parameter_id,parameter_version:p.parameter_version}})),
   ]});
  if(canonicalSha256(trace.execution_output)!==canonicalSha256(admission.preflight.execution.output))throw Error('JUNE_REGULAR_EXECUTION_PREFLIGHT_MISMATCH');
  const comparison=sourceMonetaryComparisonV2Schema.parse(createSourceMonetaryComparison({trace,expectedRef:'expected.regular.pay',recordedRef:'recorded.eligible.pay'}));
  const sourceAdmission=createJune2026RegularSourceAdmission({authority,admission,trace,parentRuleInput:packet.rule_input});
  const required=facts.facts.filter(f=>['work.regular_hours','compensation.base_monthly_salary','compensation.gross_salary','compensation.salary_type','documents.period'].includes(f.path));
  const evidence=required.flatMap(f=>f.provenance).filter((e,i,all)=>all.findIndex(v=>canonicalSha256(v)===canonicalSha256(e))===i);
  // Identified declarations retain medium certainty; signatures approve the
  // applicability policy and never inflate the source reading's confidence.
  const certainty=admission.hours_origin==='identified_declared'||admission.decisions.some(d=>d.declaration?.provenance.some(p=>p.source_type==='declared'))?'medium' as const:'high' as const;
  const finding=comparison.signed_difference.minor_units>0?findingV2Schema.parse({
   schema_version:'tivdoc-source-finding-v2',finding_id:june2026RegularId({run:facts.analysis_run_id,comparison:comparison.sha256,authority:authority.authority_sha256}),
   case_id:facts.case_id,analysis_run_id:facts.analysis_run_id,category:'minimum_wage',status:'candidate',period:{start_date:'2026-06-01',end_date:'2026-06-30'},
   paid:comparison.recorded,expected:comparison.expected,potential_gap:comparison.signed_difference,
   confidence:Math.min(...required.map(f=>f.confidence)),confidence_tier:certainty,fact_references:required.map(f=>f.fact_id),evidence_references:evidence,
   rule:trace.rule,calculation_trace:trace,comparison,requires_confirmation:false,created_at:calculatedAt,
   authority:{namespace:authority.registry.namespace,authority_sha256:authority.authority_sha256,admission_sha256:admission.resolution_sha256,
    assessment_envelope_sha256:authority.assessment_envelope_sha256,real_legal_authority:authority.real_legal_authority,human_report_approval:false},
  }):null;
  const seed={schema_version:'june2026-regular-execution-v1',case_id:facts.case_id,analysis_run_id:facts.analysis_run_id,
   input_revision:packet.current.input_revision,input_sha256:packet.current.input_sha256,order_id:packet.current.order_id,
   authority_sha256:authority.authority_sha256,admission,trace,...(sourceAdmission?{source_admission:sourceAdmission}:{}),comparison,finding,certainty,
   status:comparison.signed_difference.minor_units>0?'finding' as const:'no_gap' as const};
  return deepFreeze({...seed,result_sha256:canonicalSha256(seed)});
 }
 async execute(input:Parameters<RuleSpecExecutorPort['execute']>[0]){
  const {authority,packet}=this.input;assertJune2026RegularAuthority(authority);
  if(Date.parse(input.calculated_at)<Date.parse(authority.assessment.issued_at))throw Error('JUNE_REGULAR_CALCULATION_BEFORE_ASSESSMENT');
  if(canonicalSha256(input.rule_input)!==canonicalSha256(packet.rule_input))throw Error('JUNE_REGULAR_RULE_INPUT_BINDING');
  const expected=await new June2026RegularCatalog(authority).resolve({mode:authority.mode,topic:'minimum_wage',target_date:'2026-06-30',
   as_of:input.calculated_at.slice(0,10),sector:'general_private',population:'adult_general'});
  if(expected.readiness.status!=='READY'||!expected.readiness.usable_for_rules||canonicalSha256(expected)!==canonicalSha256(input.selection))throw Error('JUNE_REGULAR_EXECUTOR_SELECTION');
  const result=this.materialize(input.execution_id,input.calculated_at,input.selection.catalog_sha256);
  if(this.result&&canonicalSha256(this.result)!==canonicalSha256(result))throw Error('JUNE_REGULAR_EXECUTOR_REPLAY');
  this.result=result;
  const c=createJune2026MinimumWageCandidate(1),amount=result.comparison.signed_difference.minor_units<0?null:result.comparison.signed_difference;
  return deepFreeze({topic:'minimum_wage' as const,rule_spec_id:c.rule.rule_spec_id,rule_spec_version:c.rule.rule_spec_version,
   amount,trace:result.trace,...(result.source_admission?{source_admission:result.source_admission}:{}),result_sha256:canonicalSha256({amount,trace:result.trace,...(result.source_admission?{source_admission:result.source_admission}:{})})});
 }
}
export type June2026RegularExecution=NonNullable<June2026RegularExecutor['result']>;
