import 'server-only';
import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {employmentSnapshotSchema} from '@/engine/facts/snapshot';
import {statement} from '@/server/platform/persistence/postgres/contracts';
import {PROJECTION_SCHEMA_VERSION,PROJECTION_LEGAL_BASIS,PROJECTION_TOPICS,parseProjection} from '../reports/case-report-projection';
import {AI_PUBLICATION_POLICY,reportDocumentV3Schema} from '../reports/report-document';
import {savedAnalysisId} from './saved-draft-report';
import type {SavedMonthCompletion} from './saved-job-runner';
import {assertDevFinancialScenario} from './dev-financial-contract';
import {runSavedDevFinancialMonth} from './dev-financial-analysis';

type Input=Parameters<SavedMonthCompletion>[0];
/** A saved canonical result becomes the existing product report envelope.
 * Zero activated rules yields an immutable DRAFT, never a checked finding or
 * report-ready publication. This bridge cannot turn the engineering comparison
 * into a canonical monetary finding. */
export async function saveAutomaticDevCanonicalDraft(input:Input){
 const {context,job,orderId,parent,month}=input;
 if(month!=='2026-06'||!parent.bundle||parent.bundle.case_id!==job.case_id)throw Error('MANAGED_DEV_SCOPE_UNSUPPORTED');
 const bundle=parent.bundle;
 const selected=await context.client.query(statement('automatic_dev_draft_source',
  'select private.dev_financial_admit($1::uuid,$2::uuid,$3,$4) source',[job.case_id,orderId,job.revision,job.input_sha256]));
 const source=z.object({public_id:z.string(),document_id:z.uuid(),version_id:z.uuid(),source_sha256:z.string()}).parse(selected.rows[0]?.source);
 const offer=await context.client.query(statement('automatic_dev_draft_offer','select offer_sha256 from private.product_orders where id=$1::uuid and case_id=$2::uuid',[orderId,job.case_id]));
 const id=savedAnalysisId('automatic-dev-canonical-product-draft',bundle.result_sha256);
 const projection=parseProjection({schema_version:PROJECTION_SCHEMA_VERSION,case_public_id:source.public_id,
  check_period_month:month,months_covered:[month],report_kind:'initial',legal_basis:PROJECTION_LEGAL_BASIS,generated_at:new Date(bundle.as_of).toISOString(),
  topics:PROJECTION_TOPICS.map(topic=>({topic,branches_examined:[],parameter_grades:{},gate:'awaiting_verification',activation:'awaiting_verification',
   status:'not_checked',customer_text:'ממתין לאימות בסיום הפיתוח',blocked_by_grades:['draft']}))});
 const document=reportDocumentV3Schema.parse({schema_version:'tivdoc-report-document-v3',id,case_id:job.case_id,order_id:orderId,revision:job.revision,
  input_sha256:job.input_sha256,projection_sha256:canonicalSha256(projection),purchased_period:{from:month,to:month},projection,
  // The canonical catalog currently produced no findings. The independent
  // canonical report and engineering artifact retain their own source traces.
  evidence:[],findings:[],publication:{state:'draft',approval_actor_kind:'automation',approved_input_sha256:null,published_at:null},
  service_kind:'ai_assisted',publication_policy:AI_PUBLICATION_POLICY,order_offer_sha256:offer.rows[0]?.offer_sha256,
  correction_policy:'append_new_revision_preserve_published'});
 const result=await context.client.query(statement('automatic_dev_canonical_draft_save',
  'select private.automatic_dev_canonical_draft_save($1::jsonb,$2,$3) value',[JSON.stringify(document),bundle.analysis_run_id,bundle.result_sha256]));
 const receipt=z.object({projection_id:z.literal(id),publication:z.literal('draft'),replayed:z.boolean()}).strict().parse(result.rows[0]?.value);
 return {source,receipt};
}

/** Runs inside the runner's existing case/source/lease-fenced transaction.
 * Answers create a new source revision and therefore a new canonical run;
 * retries reuse both run and artifact rather than appending duplicates. */
export const runAutomaticDevMonth:SavedMonthCompletion=async input=>{
 const {source}=await saveAutomaticDevCanonicalDraft(input);
 const facts=employmentSnapshotSchema.parse(z.object({facts:z.unknown()}).parse(input.parent.stages.find(s=>s.stage==='canonical_facts')?.payload).facts);
 // Source-type transcription cannot bypass an unanswered/contradictory month.
 // Either answer order is valid; an incomplete source remains awaiting input.
 const periods=facts.facts.filter(f=>f.path==='documents.period');
 if(periods.length!==1||periods[0].status!=='confirmed'||periods[0].conflicting_fact_ids.length
  ||periods[0].value?.document_id!==source.version_id||periods[0].value.period.start_date!=='2026-06-01'
  ||periods[0].value.period.end_date!=='2026-06-30'
  ||!periods[0].provenance.some(p=>p.source_type==='documented'&&p.source_reference.document_id===source.version_id&&p.source_reference.locator?.page))return;
 const missingSalary=!facts.facts.some(f=>f.path==='compensation.salary_type'&&f.value!==null);
 if(!missingSalary)try{assertDevFinancialScenario(facts,source.version_id);}catch(error){
  if(error instanceof Error&&error.message==='DEV_FINANCIAL_CANONICAL_SCENARIO')return;
  throw error;
 }
 // A pending source confirmation is a waiting state, not a provider failure.
 const essential=facts.facts.filter(f=>['compensation.base_monthly_salary','work.regular_hours'].includes(f.path));
 if(essential.some(f=>f.value!==null&&f.status!=='confirmed'))return;
 try{await runSavedDevFinancialMonth({context:input.context,job:input.job,orderId:input.orderId,parent:input.parent});}
 catch(error){
  if(error instanceof Error&&error.message==='DEV_FINANCIAL_COMPLETIONS_REQUIRED')return;
  throw error;
 }
};
