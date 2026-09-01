import { Questionnaire } from "@/components/check/questionnaire";
import { guardStableAppEntrypoint } from "@/server/platform/capabilities/stable-next-entrypoint";

export default async function CheckPage() {
  await guardStableAppEntrypoint("CEP-002");
  return <Questionnaire />;
}
