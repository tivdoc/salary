import {canonicalSha256,deepFreeze} from '../../rule-runtime/canonical.ts';
import type {DocumentReviewInput} from '../../document-review/contracts.ts';
import type {DocumentReviewSource} from '../../document-review/calculations.ts';
import {savedNonPayslipEvidenceSchema} from '../../extraction/document-evidence/snapshot.ts';
import type {NormalizedDocumentEvidence} from '../../extraction/document-evidence/contracts.ts';
import {nonPayslipEffectiveReadingSha} from '../../document-review/non-payslip.ts';
import {obligationsEntitlementInputSchema,type ObligationsEntitlementInput} from './contracts.ts';
import {parseObligationLiteralPromise} from './literal-promise.ts';
import {OBLIGATIONS_SOURCE_REVIEW_SHA256} from './source-policy.ts';

type Observation=NormalizedDocumentEvidence['observations'][number];
type Entry={kind:'literal_promise'|'payment_period'|'agreement_acceptance'|'complete_conditions';sources:DocumentReviewSource[];value:unknown;witness_sha256:string};
const sourceRow=(o:Observation)=>canonicalSha256({page:o.original.page,block:o.original.block_id,row:o.original.row_id});

/** These are supported source statements, not text proposed to the customer.
 * They must already exist as exact, current, individually identified original
 * observations. An unrecognized statement remains a source-interpretation gap.
 * No signature image, confidence or silence establishes agreement acceptance. */
export const OBLIGATION_POSITIVE_SOURCE_GRAMMAR=deepFreeze({
 agreement_label:'הסכמת הצדדים',agreement_pattern:'הצדדים הסכימו ביום YYYY-MM-DD להחיל את ההתחייבות שבסעיף זה.',
 unconditional_label:'תנאי התשלום',unconditional_statement:'התשלום לפי סעיף זה אינו מותנה בתנאים נוספים.',
 finite_conditions_label:'תנאי התשלום',finite_conditions_statement:'התשלום לפי סעיף זה מותנה רק בקיום כל התנאים המפורטים להלן.',
});

/** Recompose from the ordinary immutable reading journal. No caller witness
 * or old report is accepted as evidence; the receipt records exactly what this
 * producer consumed. Source coverage is a prerequisite, never a substitute for
 * the positive agreement/condition statements below. */
