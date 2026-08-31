"use client";

import { useEffect, useRef, useState } from "react";
import type { PortalCaseProjection, ReportAccessGrant } from "../../server/product/customer-portal/contracts";
import styles from "./portal-workspace.module.css";

type PortalWorkspaceProps = Readonly<{ caseId: string; csrfToken: string }>;
type CaseResponse = Readonly<{ case?: PortalCaseProjection }>;

const TOPIC_LABELS = Object.freeze([
  "שכר מינימום",
  "זמן עבודה",
  "פנסיה",
  "נסיעות",
  "הבראה",
  "חופשה",
  "מחלה",
]);

export function PortalWorkspace({ caseId, csrfToken }: PortalWorkspaceProps) {
  const [projection, setProjection] = useState<PortalCaseProjection | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [notice, setNotice] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const clarificationKey = useRef<string | null>(null);
  const privacyKey = useRef<string | null>(null);

  async function refresh() {
    setStatus("loading");
    try {
      setProjection(await fetchProjection(caseId));
      setStatus("ready");
    } catch {
      setProjection(null);
      setStatus("error");
    }
  }

  useEffect(() => {
    let active = true;
    void fetchProjection(caseId).then(
      (value) => { if (active) { setProjection(value); setStatus("ready"); } },
      () => { if (active) { setProjection(null); setStatus("error"); } },
    );
    return () => { active = false; };
  }, [caseId]);

  async function submitClarification() {
    const task = projection?.clarification_tasks[0];
    if (!projection || !task || answer.trim().length < 1) return;
    clarificationKey.current ??= `portal-clarification-${crypto.randomUUID()}`;
    const response = await portalPost(
      `/api/portal/cases/${encodeURIComponent(caseId)}/clarifications/${encodeURIComponent(task.task_id)}/answers`,
      csrfToken,
      {
        expected_revision: projection.revision,
        question_version: task.question_version,
        value: answer.trim(),
        explicit_confirmation: true,
        consent_version: "synthetic-consent-1",
        terms_version: "synthetic-terms-1",
        idempotency_key: clarificationKey.current,
      },
    );
    setNotice(response.ok ? "התשובה התקבלה ותועבר לבדיקה אנושית." : problemLabel(response.status));
    if (response.ok) await refresh();
  }

  async function requestPrivacy() {
    if (!projection) return;
    privacyKey.current ??= `portal-privacy-${crypto.randomUUID()}`;
    const response = await portalPost(`/api/portal/cases/${encodeURIComponent(caseId)}/privacy`, csrfToken, {
      expected_revision: projection.revision,
      request_kind: "data_export",
      idempotency_key: privacyKey.current,
    });
    setNotice(response.ok ? "בקשת הפרטיות נרשמה." : problemLabel(response.status));
  }

  async function downloadReport(reportId: string) {
    if (!projection) return;
    const grantResponse = await portalPost(
      `/api/portal/cases/${encodeURIComponent(caseId)}/reports/${encodeURIComponent(reportId)}/grants`,
      csrfToken,
      { expected_revision: projection.revision },
    );
    if (!grantResponse.ok) {
      setNotice(problemLabel(grantResponse.status));
      return;
    }
    const { grant } = await grantResponse.json() as { grant: ReportAccessGrant };
    const download = await portalPost("/api/portal/reports/download", csrfToken, grant);
    if (!download.ok) {
      setNotice(problemLabel(download.status));
      return;
    }
    const url = URL.createObjectURL(await download.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = "tivdoc-report.pdf";
    link.click();
    URL.revokeObjectURL(url);
    setNotice("הדוח המאושר הורד.");
  }

  return (
    <div className={styles.page} dir="rtl" lang="he">
      <a className={styles.skip} href="#portal-content">מעבר לתוכן הראשי</a>
      <header className={styles.header}>
        <div><span className={styles.brand}>Tivdoc</span><span>האזור האישי</span></div>
        <button type="button" onClick={() => void refresh()} disabled={status === "loading"}>רענון</button>
      </header>
      <main id="portal-content" className={styles.main}>
        {status === "loading" ? <State title="טוענים את התיק" detail="המידע יופיע לאחר אימות מאובטח." /> : null}
        {status === "error" ? <State title="לא ניתן להציג את התיק" detail="מטעמי פרטיות לא מוצגים פרטים נוספים." alert /> : null}
        {status === "ready" && projection ? (
          <>
            <section className={styles.hero} aria-labelledby="case-title">
              <div><p>מצב התיק</p><h1 id="case-title">{projection.status_label_he}</h1></div>
              <dl><div><dt>מספר תיק</dt><dd><code dir="ltr">{projection.case_id}</code></dd></div><div><dt>עדכון</dt><dd>{projection.revision}</dd></div></dl>
            </section>

            <section className={styles.section} aria-labelledby="topics-title">
              <h2 id="topics-title">תחומי הבדיקה</h2>
              <div className={styles.topicGrid}>
                {TOPIC_LABELS.map((label) => <article key={label}><h3>{label}</h3><p>בבדיקה פנימית</p></article>)}
              </div>
            </section>

            <section className={styles.section} aria-labelledby="documents-title">
              <h2 id="documents-title">מסמכים</h2>
              <ul className={styles.list}>{projection.document_references.map((document) => <li key={document.document_id}><span>{documentTypeLabel(document.declared_type)}</span><strong>{documentStatusLabel(document.status)}</strong></li>)}</ul>
            </section>

            <section className={styles.section} aria-labelledby="clarification-title">
              <h2 id="clarification-title">השלמת מידע</h2>
              {projection.clarification_tasks[0] ? (
                <div className={styles.formBlock}>
                  <label htmlFor="clarification-answer">{projection.clarification_tasks[0].prompt_he}</label>
                  <textarea id="clarification-answer" value={answer} onChange={(event) => setAnswer(event.target.value)} maxLength={2_000} />
                  <button data-testid="submit-clarification" type="button" onClick={() => void submitClarification()}>שליחת תשובה לבדיקה</button>
                </div>
              ) : <p>אין כרגע שאלות שממתינות למענה.</p>}
            </section>

            <section className={styles.section} aria-labelledby="reports-title">
              <h2 id="reports-title">דוחות ששוחררו</h2>
              {projection.reports.length > 0 ? projection.reports.map((report) => (
                <article className={styles.report} key={`${report.report_id}:${report.report_revision}`}>
                  <div><h3>{report.edition === "full_reviewed_report" ? "דוח מלא שנבדק" : "סיכום בדיקה"}</h3><p>{report.customer_message_he}</p></div>
                  <button data-testid="download-report" type="button" onClick={() => void downloadReport(report.report_id)}>הורדת דוח מאושר</button>
                </article>
              )) : <p>אין כרגע דוח ששוחרר לצפייה.</p>}
            </section>

            <section className={styles.privacy} aria-labelledby="privacy-title">
              <div><h2 id="privacy-title">פרטיות ושמירת מידע</h2><p>בקשות לעיון, תיקון או מחיקה נרשמות ומטופלות על ידי גורם מורשה.</p></div>
              <button data-testid="privacy-request" type="button" onClick={() => void requestPrivacy()}>בקשת עותק מהמידע</button>
            </section>
            {notice ? <p className={styles.notice} role="status" aria-live="polite">{notice}</p> : null}
          </>
        ) : null}
      </main>
    </div>
  );
}

function State({ title, detail, alert = false }: Readonly<{ title: string; detail: string; alert?: boolean }>) {
  return <section className={styles.state} role={alert ? "alert" : "status"}><h1>{title}</h1><p>{detail}</p></section>;
}

function portalPost(path: string, csrfToken: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "content-type": "application/json", "x-tivdoc-csrf": csrfToken },
    body: JSON.stringify(body),
  });
}

