import {DevFinancialReport} from "@/components/case/dev-financial-report";
import {devFinancialCustomerReports,devFinancialPreviewEnabled} from "@/server/product/reports/dev-financial-customer";
import { AI_REPORT_DISCLOSURE } from "@/server/product/reports/report-document";
import { ReportOpen } from "@/components/case/report-open";
import { ReportFindingActions } from "@/components/case/report-finding-actions";
import { inquiryText } from "@/server/product/reports/report-inquiry";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { CaseShell } from "@/components/case/case-shell";
import { ReportView } from "@/components/case/report-view";
import { customerReports, type CustomerReports } from "@/server/product/reports/customer-reports";
import { listIdentityCases, resolveIdentitySession } from "@/server/product/case-access/service";
import { readCaseSessionCookie } from "@/server/product/case-access/session-cookie";
import { guardStableAppEntrypoint } from "@/server/platform/capabilities/stable-next-entrypoint";
import {privateDocumentReviewReports} from '@/server/product/reports/private-document-review';
import {privateReviewEnvironmentEnabled} from '@/server/product/reports/private-review-environment';

export const metadata: Metadata = {
  title: "הדוח | Tivdoc",
  robots: { index: false, follow: false },
};

const privateReviewUnavailableText={
  expired:'תוקף ההרשאה להצגת הטיוטה פג.',
  revoked:'ההרשאה להצגת הטיוטה בוטלה.',
  authority_unavailable:'לא ניתן לאמת כעת את ההרשאה שעליה מבוססת הטיוטה.',
  source_or_analysis_changed:'המקור או מצב הניתוח אינם עדכניים עבור טיוטה זו.',
} as const;
const israelCreatedAt=(value:string)=>{
  const date=new Date(value);
  return Number.isNaN(date.getTime())?null:new Intl.DateTimeFormat('he-IL',{
    timeZone:'Asia/Jerusalem',dateStyle:'short',timeStyle:'short',
  }).format(date);
};

