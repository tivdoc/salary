"use client";

import { useEffect, useRef, useState } from "react";
import {
  FileText,
  ChatText,
  MagnifyingGlass,
  ListChecks,
  ArrowLeft,
} from "@phosphor-icons/react";

const stages = [
  {
    title: "מתחילים במסמכים",
    text: "תלוש שכר, מסמכי העסקה ודוח נוכחות, אם יש. כל מסמך מוסיף עוד חלק לתמונה.",
    icon: FileText,
    label: "מסמכים",
    detail: "תלוש שכר + מסמכי העסקה",
    note: "המידע מופיע בכמה מקומות. מחברים ביניהם.",
  },
  {
    title: "משלימים את מה שלא כתוב",
    text: "עונים על שאלות קצרות על שעות העבודה, התפקיד והתנאים בפועל.",
    icon: ChatText,
    label: "התשובות שלך",
    detail: "איך נראה שבוע העבודה שלך?",
    note: "גם מה שלא מופיע בתלוש יכול להיות רלוונטי.",
  },
  {
    title: "בודקים ומשווים",
    text: "מצליבים את המידע. כשחסר בסיס לבדיקה, מציינים מה צריך להשלים.",
    icon: MagnifyingGlass,
    label: "הצלבת מידע",
    detail: "מסמך, תשובה והקשר",
    note: "חסר מידע? מסמנים בירור, בלי לנחש סכום.",
  },
  {
    title: "מבינים את הצעד הבא",
    text: "התוצר מרכז את מה שנבדק, את המקורות ואת השאלות שעוד נותרו פתוחות.",
    icon: ListChecks,
    label: "מבנה התוצר",
    detail: "ממצא ← מקור ← צעד הבא",
    note: "מבדילים בין מה שנבדק לבין מה שעדיין לא ידוע.",
  },
];

export function Process() {
  const [active, setActive] = useState(0);
  const items = useRef<(HTMLLIElement | null)[]>([]);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (!window.matchMedia("(min-width: 769px)").matches) return;
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible)
          setActive(Number((visible.target as HTMLElement).dataset.stage));
      },
      { rootMargin: "-25% 0px -45% 0px", threshold: [0, 0.5, 1] },
    );
    items.current.forEach((item) => {
      if (item) observer.observe(item);
    });
    return () => observer.disconnect();
  }, []);
  const stage = stages[active];
  const Icon = stage.icon;
  return (
    <section
      className="home-section process-v3"
      id="how-it-works"
      aria-labelledby="process-title"
    >
      <div className="shell">
        <div className="section-intro">
          <h2 id="process-title">כל חלק מוסיף בהירות.</h2>
          <p>ארבעה שלבים, מהמסמך הראשון ועד להבנת התוצאה.</p>
        </div>
        <div className="process-v3__grid">
          <ol className="process-v3__list">
            {stages.map((item, index) => (
              <li
                key={item.title}
                data-stage={index}
                ref={(node) => {
                  items.current[index] = node;
                }}
              >
                <button
                  type="button"
                  aria-pressed={active === index}
                  aria-controls="process-stage"
                  onClick={() => setActive(index)}
                >
                  <span className="stage-number">0{index + 1}</span>
                  <span>
                    <strong>{item.title}</strong>
                    <span>{item.text}</span>
                  </span>
                  <ArrowLeft aria-hidden="true" />
                </button>
                <div className="process-mobile-note">
                  <item.icon size={22} aria-hidden="true" />
                  <span>{item.detail}</span>
                </div>
              </li>
            ))}
          </ol>
          <div className="process-v3__stage" id="process-stage">
            <div className="process-illustration" key={active}>
              <span className="stage-large-number" aria-hidden="true">
                0{active + 1}
              </span>
              <div className="process-stage-paper">
                <Icon size={42} weight="duotone" aria-hidden="true" />
                <span>{stage.label}</span>
                <strong>{stage.detail}</strong>
                <div className="paper-lines" />
                <div className="paper-lines short" />
                <p>{stage.note}</p>
              </div>
            </div>
            <p className="illustration-caption">
              המחשת תהליך · אינה בדיקה פעילה
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
