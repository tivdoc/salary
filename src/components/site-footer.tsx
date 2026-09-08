import Link from "next/link";
import { BrandLogo } from "@/components/brand-logo";
import { productOffer } from "@/config/product-offer";
export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="shell site-footer__inner">
        <div>
          <Link prefetch={false} className="footer-brand" href="/" aria-label="תבדוק, עמוד הבית">
            <BrandLogo />
          </Link>
          <p>המסמכים שלך. התמונה המלאה.</p>
          <p>מופעל על ידי תקראלוקס · ח״פ 317067916 · אורן 4, נשר</p>
        </div>
        <nav aria-label="שירות ומידע">
          <a href={"mailto:" + productOffer.supportEmail}>יצירת קשר</a>
          <Link prefetch={false} href="/privacy">פרטיות</Link>
          <Link prefetch={false} href="/terms">תנאי שימוש</Link>
          <Link prefetch={false} href="/accessibility">נגישות</Link>
          <Link prefetch={false} href="/#faq">שאלות ותשובות</Link>
        </nav>
      </div>
    </footer>
  );
}
