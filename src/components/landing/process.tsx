"use client";
import { useEffect, useRef, useState } from "react";
import { FileText } from "@phosphor-icons/react/dist/csr/FileText";
import { ChatText } from "@phosphor-icons/react/dist/csr/ChatText";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { ListChecks } from "@phosphor-icons/react/dist/csr/ListChecks";
const stages = [
  {
    title: "קודם, מה שכתוב.",
    text: "תלוש שכר, חוזה ודוח נוכחות. כל מסמך נותן זווית אחרת על העבודה שלך.",
    label: "המסמכים",
    icon: FileText,
  },
  {
    title: "ואז, מה שקורה באמת.",
    text: "השעות, התפקיד והתנאים בפועל. כמה תשובות משלימות את מה שהמסמכים לא מספרים.",
    label: "התשובות שלך",
    icon: ChatText,
  },
  {
    title: "מחברים את הקצוות.",
    text: "מצליבים מקורות ובודקים את ההקשר. מידע חסר נשאר שאלה לבירור, ולא הופך לניחוש.",
    label: "הצלבת המידע",
    icon: MagnifyingGlass,
  },
  {
    title: "רואים מה הצעד הבא.",
    text: "מה נבדק, על סמך מה, ומה עוד צריך להשלים. תמונה שאפשר להבין ולהמשיך ממנה.",
    label: "מבנה התוצר",
    icon: ListChecks,
  },
];
export function Process() {
  const [active, setActive] = useState(0);
  const [keyboard, setKeyboard] = useState(false);
  const items = useRef<(HTMLLIElement | null)[]>([]);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible) {
          setKeyboard(false);
          setActive(Number((visible.target as HTMLElement).dataset.stage));
        }
      },
      { rootMargin: "-25% 0px -40% 0px", threshold: [0, 0.4, 0.8] },
    );
    items.current.forEach((item) => {
      if (item) observer.observe(item);
    });
    return () => observer.disconnect();
  }, []);
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
        <div className="studio-process__layout">
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
          <ol className="studio-chapters">
            {stages.map((stage, index) => (
              <li
                key={stage.title}
                data-reveal
                data-stage={index}
                ref={(node) => {
                  items.current[index] = node;
                }}
              >
                <button
                  type="button"
                  aria-pressed={active === index}
                  aria-controls="process-illustration"
                  onClick={(event) => {
                    setKeyboard(event.detail === 0);
                    setActive(index);
                  }}
                >
                  <span className="chapter-index">0{index + 1}</span>
                  <span className="chapter-copy">
                    <strong>{stage.title}</strong>
                    <span>{stage.text}</span>
                  </span>
                  <stage.icon
                    className="chapter-icon"
                    size={26}
                    aria-hidden="true"
                  />
                </button>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
