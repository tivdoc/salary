import { guardStableAppEntrypoint } from "@/server/platform/capabilities/stable-next-entrypoint";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowUpLeft,
  ArrowUUpLeft,
  Files,
  EnvelopeSimple,
} from "@phosphor-icons/react/dist/ssr";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { TrackedLink } from "@/components/tracked-link";
import { BrandSymbol } from "@/components/brand-logo";
import { ExplainerVideo } from "@/components/landing/explainer-video";
import { PriceTiers } from "@/components/landing/price-tiers";
import { Hero } from "@/components/landing/hero";
import { Process } from "@/components/landing/process";
import { ReportPreview } from "@/components/landing/report-preview";
import { Faq } from "@/components/landing/faq";
import { LandingView } from "@/components/landing/landing-view";
import { StudioMotion } from "@/components/landing/studio-motion";
import { fullPrice, initialPrice, productOffer } from "@/config/product-offer";
import "./studio.css";

export default async function Home() {
  await guardStableAppEntrypoint("CEP-001");
  const salesAvailable = process.env.TIVDOC_INITIAL_SALES_ENABLED === "true" && process.env.TIVDOC_INVOICE4U_CHECKOUT_ENABLED === "true";
  return (
    <div className="studio-site">
      <LandingView />
      <StudioMotion />
      <SiteHeader compact />
      <main id="main-content">
        <Hero />
        <div className="studio-availability studio-shell" role="status">
          <span className="availability-dot" />
          {salesAvailable
            ? "אפשר להתחיל בדיקה ראשונית"
            : "פתיחת הזמנות חדשות אינה זמינה כרגע."}
          <Link href="/check" prefetch={false}>
            זמינות השירות <ArrowLeft size={16} aria-hidden="true" />
          </Link>
        </div>
        <Process />
        <section className="studio-film" aria-labelledby="film-title">
          <div className="studio-shell">
            <div className="studio-film__heading" data-reveal>
              <h2 id="film-title">
                כל התהליך.
                <br />
                בחצי דקה.
              </h2>
              <span className="film-duration" aria-label="30 שניות">
                00:30
              </span>
            </div>
            <div className="studio-film__frame" data-reveal>
              <ExplainerVideo poster="/media/tivdoc-explainer-poster.webp" />
            </div>
            <details className="studio-transcript" id="explainer-transcript">
              <summary>מעדיפים לקרוא? ההסבר כאן</summary>
              <p>
                מתחילים בתלוש ובמסמכים הזמינים, ומשלימים תשובות על העבודה בפועל.
                הבדיקה המתוכננת מצליבה את המקורות בתחום שנכלל במוצר. מידע חסר
                מצוין ככזה, ולא הופך לסכום משוער. התוצר נועד לרכז את מה שנבדק,
                מקורותיו והצעד הבא לבירור. זו המחשה של שירות מתוכנן, ללא הבטחה
                להחזר כספי. התוצר אינו הבטחה לקבלת כסף מהמעסיק.
              </p>
            </details>
          </div>
        </section>
        <ReportPreview />
        <section
          className="studio-pricing"
          id="pricing"
          aria-labelledby="pricing-title"
        >
          <div className="studio-shell">
            <h2 id="pricing-title" className="studio-section-title" data-reveal>
              מתחילים קטן.
              <br />
              <span>מעמיקים אם צריך.</span>
            </h2>
            <p className="studio-pricing__intro">
              {salesAvailable ? "מתחילים בבדיקה ראשונית. כל המשך הוא החלטה נפרדת." : "מחירי ההשקה. פתיחת הזמנות חדשות אינה זמינה כרגע."}
            </p>
            <div className="price-comparison" data-reveal>
              <article className="price-sheet">
                <div className="price-sheet__heading">
                  <h3>בדיקה ראשונית</h3>
                  <span>נקודת ההתחלה</span>
                </div>
                <p className="price-sheet__amount">
                  <bdi>{initialPrice}</bdi>
                  <span>תשלום חד־פעמי</span>
                </p>
                <p className="price-sheet__scope">
                  חודש אחד. עד {productOffer.initial.maxTopics} נושאים.
                </p>
                <ul>
                  <li>בחינת פערים אפשריים בתחום הבדיקה</li>
                  <li>מידע חסר ומה דורש בירור</li>
                  <li>חישוב רק כשיש בסיס מספיק</li>
                </ul>
                <details>
                  <summary>מה עוד כדאי לדעת</summary>
                  <p>
                    הכיסוי תלוי במסמכים ובתשובות שמסרת. זו אינה בדיקה של כל
                    תקופת ההעסקה. ייתכן שיידרשו השלמות; מועד מסירה ייקבע לפי
                    הטיפול בתיק, ללא התחייבות לתוצאה מיידית.
                  </p>
                </details>
                <TrackedLink
                  prefetch={false}
                  className="studio-button"
                  href="/check"
                  eventName="start_check"
                >
                  {salesAvailable
                    ? "התחלת בדיקה"
                    : "זמינות השירות"}
                  <ArrowUpLeft size={22} aria-hidden="true" />
                </TrackedLink>
              </article>
              <article className="price-sheet price-sheet--full">
                <div className="price-sheet__heading">
                  <h3>דוח מלא</h3>
                  <span>המשך מתוכנן</span>
                </div>
                <p className="price-sheet__amount">
                  <bdi>{fullPrice}</bdi>
                  <span>מחיר כולל ראשוני לפי מדרגת הפער המבוסס</span>
                </p>
                <p className="price-sheet__scope">בדיקת AI עם מקורות, הסברים ואפשרות לתיקון.</p>
                <ul>
                  <li>העמקה בתקופה שתוסכם מראש</li>
                  <li>ממצאים, מקורות וצעד הבא</li>
                  <li>חישוב רק כשהמידע והוודאות מאפשרים</li>
                </ul>
                <details>
                  <summary>מה עוד כדאי לדעת</summary>
                  <p>
                    דוח מלא עדיין אינו זמין לרכישה. לפני רכישה יוצגו היקף
                    הבדיקה ומועד המסירה. התשלום הראשוני המאומת מתקזז פעם אחת. סכום לא
                    יוצג כשהמידע או רמת הוודאות אינם מאפשרים זאת.
                  </p>
                </details>
                <a className="studio-text-link" href="#what-you-get">
                  מבנה התוצר <ArrowLeft size={20} aria-hidden="true" />
                </a>
              </article>
            </div>
            <PriceTiers />
          </div>
        </section>
        <section
          className="studio-about"
          id="about"
          aria-labelledby="about-title"
        >
          <div className="studio-shell">
            <div className="studio-about__intro" data-reveal>
              <BrandSymbol />
              <h2 id="about-title">
                מאחורי כל מסמך,
                <br />
                יש יום עבודה שלם.
              </h2>
              <p>
                תבדוק נועדה לעזור להבין את הקשר בין מה שמופיע במסמכים לבין מה
                שקורה בפועל. עם הסבר ברור, וגם עם מקום למה שעדיין לא ידוע.
              </p>
            </div>
            <div className="studio-principles" data-reveal>
              <div>
                <h3>המידע שלך, פרטי.</h3>
                <p>הגישה למסמכים מוגבלת לצורך השירות.</p>
                <Link href="/privacy">
                  מדיניות הפרטיות <ArrowLeft size={17} aria-hidden="true" />
                </Link>
              </div>
              <div>
                <h3>גם הגבולות ברורים.</h3>
                <p>הבדיקה אינה קביעה משפטית או הבטחה להחזר.</p>
                <Link href="/terms">
                  תנאי השירות <ArrowLeft size={17} aria-hidden="true" />
                </Link>
              </div>
            </div>
          </div>
        </section>
        <Faq />
        <section className="studio-service" aria-labelledby="service-title">
          <div className="studio-shell">
            <h2 id="service-title" data-reveal>
              כבר התחלנו?
              <br />
              <span>ממשיכים מכאן.</span>
            </h2>
            <div className="studio-service__links">
              <Link href="/cases">
                <ArrowUUpLeft size={26} aria-hidden="true" />
                <span>מצב הבדיקה שלי</span>
                <ArrowUpLeft size={23} aria-hidden="true" />
              </Link>
              <Link href="/cases">
                <Files size={26} aria-hidden="true" />
                <span>העלאת מסמכים</span>
                <ArrowUpLeft size={23} aria-hidden="true" />
              </Link>
              <a href={"mailto:" + productOffer.supportEmail}>
                <EnvelopeSimple size={26} aria-hidden="true" />
                <span>פנייה לשירות</span>
                <ArrowUpLeft size={23} aria-hidden="true" />
              </a>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
