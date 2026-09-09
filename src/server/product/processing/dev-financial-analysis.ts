import 'server-only';
import {z} from 'zod';
import {employmentSnapshotSchema} from '@/engine/facts/snapshot';
import {normalizedPayslipExtractionSchema} from '@/engine/extraction/payslip';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {calculateDevMinimumWage,DEV_MINIMUM_WAGE_POLICY} from '@/engine/calculations/dev-minimum-wage';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {renderDevFinancialArtifacts} from '../reports/dev-financial-artifacts';
import {sourceJobSchema,type SourceJob} from './source-dispatch';
import {runSavedWorkerMonth} from './saved-worker';
import {readSavedExtractionProvenance} from './live-extraction-provenance';
import {savedMonthIdempotencyKey} from './saved-order-scope';
import {savedAnalysisId} from './saved-draft-report';
import {DEV_FINANCIAL_SCHEMA,devFinancialFacts,devFinancialFinding,devHoursReadingSchema,devHoursRequestCode,parseDevFinancialRun,assertDevFinancialScenario,devFinancialSourcePage} from './dev-financial-contract';

/** Call inside the provisioned worker transaction. The actual DB boundary
 * requires an allowlisted DEV database and synthetic QA case. No live catalog,
 * canonical finding writer or ordinary report publication gate is changed. */
