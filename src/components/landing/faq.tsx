"use client";
import { trackEvent } from "@/lib/analytics";
import { initialPrice, fullPrice, productOffer } from "@/config/product-offer";
const questions = [
  [
    "מה צריך כדי להתחיל?",
    "תלוש שכר אחד ותשובות על העבודה שלך. חוזה עבודה ודוח נוכחות יכולים לעזור, אם הם זמינים.",
  ],
  [
    "מה כלול בבדיקה הראשונית?",
    "בדיקה ראשונית במחיר " +
      initialPrice +
      ", לחודש אחד ועד " +
      productOffer.initial.maxTopics +
      " נושאים שנבדקו. הכיסוי תלוי במסמכים ובמידע שנמסרו; לא כל נושא וכל תקופה כלולים.",
  ],
  [
    "מה קורה כשחסר מסמך?",
    "מציינים מה חסר ומה נדרש להמשך. מידע חסר אינו אישור שהכול תקין. כשאין בסיס מספיק או כשהוודאות נמוכה, לא מציגים סכום או טווח.",
  ],
  [
    "הבדיקה מבטיחה שמגיע לי כסף?",
    "לא. היא נועדה לברר פערים אפשריים בתחום שנבדק. היא אינה קביעה משפטית, ייצוג או הבטחה להחזר מהמעסיק.",
  ],
  [
    "אפשר להמשיך לדוח מלא?",
    "המחיר הכולל לבדיקה הראשונית ולדוח המורחב הוא " +
      fullPrice +
      " לפי מדרגות הפער המבוסס. התשלום הראשוני המאומת מתקזז פעם אחת. זהו דוח AI עם מקורות ותמיכה, ללא ייצוג או הבטחת גבייה. השדרוג ייפתח רק כשיש בסיס כספי מאומת וכיסוי שניתן למסור.",
  ],
  [
    "איך חוזרים לבדיקה שכבר התחלתי?",
    "אפשר להיכנס לתיקים עם פרטי הקשר שאומתו וקוד חד־פעמי, גם ממכשיר אחר. מסמך או דוח מוצגים רק לאחר בדיקת הרשאה. אם הקוד אינו מגיע, אפשר לפנות לשירות.",
  ],
];
export function Faq() {
  return (
    <section className="faq-section" id="faq" aria-labelledby="faq-title">
      <div className="shell faq-section__grid">
        <div>
          <h2 id="faq-title">טוב ששאלת.</h2>
          <p>כמה תשובות לפני שמתחילים.</p>
        </div>
        <div className="faq-list">
          {questions.map(([question, answer], index) => (
            <details
              key={question}
              onToggle={(event) =>
                event.currentTarget.open &&
                trackEvent("faq_opened", { question: "faq-" + (index + 1) })
              }
            >
              <summary>
                {question}
                <span aria-hidden="true">+</span>
              </summary>
              <p>{answer}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
