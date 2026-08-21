type SamplePayslipProps = {
  variant?: "hero" | "final" | "redacted";
};

const payslipRows = [
  ["שכר בסיס", "9,400.00"],
  ["שעות רגילות", "186.00"],
  ["שעות נוספות", "620.00"],
  ["נסיעות", "418.00"],
  ["הפרשת עובד לפנסיה", "564.00-"],
  ["יתרת חופשה", "4.25"],
];

export function SamplePayslip({ variant = "hero" }: SamplePayslipProps) {
  const isRedacted = variant === "redacted";
  const isFinal = variant === "final";

  return (
    <div className={`payslip payslip--${variant}`} aria-label="תלוש שכר בדיוני לבדיקה לדוגמה">
      <div className="payslip__clip" aria-hidden="true" />
      <div className="payslip__topline">
        <span>אופק שירותים ופרויקטים בע״מ</span>
        <span className="mono">08/2026</span>
      </div>
      <div className="payslip__title">
        <div>
          <strong>תלוש שכר</strong>
          <span>מסמך בדיוני</span>
        </div>
        <div className="payslip__identity">
          <span>עובד/ת</span>
          <b className={isRedacted ? "redacted" : ""}>{isRedacted ? "פרט חסוי" : "נועה ישראלי"}</b>
        </div>
      </div>

      <div className="payslip__grid payslip__grid--head" aria-hidden="true">
        <span>רכיב</span><span>כמות</span><span>סכום ₪</span>
      </div>
      <div className="payslip__rows">
        {payslipRows.map(([label, amount], index) => (
          <div className={`payslip__grid ${index === 2 ? "payslip__grid--flagged" : ""}`} key={label}>
            <span>{label}</span>
            <span className="mono">{index === 1 ? "186" : index === 2 ? "7" : "1"}</span>
            <span className="mono">{amount}</span>
          </div>
        ))}
      </div>

      <div className="payslip__totals">
        <div><span>ברוטו</span><strong className="mono">10,438 ₪</strong></div>
        <div><span>נטו לתשלום</span><strong className="mono">8,714 ₪</strong></div>
      </div>

      {!isRedacted && (
        <>
          <div className="scan-line" aria-hidden="true" />
          <div className="review-note review-note--hours">לבדוק את השעות האלה</div>
          <div className="anomaly-ring" aria-hidden="true" />
          {(variant === "hero" || isFinal) && (
            <div className="demo-gap">
              <span>בדיקה לדוגמה</span>
              <strong>פער כספי פוטנציאלי</strong>
              <b className="mono">₪18,460</b>
            </div>
          )}
          {isFinal && <div className="review-note review-note--pension">למה בסיס הפנסיה נמוך יותר?</div>}
        </>
      )}

      {isRedacted && (
        <div className="classified-stamp" aria-label="פרטים אישיים מושחרים">פרטים אישיים הושחרו</div>
      )}
    </div>
  );
}
