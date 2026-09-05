import { TrackedLink } from "@/components/tracked-link";
import { formatDuration, formatPrice, productOffer } from "@/lib/product-offer";

/**
 * Site S5. The hero visual, in place of the canvas's cut-out photograph of a
 * person — there is no such photograph and one will not be invented (brief §4:
 * no stock, no AI-generated person, no placeholder).
 *
 * What it shows instead is the product's own shape: a report frame carrying the
 * three certainty levels in the exact language D-6.2 fixes, and NO amounts.
 * D-6.3 is mechanical — at low certainty no amount is shown anywhere in the
 * product — and a marketing page that showed one here would be the first place
 * to break it. The rows below therefore carry no shekel figure at all, not even
 * a plausible-looking one.
 */
export function HeroVisual() {
  const levels = [
    { level: "גבוהה", shows: "סכום או טווח", sentence: "הנתון נשען על המסמכים" },
    { level: "בינונית", shows: "טווח בלבד", sentence: "הנתון תלוי במה שמסרת" },
    { level: "נמוכה", shows: "כיוון בלבד, בלי מספר", sentence: "אי אפשר לקבוע סכום, וזה מה שיעלה את הוודאות" },
  ];
  return (
    <figure className="v5-hero__visual" aria-labelledby="hero-visual-title">
      <div className="v5-report">
        <div className="v5-report__bar">
          <span className="v5-report__dot" aria-hidden="true" />
          <p id="hero-visual-title">כך נראית התוצאה: כל נקודה עם רמת הוודאות שלה</p>
        </div>
        <ul className="v5-report__rows">
          {levels.map((row) => (
            <li className={`v5-report__row v5-report__row--${row.level === "גבוהה" ? "high" : row.level === "בינונית" ? "medium" : "low"}`} key={row.level}>
              <span className="v5-report__level">ודאות {row.level}</span>
              <span className="v5-report__shows">{row.shows}</span>
              <span className="v5-report__sentence">{row.sentence}</span>
            </li>
          ))}
        </ul>
        <p className="v5-report__note">המסגרת מציגה את רמות הוודאות בלבד. אין כאן סכומים — סכום מוצג רק בתיק שלך, ורק כשהבסיס לנושא מלא.</p>
      </div>
    </figure>
  );
}

export function HeroV5() {
  const offer = productOffer();
  const price = formatPrice(offer.initial_check.price);
  const automatic = formatDuration(offer.initial_check.delivery.automatic);
  return (
    <section className="v5-hero" aria-labelledby="v5-hero-title">
      <div className="v5-shell v5-hero__grid">
        <div className="v5-hero__copy">
          <h1 id="v5-hero-title">תבדוק.<br />לפני שהחודש נגמר.</h1>
          <p className="v5-hero__lede">
            בדיקה של תלוש אחד, לפי החוק וההסכמים שחלים עליך. מתחילים מכמה שאלות, מצרפים תלוש,
            ומקבלים נקודות לבדיקה תוך {automatic}.
          </p>
          <TrackedLink className="button button--primary button--large v5-cta" href="/check" eventName="start_check">
            לבדיקת התלוש שלי · {price}
          </TrackedLink>
          {/* D-5.1: the second product is named before any payment, never after. */}
          <p className="v5-hero__second-product">{offer.second_product_sentence}</p>
        </div>
        <HeroVisual />
      </div>
    </section>
  );
}
