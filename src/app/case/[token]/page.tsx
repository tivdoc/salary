import { guardStableAppEntrypoint } from "@/server/platform/capabilities/stable-next-entrypoint";

// UX Run 1 / U0: the inventory entry exists before the screen does (CEP-096).
export default async function CaseAccessPage() {
  await guardStableAppEntrypoint("CEP-096");
  return null;
}
