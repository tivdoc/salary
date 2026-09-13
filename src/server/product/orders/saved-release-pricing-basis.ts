import 'server-only';
import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {assertAiReleaseRuntimeResult,type AiReleaseRuntimeResult} from '@/engine/ai-release-runtime/runtime';
import {assertCaseAnalysisAiReleaseScope,CASE_ANALYSIS_AI_RELEASE_CODE_VERSION} from '@/engine/case-analysis/contracts';
import type {DocumentReviewCalculationInput,DocumentReviewOperand} from '@/engine/document-review/calculations';
import {decodeBundle,decodeCommand,decodeReport} from '@/server/platform/persistence/postgres/analysis/validation';
import {statement} from '@/server/platform/persistence/postgres/contracts';
import {loadSavedRealAiServiceConfiguration,assertSavedRealAiServiceCurrent} from '../processing/saved-real-ai-service-configuration';
import {lockCurrentSource,sourceJobSchema,type SourceJob} from '../processing/source-dispatch';
import {readSavedOrders,purchasedMonths,savedOrderLegalTopics,savedOrderReceiptSha256,savedOrderOrigin} from '../processing/saved-order-scope';
import {savedAiReleaseBaseKey,resolveSavedDocumentReviewKey} from '../processing/document-review-key';
import {savedCaseTenant} from '../processing/saved-admission';
import {AI_RELEASE_REPORT_TEMPLATE} from '../reports/ai-release-report';
import {pricingBasisSchema,releasePricingBasisSchema,RELEASE_PRICING_BASIS_VERSION,type SavedReleasePricingBasis} from './pricing';
import type {SavedReleasePricingBasisReader} from './quote-ledger';

const sha=z.string().regex(/^[a-f0-9]{64}$/u);
const findingRow=z.object({id:z.uuid(),finding_receipt_sha256:sha,calculation_payload:z.unknown(),
 source_fact_references:z.object({schema_version:z.literal('ai-release-fact-references-v1'),
  canonical_facts_snapshot_sha256:sha,source_input_sha256:sha,parameter_manifest_sha256:sha,source_operands:z.unknown()}).strict()});
type FindingRow=z.infer<typeof findingRow>;
type Check=AiReleaseRuntimeResult['checks'][number];
type Candidate=Extract<DocumentReviewCalculationInput['operation'],{kind:'candidate_rule'}>;
const same=(a:unknown,b:unknown)=>canonicalSha256(a)===canonicalSha256(b);
/** Software coverage only; no implication that the customer's data is missing. */
export function savedReleasePricingUnsupportedTopics(topics:readonly string[]){
 return topics.filter(topic=>!['minimum_wage','working_time','travel','pension','convalescence','vacation','rest_day','contract','bonuses'].includes(topic));
}

