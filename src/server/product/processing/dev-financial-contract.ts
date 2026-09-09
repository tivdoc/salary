import {z} from 'zod';
import {createHash} from 'node:crypto';
import {savedMonthIdempotencyKey} from './saved-order-scope';
import {employmentSnapshotSchema,type EmploymentSnapshot} from '@/engine/facts/snapshot';
import {canonicalFactSchema} from '@/engine/facts/contracts';
import {canonicalSha256,deepFreeze} from '@/engine/rule-runtime/canonical';
import {calculateDevMinimumWage,DEV_MINIMUM_WAGE_POLICY,type DevMinimumWageResult} from '@/engine/calculations/dev-minimum-wage';
import {savedAnalysisId} from './saved-draft-report';
import {parseOpenAiProviderReceipt} from '@/server/engine/extraction/providers/openai/provider-receipt';

const hash=z.string().regex(/^[a-f0-9]{64}$/u);
export const DEV_FINANCIAL_SCHEMA='tivdoc-dev-financial-run-v1' as const;
export const DEV_FINANCIAL_DISCLOSURE='ניסוי הנדסי בסביבת הפיתוח — מסמך סינתטי, ספק חילוץ מוזרק וכלל שלא הופעל לשירות. זו אינה בדיקת תלוש אמיתי או קביעה של חוב של המעסיק.';
export const devHoursReadingSchema=z.object({request_id:z.uuid(),answer_revision:z.number().int().positive(),identity_id:z.uuid(),
 answered_at:z.iso.datetime({offset:true}),answer:z.string().regex(/^(0|[1-9][0-9]{0,2})(?:\.[0-9]{1,4})?$/u).refine(s=>Number(s)>0&&Number(s)<=182),
 version_id:z.uuid(),checkpoint_sha256:hash}).strict();
export type DevHoursReading=z.infer<typeof devHoursReadingSchema>;
const sourceSchema=z.object({document_id:z.uuid(),version_id:z.uuid(),source_sha256:hash,checkpoint_sha256:hash,
 path:z.string(),mime:z.enum(['application/pdf','image/png','image/jpeg']),size:z.number().int().positive().max(10*1024*1024),page:z.number().int().positive()}).strict();
const shape=z.object({schema_version:z.literal(DEV_FINANCIAL_SCHEMA),authority:z.literal('engineering_only'),run_id:z.uuid(),case_id:z.uuid(),public_id:z.string().regex(/^TV-[A-Z0-9]{8}$/u),
 order_id:z.uuid(),input_revision:z.number().int().positive(),input_sha256:hash,month:z.literal('2026-06'),parent_run_id:z.uuid(),parent_result_sha256:hash,parent_key:z.string(),
 parent_facts:employmentSnapshotSchema,parent_facts_sha256:hash,facts:employmentSnapshotSchema,facts_sha256:hash,reading:devHoursReadingSchema.nullable(),source:sourceSchema,
 policy_sha256:hash,created_at:z.iso.datetime({offset:true}),calculation:z.unknown(),finding:z.unknown(),request_id:z.uuid().nullable(),
 scenario:z.literal('synthetic_adult_hourly_general_182_regular_base_only'),extraction_provider:z.enum(['injected_test_provider','openai_live','not_configured','unproven_legacy']),
 extraction_provenance:z.object({kind:z.enum(['injected_test_provider','openai_live','not_configured','unproven_legacy']),providerAttempted:z.boolean(),allPassesSucceeded:z.boolean(),checkpointResultSha256:hash,receipts:z.array(z.unknown().transform(parseOpenAiProviderReceipt)).max(2)}).strict().optional()}).strict();

