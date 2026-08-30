import type { Metadata } from "next";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "האזור האישי | Tivdoc",
  robots: { index: false, follow: false },
};

/**
 * The route stays non-disclosing until the P2 server identity adapter is wired.
 * Synthetic projections are exercised only through the isolated service tests.
 */
export default function PortalPage(): never {
  notFound();
}