async function fetchProjection(caseId: string): Promise<PortalCaseProjection> {
  const response = await fetch(`/api/portal/cases/${encodeURIComponent(caseId)}`, { cache: "no-store", credentials: "same-origin" });
  if (!response.ok) throw new Error("case_unavailable");
  const body = await response.json() as CaseResponse;
  if (!body.case) throw new Error("case_unavailable");
  return body.case;
}

function problemLabel(status: number): string {
  if (status === 409) return "המידע השתנה. יש לרענן את התיק ולנסות שוב.";
  if (status === 404) return "לא ניתן לבצע את הפעולה.";
  return "הפעולה לא הושלמה. אפשר לנסות שוב מאוחר יותר.";
}

function documentTypeLabel(value: string): string {
  if (value === "payslip") return "תלוש שכר";
  if (value === "timesheet") return "דוח נוכחות";
  if (value === "employment_agreement") return "הסכם העסקה";
  return "מסמך";
}

function documentStatusLabel(value: string): string {
  const labels: Readonly<Record<string, string>> = Object.freeze({ awaiting_upload: "ממתין להעלאה", received: "התקבל", processing: "בעיבוד", needs_review: "ממתין לביקורת", accepted: "אושר", rejected: "נדרשת העלאה מחדש" });
  return labels[value] ?? "בבדיקה";
}