// Explicit economic identity, independent of generated check IDs and numbers.
// The same wage month cannot be counted twice under two minimum-wage methods.
function economicIdentity(check:Check){
 if((check.topic==='working_time'||check.topic==='rest_day')&&check.rule_id==='il.review.working-time.required-versus-allocated')return `workday:${check.period.from}`;
 if(check.topic==='minimum_wage'&&/^il\.review\.minimum-wage\.(published_hourly_182|monthly_exact_div182|full_monthly)\.components\.\d+$/u.test(check.rule_id))return 'ordinary_wage';
 if(check.topic==='travel'&&/^il\.review\.travel\.(general_order_floor\.)?[a-z_]+\.(expected|comparison)$/u.test(check.rule_id))return 'travel_reimbursement';
 if(check.topic==='convalescence'&&/^il\.review\.convalescence\.2026\.calendar-fraction\.[1-9]\d*\.(expected|comparison)$/u.test(check.rule_id))return 'convalescence_payment';
 if(check.topic==='vacation'&&/^il\.review\.vacation\.pay\.(expected|comparison)$/u.test(check.rule_id))return 'vacation_payment';
 if(check.topic==='contract'||check.topic==='bonuses'){
  const scope=new RegExp(`^il\\.review\\.${check.topic}\\.(fixed|linear)\\.(expected|comparison)\\.([a-f0-9]{16})$`,'u').exec(check.rule_id)?.[3];
  if(scope)return `obligation:${scope}`;
 }
 if(check.topic==='pension'){
  const share=/^il\.review\.pension\.(employee|employer|severance)\.(expected|comparison)(\.floor)?$/u.exec(check.rule_id)?.[1];
  if(share)return `pension_${share}`;
 }
 return null;
}
function recordedOperands(op:Candidate,input:DocumentReviewCalculationInput){
 const ref=op.comparison?.recorded_ref;if(!ref)return [];
 if(op.rule.rule_spec_id==='il.review.working-time.required-versus-allocated'){
  const found=new Map<string,DocumentReviewOperand>(),visited=new Set<string>();
  // Follow only the actual compiled payroll-allocation subtree. Shared rates
  // are evidence, but allocated hour observations identify the payment rows.
  const visit=(id:string):boolean=>{
   if(visited.has(id))return true;visited.add(id);if(visited.size>64)return false;
   const binding=op.fact_bindings.find(b=>b.ref_id===id);
   if(binding){const operand=input.operands.find(o=>o.id===binding.operand_id);if(!operand)return false;found.set(operand.id,operand);return true;}
   const node=op.rule.nodes.find(n=>n.node_id===id);if(!node)return false;
   if(id==='wt.hour')return node.operation==='constant.rational'&&node.value==='1'&&node.unit==='hours';
   if(!id.startsWith('wt.allocated.')&&id!=='wt.recorded')return false;
   const refs=node.operation==='aggregate.bounded'?node.refs:node.operation==='money.scale'?[node.money_ref,node.rational_ref]
    :node.operation==='divide'||node.operation==='multiply'?[node.left_ref,node.right_ref]:null;
   return refs!==null&&refs.every(visit);
  };
  return visit(ref)?[...found.values()]:[];
 }
 const direct=op.fact_bindings.find(b=>b.ref_id===ref);
 const aggregate=op.rule.nodes.find(n=>n.node_id===ref);
 const refs=direct?[ref]:aggregate?.operation==='aggregate.bounded'?aggregate.refs:[];
 return refs.map(id=>input.operands.find(o=>o.id===op.fact_bindings.find(b=>b.ref_id===id)?.operand_id));
}

/** v1.1 commercial basis: exact, source-supported comparisons, NOT an assertion
 * of legal debt or actual remittance. `high` denotes an exact admitted amount;
 * `employer_owes` is the historical pricing contract's positive-gap direction.
 * Neither changes qualified_ai_report / verified_debt:false in saved results.
 * This bounded map covers minimum wage, source-allocated workdays/rest days, travel, separate pension
 * shares, due convalescence payments, actual leave pay and a single positive explicit obligation. Other monetary families, conditional results, missing comparisons,
 * offsets and ambiguous allocations remain amount_unknown (null), never zero.
 * Expected/comparison twins share ONE economic identity. Distinct identities
 * must also have disjoint recorded observations AND source locations. Common
 * wage bases may support pension shares; a payment row may never be reused.
 * Workday compensation includes ordinary pay. Positive workday and monthly
 * minimum-wage gaps therefore require a cross-topic economic allocation that
 * the current source model does not provide; different cells cannot prove it.
 * Zero minimum-wage comparison plus positive workday gaps is non-additive only
 * in its zero component and may be priced. Rest-day coverage must be independently purchased and fully calculated.
 * Positive leave-pay and ordinary/workday wage gaps likewise require an
 * economic allocation before addition. Vacation quota/prorated calendar days
 * remain checked noncash outputs; they are never priced or converted to money.
 * Convalescence must already have a due date in this month and a complete
 * source-allocated payment comparison; accrued entitlement alone is insufficient.
 * Only the actually checked month is priced; no extrapolation or debt total.
 */
