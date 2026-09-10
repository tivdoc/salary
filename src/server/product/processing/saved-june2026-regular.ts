import 'server-only';
import {z} from 'zod';
import {June2026RegularExecutor} from '@/engine/minimum-wage-june2026/regular-service/executor';
import type {RuleSpecExecutorPort,ReportBuilderPort} from '@/engine/wave3/contracts';
import {June2026RegularReportBuilder} from '../reports/june2026-regular-service';
import {publishSavedAiReport} from '../reports/publish-ai-report';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {assertSavedJune2026RegularAuthority,type SavedJune2026RegularAuthority} from './saved-june2026-regular-authority';
import type {SavedJune2026AdmittedContext} from './saved-june2026-admitted-context';
import {SavedAnalysisDraftBuilder} from './saved-draft-report';
import type {SourceJob} from './source-dispatch';

export class SavedJune2026RegularRuntime implements RuleSpecExecutorPort,ReportBuilderPort{
 private executor:June2026RegularExecutor|null=null;
 private report:June2026RegularReportBuilder|null=null;
 private contextBlocker:string|null='saved_context_not_prepared';
 constructor(private readonly authority:SavedJune2026RegularAuthority,private readonly job:SourceJob,
  private readonly order:{id:string;kind:'initial'|'full';offer_sha256:string},private readonly publicId:string){assertSavedJune2026RegularAuthority(authority,job,order.id);}
 prepare(loaded:SavedJune2026AdmittedContext){
  if(loaded.state!=='context_loaded'){this.contextBlocker=loaded.code;return;}
  this.contextBlocker=null;
  this.executor=new June2026RegularExecutor({authority:this.authority.authority,packet:loaded.admission_assessment,facts:loaded.facts});
  this.report=new June2026RegularReportBuilder({authority:this.authority.authority,executor:this.executor,publicId:this.publicId,offerSha256:this.order.offer_sha256,reportKind:this.order.kind});
 }
 blockers(){
  if(this.executor?.admission.execution_allowed)return null;
  return {status:'blocked_missing_facts' as const,blockers:this.contextBlocker?[this.contextBlocker]:this.executor?.admission.blockers??['regular_evidence_not_prepared']};
 }
 diagnostics(){return {schema_version:'saved-june2026-regular-diagnostics-v1',namespace:this.authority.authority.registry.namespace,
  authority_sha256:this.authority.authority.authority_sha256,registry_sha256:this.authority.registry_sha256,
  assessment_sha256:this.authority.assessment_sha256,admission:this.executor?.admission??null,execution:this.executor?.result??null,context_blocker:this.contextBlocker};}
 async execute(input:Parameters<RuleSpecExecutorPort['execute']>[0]){
  assertSavedJune2026RegularAuthority(this.authority,this.job,this.order.id);
  if(!this.executor)throw Error('REGULAR_SAVED_CONTEXT_REQUIRED');return this.executor.execute(input);
 }
 async build(bundle:Parameters<ReportBuilderPort['build']>[0]){
  return this.executor?.result&&this.report?this.report.build(bundle):new SavedAnalysisDraftBuilder().build(bundle);
 }
 async persist(context:PostgresTransactionContext,runId:string){
  if(!this.executor?.result)return null;
  if(!this.report?.document)throw Error('REGULAR_REPORT_DOCUMENT_REQUIRED');
  const result=await context.client.query(statement('regular_canonical_save',
   'select private.june2026_regular_result_save($1::uuid,$2::uuid,$3,$4,$5,$6::jsonb,$7::jsonb) value',
   [this.job.case_id,this.order.id,this.job.revision,this.job.input_sha256,runId,JSON.stringify(this.executor.result),JSON.stringify(this.report.document)]));
  const saved=z.object({projection_id:z.uuid(),identity_id:z.uuid()}).parse(result.rows[0]?.value);
  if(saved.projection_id!==this.report.document.id)throw Error('REGULAR_REPORT_SAVE_ACK');
  return publishSavedAiReport(context,{caseId:this.job.case_id,identityId:saved.identity_id,projectionId:saved.projection_id});
 }
}
