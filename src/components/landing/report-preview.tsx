"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { FileText, Plus } from "@phosphor-icons/react";
import { productOffer } from "@/config/product-offer";

export function ReportPreview() {
  const [tab, setTab] = useState(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  function changeTab(event: KeyboardEvent<HTMLButtonElement>) {
    let next: number;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = 1;
    else if (event.key === "ArrowLeft" || event.key === "ArrowRight")
      next = 1 - tab;
    else return;
    event.preventDefault();
    setTab(next);
    tabs.current[next]?.focus();
  }
  return (
    <section
      className="home-section report-preview"
      id="what-you-get"
      aria-labelledby="report-title"
    >
      <div className="shell">
        <div className="section-intro">
          <h2 id="report-title">
            פחות סימני שאלה.
            <br />
            יותר הבנה של מה שחשוב.
          </h2>
          <p>
            כך מתוכנן להיראות המידע בתוצר: מה נבדק, על מה הוא מבוסס ומה אפשר
            לעשות עכשיו.
          </p>
        </div>
        <div className="report-preview__box">
          <div className="report-tabs" role="tablist" aria-label="מבנה התוצר">
            {["בדיקה ראשונית", "דוח מלא"].map((label, index) => (
              <button
                key={label}
                type="button"
                role="tab"
                id={`report-tab-${index}`}
                aria-selected={tab === index}
                aria-controls="report-panel"
                tabIndex={tab === index ? 0 : -1}
                ref={(node) => {
                  tabs.current[index] = node;
                }}
                onClick={() => setTab(index)}
                onKeyDown={changeTab}
              >
                {label}
              </button>
            ))}
          </div>
          <div
            role="tabpanel"
            id="report-panel"
            aria-labelledby={`report-tab-${tab}`}
            tabIndex={0}
            className="report-preview__content"
          >
            <div className="report-preview__description">
              <FileText size={40} weight="duotone" aria-hidden="true" />
              <h3>{tab === 0 ? "נקודת התחלה מסודרת" : "להעמיק בתמונה"}</h3>
              <p>
                {tab === 0
                  ? `בדיקה של חודש אחד ועד ${productOffer.initial.maxTopics} נושאים שנבדקו, לפי המסמכים והמידע שנמסרו.`
                  : "המשך מתוכנן לתקופה שתוסכם מראש, בדיקת AI עם פירוט, מקורות ואפשרות לבירור. המוצר עדיין אינו זמין לרכישה."}
              </p>
              <p className="preview-disclosure">
                מבנה תוצר מתוכנן להמחשה. זה אינו דוח שהופק במערכת ואינו תוצאה של
                לקוח.
              </p>
            </div>
            <div className="report-preview__findings">
              {[
                [
                  "מה נבדק — ומה עדיין חסר",
                  "כיסוי הבדיקה",
                  "לכל נושא יוצג האם נבדק, חסר עבורו מידע או שאינו כלול. היעדר ממצאים לבדו אינו מעיד שהכול תקין.",
                ],
                [
                  "על איזה מידע הבדיקה נשענת",
                  "מקור והסבר",
                  "לצד כל ממצא מתוכנן להופיע המסמך, העמוד או התשובה שעליהם הוא מבוסס, יחד עם הסבר קריא.",
                ],
                [
                  "מה כדאי לברר בהמשך",
                  "הצעד הבא",
                  "יופיע פירוט של השאלה או המסמך הדרושים להמשך. כשאין בסיס מספיק או כשהוודאות נמוכה, לא יוצגו סכום או טווח.",
                ],
              ].map(([title, label, text]) => (
                <details key={`${tab}-${label}`}>
                  <summary>
                    <span>
                      <small>{label}</small>
                      <strong>{title}</strong>
                    </span>
                    <Plus size={20} aria-hidden="true" />
                  </summary>
                  <p>{text}</p>
                </details>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
