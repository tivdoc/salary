import {
  ArrowLeft,
  FileText,
  ChatText,
  Check,
  MagnifyingGlass,
} from "@phosphor-icons/react/dist/ssr";
import { TrackedLink } from "@/components/tracked-link";
import { BrandSymbol } from "@/components/brand-logo";
import { fullPrice, initialPrice, productOffer } from "@/config/product-offer";
export function Hero() {
  return (
    <section className="home-hero">
      <div className="shell home-hero__grid">
        <div className="home-hero__copy">
          <p className="home-kicker">מסתכלים גם מעבר לתלוש</p>
          <h1>
            המסמכים שלך.
            <br />
            <span>התמונה המלאה.</span>
          </h1>
          <p className="home-lead">
            מחברים בין תלושי השכר, מסמכי ההעסקה והתשובות שלך כדי לבדוק את מה
            שמופיע — ואת מה שחסר.
          </p>
          <div className="home-hero__actions">
            <TrackedLink
              className="button button--primary"
              href="/check"
              eventName="start_check"
            >
              התחלת בדיקה ראשונית — <bdi>{initialPrice}</bdi>
              <ArrowLeft aria-hidden="true" />
            </TrackedLink>
            <a className="home-text-link" href="#what-you-get">
              מה מקבלים בבדיקה
            </a>
          </div>
          <p className="home-scope">
            חודש אחד · עד {productOffer.initial.maxTopics} נושאים שנבדקו.
            <br />
            דוח מלא מתוכנן בתשלום נוסף של <bdi>{fullPrice}</bdi>; עדיין אינו
            זמין לרכישה.
          </p>
        </div>
        <figure className="document-scene">
          <div className="document-scene__backdrop" />
          <div className="scene-paper scene-paper--back">
            <FileText size={26} />
            <strong>מסמכי העסקה</strong>
            <span>התנאים שסוכמו</span>
            <div className="paper-lines" />
            <div className="paper-lines short" />
          </div>
          <div className="scene-paper scene-paper--front">
            <div className="paper-heading">
              <FileText size={28} />
              <span>
                תלוש שכר<strong>מתחילים במה שכתוב</strong>
              </span>
            </div>
            <div className="paper-row">
              <span>תקופת הבדיקה</span>
              <b>חודש אחד</b>
            </div>
            <div className="paper-row">
              <span>פרטי השכר</span>
              <Check size={18} />
            </div>
            <div className="paper-row paper-row--highlight">
              <span>שעות ונוכחות</span>
              <MagnifyingGlass size={19} />
            </div>
            <div className="paper-row">
              <span>הפרשות ותנאים</span>
              <Check size={18} />
            </div>
            <div className="paper-lines" />
          </div>
          <div className="scene-question">
            <ChatText size={26} />
            <div>
              <strong>ומה קרה בפועל?</strong>
              <span>התשובות שלך משלימות את המסמכים.</span>
            </div>
          </div>
          <BrandSymbol className="scene-symbol" />
          <figcaption>המחשת התהליך בלבד · ללא נתוני לקוח</figcaption>
        </figure>
      </div>
    </section>
  );
}