export function devFinancialFacts(parent:EmploymentSnapshot,runId:string,reading:DevHoursReading|null):EmploymentSnapshot{
 let facts=[...parent.facts];
 if(reading){
  const checked=devHoursReadingSchema.parse(reading),old=facts.find(f=>f.path==='work.regular_hours');
  if(old&&(old.value!==null||old.status==='conflicted'||old.conflicting_fact_ids.length>0))throw Error('DEV_FINANCIAL_NONMISSING_INPUT_OVERRIDE');
  facts=facts.filter(f=>f.path!=='work.regular_hours');
  facts.push(canonicalFactSchema.parse({fact_id:savedAnalysisId('dev-customer-hours',canonicalSha256(checked)),case_id:parent.case_id,path:'work.regular_hours',
   value:{amount:checked.answer,unit:'hours_per_month'},status:'confirmed',confidence:1,
   provenance:[{source_type:'declared',source_reference:{kind:'case_request_answer',request_id:checked.request_id,answer_revision:checked.answer_revision}}],
   conflicting_fact_ids:[],resolution:null,created_at:checked.answered_at}));
 }
 // This is a distinct engineering snapshot. Original canonical facts/IDs and
 // blocked legal results remain immutable; only this exact customer reading
 // can supply the absent input, with its actor recorded alongside the snapshot.
 return employmentSnapshotSchema.parse({...parent,snapshot_id:savedAnalysisId('dev-financial-facts',canonicalSha256({runId,parent:canonicalSha256(parent),reading})),analysis_run_id:runId,facts});
}
export function devFinancialFinding(runId:string,result:DevMinimumWageResult){
 return result.state==='missing_input'?null:{id:savedAnalysisId('dev-financial-finding',runId),analysis_run_id:runId,
  authority:'engineering_only' as const,topic:'minimum_wage' as const,expected_minor:result.expectedMinor,recorded_minor:result.recordedMinor,gap_minor:result.gapMinor,
  trace_sha256:result.trace.trace_sha256,comparison_sha256:canonicalSha256(result.comparison)};
}
export function parseDevFinancialRun(candidate:unknown){
 const p=shape.parse(candidate);
 if(!p.extraction_provenance&&p.extraction_provider!=='injected_test_provider')throw Error('DEV_FINANCIAL_PROVIDER_PROVENANCE_REQUIRED');
 if(p.extraction_provenance){const evidence=p.extraction_provenance;
  for(const receipt of evidence.receipts)if(receipt.source_page_count!==undefined)for(const fact of p.parent_facts.facts)for(const item of fact.provenance)if(item.source_type==='documented'&&item.source_reference.document_id===p.source.version_id&&(item.source_reference.locator?.page??1)>receipt.source_page_count)throw Error('DEV_FINANCIAL_PROVIDER_PAGE');
  if(evidence.kind!==p.extraction_provider||evidence.receipts.some(r=>r.origin!==evidence.kind||r.case_id!==p.case_id||r.document_id!==p.source.version_id||r.source_sha256!==p.source.source_sha256||r.source_size_bytes!==p.source.size||r.source_mime_type!==p.source.mime||(r.source_page_count!==undefined&&p.source.page>r.source_page_count))
   ||(evidence.kind==='unproven_legacy'?evidence.receipts.length!==0:evidence.receipts.length<1)
   ||evidence.providerAttempted!==evidence.receipts.some(r=>r.provider_attempted)
   ||evidence.allPassesSucceeded!==(evidence.receipts.length>0&&evidence.receipts.every(r=>r.status==='completed')))throw Error('DEV_FINANCIAL_PROVIDER_BINDING');
 }
 assertDevFinancialScenario(p.parent_facts,p.source.version_id);
 if(devFinancialSourcePage(p.parent_facts,p.source.version_id)!==p.source.page)throw Error('DEV_FINANCIAL_SOURCE_PAGE');
 if(p.parent_key!==savedMonthIdempotencyKey({schema_version:'saved-case-work-v1',case_id:p.case_id,revision:p.input_revision,input_sha256:p.input_sha256,mode:'draft'},p.order_id,'2026-06'))throw Error('DEV_FINANCIAL_PARENT_KEY');
 if(p.parent_facts.case_id!==p.case_id||p.parent_facts.analysis_run_id!==p.parent_run_id||canonicalSha256(p.parent_facts)!==p.parent_facts_sha256
  ||p.policy_sha256!==canonicalSha256(DEV_MINIMUM_WAGE_POLICY))throw Error('DEV_FINANCIAL_PARENT_BINDING');
 if(p.reading&&(p.reading.version_id!==p.source.version_id||p.reading.checkpoint_sha256!==p.source.checkpoint_sha256||p.reading.request_id!==p.request_id))throw Error('DEV_FINANCIAL_READING_BINDING');
 const facts=devFinancialFacts(p.parent_facts,p.run_id,p.reading);
 if(canonicalSha256(facts)!==p.facts_sha256||canonicalSha256(p.facts)!==p.facts_sha256)throw Error('DEV_FINANCIAL_FACT_TRANSFORMATION');
 const extension=p.source.mime==='application/pdf'?'pdf':p.source.mime==='image/png'?'png':'jpg';
 if(p.source.path!==`cases/${p.case_id}/versions/${p.source.version_id}.${extension}`)throw Error('DEV_FINANCIAL_SOURCE_PATH');
 for(const fact of facts.facts.filter(f=>['work.regular_hours','compensation.base_monthly_salary'].includes(f.path)))
  for(const evidence of fact.provenance)if(evidence.source_type==='documented'&&evidence.source_reference.kind==='document'
   &&evidence.source_reference.document_id!==p.source.version_id)throw Error('DEV_FINANCIAL_FACT_SOURCE');
 const calculation=calculateDevMinimumWage({facts,month:p.month,calculatedAt:p.created_at}),finding=devFinancialFinding(p.run_id,calculation);
 if(canonicalSha256(calculation)!==canonicalSha256(p.calculation)||canonicalSha256(finding)!==canonicalSha256(p.finding))throw Error('DEV_FINANCIAL_CALCULATION_MISMATCH');
 return deepFreeze({...p,calculation,finding});
}
export type DevFinancialRun=ReturnType<typeof parseDevFinancialRun>;

