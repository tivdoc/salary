import Link from "next/link";

// UX Run 1 / U3. The frame every access and case screen sits in: the wordmark,
// one main region, the privacy line. Reuses the check funnel's classes so the
// screens read as one product.
export function CaseShell({ children, eyebrow }: { children: React.ReactNode; eyebrow?: string }) {
  return (
    <div className="check-app">
      <header className="check-header">
        <div className="check-shell check-header__top">
          <Link className="wordmark" href="/" aria-label="Tivdoc, חזרה לעמוד הבית">
            <span className="wordmark__mark" aria-hidden="true">T</span>
            Tivdoc
          </Link>
          {eyebrow ? <span className="check-header__price mono">{eyebrow}</span> : null}
        </div>
      </header>
      <main id="main-content" className="check-main">
        <div className="check-shell">{children}</div>
      </main>
      <footer className="check-footer"><div className="check-shell"><span>המידע משמש לביצוע הבדיקה בלבד.</span><a href="/privacy">פרטיות</a></div></footer>
    </div>
  );
}
