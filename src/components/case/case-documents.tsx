import Link from "next/link";
import type { CaseDocument } from "@/server/product/reports/case-documents";
import { freePayslipSlots } from "@/server/product/reports/case-documents";

// Site S2.3 / S3.4. The documents on a case, and the way to add another after
// payment. Adding one goes to the same review screen the funnel uses — a
// second upload path would be a second place readability is judged, and the
// wave that built the review screen exists to stop exactly that.

const TYPE_HE: Readonly<Record<string, string>> = Object.freeze({
  payslip: "תלוש",
  contract: "חוזה עבודה",
  attendance: "דוח נוכחות",
});

function formatSize(size: number): string {
  return size < 1024 * 1024 ? `${Math.round(size / 1024)}KB` : `${(size / 1024 / 1024).toFixed(1)}MB`;
}

export function CaseDocuments({ publicId, documents }: { publicId: string; documents: readonly CaseDocument[] }) {
  const free = freePayslipSlots(documents);
  return (
    <div className="case-documents">
      <div className="received-card">
        <h1>המסמכים בתיק</h1>
        {documents.length === 0 ? (
          <p>עוד לא צורפו מסמכים לתיק הזה.</p>
        ) : (
          <p>{documents.length} מסמכים. הקבצים שמורים באזור פרטי ואינם נשלחים למעסיק.</p>
        )}
      </div>

      {documents.length > 0 ? (
        <ul className="case-documents__list">
          {documents.map((document) => (
            <li className="case-documents__item" key={document.id}>
              <div>
                <p className="case-documents__name">{document.original_filename}</p>
                <p className="case-documents__meta">
                  {TYPE_HE[document.document_type] ?? document.document_type}
                  {document.period_month ? ` · ${document.period_month}` : ""}
                  {` · ${formatSize(document.size)}`}
                </p>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="received-card">
        <h2>להוסיף מסמך</h2>
        {free.length === 0 ? (
          <p>התיק מכיל כבר את המספר המרבי של תלושים.</p>
        ) : (
          <>
            <p>אפשר לצרף עוד תלוש — הבדיקה תכסה אותו בדוח המלא.</p>
            <Link className="button button--primary" href={`/check/upload?case=${publicId}`}>הוספת מסמך</Link>
          </>
        )}
      </div>
    </div>
  );
}
