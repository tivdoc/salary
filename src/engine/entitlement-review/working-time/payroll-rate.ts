import {canonicalSha256} from '../../rule-runtime/canonical';
import type {StoredCaseInputSnapshot} from '../../case-analysis/contracts';
import type {DocumentReviewInput} from '../../document-review/contracts';
import {documentReviewCalculationInputSchema,type DocumentReviewOperand} from '../../document-review/calculations';
import {reviewInputFromPayslips,PAYSLIP_REVIEW_POLICY} from '../../document-review/payslip-adapter';

/** Read the already accepted ordinary payroll cell again from the saved
 * snapshot. This supplies a printed base rate, not approval that this is the
 * complete regular wage for overtime or that a contractual supplement is absent. */
export function workingTimePayrollRate(input:DocumentReviewInput,snapshot:StoredCaseInputSnapshot):DocumentReviewOperand|null{
 if(!input.purchased_scope.topics.some(t=>t==='working_time'||t==='rest_day'))return null;
 if(new Set(snapshot.documents.map(d=>d.document_id)).size!==snapshot.documents.length
  ||new Set(snapshot.extractions.map(e=>e.document_id)).size!==snapshot.extractions.length)throw Error('WORKING_RATE_DUPLICATE_SOURCE');
 const documents=snapshot.documents.filter(d=>{
  if(d.document_type!=='payslip')return false;
  const review=input.documents.find(r=>r.document_id===d.document_id),extraction=snapshot.extractions.find(e=>e.document_id===d.document_id);
  if(!review||!extraction)return false;
  if(d.case_id!==input.case_id||review.case_id!==input.case_id)throw Error('WORKING_RATE_FOREIGN_SOURCE');
  return review.version_id===d.document_id&&review.file_sha256===d.content_sha256&&review.reading_sha256===canonicalSha256(extraction);
 });
 if(!documents.length)return null;
 const extractions=snapshot.extractions.filter(e=>documents.some(d=>d.document_id===e.document_id));
 const ordinary=reviewInputFromPayslips({case_id:input.case_id,period:input.period,purchased_scope:input.purchased_scope,
  snapshot:{...snapshot,documents,extractions},review_policy:PAYSLIP_REVIEW_POLICY});
 const rates:DocumentReviewOperand[]=[];
 for(const check of ordinary.checks){
  const c=documentReviewCalculationInputSchema.parse(check.calculation);if(c.operation.kind!=='product')continue;
  const moneyRef=c.operation.money_ref,rate=c.operands.find(o=>o.id===moneyRef);
  if(!rate||rate.state!=='observed'||rate.representation!=='money_ils'||rate.quantity_unit!==null
   ||rate.printed_value===null||!/^\d+(?:\.\d{1,2})?$/u.test(rate.printed_value)||Number(rate.printed_value)<=0)continue;
  const document=ordinary.documents.find(d=>d.document_id===rate.source.document_id);
  const extraction=extractions.find(e=>e.document_id===rate.source.document_id);
  const row=extraction?.additional_components.find(r=>rate.observation_id===`${r.component_id}:rate`);
  if(!row||row.semantic_kind!=='hourly_base'||row.source.source_scope?.period_kind!=='current'
   ||document?.period?.from!==input.period.from||document.period.to!==input.period.to)continue;
  rates.push(rate);
 }
 // Multiple base rows may describe different jobs or effective rates. Equal
 // numbers do not establish interchangeable source identities.
 return rates.length===1?rates[0]:null;
}
