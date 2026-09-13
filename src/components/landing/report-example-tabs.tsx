"use client";
import { useRef, useState, type ReactNode, type KeyboardEvent } from "react";
export function ReportExampleTabs({ children }: { children: ReactNode[] }) {
  const [active, setActive] = useState(0);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  function navigate(e: KeyboardEvent<HTMLButtonElement>) {
    let next: number;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = 1;
    else if (e.key === "ArrowLeft" || e.key === "ArrowRight") next = 1 - active;
    else return;
    e.preventDefault();
    setActive(next);
    refs.current[next]?.focus();
  }
  return (
    <div className="sample-report">
      <div className="report-tabs" role="tablist" aria-label="דוחות לדוגמה">
        {["בדיקה ראשונית", "דוח מורחב"].map((title, i) => (
          <button
            key={title}
            id={"report-tab-" + i}
            role="tab"
            aria-selected={active === i}
            aria-controls={"sample-panel-" + i}
            tabIndex={active === i ? 0 : -1}
            ref={(el) => {
              refs.current[i] = el;
            }}
            onClick={() => setActive(i)}
            onKeyDown={navigate}
          >
            {title}
          </button>
        ))}
      </div>
      {children.map((child, i) => (
        <div
          key={i}
          id={"sample-panel-" + i}
          role="tabpanel"
          aria-labelledby={"report-tab-" + i}
          tabIndex={0}
          hidden={i !== active}
        >
          {child}
        </div>
      ))}
    </div>
  );
}
