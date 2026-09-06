import {
  renderPermission,
  SEVERITY_TEXT,
  type CaseReportProjection,
  type TopicProjection,
} from "@/server/product/reports/case-report-projection";
import { mappingFor } from "@/server/product/reports/refusal-requests";
import { formatPrice, productOffer } from "@/lib/product-offer";

// Site S3.4 — the report's render rules, in one component so no screen invents
// its own. Everything it prints comes from the projection; it computes nothing.
//
// The rule that governs every branch below: `renderPermission` decides whether a
// figure may appear, and no component asks any other question before printing
// one. A topic that is awaiting verification or refused has no amount to print
// because the shape does not carry one — there is nothing to accidentally read.

const TOPIC_HE: Readonly<Record<string, string>> = Object.freeze({
  minimum_wage: "שכר מינימום",
  working_time: "שעות עבודה",
  pension: "פנסיה",
  travel: "נסיעות",
  convalescence: "דמי הבראה",
  vacation: "חופשה",
  sick_leave: "דמי מחלה",
});

const DIRECTION_HE: Readonly<Record<string, string>> = Object.freeze({
  employer_owes: "לטובתך",
  employee_owes: "לטובת המעסיק",
  none: "ללא פער",
});

function money(value: Readonly<{ currency: "ILS"; minor_units: number }>): string {
  return formatPrice({ amount: (value.minor_units / 100).toFixed(2), currency: value.currency });
}

function TopicCard({ topic }: { topic: TopicProjection }) {
  const permission = renderPermission(topic);
  return (
    <li className={`report-topic report-topic--${topic.gate}`}>
      <h3>{TOPIC_HE[topic.topic] ?? topic.topic}</h3>

      {/* "What was checked, what was not, and why" — always, for every gate. */}
      <p className="report-topic__line">{permission.line}</p>

      {topic.gate === "checked" ? (
        <>
          {topic.severity_class === null ? null : (
            <p className="report-topic__severity">{SEVERITY_TEXT[topic.severity_class]}</p>
          )}
          <p className="report-topic__direction">
            {DIRECTION_HE[topic.direction]}
            {/* D-6.3: a number appears only where the display allows one. */}
            {permission.showsNumber && topic.amount ? ` · ${money(topic.amount)}` : null}
            {permission.showsNumber && topic.range ? ` · ${money(topic.range.low)}–${money(topic.range.high)}` : null}
          </p>
          {topic.assumptions.map((assumption) => (
            <p className="report-topic__assumption" key={assumption.slot}>{assumption.statement}</p>
          ))}
          {topic.retroactive_update ? (
            <p className="report-topic__retro">עודכן רטרואקטיבית ב־{topic.retroactive_update.known_at} ({topic.retroactive_update.source})</p>
          ) : null}
          {topic.missing_facts.length > 0 ? (
            <p className="report-topic__missing">מה שיעלה את הוודאות: {topic.missing_facts.join(", ")}</p>
          ) : null}
        </>
      ) : null}

      {topic.gate === "refused" ? (
        <>
          {topic.assumptions.map((assumption) => (
            <p className="report-topic__assumption" key={assumption.slot}>{assumption.statement}</p>
          ))}
          {mappingFor(topic.not_checked.code)?.question ? (
            <p className="report-topic__request">שאלנו אותך על כך בת׳רד של התיק.</p>
          ) : null}
        </>
      ) : null}

      {topic.branches_examined.length > 0 ? (
        <p className="report-topic__branches">נבחנו: {topic.branches_examined.join(" · ")}</p>
      ) : null}
    </li>
  );
}

export function ReportView({ projection }: { projection: CaseReportProjection }) {
  const offer = productOffer();
  const checked = projection.topics.filter((topic) => topic.gate === "checked");
  const findings = checked.filter((topic) => topic.status === "finding");
  const awaiting = projection.topics.filter((topic) => topic.gate === "awaiting_verification");

  return (
    <div className="report-view">
      <div className="received-card">
        <h1>מה נבדק בתיק</h1>
        <p>
          חודש הבדיקה: {projection.check_period_month}
          {projection.months_covered.length > 1 ? ` · כיסוי: ${projection.months_covered.join(", ")}` : null}
        </p>
        {/* The reader is told what state the whole report is in before any topic. */}
        {awaiting.length === projection.topics.length ? (
          <p className="report-view__all-awaiting">
            כל הנושאים ממתינים לאימות בסיום הפיתוח. עד שהאימות הושלם אנחנו לא מציגים כיוון, טווח או סכום — לא מספר קטן ולא מספר זהיר.
          </p>
        ) : (
          <p>{findings.length > 0 ? `נמצאו ${findings.length} נקודות לבדיקה.` : "לא נמצאו פערים בנושאים שנבדקו."}</p>
        )}
      </div>

      <ul className="report-view__topics">
        {projection.topics.map((topic) => <TopicCard key={topic.topic} topic={topic} />)}
      </ul>

      {findings.length > 0 ? (
        <div className="received-card">
          <h2>מה עושים עכשיו</h2>
          <p>אפשר לפנות למעסיק עם הנקודות שנמצאו. הדוח המלא כולל נוסח מוכן להעתקה לכל ממצא וצעד הבא.</p>
          {/* D-5.1 before the CTA, always. */}
          <p className="report-view__second-product">{offer.second_product_sentence}</p>
        </div>
      ) : null}

      <p className="report-view__basis">בסיס משפטי: {projection.legal_basis}</p>
    </div>
  );
}