export function mapSavedReleasePricingBasis(input:{result:AiReleaseRuntimeResult;identityId:string;analysisVersion:string;
 factsSha256:string;findings:readonly FindingRow[];onUnavailable?:(reason:string)=>void}):SavedReleasePricingBasis|null{
 const r=input.result;assertAiReleaseRuntimeResult(r);
 const unavailable=(reason:string)=>{input.onUnavailable?.(reason);return null;};
 const rows=input.findings.map(row=>findingRow.parse(row));
 if(rows.length!==r.findings.length||new Set(rows.map(row=>row.id)).size!==rows.length
  ||new Set(rows.map(row=>row.finding_receipt_sha256)).size!==rows.length)throw Error('PRICING_FINDING_SET_MISMATCH');
 for(const f of r.findings){
  const row=rows.find(row=>row.finding_receipt_sha256===f.sha256);
  if(!row||!same(row.calculation_payload,f)||!same(row.source_fact_references,{schema_version:'ai-release-fact-references-v1',
   canonical_facts_snapshot_sha256:input.factsSha256,source_input_sha256:r.current_scope.input_sha256,
   parameter_manifest_sha256:f.family_parameter_manifest_sha256,source_operands:f.source_operands}))throw Error('PRICING_FINDING_RECEIPT_MISMATCH');
 }
 const topics=r.purchased_scope.topics;
 if(!topics.length||savedReleasePricingUnsupportedTopics(topics).length)return unavailable('pricing_adapter_unsupported_topics');
 const families=r.families.filter(f=>topics.includes(f.topic));
 if(families.length!==topics.length||families.some(f=>f.state!=='qualified'||f.coverage_gaps.length||f.nonmonetary_outcomes.length)){
  const conditional=families.some(f=>f.checks.some(c=>c.blockers.some(b=>b.code==='AI_RUNTIME_COUNTERFACTUAL_ONLY')));
  return unavailable(conditional?'pricing_comparison_conditional':'pricing_comparison_incomplete');
 }
 const checks=families.flatMap(f=>f.checks),groups=new Map<string,Check[]>();
 const positive=(topic:string)=>checks.some(c=>c.topic===topic&&c.difference?.kind==='money'&&c.difference.minor_units>0);
 if(positive('minimum_wage')&&(positive('working_time')||positive('rest_day')))return unavailable('pricing_cross_topic_allocation_unavailable');
 if(positive('vacation')&&(positive('minimum_wage')||positive('working_time')||positive('rest_day')))return unavailable('pricing_cross_topic_allocation_unavailable');
 // A source-specific obligation is not proof that another positive award is
 // economically independent. Admit a single positive obligation only; complete
 // zero comparisons still prove checked scope, without adding any money.
 if(positive('contract')||positive('bonuses')){
  const positiveComparisons=checks.filter(c=>c.recorded?.kind==='money'&&c.difference?.kind==='money'&&c.difference.minor_units>0);
  if(positiveComparisons.length!==1)return unavailable('pricing_cross_topic_allocation_unavailable');
 }
 for(const check of checks){
  if(check.state!=='calculated'||check.blockers.length)return unavailable('pricing_comparison_incomplete');
  // Only these factory-issued, resolved calendar-day outputs are noncommercial.
  // Missing/conditional annual evidence was rejected at the family boundary.
  if(check.topic==='vacation'&&/^il\.review\.vacation\.annual\.(quota|prorated)$/u.test(check.rule_id)
   &&check.expected?.kind==='integer'&&check.expected.unit==='calendar_days'&&check.recorded===null&&check.difference===null)continue;
  const key=economicIdentity(check);if(!key)return unavailable('pricing_adapter_unsupported_rule_branch');
  groups.set(key,[...(groups.get(key)??[]),check]);
 }
 const components:z.infer<typeof releasePricingBasisSchema>['components']=[],used=new Set<string>();
 for(const [economic_key,group] of groups){
  if(economic_key.startsWith('obligation:')&&group.length!==2)return unavailable('pricing_comparison_alternatives');
  const comparisons=group.filter(c=>c.recorded?.kind==='money'&&c.difference?.kind==='money');
  if(comparisons.length!==1)return unavailable(comparisons.length?'pricing_comparison_alternatives':'pricing_recorded_comparison_missing');
  const c=comparisons[0],calculation=r.review.checks.find(check=>check.check_id===c.check_id)?.calculation;
  if(!calculation||calculation.input.operation.kind!=='candidate_rule')return null;
  const op=calculation.input.operation;
  if(op.conditional_assumptions?.length||!op.comparison||c.expected?.kind!=='money'||c.recorded?.kind!=='money'||c.difference?.kind!=='money'
   ||[c.expected,c.recorded,c.difference].some(v=>v.currency!=='ILS')||c.expected.minor_units<0||c.recorded.minor_units<0
   ||c.difference.minor_units<0||c.expected.minor_units-c.recorded.minor_units!==c.difference.minor_units)return null;
  // An expected-only twin may be skipped only when the same actual comparison
  // supplies precisely that expected value; it never contributes an amount.
  if(group.some(other=>!same(other.expected,c.expected)||!same(other.period,c.period)))return null;
  const month=c.period.from.slice(0,7),end=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),0)).toISOString().slice(0,10);
  if(c.topic==='working_time'||c.topic==='rest_day'){
   if(c.period.from<r.current_scope.period.from||c.period.to>r.current_scope.period.to||c.period.to.slice(0,7)!==month)return unavailable('pricing_workday_outside_checked_month');
  }else if(c.period.from!==`${month}-01`||c.period.to!==end||!same(c.period,r.current_scope.period))return null;
  const recorded=recordedOperands(op,calculation.input);if(!recorded.length||recorded.some(o=>!o))return unavailable('pricing_adapter_unsupported_payment_expression');
  const banded=(c.topic==='working_time'||c.topic==='rest_day')&&op.comparison.recorded_basis==='document_allocation';
  if(banded&&!recorded.some(o=>o?.quantity_unit==='hours'))return unavailable('pricing_payment_allocation_missing');
  const evidence_ids:string[]=[];
  for(const operand of recorded){
   if(!operand||operand.state!=='observed'||!banded&&operand.representation!=='money_ils'||operand.printed_value===null)return unavailable('pricing_payment_source_incomplete');
   const s=operand.source,manifest=c.source_manifest.find(m=>m.kind==='case_document'&&m.case_id===r.case_id&&m.document_id===s.document_id&&m.version_id===s.version_id&&m.file_sha256===s.file_sha256);
   if(!manifest||!z.uuid().safeParse(s.version_id).success||s.page>manifest.page_count)return null;
   if(!banded||operand.quantity_unit==='hours'){
    const keys=[`observation:${s.file_sha256}:${operand.observation_id}`,`location:${s.file_sha256}:${s.page}:${s.locator}`];
    if(keys.some(key=>used.has(key)))return unavailable('pricing_payment_source_overlap');keys.forEach(key=>used.add(key));
   }
   evidence_ids.push(s.version_id);
  }
  const row=rows.find(row=>row.finding_receipt_sha256===c.sha256);if(!row)throw Error('PRICING_COMPARISON_FINDING_MISSING');
  if(c.topic!=='minimum_wage'&&c.topic!=='working_time'&&c.topic!=='travel'&&c.topic!=='pension'&&c.topic!=='convalescence'&&c.topic!=='vacation'&&c.topic!=='rest_day'&&c.topic!=='contract'&&c.topic!=='bonuses')return null;
  components.push({finding_id:row.id,economic_key,month,topic:c.topic,kind:c.topic==='pension'?'fund_deposit':'wage_gap',
   direction:c.difference.minor_units===0?'none':'employer_owes',certainty:'high',active:true,basis_complete:true,
   amount:c.difference.minor_units,range:null,evidence_ids:[...new Set(evidence_ids)],rule_versions:[`${c.rule_id}@${c.rule_version}:${c.rule_sha256}`],alternative_group:null});
 }
 if(!components.length)return null;
 const versioned=components.some(c=>['rest_day','contract','bonuses'].includes(c.topic));
 return (versioned?releasePricingBasisSchema:pricingBasisSchema).parse({...(versioned?{schema_version:RELEASE_PRICING_BASIS_VERSION}:{}),case_id:r.case_id,identity_id:input.identityId,analysis_version:input.analysisVersion,input_sha256:r.current_scope.input_sha256,
  checked_months:[...new Set(components.map(c=>c.month))].sort(),checked_topics:[...new Set(components.map(c=>c.topic))].sort(),components});
}