export async function runSavedDevFinancialMonth(input:{context:PostgresTransactionContext;job:SourceJob;orderId:string;parent?:Awaited<ReturnType<typeof runSavedWorkerMonth>>}){
 const job=sourceJobSchema.parse(input.job);z.uuid().parse(input.orderId);
 const {context}=input;
 const selected=await context.client.query(statement('dev_financial_admit','select private.dev_financial_admit($1::uuid,$2::uuid,$3,$4) source',[job.case_id,input.orderId,job.revision,job.input_sha256]));
 if(selected.rows.length!==1)throw Error('DEV_FINANCIAL_ADMISSION_ACK');
 const source=z.object({document_id:z.uuid(),version_id:z.uuid(),source_sha256:z.string(),checkpoint_sha256:z.string(),path:z.string(),mime:z.string(),size:z.coerce.number(),public_id:z.string(),request_id:z.uuid().nullable(),
  checkpoint:z.object({run:z.object({result:z.object({final_extraction:normalizedPayslipExtractionSchema})})}),input:z.object({answers:z.array(z.record(z.string(),z.unknown())).optional()})}).parse(selected.rows[0].source);
 const extraction=source.checkpoint.run.result.final_extraction;
 const provenance=readSavedExtractionProvenance(z.object({checkpoint:z.unknown()}).parse(selected.rows[0].source).checkpoint);
 // The real V2 adapter retains base/hourly rows in additional_components.
 // Permit exactly one paid base row and at most one quantity/rate-only row;
 // a second paid component would invalidate this deliberately narrow scenario.
 const bases=extraction.additional_components.filter(c=>c.semantic_kind==='base_salary');
 const hourly=extraction.additional_components.filter(c=>c.semantic_kind==='hourly_base');
 const baseValue=extraction.fields.find(f=>f.field==='base_monthly_salary')?.normalized_value;
 if(extraction.document_id!==source.version_id||!extraction.earnings_components_complete
  ||bases.length!==1||hourly.length>1||bases.length+hourly.length!==extraction.additional_components.length
  ||!bases[0].amount||canonicalSha256(bases[0].amount)!==canonicalSha256(baseValue??null)
  ||hourly.some(c=>c.amount_raw!==null||c.amount!==null||c.percentage_raw!==null)
  // V2's documented "high" row score is 0.94. Canonical input confirmation
  // and the existing P95 critical-field gate remain separately enforced.
  ||extraction.additional_components.some(c=>c.confidence<0.94||c.warning_flags.length||c.normalization_warnings.length)
  ||extraction.fields.find(f=>f.field==='salary_type')?.normalized_value!=='hourly')throw Error('DEV_FINANCIAL_SCENARIO_UNSUPPORTED');
 const parent=input.parent??await runSavedWorkerMonth({context,job,orderId:input.orderId,month:'2026-06'});
 if(!parent.bundle)throw Error('DEV_FINANCIAL_PARENT_REQUIRED');
 const parentFacts=employmentSnapshotSchema.parse(z.object({facts:z.unknown()}).parse(parent.stages.find(s=>s.stage==='canonical_facts')?.payload).facts);
 assertDevFinancialScenario(parentFacts,source.version_id);
 const runId=savedAnalysisId('dev-financial-run',canonicalSha256({job,orderId:input.orderId,parent:parent.bundle.result_sha256,policy:DEV_MINIMUM_WAGE_POLICY}));
 const answers=(source.input.answers??[]).filter(a=>a.id===source.request_id);
 if(answers.length>1)throw Error('DEV_FINANCIAL_ANSWER_AMBIGUOUS');
 let reading=null;
 if(answers[0]){
  const a=z.object({id:z.uuid(),case_id:z.uuid(),code:z.string(),scope_month:z.literal('2026-06'),answer_kind:z.literal('number'),answer:z.string(),answer_revision:z.number().int(),answer_identity_id:z.uuid(),answer_created_at:z.string()}).parse(answers[0]);
  if(a.case_id!==job.case_id||a.code!==devHoursRequestCode(job.case_id,input.orderId,source.version_id,source.checkpoint_sha256))throw Error('DEV_FINANCIAL_ANSWER_SOURCE');
  reading=devHoursReadingSchema.parse({request_id:a.id,answer_revision:a.answer_revision,identity_id:a.answer_identity_id,answered_at:a.answer_created_at,answer:a.answer,version_id:source.version_id,checkpoint_sha256:source.checkpoint_sha256});
 }
 const facts=devFinancialFacts(parentFacts,runId,reading),calculation=calculateDevMinimumWage({facts,month:'2026-06',calculatedAt:parentFacts.created_at});
 let requestId=source.request_id;
 if(calculation.state==='missing_input'&&calculation.fields.includes('work.regular_hours')&&!extraction.fields.some(f=>f.field==='regular_hours'&&f.normalized_value!==null)){
  const opened=await context.client.query(statement('dev_financial_request_open','select private.dev_financial_request_open($1::uuid,$2::uuid,$3,$4) id',[job.case_id,input.orderId,job.revision,job.input_sha256]));
  requestId=z.uuid().parse(opened.rows[0]?.id);
 }
 const run=parseDevFinancialRun({schema_version:DEV_FINANCIAL_SCHEMA,authority:'engineering_only',run_id:runId,case_id:job.case_id,public_id:source.public_id,
  order_id:input.orderId,input_revision:job.revision,input_sha256:job.input_sha256,month:'2026-06',parent_run_id:parent.bundle.analysis_run_id,parent_result_sha256:parent.bundle.result_sha256,parent_key:savedMonthIdempotencyKey(job,input.orderId,'2026-06'),
  parent_facts:parentFacts,parent_facts_sha256:canonicalSha256(parentFacts),facts,facts_sha256:canonicalSha256(facts),reading,
  source:{document_id:source.document_id,version_id:source.version_id,source_sha256:source.source_sha256,checkpoint_sha256:source.checkpoint_sha256,path:source.path,mime:source.mime,size:source.size,page:devFinancialSourcePage(parentFacts,source.version_id)},
  policy_sha256:canonicalSha256(DEV_MINIMUM_WAGE_POLICY),created_at:parentFacts.created_at,calculation,finding:devFinancialFinding(runId,calculation),request_id:requestId,
  scenario:'synthetic_adult_hourly_general_182_regular_base_only',extraction_provider:provenance.kind,extraction_provenance:provenance});
 const artifacts=renderDevFinancialArtifacts(run);
 const result=await context.client.query(statement('dev_financial_save','select private.dev_financial_save($1::jsonb,$2,$3,$4) value',
  [JSON.stringify(run),canonicalSha256(run),artifacts.html,Buffer.from(artifacts.pdf).toString('base64')]));
 const receipt=z.object({run_id:z.literal(runId),replayed:z.boolean()}).strict().parse(result.rows[0]?.value);
 return {run,artifacts,receipt};
}
