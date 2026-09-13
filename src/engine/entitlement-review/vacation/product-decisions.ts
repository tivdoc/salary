import {z} from 'zod';
import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {documentReviewCalculationInputSchema,type DocumentReviewSource,type DocumentReviewOperand} from '../../document-review/calculations.ts';
import type {DocumentReviewInput} from '../../document-review/contracts.ts';
import {aiReleaseDecisionMethodSchema,type AiReleaseDecisionMethod} from '../../ai-release-decisions/contracts.ts';
import {AI_RELEASE_DECISION_RECIPES} from '../../ai-release-decisions/catalog.ts';
import {vacationEntitlementInputSchema,type VacationEntitlementInput} from './contracts.ts';
import {VACATION_SOURCE_REVIEW_SHA256} from './sources.ts';

const sourceSchema=documentReviewCalculationInputSchema.shape.operands.element.shape.source;
const sha=z.string().regex(/^[a-f0-9]{64}$/u);
const period=z.object({from:z.iso.date(),to:z.iso.date()}).strict().refine(p=>p.from<=p.to);
const common={state:z.enum(['identified','missing','unknown','conflict','stale','expired','unreadable']),source:sourceSchema.nullable()};
/** INTERNAL AI source classifications, never a document_field answer schema.
 * Production callers must replay the deterministic producer and supply its
 * exact hashes. A cited reading establishes facts, not the legal classification.
 * Same-page numbers alone cannot establish these relations. */
