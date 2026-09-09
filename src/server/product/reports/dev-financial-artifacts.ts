import {createHash} from 'node:crypto';
import {devFinancialDisclosure,parseDevFinancialRun,type DevFinancialRun} from '../processing/dev-financial-contract';
import {DEV_MINIMUM_WAGE_POLICY,DEV_MINIMUM_WAGE_RULE} from '@/engine/calculations/dev-minimum-wage';
import {renderDeterministicRtlDocument,type RtlBlock} from '@/server/reports/deterministic-hebrew-pdf';

export const devArtifactSha=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function devMoney(minor:number){const value=BigInt(minor),absolute=value<BigInt(0)?-value:value;return `${value<BigInt(0)?'-':''}${absolute/BigInt(100)}.${String(absolute%BigInt(100)).padStart(2,'0')}`;}
export function devFinancialRows(run:DevFinancialRun):string[][]{
 const rows=[['חודש','יוני 2026'],['מזהה הניתוח הכספי',run.run_id],['מזהה ניתוח המקור',run.parent_run_id],['גרסת קלט',String(run.input_revision)],['מסמך',run.source.document_id],['גרסת מסמך',run.source.version_id],['עמוד',String(run.source.page)],['כלל',`${DEV_MINIMUM_WAGE_RULE.rule_spec_id}@${DEV_MINIMUM_WAGE_RULE.rule_spec_version}`],['גרסת פרמטר',DEV_MINIMUM_WAGE_POLICY.parameterVersion]];
 if(run.extraction_provenance)rows.push(['מקור החילוץ',run.extraction_provider],['עקבות ספק',run.extraction_provenance.receipts.map(r=>`${r.actual_model??r.requested_model}; ${r.provider_request_id??r.provider_response_id??'ללא מזהה ספק'}`).join('; ')]);
 if(run.calculation.state==='calculated'){
  const hours=run.calculation.trace.inputs.find(i=>i.input_id==='fact.regular.hours')?.value;
  const rate=run.calculation.trace.inputs.find(i=>i.input_id==='parameter.hourly.floor')?.value;
  if(hours?.kind!=='rational'||rate?.kind!=='money')throw Error('DEV_FINANCIAL_DISPLAY_INPUTS');
  rows.push(['שעות רגילות מהעקבה',hours.denominator==='1'?hours.numerator:`${hours.numerator}/${hours.denominator}`],
   ['תעריף לשעה מהעקבה',devMoney(rate.minor_units)+' ₪'],
   ['שדות קלט','work.regular_hours; compensation.base_monthly_salary'],
   ['שכר צפוי בהנחות הניסוי',devMoney(run.calculation.expectedMinor)+' ₪'],['רכיב בסיס מתועד',devMoney(run.calculation.recordedMinor)+' ₪'],['צפוי פחות מתועד',devMoney(run.calculation.gapMinor)+' ₪'],
   ['SHA-256 עקבת חישוב',run.calculation.trace.trace_sha256]);
  for(const input of run.calculation.trace.inputs.filter(i=>i.source.kind==='fact')){
   const source=input.source;if(source.kind!=='fact')continue;
   const fact=run.facts.facts.find(f=>f.fact_id===source.fact_id)!;
   const locators=fact.provenance.map(p=>p.source_type==='documented'
    ?`מסמך ${p.source_reference.document_id}, עמוד ${p.source_reference.locator?.page??'לא צוין'}`
    :p.source_type==='declared'&&p.source_reference.kind==='case_request_answer'
     ?`תשובה ${p.source_reference.request_id}, גרסה ${p.source_reference.answer_revision}`:'מקור אחר בעקבה');
   rows.push([`מקור ${fact.path}`,locators.join('; ')]);
  }
 }
 else rows.push(['חסר קלט מאומת',run.calculation.fields.join(', ')]);
 return rows;
}
export function renderDevFinancialArtifacts(candidate:unknown){
 const run=parseDevFinancialRun(candidate),rows=devFinancialRows(run),title='דוח כספי — ניסוי הנדסי בלבד';
 const explanation='ההנחות הסינתטיות: עובד בגיר בשכר שעתי, מסגרת כללית של 182 שעות, חודש ידוע ורכיב בסיס יחיד עבור השעות הרגילות. אין כאן הוכחה שהדין חל או שהמעסיק חייב כסף.';
 const html=`<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><title>${title}</title><body><h1>${title}</h1><p>${escape(devFinancialDisclosure(run))}</p><p>${explanation}</p><table><tbody>${rows.map(r=>`<tr><th>${escape(r[0])}</th><td><bdi>${escape(r[1])}</bdi></td></tr>`).join('')}</tbody></table><p>SHA-256 מקור: <bdi>${run.source.source_sha256}</bdi></p><p>מקור פרמטר: <a href="${escape(DEV_MINIMUM_WAGE_POLICY.source.url)}">ביטוח לאומי — טבלת שכר מינימום</a></p><p>המקור משמש להשוואה הנדסית; הכלל והפרמטר אינם פעילים בשירות.</p>${run.reading?'<p>מספר השעות הוזן בתשובת לקוח מזוהה, ולא נקרא בידי ספק OCR.</p>':''}</body></html>`;
 const blocks:RtlBlock[]=[{kind:'heading',level:1,text:title},{kind:'paragraph',text:devFinancialDisclosure(run)},{kind:'paragraph',text:explanation},
  {kind:'table',columns:['פרט','ערך'],rows:rows.filter(r=>r[0]!=='SHA-256 עקבת חישוב'),...(run.extraction_provenance?{wrap_cells:true}:{})},
  ...(run.calculation.state==='calculated'?[{kind:'hash' as const,label:'SHA-256 עקבת חישוב',value:run.calculation.trace.trace_sha256}]:[]),
  {kind:'hash',label:'SHA-256 מקור',value:run.source.source_sha256},
  {kind:'paragraph',text:'מקור פרמטר: ביטוח לאומי — טבלת שכר מינימום. הכלל והפרמטר אינם פעילים בשירות.'},
  ...(run.reading?[{kind:'paragraph' as const,text:'מספר השעות הוזן בתשובת לקוח מזוהה, ולא נקרא בידי ספק OCR.'}]:[])];
 const pdf=renderDeterministicRtlDocument({title,subject:run.run_id,fixed_date:run.created_at.slice(0,10).replaceAll('-',''),blocks});
 return {html,pdf,htmlSha256:devArtifactSha(html),pdfSha256:devArtifactSha(pdf)};
}
