import type { Metadata } from "next";
import { Heebo, IBM_Plex_Mono, IBM_Plex_Sans_Hebrew, Rubik } from "next/font/google";
import { AnalyticsProvider } from "@/components/analytics-provider";
import { AttributionProvider } from "@/components/attribution-provider";
import { MetaPixelProvider } from "@/components/meta-pixel-provider";
import "./globals.css";

const plexSansHebrew = IBM_Plex_Sans_Hebrew({
  variable: "--font-sans",
  subsets: ["hebrew", "latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

// Site S5: the home page's typography — Rubik 800 for headings, Heebo for body
// (design/landing-v5). Scoped by CSS variables, so only `.v5` uses them and the
// rest of the product keeps IBM Plex.
const rubik = Rubik({
  variable: "--font-display",
  subsets: ["hebrew", "latin"],
  weight: ["700", "800"],
  display: "swap",
});

const heebo = Heebo({
  variable: "--font-body",
  subsets: ["hebrew", "latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://tivdoc.com";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "Tivdoc - בדיקת תלוש, שכר וזכויות בעבודה",
  description:
    "Tivdoc בודק לא רק את התלוש, אלא גם את חוזה העבודה, שעות העבודה והתפקיד בפועל כדי לזהות פערים אפשריים בשכר ובזכויות.",
  applicationName: "Tivdoc Salary",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    locale: "he_IL",
    url: "/",
    siteName: "Tivdoc",
    title: "Tivdoc - בדיקת תלוש, שכר וזכויות בעבודה",
    description: "תלוש הוא רק השכבה הראשונה. Tivdoc בודק גם מה עומד מאחוריו.",
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="he" dir="rtl" className={`${plexSansHebrew.variable} ${plexMono.variable} ${rubik.variable} ${heebo.variable}`}>
      <body>
        <a className="skip-link" href="#main-content">דלג לתוכן הראשי</a>
        {children}
        <AttributionProvider />
        <AnalyticsProvider />
        <MetaPixelProvider pixelId={process.env.NEXT_PUBLIC_META_PIXEL_ID} />
      </body>
    </html>
  );
}
