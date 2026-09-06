import type { Metadata } from "next";
import { CheckHeader } from "@/components/check/check-header";
import { FunnelProgressProvider } from "@/components/check/funnel-progress";

export const metadata: Metadata = {
  title: "בדיקת שכר | Tivdoc",
  robots: { index: false, follow: false },
};

export default function CheckLayout({ children }: { children: React.ReactNode }) {
  return (
    <FunnelProgressProvider>
      <div className="check-app">
        <CheckHeader />
        <main id="main-content" className="check-main">
          <div className="check-shell">{children}</div>
        </main>
        <footer className="check-footer"><div className="check-shell"><span>המידע משמש לביצוע הבדיקה בלבד.</span><a href="/privacy">פרטיות</a></div></footer>
      </div>
    </FunnelProgressProvider>
  );
}
