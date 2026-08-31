import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { OperationsWorkspace } from "@/components/operations/operations-workspace";
import { productPageSession } from "@/server/product/auth/next-session";
import { readStableProductRouteFlags } from "@/server/product/routes/flags";
import { resolveCanonicalOperationsService } from "@/server/product/routes/runtime";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "מסוף תפעול | Tivdoc",
  description: "סביבת תפעול פנימית מאובטחת",
  robots: { index: false, follow: false, noarchive: true, nosnippet: true },
};

export default async function OperationsPage() {
  if (!readStableProductRouteFlags().operationsUi || !resolveCanonicalOperationsService()) notFound();
  const session = await productPageSession("operations");
  if (!session) notFound();
  return <OperationsWorkspace csrfToken={session.csrf_token} />;
}
