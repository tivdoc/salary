import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans_Hebrew } from "next/font/google";
import { AttributionProvider } from "@/components/attribution-provider";
import { AnalyticsProvider } from "@/components/analytics-provider";
import { MetaPixelProvider } from "@/components/meta-pixel-provider";
import { EXTERNAL_MEASUREMENT_ENABLED } from "@/lib/measurement-policy";
import "./globals.css";
import "./website.css";

const plexSansHebrew = IBM_Plex_Sans_Hebrew({
  variable: "--font-sans",
  subsets: ["hebrew"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  preload: false,
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://tivdoc.com";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "תבדוק — בדיקת תלוש, שכר וזכויות בעבודה",
  description:
    "Tivdoc בודק לא רק את התלוש, אלא גם את חוזה העבודה, שעות העבודה והתפקיד בפועל כדי לזהות פערים אפשריים בשכר ובזכויות.",
  applicationName: "תבדוק",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    locale: "he_IL",
    url: "/",
    siteName: "Tivdoc",
    title: "תבדוק — בדיקת תלוש, שכר וזכויות בעבודה",
    description: "תלוש הוא רק השכבה הראשונה. Tivdoc בודק גם מה עומד מאחוריו.",
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="he" dir="rtl" className={`${plexSansHebrew.variable} ${plexMono.variable}`}>
      <body>
        <a className="skip-link" href="#main-content">דלג לתוכן הראשי</a>
        {children}
        <AttributionProvider />
        {EXTERNAL_MEASUREMENT_ENABLED ? (
          <>
            <AnalyticsProvider />
            <MetaPixelProvider pixelId={process.env.NEXT_PUBLIC_META_PIXEL_ID} />
          </>
        ) : null}
      </body>
    </html>
  );
}