export const vacationCaseSourceEvidenceSchema=z.object({schema_version:z.literal('vacation-case-source-evidence-v1'),
 case_id:z.string().min(1),period,
 entries:z.array(z.discriminatedUnion('kind',[
  z.object({...common,kind:z.literal('seniority'),reference_year:z.literal(2026),continuity:z.enum(['same_employer_or_workplace','unresolved']),operand_sha256:sha}).strict(),
  z.object({...common,kind:z.literal('annual_workdays'),coverage:period,inventory:z.enum(['complete_classified_workdays','partial_or_unclassified']),operand_sha256:sha}).strict(),
  z.object({...common,kind:z.literal('calendar_days'),coverage:period,exclusions:z.enum(['section5_and_weekly_rest_accounted','unclassified']),operand_sha256:sha}).strict(),
  z.object({...common,kind:z.literal('quarter_selection'),coverage:period,selection:z.enum(['preceding_quarter_all_months_full','employee_selected_fullest_quarter']),fullest_quarter_inventory:z.enum(['complete_prior_twelve_months','not_needed','incomplete'])}).strict(),
  z.object({...common,kind:z.literal('monthly_period'),coverage:period,basis:z.enum(['identified_wage_if_worked_same_leave_period','unclassified']),operand_sha256:sha}).strict(),
  z.object({...common,kind:z.literal('recorded_allocation'),coverage:period,allocation:z.enum(['exclusive_same_leave_days','partial_or_unassigned']),operand_sha256:sha}).strict(),
 ])).max(6),
}).strict();
export type VacationCaseSourceEvidence=z.infer<typeof vacationCaseSourceEvidenceSchema>;
export type VacationCaseContext={review:DocumentReviewInput; evidence:VacationCaseSourceEvidence; authenticated_evidence_sha256s:readonly string[]};
const config:Readonly<Record<string,{kind:VacationCaseSourceEvidence['entries'][number]['kind'];paths:readonly string[];checks:readonly string[]}>>={
 'vacation.seniority_basis':{kind:'seniority',paths:['period','calendar_year','seniority_year'],checks:['annual.quota','annual.prorated']},
 'vacation.annual_workdays':{kind:'annual_workdays',paths:['period','evaluated_at','annual_basis'],checks:['annual.prorated']},
 'vacation.pay_calendar_days':{kind:'calendar_days',paths:['period','leave_pay.mode','leave_pay.leave_period','leave_pay.leave_calendar_days'],checks:['pay.expected','pay.comparison']},
 'vacation.pay_quarter_selection':{kind:'quarter_selection',paths:['period','leave_pay.mode','leave_pay.leave_period','leave_pay.quarter_period'],checks:['pay.expected','pay.comparison']},
 'vacation.pay_monthly_period':{kind:'monthly_period',paths:['period','leave_pay.mode','leave_pay.leave_period','leave_pay.wage'],checks:['pay.expected','pay.comparison']},
 'vacation.pay_recorded_allocation':{kind:'recorded_allocation',paths:['period','leave_pay.leave_period','leave_pay.recorded'],checks:['pay.comparison']},
};
function at(input:VacationEntitlementInput,path:string){let value:unknown=input;for(const key of path.split('.'))value=value&&typeof value==='object'?Reflect.get(value,key):null;return value??null;}
function sourcesIn(value:unknown){const sources:DocumentReviewSource[]=[];const visit=(v:unknown):void=>{const s=sourceSchema.safeParse(v);if(s.success){sources.push(s.data);return;}if(v&&typeof v==='object')Object.values(v).forEach(visit);};visit(value);return [...new Map(sources.map(s=>[canonicalSha256(s),s])).values()];}
export function vacationCaseConsumed(input:VacationEntitlementInput,paths:readonly string[]){return paths.map(path=>{const value=at(input,path);return {path:'entitlement_evidence.vacation.'+path,state:value&&typeof value==='object'&&'state'in value?String(value.state):value===null?'missing':'structural',value_sha256:canonicalSha256(value),source_sha256s:sourcesIn(value).map(s=>canonicalSha256(s))};});}
function sourceBound(s:DocumentReviewSource,input:VacationEntitlementInput,context:VacationCaseContext){
 const pins=input.source_manifest.filter(p=>p.document_id===s.document_id&&p.version_id===s.version_id);
 if(pins.length!==1||pins[0].case_id!==input.case_id||pins[0].file_sha256!==s.file_sha256||s.page>pins[0].page_count||pins[0].kind==='legal_source')throw Error('VACATION_CASE_SOURCE_BINDING');
 if((s.reading==='customer_declaration')!==(pins[0].kind==='customer_answer')||(s.reading==='questionnaire_declaration')!==(pins[0].kind==='questionnaire'))throw Error('VACATION_CASE_DECLARATION_BINDING');
 if(!['customer_declaration','questionnaire_declaration'].includes(s.reading)&&!context.review.documents.some(d=>d.case_id===input.case_id&&d.document_id===s.document_id&&d.version_id===s.version_id&&d.file_sha256===s.file_sha256&&d.page_count!==null&&s.page<=d.page_count&&[d.reading_sha256,...(d.accepted_reading_sha256??[])].includes(s.reading_receipt_sha256)))throw Error('VACATION_CASE_CURRENT_SOURCE');
}
const acceptedPhysical=(s:DocumentReviewSource)=>['identified_document_reading','provider_extraction'].includes(s.reading);
function operandReason(o:DocumentReviewOperand|null,representation:string,unit:string|null){return !o?'operand:missing':o.state!=='observed'?'operand:'+o.state:!acceptedPhysical(o.source)?'operand:accepted_reading_required':o.representation!==representation||o.quantity_unit!==unit?'operand:unit_mismatch':o.printed_value===null?'operand:missing':null;}
const same=(a:unknown,b:unknown)=>canonicalSha256(a)===canonicalSha256(b);
export type VacationCaseReadiness={allowed:boolean;reason:string|null;consumed_paths:string[];consumed_sha256:string;source_sha256s:string[];evidence_sha256:string|null;source_policy_sha256:string;dependent_check_ids:string[]};
/** Pure readiness only: no accepted decision, annual inventory, wage
 * classification, monetary result, or new customer question is generated. */
