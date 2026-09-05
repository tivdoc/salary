import { ReceivedStatus } from "@/components/check/received-status";
import { redirect } from "next/navigation";
import { readCaseIdFromCookie } from "@/lib/case-cookie";
import { guardStableAppEntrypoint } from "@/server/platform/capabilities/stable-next-entrypoint";

export default async function ReceivedPage() {
  await guardStableAppEntrypoint("CEP-005");
  if (!(await readCaseIdFromCookie())) redirect("/check"); // UX Run 1 / U7: no case, no screen.
  return <ReceivedStatus />;
}
