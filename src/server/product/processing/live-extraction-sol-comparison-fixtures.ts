import {createHash} from 'node:crypto';
import {renderDeterministicRtlDocument,type RtlBlock} from '@/server/reports/deterministic-hebrew-pdf';

export type SolSingleBaseSourceKind='clear'|'absent-hours'|'conflicting-hours';
export const SOL_SINGLE_BASE_SOURCE_POLICY='sol-hebrew-single-base-source-v1' as const;

/** Source facts are literal synthetic observations, independent of any live
 * response, legal catalog or calculator. The oracle is returned separately and
 * must never be included in a model request. Missing/conflicting observations
 * are not repaired by the fixture or inferred from wage divided by a rate. */
export function createSolSingleBaseSource(kind:SolSingleBaseSourceKind){
 if(!['clear','absent-hours','conflicting-hours'].includes(kind))throw Error('SOL_SOURCE_KIND_INVALID');
 const common:RtlBlock[]=[
  {kind:'heading',text:'תלוש שכר סינתטי לבדיקה',level:1},
  {kind:'paragraph',text:'נתונים בדויים בלבד. אין בתלוש עובד אמיתי או אישור מקצועי.'},
  {kind:'table',columns:['פרט','ערך'],rows:[['מעסיק','מפעל בדיקה סינתטי'],['עובד','עובד בדיקה בדוי'],
   ['סוג שכר','שעתי'],['חודש שכר','06/2026'],['תחילת תקופת השכר','01/06/2026'],['סיום תקופת השכר','30/06/2026'],
   ['תחילת עבודה','15/01/2025']]},
  {kind:'heading',text:'נתוני שעות רגילות',level:2},
 ];
 const hours:RtlBlock[]=kind==='absent-hours'
  ?[{kind:'paragraph',text:'נתון השעות הרגילות אינו מופיע בתלוש. נתון התעריף לשעה אינו מופיע בתלוש.'}]
  :kind==='conflicting-hours'
   ?[{kind:'table',columns:['פרט','שעות'],rows:[['שעות רגילות לפי רישום נוכחות','100'],['שעות רגילות לפי רישום נוסף','120']]},
     {kind:'paragraph',text:'הרישומים סותרים. לא נקבע איזה רישום נכון. אין שעות נוספות בשני הרישומים.'}]
   :[{kind:'table',columns:['פרט','ערך'],rows:[['שעות רגילות','100'],['תעריף רגיל לשעה בשקלים','33.00']]}];
 const blocks:RtlBlock[]=[...common,...hours,
  {kind:'heading',text:'תשלומי שכר',level:2},
  {kind:'table',columns:['רכיב','כמות שעות','תעריף בשקלים','סכום בשקלים'],wrap_cells:true,
   rows:[['שכר יסוד שעתי',kind==='clear'?'100':'לא מופיע',kind==='clear'?'33.00':'לא מופיע','3300.00']]},
  {kind:'paragraph',text:'זהו רכיב התשלום היחיד. אין תשלומים נוספים, החזרים, תוספות או שעות נוספות.'},
  {kind:'heading',text:'סיכום התלוש בשקלים',level:2},
  {kind:'table',columns:['פרט','סכום'],rows:[['שכר בסיס','3300.00'],['ברוטו','3300.00'],['סך ניכויים','0.00'],['נטו לתשלום','3300.00']]},
  {kind:'paragraph',text:'נתוני פנסיה אינם מוצגים במקור הסינתטי. היעדר הצגה אינו קביעה משפטית לגבי חובת הפרשה.'},
 ];
 const bytes=renderDeterministicRtlDocument({title:'תלוש שכר סינתטי',subject:SOL_SINGLE_BASE_SOURCE_POLICY,fixed_date:'20260630',blocks});
 const oracle={synthetic:true,humanReview:false,legalGoldenApproval:false,period:{year:2026,month:6,start_date:'2026-06-01',end_date:'2026-06-30'},
  salaryType:'hourly',employmentStartDate:'2025-01-15',regularHours:kind==='clear'?['100']:kind==='conflicting-hours'?['100','120']:[],
  hourlyRateMinor:kind==='clear'?3300:null,baseMinor:330000,grossMinor:330000,deductionsMinor:0,netMinor:330000,paidComponentCount:1,
  outcome:kind==='clear'?'readable':kind==='absent-hours'?'essential_input_missing':'conflicting_observations',
  // Independently specified full-precision floor, not derived through imports
  // from the implementation under test: 6443.85 *100 /182 rounded once.
  canonicalExpectedMinor:kind==='clear'?354058:null,canonicalGapMinor:kind==='clear'?24058:null,
  publishedHourlyExpectedMinor:kind==='clear'?354000:null,publishedHourlyGapMinor:kind==='clear'?24000:null,
  financialFormulaDisclosure:'Canonical candidate uses full-precision monthly/182 with final half-up agorot rounding; published-hourly engineering comparator uses35.40.'};
 return {id:`he-single-${kind}`,kind,policy:SOL_SINGLE_BASE_SOURCE_POLICY,name:`he-single-${kind}-june2026.pdf`,bytes,
  sha256:createHash('sha256').update(bytes).digest('hex'),sizeBytes:bytes.length,mimeType:'application/pdf' as const,pageCount:1 as const,oracle};
}
