import type { Metadata } from "next";
import { ReminderOptOut } from "@/components/check/reminder-opt-out";
import { guardStableAppEntrypoint } from "@/server/platform/capabilities/stable-next-entrypoint";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "ביטול תזכורות | Tivdoc",
  robots: { index: false, follow: false },
};

/**
 * Site S4 (ב.12) — where the reminder's opt-out link lands.
 *
 * No guard beyond the entry point's: this screen is reached from a message, by
 * someone who by definition does not have a session, and asking them to log in
 * before they may stop being contacted would be the product holding its own
 * mailing list hostage. It reveals nothing — the token is passed through to a
 * POST and never resolved here, so the page looks the same for a valid token,
 * an expired one and a made-up one.
 */
export default async function ReminderOptOutPage({ searchParams }: { searchParams: Promise<{ t?: string }> }) {
  await guardStableAppEntrypoint("CEP-107");
  const { t } = await searchParams;
  const token = typeof t === "string" && /^[A-Za-z0-9_-]{22}$/u.test(t) ? t : null;
  return <ReminderOptOut token={token} />;
}
