import {DEV_FINANCIAL_DISCLOSURE} from '@/server/product/processing/dev-financial-contract';
import {DEV_MINIMUM_WAGE_POLICY} from '@/engine/calculations/dev-minimum-wage';
import {devFinancialRows} from '@/server/product/reports/dev-financial-artifacts';
import type {DevCustomerFinancialReport} from '@/server/product/reports/dev-financial-customer';

export function DevFinancialReport({report}:{report:DevCustomerFinancialReport}){
 const {run,current}=report,url=`/api/cases/${run.public_id}/reports?engineering=1&report=${run.run_id}`;
 return <article aria-label="דוח ניסוי הנדסי" data-financial-run={run.run_id} data-current={String(current)} style={{minWidth:0,overflowWrap:'anywhere'}}>
  <h1>דוח כספי — ניסוי הנדסי בלבד</h1><p>{DEV_FINANCIAL_DISCLOSURE}</p>
  {!current?<p role="status">גרסה היסטורית — הקלט השתנה. אין לראות בה תוצאה עדכנית.</p>:null}
  <p>ההנחות הסינתטיות: עובד בגיר בשכר שעתי, מסגרת כללית של 182 שעות, חודש ידוע ורכיב בסיס יחיד עבור השעות הרגילות. אין כאן הוכחה שהדין חל או שהמעסיק חייב כסף.</p>
  <table style={{width:'100%',tableLayout:'fixed'}}><thead><tr><th style={{width:'35%'}}>פרט</th><th>ערך</th></tr></thead><tbody>{devFinancialRows(run).map(([label,value])=><tr key={label}><th>{label}</th><td><bdi>{value}</bdi></td></tr>)}</tbody></table>
  {run.reading?<p>מספר השעות הוזן בתשובת לקוח מזוהה, ולא נקרא בידי ספק OCR.</p>:null}
  {current&&run.request_id&&run.calculation.state==='missing_input'?<p><a href={`/case/${run.public_id}/thread`}>השלמת מספר השעות בשרשור התיק</a></p>:null}
  <p>SHA-256 מקור: <bdi>{run.source.source_sha256}</bdi></p>
  <p><a href={url}>הורדת דוח הניסוי ב־PDF</a> · <a href={`${url}&version=${run.source.version_id}`}>מסמך המקור הסינתטי</a></p>
  <p><a href={DEV_MINIMUM_WAGE_POLICY.source.url}>מקור פרמטר ההשוואה — ביטוח לאומי</a>. הכלל והפרמטר אינם פעילים בשירות.</p>
 </article>;
}
