import { ArrowDown } from "@phosphor-icons/react/dist/ssr";
import { LensArtwork } from "@/components/landing/lens-artwork";
import { DetailDialog } from "./detail-dialog";
import { ExplainerVideo } from "./explainer-video";
export function Hero() {
  return (
    <section className="studio-hero" aria-labelledby="hero-title">
      <div className="studio-shell studio-hero__layout">
        <div className="studio-hero__copy">
          <p className="studio-eyebrow">בדיקת שכר וזכויות בעבודה</p>
          <h1 id="hero-title">
            <span>יש יותר</span>
            <span>ממה שכתוב.</span>
          </h1>
          <p className="studio-hero__intro">
            בדיקת AI שמחברת בין תלוש השכר לעבודה בפועל, כדי לזהות פערים אפשריים
            בשכר ובזכויות.
          </p>
          <div className="hero-actions">
            <a className="studio-link" href="#how-it-works">
              <span className="studio-link__icon">
                <ArrowDown size={22} aria-hidden="true" />
              </span>
              איך הבדיקה עובדת
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
        <LensArtwork />
      </div>
    </section>
  );
}
