import {z} from 'zod';
import {canonicalSha256,deepFreeze} from '@/engine/rule-runtime/canonical';
import {parseLegacyPaidScope,type LegacyPaidScope} from '../orders/legacy-paid-receipt.ts';
import {documentSourcePeriodIntakeTargetSchema,documentSourcePeriodIntakeTarget,documentSourcePeriodIntakeQuestion,legacySourceDocumentNeedTarget,
 sourceIntakeDocumentSchema,sourceIntakeAnchorSchema,assertSourceIntakeAnchor,resolveDocumentSourcePeriodIntakeVerification,
 type SourcePeriodIntakeReading,type SourceIntakeAnchor} from '../reports/document-source-period-intake.ts';
const sha=z.string().regex(/^[a-f0-9]{64}$/u);
const journalSchema=z.object({case_id:z.uuid(),documents:z.array(sourceIntakeDocumentSchema.omit({page_count:true})),legacy_orders:z.array(z.unknown()),
 answers:z.array(z.record(z.string(),z.unknown())).optional()});
const answerSchema=z.object({id:z.uuid(),case_id:z.uuid(),code:z.string(),scope_month:z.null(),answer_kind:z.literal('choice'),answer:z.string(),
 answer_revision:z.number().int().positive(),answer_identity_id:z.uuid(),answer_created_at:z.iso.datetime({offset:true}),field_target:documentSourcePeriodIntakeTargetSchema});
export const sourceIntakeJournalInputSchema=z.object({caseId:z.uuid(),revision:z.number().int().positive(),inputSha256:sha,journalSha256:sha,journal:z.unknown(),currentDocuments:z.unknown(),sourceAnchors:z.unknown()});
export type SourceIntakeJournalInput=z.infer<typeof sourceIntakeJournalInputSchema>;
/** Pure replay of server-authenticated journal snapshots. SQL must check the
 * stored PG text hashes for current and original anchors before this call. */
