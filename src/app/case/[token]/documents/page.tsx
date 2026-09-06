import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { CaseShell } from "@/components/case/case-shell";
import { CaseDocuments } from "@/components/case/case-documents";
import { listCaseDocuments } from "@/server/product/reports/case-documents";
import { listIdentityCases, resolveIdentitySession } from "@/server/product/case-access/service";
import { readCaseSessionCookie } from "@/server/product/case-access/session-cookie";
import { guardStableAppEntrypoint } from "@/server/platform/capabilities/stable-next-entrypoint";

export const metadata: Metadata = {
  title: "מסמכים בתיק | Tivdoc",
  robots: { index: false, follow: false },
};

/**
 * Site S3.4 + S2.3 — the case's documents after payment.
 *
 * Behind the verified identity session, like every case screen: the documents
 * are the customer's own payslips, and a link that reaches them without a
 * session would be exactly the failure the access system was rebuilt to remove.
 */
export default async function CaseDocumentsPage({ params }: { params: Promise<{ token: string }> }) {
  await guardStableAppEntrypoint("CEP-103");
  const { token } = await params;
  if (!/^TV-[A-Z0-9]{8}$/u.test(token)) notFound();
  const session = await resolveIdentitySession(await readCaseSessionCookie());
  if (!session) redirect("/login");
  const cases = await listIdentityCases(session.identity_id);
  const item = cases.find((candidate) => candidate.public_id === token);
  if (!item) notFound();

  const documents = await listCaseDocuments(item.case_id);
  return (
    <CaseShell eyebrow={`תיק ${item.public_id}`}>
      <CaseDocuments publicId={item.public_id} documents={documents} />
      <p className="case-back">
        <Link href={`/case/${item.public_id}`}>חזרה לתיק</Link>
      </p>
    </CaseShell>
  );
}
