import {customerWording} from './report-wording';
import {renderPermission,parseProjection} from './case-report-projection';
import {renderDeterministicRtlDocument,hebrewTopicLabel,type RtlBlock} from '../../reports/deterministic-hebrew-pdf';
import type {SavedReport} from './customer-reports';
export function savedReportPdf(report:SavedReport):Uint8Array{
 const p=parseProjection(report.projection);const title=p.report_kind==='full'?'דוח מלא':'דוח ראשוני';const blocks:RtlBlock[]=[{kind:'heading',level:1,text:title},{kind:'table',columns:['פרטי הדוח','ערך'],rows:[['תיק',p.case_public_id],['חודשים שנבדקו',p.months_covered.join(', ')],['תאריך פרסום',report.publishedAt.slice(0,10)],['גרסה',String(report.document?.revision??'היסטורית')]]},{kind:'hash',label:'מזהה תוכן הדוח',value:report.sha256}];
 for(const topic of p.topics){const permission=renderPermission(topic,p.report_kind);blocks.push({kind:'heading',level:2,text:hebrewTopicLabel(topic.topic)},{kind:'paragraph',text:permission.line});
  if(topic.gate==='checked'){if(permission.showsNumber&&topic.amount)blocks.push({kind:'table',columns:['סוג סכום','שקלים'],rows:[['פער שנבדק',(topic.amount.minor_units/100).toFixed(2)]]});if(permission.showsNumber&&topic.range)blocks.push({kind:'table',columns:['סוג סכום','שקלים'],rows:[['טווח שנבדק',`${(topic.range.low.minor_units/100).toFixed(2)}–${(topic.range.high.minor_units/100).toFixed(2)}`]]});for(const assumption of topic.assumptions)blocks.push({kind:'paragraph',text:assumption.statement});}
  const wording=customerWording(report.wording?.[topic.topic]);if(wording)blocks.push({kind:'paragraph',text:wording});
  const finding=report.document?.findings.find(f=>f.topic===topic.topic);if(finding){blocks.push({kind:'paragraph',text:'גרסאות כללי החישוב והפרמטרים:'},{kind:'paragraph',text:[...finding.rule_versions,...finding.parameter_versions].join(', ')});for(const id of finding.evidence_ids){const e=report.document!.evidence.find(v=>v.id===id)!;blocks.push({kind:'paragraph',text:'מסמך מקור וגרסה:'},{kind:'paragraph',text:e.document_id},{kind:'paragraph',text:e.version_id},{kind:'table',columns:['עמוד','שדה'],rows:[[String(e.page),e.field]]},{kind:'hash',label:'מקור מאומת',value:e.sha256});}}
  if(topic.gate==='checked'&&topic.status==='finding')blocks.push({kind:'paragraph',text:`נוסח לבירור: שלום, אבקש פירוט של בסיס החישוב בנושא ${hebrewTopicLabel(topic.topic)} בחודש המצוין בראש הדוח. אשמח לבדוק יחד אם נדרש תיקון. תודה.`});
 }
 blocks.push({kind:'paragraph',text:'גרסת הבסיס המשפטי של הבדיקה:'},{kind:'paragraph',text:p.legal_basis});
 return renderDeterministicRtlDocument({title:p.report_kind==='full'?'דוח מלא — Tivdoc':'דוח ראשוני — Tivdoc',subject:`Tivdoc case ${p.case_public_id}`,fixed_date:report.publishedAt.slice(0,10).replaceAll('-',''),blocks});
}
