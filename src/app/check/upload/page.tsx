import { DocumentReview } from "@/components/check/document-review";
import { requireVerifiedFunnelCase } from "@/server/product/case-access/funnel-guard";
import { guardStableAppEntrypoint } from "@/server/platform/capabilities/stable-next-entrypoint";

export default async function UploadPage() {
  await guardStableAppEntrypoint("CEP-003");
  await requireVerifiedFunnelCase(); // UX Run 1 / U7 + external review #1: no case, or an unverified contact, no screen.
  return <DocumentReview />;
}