export function assertDevFinancialScenario(facts:EmploymentSnapshot,versionId:string){
 const salary=facts.facts.find(f=>f.path==='compensation.salary_type');
 const periods=facts.facts.filter(f=>f.path==='documents.period');
 if(!salary||salary.status!=='confirmed'||salary.value!=='hourly'||salary.conflicting_fact_ids.length
  ||periods.length!==1||periods[0].status!=='confirmed'||periods[0].conflicting_fact_ids.length
  ||periods[0].value?.document_id!==versionId||periods[0].value.period.start_date!=='2026-06-01'||periods[0].value.period.end_date!=='2026-06-30')
  throw Error('DEV_FINANCIAL_CANONICAL_SCENARIO');
 for(const fact of [salary,...periods])if(!fact.provenance.some(p=>p.source_type==='documented'&&p.source_reference.document_id===versionId&&p.source_reference.locator?.page))throw Error('DEV_FINANCIAL_SCENARIO_SOURCE');
}
export function devFinancialSourcePage(facts:EmploymentSnapshot,versionId:string){
 const base=facts.facts.find(f=>f.path==='compensation.base_monthly_salary');
 const source=base?.provenance.find(p=>p.source_type==='documented'&&p.source_reference.document_id===versionId&&p.source_reference.locator?.page);
 if(source?.source_type!=='documented'||!source.source_reference.locator?.page)throw Error('DEV_FINANCIAL_BASE_SOURCE_REQUIRED');
 return source.source_reference.locator.page;
}

export function devHoursRequestCode(caseId:string,orderId:string,versionId:string,checkpointSha:string){return 'dev_financial_hours:'+createHash('sha256').update([caseId,orderId,versionId,checkpointSha].join('|')).digest('hex');}

/** Legacy saved bytes keep their original disclosure; new receipts choose the
 * precise provider claim shared by HTML, PDF and customer view. */
export function devFinancialDisclosure(run:DevFinancialRun){
 if(!run.extraction_provenance)return DEV_FINANCIAL_DISCLOSURE;
 const provider=run.extraction_provider==='openai_live'?'בוצעה קריאה לספק חילוץ חי':run.extraction_provider==='injected_test_provider'?'ספק החילוץ מוזרק לבדיקת תוכנה':run.extraction_provider==='not_configured'?'ספק חילוץ לא הוגדר':'אין עקבת ספק מוכחת לחילוץ ההיסטורי';
 return `ניסוי הנדסי בסביבת הפיתוח — מסמך סינתטי; ${provider}. הכלל לא הופעל לשירות. זו אינה קביעה של חוב של המעסיק או הוכחת כשירות לניתוח תלוש לקוח אמיתי.`;
}
