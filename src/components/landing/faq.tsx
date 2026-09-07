"use client";
import { trackEvent } from "@/lib/analytics";
import { initialPrice, fullPrice, productOffer } from "@/config/product-offer";
const questions = [
  ["אפשר להתחיל בדיקה עכשיו?", productOffer.initial.available ? "אפשר להתחיל דרך כפתור התחלת הבדיקה." : "עדיין לא. אנחנו משלימים את ההיערכות למסירת תוצאות. לא ניתן לפתוח בדיקה חדשה או לשלם כרגע. השירות זמין לפניות בנוגע לבדיקות קיימות."],
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
    "מתוכנן דוח מלא במחיר " +
      fullPrice +
      " בתשלום נפרד ועם בקרה אנושית תמיד. הוא עדיין אינו זמין לרכישה באתר. תנאי התקופה, הזמן והקיזוז יימסרו לפני רכישה, כשיתאפשר להמשיך.",
  ],
  [
    "איך חוזרים לבדיקה שכבר התחלתי?",
    "קישור חזרה לבדיקה מוביל למצב הבדיקה בדפדפן שבו התחלת. אם אין גישה, אפשר לפנות לשירות. כניסה לחשבון ממכשיר אחר עדיין אינה זמינה בגרסה הזו.",
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