export default async function CaseReportsPage({ params }: { params: Promise<{ token: string }> }) {
  await guardStableAppEntrypoint("CEP-104");
  const { token } = await params;
  if (!/^TV-[A-Z0-9]{8}$/u.test(token)) notFound();
  const session = await resolveIdentitySession(await readCaseSessionCookie());
  if (!session) redirect("/login");
  const cases = await listIdentityCases(session.identity_id);
  const item = cases.find((candidate) => candidate.public_id === token);
  if (!item) notFound();

  let saved: CustomerReports | null = null;
  try { saved = await customerReports(item.case_id, session.identity_id, item.public_id); } catch { /* Distinct from an empty report list. */ }

  let engineering:Awaited<ReturnType<typeof devFinancialCustomerReports>>=[];
  let engineeringUnavailable=false;
  if(devFinancialPreviewEnabled())try{engineering=await devFinancialCustomerReports(item.case_id,session.identity_id);}catch{engineeringUnavailable=true;}
  let reviews:Awaited<ReturnType<typeof privateDocumentReviewReports>>=[];let reviewsUnavailable=false;
  if(privateReviewEnvironmentEnabled())try{reviews=await privateDocumentReviewReports(item.case_id,session.identity_id);}catch{reviewsUnavailable=true;}

  return (
    <CaseShell publicId={item.public_id} eyebrow={`תיק ${item.public_id}`}>
      {engineeringUnavailable?<p role="alert">לא ניתן לטעון את דוחות הניסוי ההנדסי כרגע. זו אינה תוצאת ניתוח.</p>:null}
      {engineering.map(report=><DevFinancialReport key={report.run.run_id} report={report}/>)}
      {reviewsUnavailable?<p role="alert">לא ניתן לטעון את הטיוטות הפרטיות כרגע.</p>:null}
      {reviews.map(report=><article key={report.report_id} data-review-run={report.analysis_run_id}>
       <h2>טיוטת סקירת מסמכים פרטית</h2><p><bdi>{report.period.from} – {report.period.to}</bdi> · גרסה {report.report_revision}</p>
       <p>{israelCreatedAt(report.created_at)?<>נוצרה: <time dateTime={report.created_at}><bdi>{israelCreatedAt(report.created_at)}</bdi></time> (שעון ישראל)</>:'מועד יצירת הטיוטה אינו זמין.'}</p>
       <p>הטיוטה כוללת בדיקות ומידע חסר בהיקף השירות שנרכש. היא אינה דוח שאושר לפרסום או קביעת חוב.</p>
       {report.current?<p><a href={`/api/cases/${token}/reports?report=${report.report_id}&review=1&format=html`}>פתיחת הטיוטה העדכנית</a>{' · '}<a href={`/api/cases/${token}/reports?report=${report.report_id}&review=1`}>הורדת PDF של אותה גרסה</a></p>
        :<p>{report.unavailable_reason?privateReviewUnavailableText[report.unavailable_reason]:'הטיוטה אינה זמינה להצגה כעת; לא נמסרה סיבה מפורטת.'} הטיוטה נשמרה בהיסטוריה ואינה מוצגת כתוצאה עדכנית.</p>}
      </article>)}
      {engineering.length>0||reviews.length>0 ? null : saved === null ? <div role="alert"><h1>לא ניתן לטעון את הדוחות כרגע</h1><p>אפשר לרענן ולנסות שוב. זו אינה תוצאת בדיקה.</p></div>
        : saved.reports.length === 0 ? <div><h1>הדוח עדיין לא מוכן</h1>{saved.checkPeriodMonth ? <p>חודש הבדיקה: <bdi>{saved.checkPeriodMonth}</bdi></p> : null}<p>כשיפורסם דוח לתיק, הוא יופיע כאן. אפשר לראות את המצב והבקשות בעמוד התיק.</p></div>
        : saved.reports.map((report) => report.state==='authority_unavailable'?<article key={report.id} aria-label="דוח שאינו זמין">
          <p>דוח היסטורי מתאריך {new Date(report.publishedAt).toLocaleDateString('he-IL')}</p>
          <h2>הדוח אינו זמין כרגע</h2>
          <p>האישור שעליו התבסס הניתוח אינו בתוקף. נדרשת בדיקה מחדש לפני הצגת התוצאה.</p>
        </article>:report.document?.schema_version==='tivdoc-report-document-v3'&&report.document.execution_authority?.namespace==='isolated_test'?<article key={report.id} aria-label="סיכום בדיקת DEV">
          <ReportOpen publicId={item.public_id} reportId={report.id}/>
          <h2>סיכום בדיקת DEV סינתטית</h2>
          <p>החישוב בוצע בתיק בדיקה עם אישורים וחתימות של מרשם בדיקה סינתטי. אין כאן אישור אדם אמיתי, הפעלת הכלל לשירות לקוחות או קביעת זכאות או חוב.</p>
          <p>ריצת ניתוח: <bdi>{report.document.execution_authority.analysis_run_id}</bdi> · חודש הבדיקה: <bdi>{report.projection.check_period_month}</bdi> · גרסת קלט {report.document.revision}</p>
          {report.projection.topics.map(topic=>topic.gate==='checked'?<p key={topic.topic}>
            {topic.topic==='minimum_wage'?'שכר מינימום':topic.topic} — {topic.amount?<>
              פער שנשמר בתוצאת הבדיקה: <bdi>{(topic.amount.minor_units/100).toFixed(2)} ILS</bdi>
            </>:topic.range?<>
              פער שנשמר בתוצאת הבדיקה: <bdi>{(topic.range.low.minor_units/100).toFixed(2)}{topic.range.low.minor_units===topic.range.high.minor_units?'':`–${(topic.range.high.minor_units/100).toFixed(2)}`} ILS</bdi>
            </>:<>לא נשמר פער כספי חיובי להצגה. ההשוואה המלאה נמצאת בתוצר הבדיקה.</>}
          </p>:null)}
          <p><a href={`/api/cases/${item.public_id}/reports?report=${report.id}&format=html`}>תוצר הבדיקה והעקבה השמורים — HTML</a>{' · '}
            <a href={`/api/cases/${item.public_id}/reports?report=${report.id}`}>תוצר הבדיקה השמור — PDF</a></p>
          <ul>{report.document.evidence.map(evidence=><li key={evidence.id}><a href={`/api/cases/${item.public_id}/reports?report=${report.id}&version=${evidence.version_id}`}>מסמך הבדיקה — עמוד {evidence.page}, שדה {evidence.field}</a></li>)}</ul>
        </article>:<article key={report.id} aria-label={`דוח שפורסם ${report.publishedAt}`}>
          <ReportOpen publicId={item.public_id} reportId={report.id}/><p>פורסם: {new Date(report.publishedAt).toLocaleDateString('he-IL')} · גרסה {report.document?.revision??'היסטורית'}{report.state==='superseded'?' · הוחלפה בגרסה חדשה':report.state==='recheck_required'?' · בבדיקה חוזרת':''}</p>
          {report.document?.schema_version==='tivdoc-report-document-v3'?<p className="report-service-disclosure">{AI_REPORT_DISCLOSURE}</p>:null}
          {report.document?.schema_version==='tivdoc-report-document-v3'&&report.document.execution_authority?<p>
            {report.document.execution_authority.namespace==='isolated_test'?'בדיקת DEV סינתטית בלבד — אישורי בדיקה, ללא אישור אדם אמיתי או הפעלת הכלל לשירות לקוחות. ':''}
            ריצת ניתוח: <bdi>{report.document.execution_authority.analysis_run_id}</bdi>{' '}
            <a href={`/api/cases/${item.public_id}/reports?report=${report.id}&format=html`}>הדוח והעקבה שנשמרו עם הניתוח</a>
          </p>:null}
          <a href={`/api/cases/${item.public_id}/reports?report=${report.id}`}>הורדת הדוח ב־PDF</a>
          <ReportView projection={report.projection} wording={report.wording} />
          {report.document?.findings.map(finding=><section key={finding.id}><h2>מקורות וצעד הבא — {finding.topic}</h2><p>כללי חישוב: {finding.rule_versions.join(', ')} · פרמטרים: {finding.parameter_versions.join(', ')}</p><ul>{finding.evidence_ids.map(id=>{const evidence=report.document!.evidence.find(e=>e.id===id)!;return <li key={id}><a href={`/api/cases/${item.public_id}/reports?report=${report.id}&version=${evidence.version_id}`}>המקור — עמוד {evidence.page}, שדה {evidence.field}</a><p>גרסת מקור: <bdi>{evidence.version_id}</bdi></p></li>;})}</ul><ReportFindingActions publicId={item.public_id} reportId={report.id} findingId={finding.id} text={inquiryText(report.projection.topics.find(t=>t.topic===finding.topic)!,report.projection.report_kind,report.projection.check_period_month)}/></section>)}
        </article>)}
      <p className="case-back">
        <Link href={`/case/${item.public_id}`}>חזרה לתיק</Link>
      </p>
    </CaseShell>
  );
}
