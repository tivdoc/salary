"use client";

import { useRef } from "react";
import { trackEvent } from "@/lib/analytics";

export function Inspector() {
  const boardRef = useRef<HTMLDivElement>(null);
  const rangeRef = useRef<HTMLInputElement>(null);
  const interacted = useRef(false);

  function setFromPointer(clientX: number) {
    const rect = boardRef.current?.getBoundingClientRect();
    if (!rect) return;
    const next = Math.min(90, Math.max(10, ((clientX - rect.left) / rect.width) * 100));
    boardRef.current?.style.setProperty("--inspector-position", String(next));
    if (rangeRef.current) rangeRef.current.value = String(Math.round(next));
    if (!interacted.current) {
      interacted.current = true;
      trackEvent("hero_inspector_interaction");
    }
  }

  return (
    <section className="inspector-section" aria-labelledby="inspector-title">
      <div className="shell">
        <div className="section-heading section-heading--narrow">
          <h2 id="inspector-title">תלוש יכול להיראות תקין ועדיין לא לספר את כל הסיפור.</h2>
          <p>הזז את חלון הבדיקה מעל רכיב השעות הנוספות כדי לראות את המידע שהתלוש לא כולל.</p>
        </div>

        <div
          className="inspector-board"
          ref={boardRef}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            setFromPointer(event.clientX);
          }}
          onPointerMove={(event) => {
            if (event.pointerType === "mouse" || event.currentTarget.hasPointerCapture(event.pointerId)) {
              setFromPointer(event.clientX);
            }
          }}
        >
          <div className="inspector-board__paper">
            <div className="inspector-board__header">
              <b>תלוש שכר / אוגוסט 2026</b>
              <span className="mono">מסמך בדיוני</span>
            </div>
            <div className="inspector-row"><span>שעות רגילות</span><span className="mono">186</span><b className="mono">9,400 ₪</b></div>
            <div className="inspector-row inspector-row--target"><span>שעות נוספות</span><span className="mono">7</span><b className="mono">620 ₪</b></div>
            <div className="inspector-row"><span>נסיעות</span><span className="mono">1</span><b className="mono">418 ₪</b></div>
          </div>

          <div className="inspector-lens" aria-live="polite">
            <div className="inspector-lens__label">Tivdoc Inspector</div>
            <div className="inspector-lens__comparison">
              <span>לפי התלוש</span><b className="mono">620 ₪</b>
              <span>לפי הנתונים שסופקו</span><b className="mono">1,840 ₪</b>
              <strong>פער אפשרי</strong><strong className="mono">+1,220 ₪</strong>
            </div>
          </div>
        </div>

        <label className="inspector-control">
          <span>מיקום חלון הבדיקה</span>
          <input
            type="range"
            min="10"
            max="90"
            defaultValue="58"
            ref={rangeRef}
            onChange={(event) => {
              boardRef.current?.style.setProperty("--inspector-position", event.target.value);
              if (!interacted.current) {
                interacted.current = true;
                trackEvent("hero_inspector_interaction");
              }
            }}
          />
        </label>
      </div>
    </section>
  );
}
