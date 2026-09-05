import { UploadForm } from "@/components/check/upload-form";
import { redirect } from "next/navigation";
import { readCaseIdFromCookie } from "@/lib/case-cookie";
import { guardStableAppEntrypoint } from "@/server/platform/capabilities/stable-next-entrypoint";

export default async function UploadPage() {
  await guardStableAppEntrypoint("CEP-003");
  if (!(await readCaseIdFromCookie())) redirect("/check"); // UX Run 1 / U7: no case, no screen.
  return <UploadForm />;
}
