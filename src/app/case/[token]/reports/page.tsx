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

export const metadata: Metadata = {
  title: "הדוח | Tivdoc",
  robots: { index: false, follow: false },
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

  return (
    <CaseShell publicId={item.public_id} eyebrow={`תיק ${item.public_id}`}>
      {engineeringUnavailable?<p role="alert">לא ניתן לטעון את דוחות הניסוי ההנדסי כרגע. זו אינה תוצאת ניתוח.</p>:null}
      {engineering.map(report=><DevFinancialReport key={report.run.run_id} report={report}/>)}
      {engineering.length>0 ? null : saved === null ? <div role="alert"><h1>לא ניתן לטעון את הדוחות כרגע</h1><p>אפשר לרענן ולנסות שוב. זו אינה תוצאת בדיקה.</p></div>
        : saved.reports.length === 0 ? <div><h1>הדוח עדיין לא מוכן</h1>{saved.checkPeriodMonth ? <p>חודש הבדיקה: <bdi>{saved.checkPeriodMonth}</bdi></p> : null}<p>כשיפורסם דוח לתיק, הוא יופיע כאן. אפשר לראות את המצב והבקשות בעמוד התיק.</p></div>
        : saved.reports.map((report) => <article key={report.id} aria-label={`דוח שפורסם ${report.publishedAt}`}>
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
