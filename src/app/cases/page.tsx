import { guardStableAppEntrypoint } from "@/server/platform/capabilities/stable-next-entrypoint";

// UX Run 1 / U0: the inventory entry exists before the screen does (CEP-098).
export default async function CasesPage() {
  await guardStableAppEntrypoint("CEP-098");
  return null;
}
