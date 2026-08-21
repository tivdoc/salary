import { ArrowLeft, ShieldCheck } from "@phosphor-icons/react/dist/ssr";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { TrackedLink } from "@/components/tracked-link";
import { DocumentLayers } from "@/components/landing/document-layers";
import { ExampleResult } from "@/components/landing/example-result";
import { Faq } from "@/components/landing/faq";
import { Hero } from "@/components/landing/hero";
import { Inspector } from "@/components/landing/inspector";
import { LandingView } from "@/components/landing/landing-view";
import { MiniDemo } from "@/components/landing/mini-demo";
import { SamplePayslip } from "@/components/landing/sample-payslip";

const checks = [
  "שעות נוספות",
  "פנסיה",
  "חופשה",
  "הבראה",
  "נסיעות",
  "שישי / שבת / חגים",
  "שכר בסיס",
  "בונוסים ועמלות",
  "חוזה מול העבודה בפועל",
];

export default function Home() {
  return (
    <>
      <LandingView />
      <SiteHeader />
      <main id="main-content">
        <Hero />
        <Inspector />
        <DocumentLayers />
        <MiniDemo />
        <ExampleResult />

        <section className="checks-section" aria-labelledby="checks-title">
          <div className="shell">
            <div className="checks-section__headline">
              <h2 id="checks-title">לא רק מה שילמו לך.<br /><mark>מה היו אמורים לשלם לך.</mark></h2>
            </div>
            <div className="checks-typography" role="list">
              {checks.map((item, index) => (
                <div className={`checks-typography__item checks-typography__item--${(index % 4) + 1}`} role="listitem" key={item}>
                  <span className="mono">{String(index + 1).padStart(2, "0")}</span>
                  <strong>{item}</strong>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="process-section" id="how-it-works" aria-labelledby="process-title">
          <div className="shell">
            <h2 id="process-title">כמה דקות. ארבעה צעדים.</h2>
            <ol className="process-list">
              {[
                ["01", "העלה תלוש", "מספיק תלוש אחד כדי להתחיל."],
                ["02", "ספר איך אתה באמת עובד", "שעות, ימים, תפקיד ומה קורה בפועל."],
                ["03", "Tivdoc בודק את התמונה המלאה", "לא רק את החשבון בתוך התלוש."],
                ["04", "ראה אם נמצאו פערים", "מקבלים בדיקה ראשונית ברורה."],
              ].map(([number, title, text]) => (
                <li key={number}>
                  <span className="process-list__number mono">{number}</span>
                  <div><h3>{title}</h3><p>{text}</p></div>
                  <ArrowLeft aria-hidden="true" />
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="privacy-section" aria-labelledby="privacy-title">
          <div className="shell privacy-section__grid">
            <div className="privacy-section__visual">
              <SamplePayslip variant="redacted" />
            </div>
            <div className="privacy-section__copy">
              <ShieldCheck size={44} weight="duotone" aria-hidden="true" />
              <h2 id="privacy-title">התלוש שלך הוא עניינך.</h2>
              <p>המסמכים והמידע שתעלה משמשים לצורך ביצוע הבדיקה ואינם נשלחים למעסיק.</p>
              <a href="/privacy">למידע על פרטיות ושמירת מסמכים</a>
            </div>
          </div>
        </section>

        <Faq />

        <section className="final-cta" aria-labelledby="final-title">
          <div className="shell final-cta__grid">
            <div className="final-cta__copy">
              <p>את התלוש הבא כבר תסתכל עליו אחרת.</p>
              <h2 id="final-title">תבדוק לפני התלוש הבא.</h2>
              <TrackedLink className="button button--primary button--large" href="/check" eventName="start_check">
                התחל בדיקה — 9.90 ₪
              </TrackedLink>
              <span>תלוש אחד מספיק כדי להתחיל.</span>
            </div>
            <div className="final-cta__visual"><SamplePayslip variant="final" /></div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
