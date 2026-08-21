import Link from "next/link";
import { TrackedLink } from "@/components/tracked-link";

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="shell site-header__inner">
        <Link className="wordmark" href="/" aria-label="Tivdoc, עמוד הבית">
          <span className="wordmark__mark" aria-hidden="true">T</span>
          Tivdoc
        </Link>
        <nav className="site-nav" aria-label="ניווט ראשי">
          <Link href="/#how-it-works">איך זה עובד</Link>
          <Link href="/#faq">שאלות</Link>
          <TrackedLink className="button button--small" href="/check" eventName="start_check">
            התחלת בדיקה
          </TrackedLink>
        </nav>
      </div>
    </header>
  );
}
