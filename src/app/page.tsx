import { guardStableAppEntrypoint } from "@/server/platform/capabilities/stable-next-entrypoint";
import { ArrowUpLeft, EnvelopeSimple } from "@phosphor-icons/react/dist/ssr";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { TrackedLink } from "@/components/tracked-link";
import { Trust } from "@/components/landing/trust";
import { PriceTiers } from "@/components/landing/price-tiers";
import { Hero } from "@/components/landing/hero";
import { Process } from "@/components/landing/process";
import { ReportPreview } from "@/components/landing/report-preview";
import { Faq } from "@/components/landing/faq";
import { LandingView } from "@/components/landing/landing-view";
import { StudioMotion } from "@/components/landing/studio-motion";
import {
  initialPrice,
  productOffer,
  formatPrice,
} from "@/config/product-offer";
import "./studio.css";

export default async function Home() {
  await guardStableAppEntrypoint("CEP-001");
  const salesAvailable =
    process.env.TIVDOC_INITIAL_SALES_ENABLED === "true" &&
    process.env.TIVDOC_INVOICE4U_CHECKOUT_ENABLED === "true";
  const tiers = productOffer.full.tiers;
  return (
    <div className="studio-site studio-flow">
      <LandingView />
      <StudioMotion />
      <SiteHeader compact />
      <main id="main-content">
        <Hero />
        <Process />
        <ReportPreview />
        <Trust />
        <section
          className="studio-pricing"
          id="pricing"
          aria-labelledby="pricing-title"
        >
          <div className="studio-shell">
            <h2 id="pricing-title" className="studio-section-title">
              כמה זה עולה
            </h2>
            <div className="pricing-overview">
              <div className="initial-offer">
                <h3>בדיקה ראשונית</h3>
                <p className="price-sheet__amount">
                  <bdi>{initialPrice}</bdi>
                  <span>תשלום חד־פעמי</span>
                </p>
                <p className="price-sheet__scope">
                  חודש אחד · עד {productOffer.initial.maxTopics} נושאים
                </p>
                <p>
                  הכיסוי תלוי במסמכים ובתשובות. זו אינה בדיקה של כל תקופת
                  ההעסקה.
                </p>
                <p className="offer-availability">
                  {salesAvailable
                    ? "אפשר להתחיל בדיקה ראשונית"
                    : "בדיקות חדשות עדיין אינן זמינות לרכישה."}
                </p>
              </div>
              <div className="followup-offer">
                <h3>המשך בתשלום נפרד</h3>
                <p className="followup-range">
                  <bdi>
                    {formatPrice(tiers[0].total_minor / 100)}–
                    {formatPrice(tiers[tiers.length - 1].total_minor / 100)}
                  </bdi>{" "}
                  כולל הבדיקה הראשונית
                </p>
                <p>
                  המחיר לפי הפער שאפשר לבסס; התשלום הראשוני המאומת מתקזז פעם
                  אחת. כל המשך הוא בחירה, ללא חיוב אוטומטי.
                </p>
                <p>התקופה, הכיסוי ומועד המסירה יוצגו בהצעה לפני רכישה.</p>
                <p className="offer-availability">
                  דוח מלא עדיין אינו זמין לרכישה.
                </p>
              </div>
            </div>
            <details className="pricing-details">
              <summary>טבלת המדרגות והקיזוז · כל המחירים לפני רכישה</summary>
              <PriceTiers />
            </details>
          </div>
        </section>
        <Faq
          action={
            <div className="finish-action">
              <p>
                {salesAvailable
                  ? "מכינים תלוש ומתחילים בבדיקה ראשונית."
                  : "בדיקות חדשות עדיין אינן זמינות לרכישה. לשאלות על השירות, אנחנו כאן."}
              </p>
              {salesAvailable ? (
                <TrackedLink
                  prefetch={false}
                  className="studio-button"
                  href="/check"
                  eventName="start_check"
                >
                  התחלת בדיקה · {initialPrice}
                  <ArrowUpLeft size={22} aria-hidden="true" />
                </TrackedLink>
              ) : (
                <a
                  className="studio-button"
                  href={"mailto:" + productOffer.supportEmail}
                >
                  פנייה לשירות
                  <EnvelopeSimple size={22} aria-hidden="true" />
                </a>
              )}
            </div>
          }
        />
      </main>
      <SiteFooter />
    </div>
  );
}
