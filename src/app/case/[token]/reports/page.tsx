import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { CaseShell } from "@/components/case/case-shell";
import { ReportView } from "@/components/case/report-view";
import { ALL_AWAITING_VERIFICATION } from "@/server/product/reports/case-report-projection.fixtures";
import { listIdentityCases, resolveIdentitySession } from "@/server/product/case-access/service";
import { readCaseSessionCookie } from "@/server/product/case-access/session-cookie";
import { guardStableAppEntrypoint } from "@/server/platform/capabilities/stable-next-entrypoint";

export const metadata: Metadata = {
  title: "הדוח | Tivdoc",
  robots: { index: false, follow: false },
};

/**
 * Site S3.4 — the report screen. It renders a `case_report_projection` and
 * computes nothing: no figure is derived here, no certainty is decided here,
 * and no topic is judged checked here.
 *
 * Where the document comes from today: the fixture, because the engine is
 * granted write access to the projection table in run 16 and not before. The
 * fixture in use is `ALL_AWAITING_VERIFICATION`, which is not a placeholder —
 * it is the product's real state (topics 0/7, no parameter active, nothing
 * attested), so this screen currently shows seven topics awaiting verification
 * and not one number. That is the correct output, not a gap in it.
 */
export default async function CaseReportsPage({ params }: { params: Promise<{ token: string }> }) {
  await guardStableAppEntrypoint("CEP-104");
  const { token } = await params;
  if (!/^TV-[A-Z0-9]{8}$/u.test(token)) notFound();
  const session = await resolveIdentitySession(await readCaseSessionCookie());
  if (!session) redirect("/login");
  const cases = await listIdentityCases(session.identity_id);
  const item = cases.find((candidate) => candidate.public_id === token);
  if (!item) notFound();

  return (
    <CaseShell eyebrow={`תיק ${item.public_id}`}>
      <ReportView projection={ALL_AWAITING_VERIFICATION} />
      <p className="case-back">
        <Link href={`/case/${item.public_id}`}>חזרה לתיק</Link>
      </p>
    </CaseShell>
  );
}
