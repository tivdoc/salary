import Link from "next/link";
import { productOffer } from "@/config/product-offer";
export function Trust() {
  return (
    <section className="studio-trust" id="about" aria-labelledby="about-title">
      <div className="studio-shell">
        <div className="trust-heading">
          <p className="studio-eyebrow">אפשר לבדוק גם אותנו</p>
          <h2 id="about-title">
            ברור מה נבדק.
            <br />
            ברור על מה מסתמכים.
          </h2>
          <p>
            בדיקת AI עם מקורות והסברים. התמיכה מטפלת בשאלות ובתיקונים; אין הבטחה
            שאיש מקצוע בודק כל דוח.
          </p>
        </div>
        <div className="trust-grid">
          <article>
            <span className="trust-index">01 / אחריות</span>
            <h3>יש כתובת לפנייה.</h3>
            <p>
              מפעילת השירות: תקראלוקס
              <br />
              ח״פ 317067916
              <br />
              אורן 4, נשר
            </p>
            <a href={"mailto:" + productOffer.supportEmail}>
              {productOffer.supportEmail}
            </a>
          </article>
          <article>
            <span className="trust-index">02 / ראיות</span>
            <h3>מהמסמך להסבר.</h3>
            <p>
              בדוגמה, שדה חסר במקור משאיר את הסכום לא ידוע. אפשר לפתוח את המקור
              ואת מצב הנושאים ולראות את ההבחנה.
            </p>
            <a href="#what-you-get">לממצא ולמקור בדוגמה ←</a>
          </article>
          <article>
            <span className="trust-index">03 / תיקון ופרטיות</span>
            <h3>אפשר לשאול. אפשר לתקן.</h3>
            <p>
              לקוחות יכולים לפנות מתוך התיק או לדוא״ל השירות עם מספר התיק. בקשות
              לעיון, תיקון או מחיקת מידע מטופלות בהתאם למדיניות.
            </p>
            <a
              href={
                "mailto:" +
                productOffer.supportEmail +
                "?subject=" +
                encodeURIComponent("שאלה או בקשת תיקון")
              }
            >
              שאלה או בקשת תיקון ←
            </a>
            <Link href="/privacy">שמירת מסמכים ומדיניות פרטיות</Link>
          </article>
        </div>
      </div>
    </section>
  );
}
