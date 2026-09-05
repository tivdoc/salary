import { PaymentHandoff } from "@/components/check/payment-handoff";
import { requireVerifiedFunnelCase } from "@/server/product/case-access/funnel-guard";
import { guardStableAppEntrypoint } from "@/server/platform/capabilities/stable-next-entrypoint";

export default async function PaymentPage() {
  await guardStableAppEntrypoint("CEP-004");
  await requireVerifiedFunnelCase(); // UX Run 1 / U7 + external review #1: no case, or an unverified contact, no screen.
  return <PaymentHandoff />;
}