/** Worker-only callback for issueSavedReleasePriceQuote. ONE current paid initial
 * month supplies the commercial basis. Existing quote-context owns identity and
 * verified paid-credit checks; this reader independently reloads REAL admission,
 * active purchase, current source readings, completed analysis and report bytes.
 * No supplied amount, AI finding label, old run or owner/QA profile is a fallback.
 * Caller owns the transaction and must roll back on any thrown guard failure. */
export function createSavedReleasePricingBasisReader(candidate:SourceJob,onUnavailable?:(reason:string)=>void):SavedReleasePricingBasisReader{
 const job=sourceJobSchema.parse(candidate);
 return async(context,source)=>{
  if(source.caseId!==job.case_id||source.inputSha256!==job.input_sha256)throw Error('PRICING_SOURCE_SCOPE');
  await lockCurrentSource(context,job);
  const profile=await loadSavedRealAiServiceConfiguration(context,job);
  if(profile.identity_id!==source.identityId)throw Error('PRICING_IDENTITY_SCOPE');
  const orders=(await readSavedOrders(context,job)).filter(order=>order.kind==='initial'||order.kind==='legacy_initial');
  if(orders.length!==1)return null;
  const order=orders[0],months=purchasedMonths(order);if(months.length!==1)return null;
  const month=months[0],current=await resolveSavedDocumentReviewKey(context,job,order,month,savedAiReleaseBaseKey(job,order.id,month,profile),{realProfile:profile});
  const selected=await context.client.query(statement('release_pricing_completed_receipt',
   `select ar.canonical_analysis_run_id analysis_run_id,ar.command_payload command,ar.command_sha256,ar.completion_payload completion,
    r.artifacts_payload artifacts,r.report_sha256,r.analysis_result_sha256 result_sha256,
    coalesce((select jsonb_agg(jsonb_build_object('id',f.id,'finding_receipt_sha256',f.finding_receipt_sha256,
     'calculation_payload',f.calculation_payload,'source_fact_references',f.source_fact_references) order by f.id)
     from public.analysis_findings f where f.analysis_run_id=ar.id and f.tenant_id=ar.tenant_id
      and f.canonical_case_id=ar.canonical_case_id and f.canonical_analysis_run_id=ar.canonical_analysis_run_id
      and f.finding_kind='qualified_ai' and f.ai_release_envelope_sha256=ar.completion_payload#>>'{bundle,ai_release,sha256}'),'[]'::jsonb) findings
    from public.analysis_runs ar join public.engine_report_versions r on r.analysis_run_id=ar.id
     and r.tenant_id=ar.tenant_id and r.canonical_case_id=ar.canonical_case_id and r.canonical_analysis_run_id=ar.canonical_analysis_run_id
     and r.analysis_result_sha256=ar.completion_payload#>>'{bundle,result_sha256}'
     and r.report_sha256=ar.completion_payload#>>'{report,report_sha256}'
     and r.report_id=ar.completion_payload#>>'{report,report_id}' and r.revision=(ar.completion_payload#>>'{report,report_revision}')::integer
    where ar.tenant_id=$1 and ar.canonical_case_id=$2 and ar.idempotency_key=$3 and ar.status='completed'`,
   [savedCaseTenant(job.case_id),job.case_id,current.key]));
  if(!selected.rows.length)return null;if(selected.rows.length!==1)throw Error('PRICING_COMPLETED_RECEIPT_AMBIGUOUS');
  const row=z.object({analysis_run_id:z.string(),command:z.unknown(),command_sha256:sha,result_sha256:sha,report_sha256:sha,artifacts:z.unknown(),
   findings:z.array(findingRow),completion:z.object({bundle:z.unknown(),report:z.unknown(),dependencies:z.object({code_version:z.literal(CASE_ANALYSIS_AI_RELEASE_CODE_VERSION),template_version:z.literal(AI_RELEASE_REPORT_TEMPLATE)}).passthrough()}).passthrough()}).parse(selected.rows[0]);
  const command=decodeCommand(row.command),bundle=decodeBundle(row.completion.bundle,savedOrderLegalTopics(order)),report=decodeReport(row.artifacts),savedReport=decodeReport(row.completion.report);
  const envelope=bundle.ai_release;if(!envelope)throw Error('PRICING_REAL_ENVELOPE_REQUIRED');
  assertCaseAnalysisAiReleaseScope(envelope,bundle);const checked=assertSavedRealAiServiceCurrent(envelope,profile);
  const scope=checked.input.assessment_input.current.scope;
  if(command.case_id!==job.case_id||command.idempotency_key!==current.key||canonicalSha256(command)!==row.command_sha256
   ||command.mode!=='real'||command.document_review_sha256!==current.reviewSha256||canonicalSha256(envelope.input.source)!==current.reviewSha256
   ||command.case_revision!==bundle.case_revision||bundle.analysis_run_id!==row.analysis_run_id||bundle.result_sha256!==row.result_sha256
   ||!same(command.period,bundle.period)||!same(command.requested_topics,savedOrderLegalTopics(order))
   ||report.report_sha256!==row.report_sha256||report.analysis_result_sha256!==bundle.result_sha256
   ||report.report_sha256!==savedReport.report_sha256||report.report_id!==savedReport.report_id||report.report_revision!==savedReport.report_revision
   ||scope.order_id!==order.id||scope.order_origin!==savedOrderOrigin(order)||scope.order_receipt_sha256!==savedOrderReceiptSha256(order)
   ||scope.input_revision!==job.revision||scope.input_sha256!==job.input_sha256||scope.authority_dependency_sha256!==job.authority_dependency_sha256
   ||scope.period.from!==`${month}-01`||!same([...checked.result.purchased_scope.topics].sort(),[...order.topics].sort()))throw Error('PRICING_COMPLETED_RECEIPT_SCOPE');
  return mapSavedReleasePricingBasis({result:checked.result,identityId:source.identityId,analysisVersion:bundle.analysis_run_id,
   factsSha256:bundle.facts_snapshot_sha256,findings:row.findings,onUnavailable});
 };
}
