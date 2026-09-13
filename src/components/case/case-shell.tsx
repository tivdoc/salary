import Link from "next/link";
import { BrandLogo } from "@/components/brand-logo";
import { CaseNavigation, ConnectionNotice } from "./case-navigation";
import { SessionControls } from "./session-controls";

// UX Run 1 / U3. The frame every access and case screen sits in: the wordmark,
// one main region, the privacy line. Reuses the check funnel's classes so the
// screens read as one product.
export function CaseShell({ children, eyebrow, publicId }: { children: React.ReactNode; eyebrow?: string; publicId?: string }) {
  return (
    <div className={publicId ? "check-app case-workspace" : "check-app"}>
      <header className="check-header">
        <div className="check-shell check-header__top">
          <Link className="wordmark" href="/" aria-label="תבדוק, חזרה לעמוד הבית">
            <BrandLogo />
          </Link>
          {publicId?<Link href={`/case/${publicId}/thread#support`}>פנייה לתמיכה</Link>:null}
          <Link href="/cases">התיקים שלי</Link><Link href="/account">חשבון</Link><SessionControls />
          {eyebrow ? <span className="check-header__price mono">{eyebrow}</span> : null}
        </div>
      </header>
      <div className="case-workspace__body">
      {publicId ? <CaseNavigation publicId={publicId} /> : null}
      <main id="main-content" className="check-main">
        <div className="check-shell"><ConnectionNotice />{children}</div>
      </main></div>
      <footer className="check-footer"><div className="check-shell"><span>המידע משמש לביצוע הבדיקה בלבד.</span><a href="/privacy">פרטיות</a></div></footer>
    </div>
  );
}
