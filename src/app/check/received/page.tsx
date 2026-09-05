import { ReceivedStatus } from "@/components/check/received-status";
import { requireVerifiedFunnelCase } from "@/server/product/case-access/funnel-guard";
import { guardStableAppEntrypoint } from "@/server/platform/capabilities/stable-next-entrypoint";

export default async function ReceivedPage() {
  await guardStableAppEntrypoint("CEP-005");
  await requireVerifiedFunnelCase(); // UX Run 1 / U7 + external review #1: no case, or an unverified contact, no screen.
  return <ReceivedStatus />;
}
