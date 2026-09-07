import { guardStableAppEntrypoint } from "@/server/platform/capabilities/stable-next-entrypoint";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowUUpLeft,
  ChatText,
  Files,
  FileText,
  MagnifyingGlass,
  ListChecks,
  ShieldCheck,
  EnvelopeSimple,
} from "@phosphor-icons/react/dist/ssr";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { TrackedLink } from "@/components/tracked-link";
import { BrandSymbol } from "@/components/brand-logo";
import { Hero } from "@/components/landing/hero";
import { Process } from "@/components/landing/process";
import { ReportPreview } from "@/components/landing/report-preview";
import { PriceTiers } from "@/components/landing/price-tiers";
import { Faq } from "@/components/landing/faq";
import { LandingView } from "@/components/landing/landing-view";
import { fullPrice, initialPrice, productOffer } from "@/config/product-offer";
export default async function Home() {
  await guardStableAppEntrypoint("CEP-001");
  return (
    <>
      <LandingView />
      <SiteHeader />
      <main id="main-content" className="home-v3">
        {process.env.TIVDOC_INITIAL_SALES_ENABLED !== 'true' || process.env.TIVDOC_INVOICE4U_CHECKOUT_ENABLED !== 'true' ? <div className="shell service-availability" role="status">פתיחת הזמנות חדשות אינה זמינה כרגע. אפשר לעיין בהסבר ולחזור לתיק קיים.</div> : null}
        <Hero />
        <div className="service-strip">
          <div className="shell service-strip__inner">
            <p>
              כבר התחלת?
              <br />
              <strong>ממשיכים מכאן.</strong>
            </p>
            <Link href="/cases">
              <span>
                <ArrowUUpLeft size={25} />
              </span>
              <strong>מצב הבדיקה שלי</strong>
              <ArrowLeft size={18} />
            </Link>
            <Link href="/cases">
              <span>
                <Files size={25} />
              </span>
              <strong>העלאת מסמכים</strong>
              <ArrowLeft size={18} />
            </Link>
            <a href={"mailto:" + productOffer.supportEmail}>
              <span>
                <ChatText size={25} />
              </span>
              <strong>עזרה ושאלות</strong>
              <ArrowLeft size={18} />
            </a>
          </div>
        </div>
        <Process />
        <section
          className="explanation-section"
          aria-labelledby="explanation-title"
        >
          <div className="shell">
            <div className="section-intro">
              <h2 id="explanation-title">כך נוצרת תמונה ברורה.</h2>
              <p>המסמכים מספרים חלק מהסיפור. התשובות שלך עוזרות לחבר אותו.</p>
            </div>
            <div
              className="explanation-flow"
              role="img"
              aria-label="מסמכים ותשובות עוברים בדיקה והשוואה ומתרכזים בתוצר עם מקור וצעד הבא"
            >
              <div>
                <FileText size={42} weight="duotone" />
                <strong>המסמכים</strong>
                <span>מה מופיע בכתב</span>
              </div>
              <span className="flow-plus" aria-hidden="true">
                +
              </span>
              <div>
                <ChatText size={42} weight="duotone" />
                <strong>התשובות שלך</strong>
                <span>מה קורה בפועל</span>
              </div>
              <ArrowLeft className="flow-arrow" size={28} aria-hidden="true" />
              <div>
                <MagnifyingGlass size={42} weight="duotone" />
                <strong>בדיקה והשוואה</strong>
                <span>כולל מה שחסר</span>
              </div>
              <ArrowLeft className="flow-arrow" size={28} aria-hidden="true" />
              <div>
                <ListChecks size={42} weight="duotone" />
                <strong>תמונה מסודרת</strong>
                <span>מקור, הסבר וצעד הבא</span>
              </div>
            </div>
            <p className="explanation-caption">
              המחשה כתובה של התהליך. סרטון הסבר אינו זמין כרגע.
            </p>
            <details className="explanation-transcript">
              <summary>לקריאת ההסבר המלא</summary>
              <p>
                מתחילים בתלוש ובמסמכים הזמינים, ומשלימים תשובות על העבודה בפועל.
                הבדיקה מצליבה את המקורות בתחום שנכלל במוצר. מידע חסר מצוין ככזה,
                ולא הופך לסכום משוער. התוצר המתוכנן מרכז את מה שנבדק, מקורותיו
                והצעד הבא לבירור. הוא אינו הבטחה להחזר כספי.
              </p>
            </details>
          </div>
        </section>
        <ReportPreview />
        <section
          className="home-section pricing-v3"
          id="pricing"
          aria-labelledby="pricing-title"
        >
          <div className="shell">
            <div className="section-intro">
              <h2 id="pricing-title">
                יודעים מה מקבלים.
                <br />
                ויודעים כמה זה עולה.
              </h2>
              <p>מתחילים בבדיקה ראשונית. כל המשך הוא החלטה נפרדת.</p>
            </div>
            <div className="offer-grid">
              <article className="offer offer--initial">
                <span className="offer-label">כאן מתחילים</span>
                <h3>בדיקה ראשונית</h3>
                <p className="offer-price">
                  <bdi>{initialPrice}</bdi>
                  <span>תשלום חד־פעמי</span>
                </p>
                <p>
                  חודש אחד. עד {productOffer.initial.maxTopics} נושאים שנבדקו.
                  <br />
                  לפי המסמכים והתשובות שמסרת.
                </p>
                <ul>
                  <li>בחינת פערים אפשריים בתחום הבדיקה</li>
                  <li>ציון מידע חסר ומה דורש בירור</li>
                  <li>ללא סכום כשאין בסיס מספיק</li>
                </ul>
                <p className="offer-note">
                  לא בדיקה של כל תקופת ההעסקה. ייתכן שיידרשו השלמות. מועד מסירה
                  ייקבע לפי הטיפול בתיק; אין התחייבות לתוצאה מיידית.
                </p>
                <TrackedLink
                  className="button button--primary"
                  href="/check"
                  eventName="start_check"
                >
                  התחלת בדיקה ראשונית
                  <ArrowLeft aria-hidden="true" />
                </TrackedLink>
              </article>
              <article className="offer">
                <span className="offer-label">
                  המשך מתוכנן · עדיין לא זמין לרכישה
                </span>
                <h3>דוח מלא</h3>
                <p className="offer-price">
                  <bdi>{fullPrice}</bdi>
                  <span>מחיר כולל ראשוני לפי מדרגת הפער המבוסס</span>
                </p>
                <p>
                  העמקה בתקופה שתוסכם מראש.
                  <br />
                  בדיקת AI עם מקורות, הסברים ואפשרות לתיקון.
                </p>
                <ul>
                  <li>פירוט ממצאים, מקורות וצעד הבא</li>
                  <li>חישוב רק כשהמידע והוודאות מאפשרים</li>
                  <li>היקף ומועד מסירה לפני רכישה</li>
                </ul>
                <p className="offer-note">
                  התשלום הראשוני המאומת מתקזז פעם אחת. שדרוג יוצע רק לאחר
                  אימות הבסיס הכספי והכיסוי שניתן למסור; אין הבטחת גבייה מהמעסיק.
                </p>
                <a className="home-text-link" href="#what-you-get">
                  להיכרות עם מבנה התוצר
                  <ArrowLeft aria-hidden="true" />
                </a>
              </article>
            </div>
            <PriceTiers />
          </div>
        </section>
        <section
          className="home-section trust-v3"
          id="about"
          aria-labelledby="trust-title"
        >
          <div className="shell trust-v3__grid">
            <div className="trust-v3__brand">
              <BrandSymbol />
              <p>
                כל פרט הוא חלק
                <br />
                מהתמונה שלך.
              </p>
            </div>
            <div>
              <h2 id="trust-title">
                בדיקה רצינית מתחילה
                <br />
                בציפיות ברורות.
              </h2>
              <p className="home-lead">
                תבדוק נועדה לעזור להבין את המידע שמפוזר בין המסמכים לבין יום
                העבודה שלך.
              </p>
              <div className="trust-item">
                <ShieldCheck size={28} aria-hidden="true" />
                <div>
                  <h3>המסמכים נשארים פרטיים</h3>
                  <p>
                    הגישה למסמכים מוגבלת לצורך השירות. אפשר לקרוא מה נשמר ואיך
                    פונים בנוגע למידע שלך.
                  </p>
                  <Link className="home-text-link" href="/privacy">
                    מדיניות הפרטיות
                  </Link>
                </div>
              </div>
              <div className="trust-item">
                <ListChecks size={28} aria-hidden="true" />
                <div>
                  <h3>גם לגבולות הבדיקה יש מקום</h3>
                  <p>
                    הבדיקה אינה קביעה משפטית או הבטחה לתשלום מהמעסיק. מידע חסר,
                    היקף הבדיקה ורמת הוודאות משפיעים על התוצאה.
                  </p>
                  <Link className="home-text-link" href="/terms">
                    תנאי השירות
                  </Link>
                </div>
              </div>
              <div className="trust-item">
                <EnvelopeSimple size={28} aria-hidden="true" />
                <div>
                  <h3>יש כתובת לשאלות</h3>
                  <p>
                    פרטי מפעיל השירות ודרכי הפנייה מופיעים בתנאי השימוש.
                  </p>
                  <a
                    className="home-text-link"
                    href={"mailto:" + productOffer.supportEmail}
                  >
                    <bdi>{productOffer.supportEmail}</bdi>
                  </a>
                </div>
              </div>
            </div>
          </div>
        </section>
        <Faq />
        <section className="closing-v3">
          <div className="shell">
            <h2>נתחיל בחלק הראשון?</h2>
            <p>תלוש אחד, כמה תשובות, ונקודת התחלה ברורה.</p>
            <TrackedLink
              className="button button--primary"
              href="/check"
              eventName="start_check"
            >
              התחלת בדיקה — <bdi>{initialPrice}</bdi>
              <ArrowLeft aria-hidden="true" />
            </TrackedLink>
            <p className="home-scope">
              חודש אחד · עד {productOffer.initial.maxTopics} נושאים שנבדקו
            </p>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