export function evaluateVacationCaseRecipe(decisionId:string,candidate:VacationEntitlementInput,context?:VacationCaseContext):VacationCaseReadiness{
 const input=vacationEntitlementInputSchema.parse(candidate),c=config[decisionId],paths=[...(c?.paths??[])];let evidenceSha:string|null=null;let evidenceSource:DocumentReviewSource|null=null;
 const finish=(reason:string|null):VacationCaseReadiness=>{const consumed=vacationCaseConsumed(input,paths);return {allowed:reason===null,reason,consumed_paths:paths,consumed_sha256:canonicalSha256({consumed,evidence_sha256:evidenceSha}),source_sha256s:[...new Set([...consumed.flatMap(f=>f.source_sha256s),...(evidenceSource?[canonicalSha256(evidenceSource)]:[])])],evidence_sha256:evidenceSha,source_policy_sha256:VACATION_SOURCE_REVIEW_SHA256,dependent_check_ids:(c?.checks??[]).map(s=>input.check_prefix+'.'+s)};};
 const last=new Date(Date.UTC(Number(input.period.from.slice(0,4)),Number(input.period.from.slice(5,7)),0)).toISOString().slice(0,10);
 if(input.period.from<'2026-05-01'||input.period.to>'2026-07-31'||input.period.from.slice(8)!=='01'||input.period.to!==last)return finish('unsupported_payroll_month');
 if(!c)return finish(decisionId==='vacation.general_section3'?'employment_and_section4_scope_evidence_required':decisionId==='vacation.no_better_arrangement'?'sector_and_better_arrangement_evidence_required':decisionId==='vacation.pay_wage_basis'?'regular_wage_component_classification_required':decisionId==='vacation.pay_applicability'?'actual_leave_and_payment_eligibility_evidence_required':'unsupported_case_recipe');
 if(!context)return finish('authenticated_source_classification_required');
 const evidence=vacationCaseSourceEvidenceSchema.parse(context.evidence);
 if(context.review.case_id!==input.case_id||!same(context.review.period,input.period)||evidence.case_id!==input.case_id||!same(evidence.period,input.period))throw Error('VACATION_CASE_SCOPE');
 if(new Set(evidence.entries.map(e=>e.kind)).size!==evidence.entries.length)throw Error('VACATION_CASE_DUPLICATE_EVIDENCE');
 const e=evidence.entries.find(e=>e.kind===c.kind);if(!e)return finish(c.kind+':source_classification_missing');
 evidenceSha=canonicalSha256(e);evidenceSource=e.source;
 if(e.source)sourceBound(e.source,input,context);
 if(e.state!=='identified')return finish(c.kind+':'+e.state);
 if(!context.authenticated_evidence_sha256s.includes(evidenceSha))throw Error('VACATION_CASE_EVIDENCE_NOT_ADMITTED');
 if(!e.source||!acceptedPhysical(e.source))return finish(c.kind+':identified_source_required');
 for(const path of paths)for(const s of sourcesIn(at(input,path)))sourceBound(s,input,context);
 if(e.kind==='seniority'){
  const o=input.seniority_year,r=operandReason(o,'integer','count');if(r)return finish(r);
  if(!/^[1-9]\d?$/u.test(o!.printed_value!)||Number(o!.printed_value)>60)return finish('seniority:bounds');
  if(e.operand_sha256!==canonicalSha256(o))throw Error('VACATION_CASE_OPERAND_BINDING');
  return finish(e.continuity==='same_employer_or_workplace'?null:'seniority:continuity_unresolved');
 }
 if(e.kind==='annual_workdays'){
  const a=input.annual_basis;if(!a)return finish('annual_basis:missing');
  for(const [key,f]of Object.entries({employment_start:a.employment_start,employment_end:a.employment_end,covered_through:a.covered_through,complete_year_evidence:a.complete_year_evidence})){
   if(f.state!=='known'||f.value===null)return finish('annual_basis.'+key+':'+f.state);
   if((f.basis==='customer_declaration')!==['customer_declaration','questionnaire_declaration'].includes(f.source!.reading))throw Error('VACATION_CASE_FACT_BASIS');
   if(f.basis!=='customer_declaration'&&!acceptedPhysical(f.source!))return finish('annual_basis.'+key+':identified_fact_required');
  }
  if(a.complete_year_evidence.value!==true)return finish('annual_inventory:incomplete');
  const start=a.employment_start.value!,end=a.employment_end.value!;
  if(end!=='ongoing'&&end<start||start>'2026-12-31'||end!=='ongoing'&&end<'2026-01-01')return finish('annual_employment:conflict');
  const from=start<'2026-01-01'?'2026-01-01':start,to=end==='ongoing'||end>'2026-12-31'?'2026-12-31':end;
  if(a.covered_through.value!<to||a.covered_through.value!>input.evaluated_at.slice(0,10))return finish('annual_inventory:incomplete_or_future');
  const r=operandReason(a.actual_workdays,'integer','days');if(r)return finish(r);
  if(!/^(0|[1-9]\d{0,2})$/u.test(a.actual_workdays!.printed_value!)||Number(a.actual_workdays!.printed_value)>Math.floor((Date.parse(to)-Date.parse(from))/86400000)+1)return finish('annual_workdays:bounds');
  if(e.operand_sha256!==canonicalSha256(a.actual_workdays))throw Error('VACATION_CASE_OPERAND_BINDING');
  return finish(e.inventory!=='complete_classified_workdays'?'annual_workdays:classification_incomplete':!same(e.coverage,{from,to})?'annual_workdays:coverage_mismatch':null);
 }
 const p=input.leave_pay;if(!p)return finish('leave_pay:missing');
 if(p.leave_period.from<input.period.from||p.leave_period.to>input.period.to)return finish('leave_pay:outside_payroll_month');
 if(e.kind==='quarter_selection'){
  if(p.mode!=='hourly_quarter')return finish('quarter_selection:hourly_mode_required');
  const q=p.quarter_period,lastQuarterDay=new Date(Date.UTC(Number(q.from.slice(0,4)),Number(q.from.slice(5,7))+2,0)).toISOString().slice(0,10);
  const lower=new Date(Date.UTC(Number(p.leave_period.from.slice(0,4))-1,Number(p.leave_period.from.slice(5,7))-1,Number(p.leave_period.from.slice(8)))).toISOString().slice(0,10);
  if(q.from.slice(8)!=='01'||q.to!==lastQuarterDay||q.to>=p.leave_period.from||q.from<lower||!same(e.coverage,q))return finish('quarter_selection:period_mismatch');
  if(e.selection==='employee_selected_fullest_quarter')return finish(e.fullest_quarter_inventory==='complete_prior_twelve_months'?null:'quarter_selection:fullest_inventory_required');
  const preceding=new Date(Date.UTC(Number(p.leave_period.from.slice(0,4)),Number(p.leave_period.from.slice(5,7))-1,0)).toISOString().slice(0,10);
  return finish(q.to===preceding?null:'quarter_selection:not_preceding');
 }
 const o=e.kind==='calendar_days'?(p.mode==='hourly_quarter'?p.leave_calendar_days:null):e.kind==='monthly_period'?p.wage:p.recorded;
 const r=operandReason(o,e.kind==='calendar_days'?'integer':'money_ils',e.kind==='calendar_days'?'calendar_days':null);if(r)return finish(r);
 if(e.operand_sha256!==canonicalSha256(o))throw Error('VACATION_CASE_OPERAND_BINDING');
 if(!same(e.coverage,p.leave_period))return finish(e.kind+':period_mismatch');
 if(e.kind==='calendar_days')return finish(!/^[1-9]\d?$/u.test(o!.printed_value!)||Number(o!.printed_value)>Math.floor((Date.parse(p.leave_period.to)-Date.parse(p.leave_period.from))/86400000)+1?'calendar_days:bounds':e.exclusions==='section5_and_weekly_rest_accounted'?null:'calendar_days:exclusions_unclassified');
 if(!/^(0|[1-9]\d{0,10})(?:\.\d{1,2})?$/u.test(o!.printed_value!))return finish('amount:invalid');
 if(e.kind==='monthly_period')return finish(p.mode!=='monthly_maintained_wage'?'monthly_period:mode_mismatch':e.basis==='identified_wage_if_worked_same_leave_period'?null:'monthly_period:unclassified');
 return finish(e.allocation==='exclusive_same_leave_days'?null:'recorded_allocation:partial_or_unassigned');
}
export function validateVacationCaseMethod(method:AiReleaseDecisionMethod,at:string,input:VacationEntitlementInput,context?:VacationCaseContext){
 method=aiReleaseDecisionMethodSchema.parse(method);
 const recipe=AI_RELEASE_DECISION_RECIPES.find(r=>r.recipe_id===method.recipe_id&&r.recipe_id.startsWith('ai-case.vacation.'));
 if(!recipe||recipe.branch!=='vacation'||recipe.recipe_version!==method.recipe_version||recipe.recipe_sha256!==method.recipe_sha256||method.source_policy_sha256!==VACATION_SOURCE_REVIEW_SHA256||!Number.isFinite(Date.parse(at))||Date.parse(method.issued_at)>Date.parse(at)||Date.parse(method.expires_at)<=Date.parse(at)||recipe.legal_sources.some(s=>!method.source_receipts.some(r=>r.source_version_id===s.version_id&&r.artifact_sha256===s.file_sha256)))throw Error('VACATION_CASE_METHOD_BINDING');
 return evaluateVacationCaseRecipe(recipe.decision_id,input,context);
}
