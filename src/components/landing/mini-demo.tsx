"use client";

import { useState } from "react";
import { Check } from "@phosphor-icons/react";
import { trackEvent } from "@/lib/analytics";

const questions = [
  { key: "hours", label: "כמה שעות אתה באמת עובד ביום?", options: ["8", "9", "10", "11+"] },
  { key: "friday", label: "אתה עובד גם ביום שישי?", options: ["כן", "לא"] },
  { key: "fixed", label: "יש לך שכר חודשי קבוע?", options: ["כן", "לא"] },
] as const;

export function MiniDemo() {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const complete = questions.every((question) => answers[question.key]);

  function answer(key: string, value: string) {
    const next = { ...answers, [key]: value };
    setAnswers(next);
    if (questions.every((question) => next[question.key])) {
      trackEvent("mini_demo_completed");
    }
  }

  return (
    <section className="mini-demo-section" aria-labelledby="mini-demo-title">
      <div className="shell mini-demo">
        <div>
          <h2 id="mini-demo-title">בוא נראה מה תלוש בלבד לא יודע עליך.</h2>
          <p>שלוש תשובות קטנות משנות את התמונה שמאחורי המספרים.</p>
        </div>
        <div className="mini-demo__questions">
          {questions.map((question) => (
            <fieldset key={question.key}>
              <legend>{question.label}</legend>
              <div className="choice-row">
                {question.options.map((option) => (
                  <button
                    className={answers[question.key] === option ? "choice is-selected" : "choice"}
                    type="button"
                    aria-pressed={answers[question.key] === option}
                    onClick={() => answer(question.key, option)}
                    key={option}
                  >
                    {answers[question.key] === option && <Check weight="bold" aria-hidden="true" />}
                    <bdi dir={question.key === "hours" ? "ltr" : "rtl"}>{option}</bdi>
                  </button>
                ))}
              </div>
            </fieldset>
          ))}
        </div>
        <div className={complete ? "mini-demo__result is-visible" : "mini-demo__result"} aria-live="polite">
          <strong>את הדברים האלה אי אפשר לדעת מהתלוש בלבד.</strong>
          <p>לכן בדיקה שמסתכלת רק על PDF עלולה לפספס חלק מהתמונה.</p>
        </div>
      </div>
    </section>
  );
}
