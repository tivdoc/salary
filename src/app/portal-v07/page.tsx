import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PortalShell } from "@/components/portal-v07/portal-shell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "האזור האישי | Tivdoc",
  robots: { index: false, follow: false },
};

/**
 * Only the data-free local shell can be enabled before the P2 server identity
 * adapter is wired. Production and default configurations remain 404, and no
 * test fixture or customer projection is loaded by this boundary.
 */
export default function PortalPage() {
  if (!localEmptyShellEnabled()) notFound();
  return <PortalShell projection={null} />;
}

function localEmptyShellEnabled(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  const value = process.env.TIVDOC_CUSTOMER_PORTAL_ENABLED?.trim().toLowerCase();
  return value === "1" || value === "true";
}
