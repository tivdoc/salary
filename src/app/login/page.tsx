import { guardStableAppEntrypoint } from "@/server/platform/capabilities/stable-next-entrypoint";

// UX Run 1 / U0: the inventory entry exists before the screen does (CEP-097).
export default async function LoginPage() {
  await guardStableAppEntrypoint("CEP-097");
  return null;
}
