import { PaymentHandoff } from "@/components/check/payment-handoff";
import { redirect } from "next/navigation";
import { readCaseIdFromCookie } from "@/lib/case-cookie";
import { guardStableAppEntrypoint } from "@/server/platform/capabilities/stable-next-entrypoint";

export default async function PaymentPage() {
  await guardStableAppEntrypoint("CEP-004");
  if (!(await readCaseIdFromCookie())) redirect("/check"); // UX Run 1 / U7: no case, no screen.
  return <PaymentHandoff />;
}
