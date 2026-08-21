"use client";

import { useEffect, useRef, useState } from "react";
import { LockKey } from "@phosphor-icons/react";

const amounts = [0, 2480, 7920, 13760, 18460];

export function ExampleResult() {
  const sectionRef = useRef<HTMLElement>(null);
  const [amountIndex, setAmountIndex] = useState(0);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        amounts.slice(1).forEach((_, index) => {
          timers.push(setTimeout(() => setAmountIndex(index + 1), 250 + index * 420));
        });
        observer.disconnect();
      },
      { threshold: 0.35 },
    );
    observer.observe(section);
    return () => {
      observer.disconnect();
      timers.forEach(clearTimeout);
    };
  }, []);

  return (
    <section className="example-result" ref={sectionRef} aria-labelledby="example-result-title">
      <div className="shell example-result__grid">
        <div className="example-result__amount">
          <span>בדיקה לדוגמה</span>
          <strong className="mono" aria-live="polite">₪{amounts[amountIndex].toLocaleString("he-IL")}</strong>
          <h2 id="example-result-title">פער כספי פוטנציאלי</h2>
          <p>כל המספרים באזור זה הם נתוני הדגמה ואינם תוצאה אישית.</p>
        </div>
        <div className="example-result__breakdown">
          {[
            ["שעות נוספות", "+ ₪8,320"],
            ["פנסיה", "+ ₪5,480"],
            ["הבראה", "+ ₪2,160"],
            ["נסיעות", "+ ₪2,500"],
          ].map(([label, amount]) => (
            <div key={label}><span>{label}</span><strong className="mono">{amount}</strong></div>
          ))}
          <div className="locked-report">
            <LockKey weight="fill" aria-hidden="true" />
            <div><b>פירוט מלא והסברים</b><span>תצוגה מקדימה של דוח מורחב עתידי</span></div>
          </div>
        </div>
      </div>
    </section>
  );
}
