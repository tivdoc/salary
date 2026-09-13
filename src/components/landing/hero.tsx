import {
  ArrowDown,
  ArrowUpLeft,
  EnvelopeSimple,
} from "@phosphor-icons/react/dist/ssr";
import { LensArtwork } from "@/components/landing/lens-artwork";
import { DetailDialog } from "./detail-dialog";
import { ExplainerVideo } from "./explainer-video";
import { TrackedLink } from "@/components/tracked-link";
import { productOffer } from "@/config/product-offer";
export function Hero({ salesAvailable }: { salesAvailable: boolean }) {
  return (
    <section className="studio-hero" aria-labelledby="hero-title">
      <div className="studio-shell studio-hero__layout">
        <div className="studio-hero__copy">
          <p className="studio-eyebrow">בדיקת שכר וזכויות בעבודה</p>
          <h1 id="hero-title">
            <span>קיבלת את כל</span>
            <span>מה שמגיע לך</span>
            <span>בעבודה?</span>
          </h1>
          <p className="studio-hero__intro">
            תבדוק מנתחת בעזרת AI את תלושי השכר והמסמכים שלך, ומסבירה מה נמצא, מה
            חסר לבדיקה ומה אפשר לעשות הלאה.
          </p>
          <div className="hero-start">
            {salesAvailable ? (
              <TrackedLink
                prefetch={false}
                className="studio-button"
                href="/check"
                eventName="start_check"
              >
                התחילו בדיקת שכר
                <ArrowUpLeft size={22} aria-hidden="true" />
              </TrackedLink>
            ) : (
              <a
                className="studio-button"
                href={
                  "mailto:" +
                  productOffer.supportEmail +
                  "?subject=" +
                  encodeURIComponent("שאלה על בדיקת שכר")
                }
              >
                לשאלות על בדיקת שכר
                <EnvelopeSimple size={22} aria-hidden="true" />
              </a>
            )}
            <p className="hero-availability">
              {salesAvailable
                ? "בדיקה ראשונית בתשלום · המחיר והכיסוי בהמשך"
                : "בדיקות חדשות עדיין אינן זמינות לרכישה."}
            </p>
          </div>
          <div className="hero-actions">
            <a className="studio-link" href="#how-it-works">
              <span className="studio-link__icon">
                <ArrowDown size={22} aria-hidden="true" />
              </span>
              איך זה עובד?
            </a>
            <DetailDialog
              label="לצפייה · 30 שניות"
              title="כך הבדיקה עובדת"
              kind="video"
            >
              <ExplainerVideo poster="/media/tivdoc-explainer-sample.jpg" />
              <p className="film-note">המחשת תהליך · ללא קול</p>
              <details id="explainer-transcript" className="studio-transcript">
                <summary>הסבר הסרטון בטקסט</summary>
                <p>
                  מסמך נכנס לבדיקה, תשובה משלימה את ההקשר ומקור מסומן ליד הממצא.
                  כשחסר מידע, מוצג מה צריך להשלים. הסרטון ממחיש את התהליך
                  המתוכנן ואינו דוח של לקוח.
                </p>
              </details>
            </DetailDialog>
          </div>
        </div>
        <div className="hero-art">
          <LensArtwork />
          <p className="hero-brand-line">יש יותר ממה שכתוב.</p>
        </div>
      </div>
    </section>
  );
}
