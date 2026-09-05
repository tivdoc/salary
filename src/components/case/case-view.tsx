import Link from "next/link";
import { formatDuration, productOffer } from "@/lib/product-offer";
import type { IdentityCase } from "@/server/product/case-access/service";

// UX Run 1 / U3. What a verified identity sees of a case today: the state,
// the next step, the delivery estimate from configuration. The full case
// screens of D-3.1 (coverage, timeline, thread, documents, reports) are wave
// S3; this is the answer to "I paid — where is my case", from any device.
const STATUS_HE: Readonly<Record<string, string>> = Object.freeze({
  started: "הבדיקה התחילה",
  questionnaire_completed: "השאלון הושלם",
  documents_uploaded: "המסמכים התקבלו",
  payment_pending: "ממתינים לאימות התשלום",
  paid: "התשלום אומת",
  under_review: "הבדיקה בעבודה",
  completed: "הבדיקה הושלמה",
});

export function CaseView({ item, otherCases }: { item: IdentityCase; otherCases: number }) {
  const offer = productOffer();
  const state = STATUS_HE[item.status] ?? item.status;
  const next = item.payment_verified
    ? item.status === "completed"
      ? "הדוח מוכן. הצגת הדוחות בתיק נבנית בגל הבא; עד אז הדוח נשלח לערוץ שמסרת."
      : `הבדיקה בעבודה. צפי לתוצאה: ${formatDuration(offer.initial_check.delivery.automatic)} במסלול האוטומטי, ${formatDuration(offer.initial_check.delivery.human)} כשהתלוש עובר לבדיקה אנושית.`
    : "התשלום עדיין לא אומת. אם שילמת, האימות מתעדכן תוך דקות.";
  return (
    <div className="received-card received-card--verified">
      <span className="mono">תיק {item.public_id}</span>
      <h1>{state}</h1>
      <p>{next}</p>
      <div className="received-card__next">
        <b>מה נבדק</b>
        <span>חודש תלוש אחד, עד שלושה נושאים לפי עוצמת האות. סכום מוצג רק כשהבסיס לנושא מלא; אחרת כיוון ורמת ודאות.</span>
      </div>
      <div className="received-card__next">
        <b>נפתח בתאריך</b>
        <span className="mono">{new Date(item.created_at).toLocaleDateString("he-IL")}</span>
      </div>
      <p className="payment-note">{offer.second_product_sentence}</p>
      {otherCases > 0 ? <Link className="button button--secondary" href="/cases">כל התיקים שלי ({otherCases + 1})</Link> : null}
      <Link className="button button--secondary" href="/check">בדיקה חדשה</Link>
    </div>
  );
}
