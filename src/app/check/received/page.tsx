import { ReceivedStatus } from "@/components/check/received-status";
import { guardStableAppEntrypoint } from "@/server/platform/capabilities/stable-next-entrypoint";

export default async function ReceivedPage() {
  await guardStableAppEntrypoint("CEP-005");
  return <ReceivedStatus />;
}
