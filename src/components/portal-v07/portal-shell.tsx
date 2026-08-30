import type { PortalCaseProjection } from "../../server/product/customer-portal/contracts";
import styles from "./portal.module.css";

type PortalShellProps = Readonly<{
  projection: PortalCaseProjection | null;
}>;

const DOCUMENT_LABELS = Object.freeze({
  awaiting_upload: "ממתין להעלאה",
  received: "התקבל",
  processing: "בעיבוד",
  needs_review: "ממתין לביקורת",
  accepted: "אושר",
  rejected: "נדרשת העלאה מחדש",
});

export function PortalShell({ projection }: PortalShellProps) {
  return (
    <div className={styles.page} dir="rtl" lang="he">
      <a className={styles.skipLink} href="#portal-main">מעבר לתוכן הראשי</a>
      <header className={styles.header}>
        <strong className={styles.brand}>Tivdoc</strong>
        <nav aria-label="ניווט בפורטל">
          <a href="#status">מצב התיק</a>
          <a href="#documents">מסמכים</a>
          <a href="#reports">דוחות</a>
          <a href="#privacy">פרטיות</a>
        </nav>
      </header>
      <main id="portal-main" className={styles.main}>
        {projection ? <CaseContent projection={projection} /> : <PortalEmptyState />}
      </main>
    </div>
  );
}

function CaseContent({ projection }: Readonly<{ projection: PortalCaseProjection }>) {
  return (
    <>
      <section id="status" className={styles.hero} aria-labelledby="case-heading">
        <div>
          <p className={styles.kicker}>האזור האישי</p>
          <h1 id="case-heading">התיק שלי</h1>
          <p className={styles.statusText} role="status" aria-live="polite">{projection.status_label_he}</p>
        </div>
        <dl className={styles.caseReference}>
          <div><dt>מספר תיק</dt><dd>{projection.case_id}</dd></div>
          <div><dt>עדכון</dt><dd>{projection.revision}</dd></div>
        </dl>
      </section>

      <div className={styles.contentGrid}>
        <section className={styles.primaryColumn} aria-labelledby="timeline-heading">
          <h2 id="timeline-heading">מה קורה בתיק</h2>
          <ol className={styles.timeline}>
            {projection.status_timeline.map((event) => (
              <li key={`${event.revision}:${event.occurred_at}`}>
                <span>{event.status_label_he}</span>
                <time dateTime={event.occurred_at}>{formatHebrewDate(event.occurred_at)}</time>
              </li>
            ))}
          </ol>
        </section>

        <aside className={styles.notice} aria-labelledby="safe-scope-heading">
          <h2 id="safe-scope-heading">מידע ברור ובטוח</h2>
          <p>המצב המוצג הוא מצב כללי. החלטות מקצועיות ודוחות מופיעים רק לאחר ביקורת ושחרור מפורש.</p>
        </aside>
      </div>

      <section id="documents" className={styles.section} aria-labelledby="documents-heading">
        <div className={styles.sectionHeading}>
          <h2 id="documents-heading">מסמכים</h2>
          <p>מוצגים רק מזהי מסמך ומצב עיבוד, ללא תוכן המסמך.</p>
        </div>
        {projection.document_references.length > 0 ? (
          <ul className={styles.compactList}>
            {projection.document_references.map((document) => (
              <li key={document.document_id}>
                <span>{documentTypeLabel(document.declared_type)}</span>
                <strong>{DOCUMENT_LABELS[document.status]}</strong>
              </li>
            ))}
          </ul>
        ) : <p className={styles.emptyInline}>עדיין לא נקלטו הפניות למסמכים.</p>}
      </section>

      <section className={styles.section} aria-labelledby="clarifications-heading">
        <div className={styles.sectionHeading}>
          <h2 id="clarifications-heading">השלמת מידע</h2>
          <p>תשובה שתימסר תישמר כהצהרה ותעבור ביקורת. היא אינה מחליפה עובדה מתועדת.</p>
        </div>
        {projection.clarification_tasks.length > 0 ? (
          <div className={styles.questionList}>
            {projection.clarification_tasks.map((task) => (
              <article key={task.task_id} className={styles.question}>
                <h3>{task.prompt_he}</h3>
                <p>גרסת שאלה {task.question_version}. נדרשת בדיקה אנושית לאחר המענה.</p>
              </article>
            ))}
          </div>
        ) : <p className={styles.emptyInline}>אין כרגע שאלות שממתינות למענה.</p>}
      </section>

      <section id="reports" className={styles.section} aria-labelledby="reports-heading">
        <div className={styles.sectionHeading}>
          <h2 id="reports-heading">דוחות ששוחררו</h2>
          <p>גישה ניתנת רק למהדורה ולאובייקט ששוחררו במפורש עבור התיק.</p>
        </div>
        {projection.reports.length > 0 ? (
          <div className={styles.reportList}>
            {projection.reports.map((report) => (
              <article key={`${report.report_id}:${report.report_revision}`} className={styles.report}>
                <div>
                  <h3>{report.edition === "full_reviewed_report" ? "דוח מלא שנבדק" : "סיכום בדיקה"}</h3>
                  <p>{report.customer_message_he}</p>
                </div>
                <span className={styles.releaseLabel}>שוחרר</span>
              </article>
            ))}
          </div>
        ) : <p className={styles.emptyInline}>אין כרגע דוח ששוחרר לצפייה.</p>}
      </section>

      <section id="privacy" className={styles.privacy} aria-labelledby="privacy-heading">
        <h2 id="privacy-heading">פרטיות ושמירת מידע</h2>
        <p>בקשות לעיון, תיקון או מחיקה נרשמות בגרסאות ומטופלות על ידי גורם מורשה.</p>
        <dl>
          <div><dt>סיווג שמירה</dt><dd>{retentionLabel(projection.retention.retention_class)}</dd></div>
          <div><dt>מצב בקשת מחיקה</dt><dd>{deletionLabel(projection.retention.deletion_status)}</dd></div>
          <div><dt>החזקה משפטית</dt><dd>{projection.retention.legal_hold ? "פעילה" : "לא פעילה"}</dd></div>
        </dl>
      </section>
    </>
  );
}