export function produceObligationSourceEvidence(candidate:ObligationsEntitlementInput,obligationId:string,review:DocumentReviewInput){
 const input=obligationsEntitlementInputSchema.parse(candidate),items=input.obligations.filter(o=>o.obligation_id===obligationId);
 if(items.length!==1||input.case_id!==review.case_id||canonicalSha256(input.period)!==canonicalSha256(review.period))throw Error('OBLIGATION_PRODUCER_SCOPE');
 const obligation=items[0],entries:Entry[]=[],unresolved:string[]=[],dependencies:{version_id:string;observation_id:string}[]=[];
 const records=(review.non_payslip_evidence??[]).filter(r=>r.document.document_id===obligation.clause.source.version_id);
 if(records.length>1)throw Error('OBLIGATION_PRODUCER_DUPLICATE_SOURCE');
 const record=records.length===1?savedNonPayslipEvidenceSchema.parse(records[0]):null,e=record?.extraction;
 const finish=()=>{
  const body={schema_version:'obligation-source-producer-receipt-v1' as const,source_policy_sha256:OBLIGATIONS_SOURCE_REVIEW_SHA256,
   case_id:input.case_id,period:input.period,obligation_id:obligationId,clause_sha256:canonicalSha256(obligation.clause),
   source_sha256:canonicalSha256({documents:review.documents,record}),entries,unresolved:[...new Set(unresolved)]};
  return deepFreeze({entries,unresolved:body.unresolved,reading_dependencies:dependencies,receipt:{...body,receipt_sha256:canonicalSha256(body)}});
 };
 if(!record||!e){unresolved.push('ordinary_contract_source_reading_required');return finish();}
 const doc=review.documents.filter(d=>d.document_id===record.document.document_id&&d.version_id===record.document.document_id),readingSha=nonPayslipEffectiveReadingSha(record);
 if(record.document.case_id!==input.case_id||record.document.document_type!=='contract'||e.detected_document_type!=='contract'||doc.length!==1
  ||doc[0].file_sha256!==record.document.content_sha256||doc[0].reading_sha256!==readingSha||doc[0].page_count!==e.physical_page_count
  ||obligation.clause.source.document_id!==record.document.document_id||obligation.clause.source.file_sha256!==record.document.content_sha256
  ||obligation.clause.source.reading_receipt_sha256!==readingSha)throw Error('OBLIGATION_PRODUCER_CURRENT_SOURCE');
 if(e.pages.length!==e.physical_page_count||new Set(e.pages.map(p=>p.page)).size!==e.physical_page_count
  ||e.pages.some(p=>p.coverage!=='complete'||p.missing_regions.length)||e.warnings.length){unresolved.push('complete_source_coverage_required');return finish();}
 const readings=new Map(record.readings.filter(r=>r.target.month===input.period.from.slice(0,7)).map(r=>[r.target.observation.observation_id,r]));
 const read=(o:Observation|undefined)=>{
  if(!o||o.issues.length||o.original.warnings.length||o.original.state==='conflict')return null;
  const r=readings.get(o.observation_id);return r?.state==='identified_reading'?r.value:null;
 };
 const citation=(observations:Observation[],label:string):DocumentReviewSource=>{
  const used=observations.map(o=>({observation_id:o.observation_id,original_sha256:o.original_sha256,reading_sha256:readings.get(o.observation_id)?.verification_sha256??null}));
  const locator={schema_version:'automatic-nonpay-source-evidence-v1',observations_sha256:canonicalSha256(used),observation_ids:observations.map(o=>o.observation_id)};
  const full=JSON.stringify(locator);
  return {document_id:doc[0].document_id,version_id:doc[0].version_id,file_sha256:doc[0].file_sha256,page:observations[0].original.page,
   locator:full.length<=500?full:JSON.stringify({schema_version:locator.schema_version,observations_sha256:locator.observations_sha256}),label,
   reading:'identified_document_reading',reading_receipt_sha256:readingSha};
 };
 const emit=(kind:Entry['kind'],observations:Observation[],value:unknown)=>{
  const source=citation(observations,'מקור מזוהה להערכת התחייבות — '+kind);
  entries.push({kind,sources:[source],value,witness_sha256:canonicalSha256({kind,source,value,observations:observations.map(o=>({original:o,reading:readings.get(o.observation_id)}))})});
 };
 const clauses=e.observations.filter(o=>o.original.semantic==='clause_text'&&o.original.page===obligation.clause.source.page&&read(o)?.kind==='text');
 const matching=clauses.filter(o=>{const v=read(o);return v?.kind==='text'&&v.value===obligation.clause.text;});
 if(matching.length!==1||matching[0].original.row_id===null){unresolved.push('unique_exact_clause_row_required');return finish();}
 const clause=matching[0],row=e.observations.filter(o=>sourceRow(o)===sourceRow(clause)),get=(semantic:Observation['original']['semantic'])=>row.filter(o=>o.original.semantic===semantic);
 const literal=parseObligationLiteralPromise(obligation.clause.text),starts=get('effective_from'),ends=get('effective_to'),amounts=get(literal?.kind==='linear'?'rate':'amount');
 const from=starts.length===1?read(starts[0]):null,to=ends.length===1?read(ends[0]):null,amount=amounts.length===1?read(amounts[0]):null;
 if(!literal||get('clause_text').length!==1||from?.kind!=='iso_date'||to?.kind!=='iso_date'||amount?.kind!=='money'
  ||literal.minor!==amount.minor_units||literal.kind!==obligation.promise.kind||literal.bonus!==(obligation.topic==='bonuses')
  ||canonicalSha256({from:from.value,to:to.value})!==canonicalSha256(obligation.clause.effective_period)){
  unresolved.push('literal_amount_or_effective_period_source_mismatch');return finish();
 }
 const used=[clause,...starts,...ends,...amounts],reconstructed=citation(used,obligation.clause.source.label);
 if(canonicalSha256(reconstructed)!==canonicalSha256(obligation.clause.source))throw Error('OBLIGATION_PRODUCER_CLAUSE_LOCATOR');
 const money=obligation.promise.kind==='fixed'?obligation.promise.amount:obligation.promise.rate;
 if(!money||money.state!=='observed'||money.observation_id!==amounts[0].observation_id||money.printed_value!==(literal.minor/100).toFixed(2)
  ||canonicalSha256(money.source)!==canonicalSha256(obligation.clause.source))throw Error('OBLIGATION_PRODUCER_AMOUNT_REPLAY');
 emit('literal_promise',used,{kind:literal.kind,topic:obligation.topic,minor:literal.minor,unit:literal.unit});
 const fullMonth=input.period.from.endsWith('-01')&&new Date(Date.parse(input.period.to+'T00:00:00Z')+86400000).toISOString().slice(0,10).endsWith('-01')&&input.period.from.slice(0,7)===input.period.to.slice(0,7);
 let quantityBound=true;
 if(obligation.promise.kind==='linear'){
  const quantities=get('quantity'),froms=get('period_start'),tos=get('period_end'),q=quantities.length===1?read(quantities[0]):null,
   qFrom=froms.length===1?read(froms[0]):null,qTo=tos.length===1?read(tos[0]):null,operand=obligation.promise.quantity;
  const label=literal.unit==='count'?'משמרות שבוצעו':literal.unit==='hours'?'שעות שבוצעו':'ימי עבודה שבוצעו';
  quantityBound=!!operand&&operand.state==='observed'&&q?.kind==='decimal'&&q.unit===literal.unit&&quantities[0].original.source_label.trim()===label
   &&qFrom?.kind==='iso_date'&&qTo?.kind==='iso_date'&&qFrom.value===input.period.from&&qTo.value===input.period.to
   &&operand.observation_id===quantities[0].observation_id&&operand.printed_value===q.value&&operand.quantity_unit===literal.unit
   &&canonicalSha256(operand.source)===canonicalSha256(citation([...quantities,...froms,...tos],operand.source.label));
  if(quantityBound)used.push(...quantities,...froms,...tos);else unresolved.push('exact_same_period_performed_quantity_required');
 }
 if(fullMonth&&quantityBound&&from.value<=input.period.from&&to.value>=input.period.to&&canonicalSha256(input.period)===canonicalSha256(obligation.payment_period))emit('payment_period',used,{period:input.period,recurrence:'whole_month_explicit'});
 else unresolved.push('whole_month_payment_period_required');
 const context=e.observations.filter(o=>o.original.page===clause.original.page&&o.original.block_id===clause.original.block_id&&o!==clause&&o.original.value_kind==='text');
 const text=(o:Observation)=>{const v=read(o);return v?.kind==='text'?v.value.trim():null;};
 const agreement=context.filter(o=>o.original.semantic==='source_label'&&o.original.source_label.trim()===OBLIGATION_POSITIVE_SOURCE_GRAMMAR.agreement_label);
 const inventory=context.filter(o=>o.original.semantic==='source_label'&&o.original.source_label.trim()===OBLIGATION_POSITIVE_SOURCE_GRAMMAR.unconditional_label);
 for(const o of [...agreement,...inventory,...context.filter(o=>['condition_text','annex_reference'].includes(o.original.semantic))]){
  if(!readings.has(o.observation_id)&&o.original.raw_value!==null&&!o.issues.length)dependencies.push({version_id:doc[0].version_id,observation_id:o.observation_id});
 }
 // A second clause, an annex or unclassified text can change this source's
 // meaning. The narrow template does not silently ignore any such content.
 const relevantIds=new Set([clause.observation_id,...context.map(o=>o.observation_id)]);
 const extraText=e.observations.some(o=>o.original.value_kind==='text'&&!relevantIds.has(o.observation_id));
 const recognized=new Set([...agreement,...inventory,...context.filter(o=>o.original.semantic==='condition_text')].map(o=>o.observation_id));
 const unknownContext=context.some(o=>!recognized.has(o.observation_id)||text(o)===null);
 if(extraText||unknownContext){unresolved.push('additional_or_unread_context_requires_interpretation');return finish();}
 if(agreement.length===1){
  const match=/^הצדדים הסכימו ביום (\d{4}-\d{2}-\d{2}) להחיל את ההתחייבות שבסעיף זה[.]?$/u.exec(text(agreement[0])??'');
  if(match&&Number.isFinite(Date.parse(match[1]))&&new Date(match[1]).toISOString().slice(0,10)===match[1])emit('agreement_acceptance',[clause,agreement[0]],{agreed_on:match[1],reference:'this_exact_clause'});
  else unresolved.push('positive_exact_agreement_statement_required');
 }else unresolved.push('positive_exact_agreement_statement_required');
 const conditions=context.filter(o=>o.original.semantic==='condition_text');
 if(inventory.length===1&&text(inventory[0])===OBLIGATION_POSITIVE_SOURCE_GRAMMAR.unconditional_statement&&conditions.length===0&&obligation.conditions.length===0)
  emit('complete_conditions',[clause,inventory[0]],{conditions_mode:'all',condition_ids:[],explicit_unconditional:true});
 else if(inventory.length===1&&text(inventory[0])===OBLIGATION_POSITIVE_SOURCE_GRAMMAR.finite_conditions_statement&&conditions.length>0&&conditions.length<=8
  &&conditions.every(o=>{const t=text(o);return t!==null&&!/(?:^או(?:\s|$)|\sאו(?:\s|$)|לפי שיקול|בכפוף לנספח|אלא אם)/u.test(t);})
  &&canonicalSha256(conditions.map(o=>'condition.'+o.observation_id.slice(0,24)).sort())===canonicalSha256(obligation.conditions.map(c=>c.condition_id).sort()))
  emit('complete_conditions',[clause,inventory[0],...conditions],{conditions_mode:'all',condition_ids:obligation.conditions.map(c=>c.condition_id),explicit_unconditional:false});
 else unresolved.push('positive_complete_condition_inventory_required');
 return finish();
}
