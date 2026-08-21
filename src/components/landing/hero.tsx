import { TrackedLink } from "@/components/tracked-link";
import { SamplePayslip } from "./sample-payslip";

export function Hero() {
  return (
    <section className="hero">
      <div className="shell hero__grid">
        <div className="hero__copy">
          <h1>
            יכול להיות שהמעסיק חייב לך אלפי שקלים.
            <mark>תבדוק לפני התלוש הבא.</mark>
          </h1>
          <p>
            Tivdoc משווה בין התלוש, חוזה העבודה, שעות העבודה והתפקיד בפועל כדי לזהות פערים אפשריים.
          </p>
          <div className="hero__actions">
            <TrackedLink className="button button--primary button--large" href="/check" eventName="start_check">
              התחל בדיקה — 9.90 ₪
            </TrackedLink>
            <span>תלוש אחד מספיק כדי להתחיל • לוקח כמה דקות</span>
          </div>
        </div>
        <div className="hero__visual">
          <SamplePayslip />
          <div className="hero__caption">
            <span className="mono">SCAN / 04</span>
            <b>תלוש שנראה רגיל. פרט אחד שלא מסתדר.</b>
          </div>
        </div>
      </div>
    </section>
  );
}