export function PortalEmptyState() {
  return (
    <section className={styles.statePage} aria-labelledby="empty-heading">
      <p className={styles.kicker}>האזור האישי</p>
      <h1 id="empty-heading">לא נמצא תיק להצגה</h1>
      <p>אם נשלחה אליך הזמנה, יש להיכנס דרך הקישור המקורי. מטעמי פרטיות לא מוצגים כאן פרטים נוספים.</p>
    </section>
  );
}

export function PortalLoadingState() {
  return <div className={`${styles.page} ${styles.statePage}`} dir="rtl" lang="he" role="status" aria-live="polite"><h1>טוענים את התיק</h1><p>המידע יופיע לאחר אימות מאובטח.</p></div>;
}

export function PortalErrorState() {
  return <div className={`${styles.page} ${styles.statePage}`} dir="rtl" lang="he" role="alert"><h1>לא ניתן להציג את התיק</h1><p>אפשר לנסות שוב מאוחר יותר. לא נחשפו פרטים על התיק.</p></div>;
}

function formatHebrewDate(value: string): string {
  return new Intl.DateTimeFormat("he-IL", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }).format(new Date(value));
}

function deletionLabel(status: PortalCaseProjection["retention"]["deletion_status"]): string {
  if (status === "requested") return "הבקשה התקבלה";
  if (status === "restricted_by_hold") return "הטיפול מוגבל עקב חובת שמירה";
  return "לא הוגשה בקשה";
}

function documentTypeLabel(type: string): string {
  if (type === "payslip") return "תלוש שכר";
  if (type === "timesheet") return "דוח נוכחות";
  if (type === "employment_agreement") return "הסכם העסקה";
  return "מסמך";
}

function retentionLabel(value: string): string {
  if (value === "legal_record") return "רשומה משפטית";
  if (value === "report_record") return "רשומת דוח";
  return "רשומת תיק";
}
