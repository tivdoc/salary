import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PortalWorkspace } from "@/components/portal/portal-workspace";
import { productPageSession } from "@/server/product/auth/next-session";
import { readStableProductRouteFlags } from "@/server/product/routes/flags";
import { resolveCanonicalPortalService } from "@/server/product/routes/runtime";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "האזור האישי | Tivdoc",
  description: "אזור אישי מאובטח למעקב אחר התיק",
  robots: { index: false, follow: false, noarchive: true, nosnippet: true },
};

export default async function PortalPage() {
  if (!readStableProductRouteFlags().portalUi || !resolveCanonicalPortalService()) notFound();
  const session = await productPageSession("portal");
  if (!session || session.actor.assigned_case_ids.length !== 1) notFound();
  return <PortalWorkspace caseId={session.actor.assigned_case_ids[0]} csrfToken={session.csrf_token} />;
}
