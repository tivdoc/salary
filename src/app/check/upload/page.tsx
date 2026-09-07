import { AwaitingDocumentNotice } from "@/components/check/awaiting-document-notice";
import { uploadSnapshot } from "@/server/product/documents/upload";
import { DocumentReview } from "@/components/check/document-review";
import { openDocumentRequest } from "@/server/product/reports/awaiting-document";
import { requireVerifiedFunnelCase } from "@/server/product/case-access/funnel-guard";
import { guardStableAppEntrypoint } from "@/server/platform/capabilities/stable-next-entrypoint";

export default async function UploadPage({searchParams}: {searchParams?: Promise<{requestId?: string}>} = {}) {
  await guardStableAppEntrypoint("CEP-003");
  const caseId = await requireVerifiedFunnelCase(); // UX Run 1 / U7 + external review #1: no case, or an unverified contact, no screen.
  // S2.4: a case that is here because it was waiting for this file says so
  // instead of asking the question the customer already answered.
  const [waiting, snapshot] = await Promise.all([openDocumentRequest(caseId), uploadSnapshot(caseId)]);
  const requested = (await searchParams)?.requestId;
  const selectedRequestId = snapshot.requests.some(row => row.id === requested) ? requested : undefined;
  return (
    <>
      {waiting ? <AwaitingDocumentNotice expiresAt={waiting.expires_at} /> : null}
      <DocumentReview key={`${caseId}:${selectedRequestId ?? ""}`} initial={snapshot} initialRequestId={selectedRequestId} />
    </>
  );
}
