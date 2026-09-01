import { PaymentHandoff } from "@/components/check/payment-handoff";
import { guardStableAppEntrypoint } from "@/server/platform/capabilities/stable-next-entrypoint";

export default async function PaymentPage() {
  await guardStableAppEntrypoint("CEP-004");
  return <PaymentHandoff />;
}
