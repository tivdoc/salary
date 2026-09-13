"use client";
import { useRef, useState, type KeyboardEvent } from "react";
import { ArrowLeft } from "@phosphor-icons/react/dist/csr/ArrowLeft";
import { ArrowRight } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { FileText } from "@phosphor-icons/react/dist/csr/FileText";
import { ChatText } from "@phosphor-icons/react/dist/csr/ChatText";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { ListChecks } from "@phosphor-icons/react/dist/csr/ListChecks";
const stages = [
  {
    title: "קודם, מה שכתוב.",
    text: "תלוש שכר, חוזה ודוח נוכחות. כל מסמך נותן זווית אחרת על העבודה שלך.",
    label: "המסמכים",
  },
  {
    title: "ואז, מה שקורה באמת.",
    text: "השעות, התפקיד והתנאים בפועל. כמה תשובות משלימות את מה שהמסמכים לא מספרים.",
    label: "התשובות שלך",
  },
  {
    title: "מחברים את הקצוות.",
    text: "מצליבים מקורות ובודקים את ההקשר. מידע חסר נשאר שאלה לבירור, ולא הופך לניחוש.",
    label: "הצלבת המידע",
  },
  {
    title: "רואים מה הצעד הבא.",
    text: "מה נבדק, על סמך מה, ומה עוד צריך להשלים. תמונה שאפשר להבין ולהמשיך ממנה.",
    label: "מבנה התוצר",
  },
];
export function Process() {
  const [active, setActive] = useState(0);
  const [keyboard, setKeyboard] = useState(false);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  function choose(index: number, fromKeyboard = false) {
    setKeyboard(fromKeyboard);
    setActive(index);
  }
  function navigate(event: KeyboardEvent<HTMLButtonElement>) {
    let next: number;
    if (event.key === "ArrowLeft") next = (active + 1) % stages.length;
    else if (event.key === "ArrowRight")
      next = (active + stages.length - 1) % stages.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = stages.length - 1;
    else return;
    event.preventDefault();
    choose(next, true);
    tabs.current[next]?.focus();
  }
  return (
    <section
      className="studio-process"
      id="how-it-works"
      aria-labelledby="process-title"
    >
      <div className="studio-shell">
        <h2 id="process-title" className="studio-section-title" data-reveal>
          הפרטים כבר שם.
          <br />
          <span>מחברים ביניהם.</span>
        </h2>
        <p className="process-intro">
          בוחרים שלב ורואים איך המסמכים והתשובות מתחברים.
        </p>
        <div className="process-explorer">
          <div
            className="process-tabs"
            role="tablist"
            aria-label="שלבי הבדיקה"
            aria-orientation="horizontal"
          >
            {stages.map((stage, index) => (
              <button
                key={stage.label}
                type="button"
                role="tab"
                id={"process-tab-" + index}
                aria-selected={active === index}
                aria-controls="process-panel"
                tabIndex={active === index ? 0 : -1}
                ref={(node) => {
                  tabs.current[index] = node;
                }}
                onClick={(event) => choose(index, event.detail === 0)}
                onKeyDown={navigate}
              >
                <span aria-hidden="true">0{index + 1}</span>
                {stage.label}
              </button>
            ))}
          </div>
          <div
            className="assembly"
            data-phase={active}
            data-keyboard={keyboard}
            id="process-illustration"
            aria-hidden="true"
          >
            <div className="assembly__canvas">
              <div className="assembly__orbit" />
              <div className="assembly__sheet assembly__sheet--one">
                <FileText size={26} />
                <span>תלוש שכר</span>
                <i />
                <i />
                <i />
              </div>
              <div className="assembly__sheet assembly__sheet--two">
                <ChatText size={26} />
                <span>העבודה בפועל</span>
                <i />
                <i />
                <i />
              </div>
              <div className="assembly__sheet assembly__sheet--three">
                <ListChecks size={26} />
                <span>התמונה שלך</span>
                <i />
                <i />
                <i />
              </div>
              <div className="assembly__focus">
                <MagnifyingGlass size={68} weight="light" />
              </div>
            </div>
            <div className="assembly__caption">
              <span>0{active + 1}</span>
              <strong>{stages[active].label}</strong>
              <span>המחשת תהליך</span>
            </div>
          </div>
          <div
            className="process-panel"
            id="process-panel"
            role="tabpanel"
            aria-labelledby={"process-tab-" + active}
            tabIndex={0}
          >
            <h3>{stages[active].title}</h3>
            <p>{stages[active].text}</p>
            <div className="process-pager">
              <span aria-live="polite" aria-atomic="true">
                שלב {active + 1} מתוך {stages.length}
              </span>
              <button
                type="button"
                disabled={active === 0}
                aria-label="השלב הקודם"
                onClick={(event) => choose(active - 1, event.detail === 0)}
              >
                <ArrowRight size={22} aria-hidden="true" />
              </button>
              <button
                type="button"
                disabled={active === stages.length - 1}
                aria-label="השלב הבא"
                onClick={(event) => choose(active + 1, event.detail === 0)}
              >
                <ArrowLeft size={22} aria-hidden="true" />
              </button>
            </div>
            <a className="process-outcome" href="#what-you-get">
              ומה מקבלים בסוף? <ArrowLeft size={18} aria-hidden="true" />
            </a>
          </div>
          <noscript>
            <ol>
              {stages.map((stage) => (
                <li key={stage.label}>
                  <h3>{stage.title}</h3>
                  <p>{stage.text}</p>
                </li>
              ))}
            </ol>
          </noscript>
        </div>
      </div>
    </section>
  );
}
