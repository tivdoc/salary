import { formatDuration, formatPrice, productOffer } from "@/lib/product-offer";

/**
 * Site S5, "שאלות לפני שמתחילים" — the canvas's six questions, answered from
 * configuration wherever a figure appears, so a price or an estimate can never
 * drift between this section and the funnel.
 */
export function FaqV5() {
  const offer = productOffer();
  const price = formatPrice(offer.initial_check.price);
  const fullPrice = formatPrice(offer.full_report.price);
  const automatic = formatDuration(offer.initial_check.delivery.automatic);
  const items = [
    {
      question: "למה בבדיקה הראשונית לא תמיד מוצג סכום?",
      answer:
        "סכום מוצג רק כשכל העובדות שהנושא דורש הגיעו ממסמך ואין סתירה ביניהן. כשעובדה נדרשת הגיעה מתשובה שלך — מוצג טווח; כשעובדה חסרה או שני מקורות סותרים — מוצג כיוון בלבד, בלי מספר. זה כלל מכני, לא שיקול דעת, והבדיקה תמיד אומרת מה חסר כדי להעלות את הוודאות.",
    },
    {
      question: `יש עוד תשלום אחרי ה־${price}?`,
      answer: `לא, אלא אם תבחר בו. הבדיקה הראשונית היא ${price}, חד־פעמי. אם נמצאו נקודות לבדיקה, מוצע דוח מלא ב־${fullPrice} — והמחיר מוצג לפני כל תשלום.`,
    },
    {
      question: "מה אם לא ימצאו כלום?",
      answer: "גם זו תשובה: הבדיקה אומרת מה נבדק, אילו נושאים כוסו ומה נמצא תקין. אין דוח מלא להציע במקרה כזה.",
    },
    {
      question: "איזה תלוש להעלות — האחרון או ישן יותר?",
      answer: "תלוש אחד מספיק כדי להתחיל, והאחרון הוא בדרך כלל הנוח ביותר. אם יש חשד לתקופה מסוימת, אפשר להעלות תלוש ממנה.",
    },
    {
      question: "אני עדיין עובד שם. זה יכול לפגוע בי?",
      answer: "המסמכים והמידע משמשים לבדיקה בלבד ואינם נשלחים למעסיק. מה לעשות עם התוצאה — ואם בכלל — נשאר אצלך.",
    },
    {
      question: "איך אני חוזר לתיק ממכשיר אחר?",
      answer: `בכניסה עם הטלפון או המייל שאימתת: נשלח קוד בן שש ספרות, והתיק נפתח. הקישור שנשלח בסיום התשלום תקף ${offer.access.link_token_ttl_hours} שעות ונפתח פעם אחת; הכניסה עצמה נשמרת ${offer.access.session_ttl_days} יום. תוצאה ראשונה מגיעה תוך ${automatic}.`,
    },
  ];
  return (
    <section className="v5-faq" id="faq" aria-labelledby="v5-faq-title">
      <div className="v5-shell">
        <h2 id="v5-faq-title" className="v5-section-title">שאלות לפני שמתחילים</h2>
        <div className="v5-faq__list">
          {items.map((item) => (
            <details key={item.question}>
              <summary>{item.question}</summary>
              <p>{item.answer}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
