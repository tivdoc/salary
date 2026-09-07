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

  return (
    <CaseShell eyebrow={`תיק ${item.public_id}`}>
      {saved === null ? <div role="alert"><h1>לא ניתן לטעון את הדוחות כרגע</h1><p>אפשר לרענן ולנסות שוב. זו אינה תוצאת בדיקה.</p></div>
        : saved.reports.length === 0 ? <div><h1>הדוח עדיין לא מוכן</h1>{saved.checkPeriodMonth ? <p>חודש הבדיקה: <bdi>{saved.checkPeriodMonth}</bdi></p> : null}<p>כשיפורסם דוח לתיק, הוא יופיע כאן. אפשר לראות את המצב והבקשות בעמוד התיק.</p></div>
        : saved.reports.map((report) => <ReportView key={report.id} projection={report.projection} />)}
      <p className="case-back">
        <Link href={`/case/${item.public_id}`}>חזרה לתיק</Link>
      </p>
    </CaseShell>
  );
}
