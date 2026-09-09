import Link from "next/link";
import { productOffer } from "@/config/product-offer";
export function Trust() {
  return (
    <section className="studio-trust" id="about" aria-labelledby="about-title">
      <div className="studio-shell">
        <h2 id="about-title" className="studio-section-title">
          יודעים מי עומד מאחורי הבדיקה.
        </h2>
        <p className="trust-limit">
          השירות נעזר ב־AI; אין הבטחה שאיש מקצוע בודק כל דוח.
        </p>
        <div className="trust-grid">
          <article>
            <span className="trust-index">01</span>
            <h3>כתובת לפנייה</h3>
            <p>מפעילת השירות: תקראלוקס</p>
            <a href={"mailto:" + productOffer.supportEmail}>
              {productOffer.supportEmail}
            </a>
            <details>
              <summary>המפעיל ובקשות תיקון</summary>
              <p>תקראלוקס · ח״פ 317067916 · אורן 4, נשר.</p>
              <p>
                לשאלה או לתיקון אפשר לפנות מתוך התיק או לדוא״ל השירות עם מספר
                התיק.
              </p>
            </details>
          </article>
          <article>
            <span className="trust-index">02</span>
            <h3>מקורות ברורים</h3>
            <p>אפשר לראות על מה מבוסס כל ממצא.</p>
            <details>
              <summary>שיטת הבדיקה</summary>
              <p>
                מצליבים מסמכים ותשובות בתחום שנכלל בבדיקה. חוסר מידע מצוין ליד
                הממצא, וחישוב מוצג רק כשיש בסיס מספיק.
              </p>
              <Link prefetch={false} href="/terms">
                תנאי השירות
              </Link>
            </details>
          </article>
          <article>
            <span className="trust-index">03</span>
            <h3>פרטיות</h3>
            <p>מסמכים ודוחות מוצגים לאחר בדיקת הרשאה.</p>
            <details>
              <summary>שמירת מידע והזכויות שלך</summary>
              <p>בקשות לעיון, תיקון ומחיקת מידע מטופלות בהתאם למדיניות.</p>
              <Link prefetch={false} href="/privacy">
                למדיניות הפרטיות המלאה
              </Link>
            </details>
          </article>
        </div>
      </div>
    </section>
  );
}