export function savedLegacySourceIntake(rawInput:unknown){
 const input=sourceIntakeJournalInputSchema.parse(rawInput);
 const caseId=z.uuid().parse(input.caseId),revision=z.number().int().positive().parse(input.revision),journal=journalSchema.parse(input.journal);
 sha.parse(input.inputSha256);if(journal.case_id!==caseId||canonicalSha256(input.journal)!==input.journalSha256)throw Error('SOURCE_INTAKE_CURRENT_HASH');
 const current= z.array(sourceIntakeDocumentSchema).parse(input.currentDocuments);
 const scopes=journal.legacy_orders.map(parseLegacyPaidScope);
 if(scopes.some(s=>s.case_id!==caseId)||new Set(scopes.map(s=>s.id)).size!==scopes.length)throw Error('SOURCE_INTAKE_SCOPE_DUPLICATE_OR_FOREIGN');
 if(new Set(current.map(d=>d.id)).size!==current.length||new Set(journal.documents.map(d=>d.id)).size!==journal.documents.length)throw Error('SOURCE_INTAKE_DOCUMENT_DUPLICATE');
 for(const d of journal.documents)if(current.filter(c=>c.id===d.id&&c.version_id===d.version_id&&c.sha256===d.sha256&&c.type===d.type).length!==1)throw Error('SOURCE_INTAKE_CURRENT_DOCUMENT');
 const anchors=z.array(sourceIntakeAnchorSchema).parse(input.sourceAnchors),head:SourceIntakeAnchor={revision,input_sha256:input.inputSha256,journal_sha256:input.journalSha256,input:input.journal};
 if(new Set(anchors.map(a=>a.revision)).size!==anchors.length)throw Error('SOURCE_INTAKE_ANCHOR_DUPLICATE');
 const readings:SourcePeriodIntakeReading[]=[],history:{request_id:string;answer_revision:number;current:boolean}[]=[],seen=new Set<string>();
 for(const raw of journal.answers??[]){
  if(!raw.field_target||typeof raw.field_target!=='object'||!('schema_version'in raw.field_target)||raw.field_target.schema_version!=='document-source-period-intake-v1')continue;
  const a=answerSchema.parse(raw),t=a.field_target;
  if(a.case_id!==caseId||t.case_id!==caseId||a.code!==`document_field:${t.target_sha256}`)throw Error('SOURCE_INTAKE_ANSWER_SCOPE');
  if(seen.has(a.id))throw Error('SOURCE_INTAKE_ANSWER_DUPLICATE');seen.add(a.id);
  const scope=scopes.find(s=>s.id===t.order_id&&s.receipt_sha256===t.order_receipt_sha256),document=current.find(d=>d.id===t.product_document_id&&d.version_id===t.version_id&&d.sha256===t.source_sha256);
  const anchor=anchors.find(a=>a.revision===t.source_revision&&a.input_sha256===t.source_input_sha256&&a.journal_sha256===t.source_journal_sha256);
  let valid=false;
  if(scope&&document){
   if(!anchor)throw Error('SOURCE_INTAKE_AUTHENTICATED_ANCHOR_REQUIRED');
   const result=resolveDocumentSourcePeriodIntakeVerification({target:t,scope,currentDocument:document,anchor,currentRevision:revision,
    requestId:a.id,answerRevision:a.answer_revision,identityId:a.answer_identity_id,answeredAt:a.answer_created_at,answer:a.answer});
   if(result.state==='intake_current'){valid=true;readings.push(result.reading);}
  }
  history.push({request_id:a.id,answer_revision:a.answer_revision,current:valid});
 }
 return deepFreeze({schema_version:'saved-legacy-source-intake-v1' as const,case_id:caseId,revision,head,scopes,documents:current.filter(c=>journal.documents.some(d=>d.id===c.id)),readings,history});
}
export type SavedLegacySourceIntake=ReturnType<typeof savedLegacySourceIntake>;
export function sourceIntakeFullMonths(period:{from:string;to:string}){
 const from=z.iso.date().parse(period.from),to=z.iso.date().parse(period.to);if(from>to)throw Error('SOURCE_INTAKE_PERIOD');
 const start=Number(from.slice(0,4))*12+Number(from.slice(5,7))-1,end=Number(to.slice(0,4))*12+Number(to.slice(5,7))-1;
 if(end-start>=600)throw Error('SOURCE_INTAKE_PERIOD_TOO_WIDE');
 const months:string[]=[];for(let i=start;i<=end;i++){
  const y=Math.floor(i/12),m=i%12+1,month=`${String(y).padStart(4,'0')}-${String(m).padStart(2,'0')}`;
  const days=[31,y%4===0&&(y%100!==0||y%400===0)?29:28,31,30,31,30,31,31,30,31,30,31];const last=`${month}-${days[m-1]}`;
  if(from<=month+'-01'&&to>=last)months.push(month);
 }return months;
}
export function effectiveLegacySourcePeriods(scopeInput:LegacyPaidScope,saved:SavedLegacySourceIntake){
 const scope=parseLegacyPaidScope(scopeInput);if(scope.case_id!==saved.case_id)throw Error('SOURCE_INTAKE_CASE');
 const matches=saved.readings.filter(r=>r.target.order_id===scope.id&&r.target.order_receipt_sha256===scope.receipt_sha256);
 const periods:{period:{from:string;to:string};source_document_kind:'payslip'|'attendance';reading_sha256:string;source_pins:{case_id:string;document_id:string;version_id:string;source_sha256:string}[]}[]=[],conflicts:string[]=[];
 for(const document of saved.documents){
  const rows=matches.filter(r=>r.target.product_document_id===document.id&&r.target.version_id===document.version_id);
  if(!rows.length)continue;
  if(new Set(rows.map(r=>canonicalSha256(r.answer))).size!==1){conflicts.push(document.version_id);continue;}
  const r=rows[0],a=r.answer;if(a.action!=='correct'||!a.value.period||(a.value.document_kind!=='payslip'&&a.value.document_kind!=='attendance'))continue;
  if(!sourceIntakeFullMonths(a.value.period).length)continue;
  periods.push({period:a.value.period,source_document_kind:a.value.document_kind,reading_sha256:r.reading_sha256,source_pins:[{case_id:scope.case_id,document_id:document.id,version_id:document.version_id,source_sha256:document.sha256}]});
 }
 const body={schema_version:'legacy-customer-source-periods-v1' as const,order_id:scope.id,order_receipt_sha256:scope.receipt_sha256,
 origin:'customer_document_reading' as const,purchase_period_unchanged:true as const,periods,conflicts};
 return deepFreeze({...body,evidence_sha256:canonicalSha256(body)});
}
/** A month established by another file cannot classify a newly uploaded or
 * replaced financial source. Explicit per-document metadata and current factual
 * readings stay reusable; negative answers stay unresolved without reopening. */
