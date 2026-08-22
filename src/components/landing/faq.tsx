"use client";

import { trackEvent } from "@/lib/analytics";

const questions = [
  ["צריך חוזה עבודה?", "לא. אפשר להתחיל גם בלי חוזה, אבל הוא עשוי לשפר את איכות הבדיקה."],
  ["כמה תלושים צריך?", "לבדיקה ראשונית אפשר להתחיל מתלוש אחד. במקרים מסוימים נבקש מסמכים נוספים."],
  ["מה קורה אם אין לי דוח שעות?", "אפשר לבצע בדיקה ראשונית לפי המידע שתמסור, אך רמת הוודאות עשויה להיות נמוכה יותר."],
  ["האם Tivdoc קובע שהמעסיק חייב לי כסף?", "לא. השירות מזהה פערים אפשריים ומבצע חישובים על בסיס המסמכים והמידע שסופקו."],
  ["מה מקבלים ב־9.99 ₪?", "בדיקה ראשונית הכוללת זיהוי חריגות והערכת פערים אפשריים בהתאם למידע שנמסר."],
];

export function Faq() {
  return (
    <section className="faq-section" id="faq" aria-labelledby="faq-title">
      <div className="shell faq-section__grid">
        <h2 id="faq-title">שאלות לפני שמתחילים.</h2>
        <div className="faq-list">
          {questions.map(([question, answer]) => (
            <details key={question} onToggle={(event) => event.currentTarget.open && trackEvent("faq_opened", { question })}>
              <summary>{question}<span aria-hidden="true">+</span></summary>
              <p>{answer}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
