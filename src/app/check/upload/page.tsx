import { UploadForm } from "@/components/check/upload-form";
import { guardStableAppEntrypoint } from "@/server/platform/capabilities/stable-next-entrypoint";

export default async function UploadPage() {
  await guardStableAppEntrypoint("CEP-003");
  return <UploadForm />;
}
