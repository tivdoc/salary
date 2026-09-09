import type { ReactNode } from "react";
import { FaqDisclosure } from "./faq-disclosure";
const questions = [
  [
    "מה צריך להכין?",
    "תלוש שכר ותשובות על העבודה שלך. חוזה ודוח נוכחות יכולים לעזור, אם הם זמינים.",
  ],
  [
    "מתי מקבלים תשובה?",
    "מועד המסירה תלוי במסמכים ובהשלמות הנדרשות ויוצג לפני רכישה. אין התחייבות לתוצאה מיידית.",
  ],
  [
    "הבדיקה מבטיחה שמגיע לי כסף?",
    "לא. זו בדיקה של פערים אפשריים, לא קביעה משפטית, ייצוג או הבטחה להחזר מהמעסיק.",
  ],
  [
    "איך חוזרים לבדיקה קיימת?",
    "דרך הקישור ׳חזרה לבדיקה׳ בראש העמוד, עם פרטי הקשר שאומתו וקוד חד־פעמי. אפשר להמשיך גם ממכשיר אחר.",
  ],
];
export function Faq({ action }: { action?: ReactNode }) {
  return (
    <section
      className="faq-section studio-finish"
      id="faq"
      aria-labelledby="faq-title"
    >
      <div className="shell faq-section__grid">
        <div>
          <h2 id="faq-title">הצעד הבא שלך</h2>
          {action}
        </div>
        <div className="faq-list">
          {questions.map(([question, answer], index) => (
            <FaqDisclosure key={question} index={index}>
              <summary>
                {question}
                <span aria-hidden="true">+</span>
              </summary>
              <p>{answer}</p>
            </FaqDisclosure>
          ))}
        </div>
      </div>
    </section>
  );
}
