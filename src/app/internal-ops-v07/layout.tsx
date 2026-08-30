import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "מסוף תפעול פנימי | Tivdoc",
  description: "מסוף תפעול פנימי מוגן",
  robots: { index: false, follow: false, noarchive: true, nosnippet: true },
};

export default function InternalOpsLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
