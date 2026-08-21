import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="shell site-footer__inner">
        <div>
          <div className="wordmark wordmark--footer">
            <span className="wordmark__mark" aria-hidden="true">T</span>
            Tivdoc
          </div>
          <p>בדיקה ראשונית של תלוש, שכר וזכויות בעבודה.</p>
        </div>
        <nav aria-label="קישורים משפטיים">
          <Link href="/privacy">פרטיות</Link>
          <Link href="/terms">תנאי שימוש</Link>
        </nav>
      </div>
    </footer>
  );
}
