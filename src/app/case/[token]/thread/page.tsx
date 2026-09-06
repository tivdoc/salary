import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { CaseShell } from "@/components/case/case-shell";
import { ThreadView } from "@/components/case/thread-view";
import { listCaseRequests } from "@/server/product/reports/case-requests";
import { listIdentityCases, resolveIdentitySession } from "@/server/product/case-access/service";
import { readCaseSessionCookie } from "@/server/product/case-access/session-cookie";
import { guardStableAppEntrypoint } from "@/server/platform/capabilities/stable-next-entrypoint";

export const metadata: Metadata = {
  title: "שאלות בתיק | Tivdoc",
  robots: { index: false, follow: false },
};

/**
 * Site S3.4 / D-2 — the thread: where a refusal becomes a question.
 *
 * A request appears here because the engine could not answer something without
 * the case's help, never because the answer was weak. A blocking request stops
 * the SLA clock while it is open (D-7.2); a non-blocking one improves the answer
 * and never delays it. This screen renders them and records answers; it opens
 * none by itself, because only a refusal opens a request.
 */
export default async function CaseThreadPage({ params }: { params: Promise<{ token: string }> }) {
  await guardStableAppEntrypoint("CEP-102");
  const { token } = await params;
  if (!/^TV-[A-Z0-9]{8}$/u.test(token)) notFound();
  const session = await resolveIdentitySession(await readCaseSessionCookie());
  if (!session) redirect("/login");
  const cases = await listIdentityCases(session.identity_id);
  const item = cases.find((candidate) => candidate.public_id === token);
  if (!item) notFound();

  const requests = await listCaseRequests(item.case_id);
  return (
    <CaseShell eyebrow={`תיק ${item.public_id}`}>
      <ThreadView publicId={item.public_id} requests={requests} />
      <p className="case-back">
        <Link href={`/case/${item.public_id}`}>חזרה לתיק</Link>
      </p>
    </CaseShell>
  );
}