export function sourceIntakeUnresolvedDocuments(saved:SavedLegacySourceIntake,scope:LegacyPaidScope){
 const pinned=z.object({documents:z.array(z.object({id:z.uuid(),version_id:z.uuid(),month:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])(?:-01)?$/u).nullish()}))}).parse(saved.head.input).documents;
 return saved.documents.filter(document=>{
  const readings=saved.readings.filter(r=>r.target.order_id===scope.id&&r.target.order_receipt_sha256===scope.receipt_sha256&&r.target.product_document_id===document.id&&r.target.version_id===document.version_id);
  if(readings.length){
   if(new Set(readings.map(r=>canonicalSha256(r.answer))).size!==1)return true;
   const a=readings[0].answer;if(a.action!=='correct')return true;
   if(a.value.document_kind!=='payslip'&&a.value.document_kind!=='attendance')return false;
   return !a.value.period||!sourceIntakeFullMonths(a.value.period).length;
  }
  return (document.type==='payslip'||document.type==='attendance')&&!pinned.find(p=>p.id===document.id&&p.version_id===document.version_id)?.month;
 });
}
/** Before monthly planning: no invented analysis period or fake document. The
 * caller persists these through the existing protected case-request opener. */
export function legacySourceIntakeRequests(saved:SavedLegacySourceIntake){
 const requests:({kind:'document_field';target:ReturnType<typeof documentSourcePeriodIntakeTarget>;question:ReturnType<typeof documentSourcePeriodIntakeQuestion>}
 |{kind:'document';target:ReturnType<typeof legacySourceDocumentNeedTarget>;question:{code:string;question:string;answer_kind:'document';blocking:true}})[]=[];
 for(const scope of saved.scopes){
  const effective=effectiveLegacySourcePeriods(scope,saved);
  const knownMonths=[...new Set([...scope.periods,...effective.periods].flatMap(p=>sourceIntakeFullMonths(p.period)))].sort();
  if(!saved.documents.length){
   for(const month of knownMonths.length?knownMonths:[undefined]){
    const target=legacySourceDocumentNeedTarget({scope,anchor:saved.head,month});requests.push({kind:'document',target,question:{code:`legacy.source.document:${scope.id}${month?':'+month:''}`,
     question:month?`נא לצרף תלוש שכר מלא לחודש ${month}. אין כרגע מסמך מקור שמור לתקופה זו.`:'נא לצרף תלוש שכר מלא או מסמך מקור המציג את התקופה לבדיקה. תקופת הרכישה לא נרשמה; אין צורך לשלם שוב.',answer_kind:'document',blocking:true}});
   }continue;
  }
  if(knownMonths.length&&scope.period_state!=='missing')continue;
  const unresolved=sourceIntakeUnresolvedDocuments(saved,scope);
  for(const document of saved.documents){
   if(knownMonths.length&&!unresolved.some(d=>d.id===document.id&&d.version_id===document.version_id))continue;
   if(document.page_count===null)continue;
   assertSourceIntakeAnchor(saved.head,scope,document);
   // Latest negative answers remain visible/history; never reopen on every head.
   if(saved.readings.some(r=>r.target.order_id===scope.id&&r.target.product_document_id===document.id&&r.target.version_id===document.version_id))continue;
   const target=documentSourcePeriodIntakeTarget({source:{document,anchor:saved.head},scope});requests.push({kind:'document_field',target,question:documentSourcePeriodIntakeQuestion(target)});
  }
 }
 return deepFreeze(requests);
}

export function sourceIntakeTechnicalDependencies(saved:SavedLegacySourceIntake){
 return deepFreeze(saved.documents.filter(d=>d.page_count===null).map(d=>({code:'source_page_count_required' as const,document_id:d.id,version_id:d.version_id,source_sha256:d.sha256})));
}
