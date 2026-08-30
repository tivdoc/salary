"use client";

import { useState } from "react";
import styles from "./internal-ops-console.module.css";

const TOPICS = ["minimum_wage", "working_time", "pension", "travel", "convalescence", "vacation", "sick_leave"] as const;
const TOPIC_LABELS: Readonly<Record<(typeof TOPICS)[number], string>> = Object.freeze({
  minimum_wage: "שכר מינימום",
  working_time: "זמן עבודה",
  pension: "פנסיה",
  travel: "נסיעות",
  convalescence: "הבראה",
  vacation: "חופשה",
  sick_leave: "מחלה",
});

type QueueItem = Readonly<{ case_id: string; revision: number; state: string; blocker_count: number; next_action_code: string; updated_at: string }>;
type ReadinessItem = Readonly<{ topic: (typeof TOPICS)[number]; status: "READY" | "BLOCKED_NOT_READY" | "NOT_APPLICABLE"; blocker_codes: readonly string[]; decision_sha256: string | null }>;
type CaseBundle = Readonly<Record<string, unknown> & { readiness?: Readonly<{ topics?: readonly ReadinessItem[]; all_topics_ready?: boolean }> }>;

type ConsoleState = Readonly<{
  status: "loading" | "ready" | "unavailable";
  problemCode: string | null;
  capabilities: readonly string[];
  queue: readonly QueueItem[];
}>;

export function InternalOpsConsole({ apiEnabled }: Readonly<{ apiEnabled: boolean }>) {
  const [state, setState] = useState<ConsoleState>(() => apiEnabled
    ? Object.freeze({ status: "unavailable", problemCode: "OPS_LOAD_REQUIRED", capabilities: [], queue: [] })
    : Object.freeze({ status: "unavailable", problemCode: "OPS_API_DISABLED", capabilities: [], queue: [] }));
  const [selectedCase, setSelectedCase] = useState<string | null>(null);
  const [bundle, setBundle] = useState<CaseBundle | null>(null);
  const [operatorReason, setOperatorReason] = useState("");
  const [actionStatus, setActionStatus] = useState<string | null>(null);

  async function loadShell() {
    setState({ status: "loading", problemCode: null, capabilities: [], queue: [] });
    try {
      const [capabilityResponse, queueResponse] = await Promise.all([
        fetch("/api/internal-ops-v07/capabilities", { cache: "no-store", credentials: "same-origin" }),
        fetch("/api/internal-ops-v07/queue", { cache: "no-store", credentials: "same-origin" }),
      ]);
      if (!capabilityResponse.ok || !queueResponse.ok) {
        setState({ status: "unavailable", problemCode: safeProblem(await capabilityResponse.json().catch(() => null)), capabilities: [], queue: [] });
        return;
      }
      const capabilities = await capabilityResponse.json() as { data?: { capabilities?: unknown } };
      const queue = await queueResponse.json() as { data?: { items?: unknown } };
      setState({
        status: "ready",
        problemCode: null,
        capabilities: stringArray(capabilities.data?.capabilities),
        queue: queueItems(queue.data?.items),
      });
    } catch {
      setState({ status: "unavailable", problemCode: "OPS_BACKEND_UNAVAILABLE", capabilities: [], queue: [] });
    }
  }

  async function selectCase(caseId: string) {
    setSelectedCase(caseId);
    setBundle(null);
    const resources = ["", "timeline", "payment", "documents", "extraction", "facts", "readiness", "analysis", "report", "audit"] as const;
    try {
      const responses = await Promise.all(resources.map((resource) => fetch(`/api/internal-ops-v07/cases/${encodeURIComponent(caseId)}${resource ? `/${resource}` : ""}`, { cache: "no-store", credentials: "same-origin" })));
      if (responses.some((response) => !response.ok)) {
        setBundle(null);
        return;
      }
      const values = await Promise.all(responses.map((response) => response.json() as Promise<{ data?: unknown }>));
      setBundle(Object.freeze(Object.fromEntries(resources.map((resource, index) => [resource || "overview", values[index]?.data ?? null]))));
    } catch {
      setBundle(null);
    }
  }

  async function submitAction(action: string) {
    if (!selectedCase || operatorReason.trim().length < 8) {
      setActionStatus("OPS_REASON_REQUIRED");
      return;
    }
    const operation = buildOperation(action, selectedCase, bundle);
    if (!operation) {
      setActionStatus("OPS_REQUIRED_PROJECTION_MISSING");
      return;
    }
    const nonce = crypto.randomUUID();
    const body = {
      schema_version: "tivdoc-internal-ops-v0.7.0",
      command_id: `cmd-${nonce}`,
      idempotency_key: `idem-${nonce}`,
      expected_revision: operation.expectedRevision,
      reason: operatorReason.trim(),
      payload: operation.payload,
    };
    setActionStatus("OPS_COMMAND_SUBMITTING");
    try {
      const response = await fetch(`/api/internal-ops-v07/${operation.path}`, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (response.ok && action === "report_manual_export") {
        const objectUrl = URL.createObjectURL(await response.blob());
        const link = document.createElement("a");
        link.href = objectUrl;
        link.download = "tivdoc-internal-report.pdf";
        link.click();
        URL.revokeObjectURL(objectUrl);
        setActionStatus("OPS_LOCAL_EXPORT_COMPLETED");
        await selectCase(selectedCase);
        return;
      }
      const result = await response.json().catch(() => null);
      setActionStatus(response.ok ? "OPS_COMMAND_ACCEPTED" : safeProblem(result));
      if (response.ok) await selectCase(selectedCase);
    } catch {
      setActionStatus("OPS_BACKEND_UNAVAILABLE");
    }
  }

  const readiness = normalizedReadiness(bundle?.readiness);
  return (
    <div className={styles.console} dir="rtl" lang="he">
      <a className={styles.skip} href="#ops-main">דלגו לתוכן הראשי</a>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>TIVDOC · סביבת תפעול פנימית V0.7</p>
          <h1>מסוף בקרת תיק</h1>
          <p>תצוגה פנימית בלבד. אין מסירה ללקוח ואין עקיפת חסמים.</p>
        </div>
        <div className={styles.status} role="status" aria-live="polite">
          <span className={state.status === "ready" ? styles.dotReady : styles.dotBlocked} aria-hidden="true" />
          {state.status === "loading" ? "טוען הרשאות" : state.status === "ready" ? "גישה מאומתת" : "הגישה אינה זמינה"}
        </div>
      </header>

      <div className={styles.workspace}>
        <aside className={styles.queue} aria-label="תור תיקים">
          <div className={styles.sectionTitle}><h2>תור עבודה</h2><span>{state.queue.length}</span></div>
          <button className={styles.refresh} type="button" disabled={!apiEnabled || state.status === "loading"} onClick={() => void loadShell()}>רעננו תור והרשאות</button>
          {state.problemCode ? <p className={styles.problem} role="alert"><code dir="ltr">{state.problemCode}</code></p> : null}
          {state.status === "ready" && state.queue.length === 0 ? <p className={styles.empty}>אין תיקים מוקצים.</p> : null}
          <ul>
            {state.queue.map((item) => (
              <li key={item.case_id}>
                <button className={selectedCase === item.case_id ? styles.caseActive : styles.caseButton} onClick={() => void selectCase(item.case_id)} type="button">
                  <span><code dir="ltr">{item.case_id}</code><small>גרסה {item.revision}</small></span>
                  <span className={styles.blockerCount} aria-label={`${item.blocker_count} חסמים`}>{item.blocker_count}</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <main id="ops-main" className={styles.main}>
          <nav className={styles.tabs} aria-label="שלבי התיק">
            {["סקירה", "תשלום", "מסמכים", "חילוץ", "עובדות", "משפטי", "ניתוח", "דוח", "ביקורת"].map((label, index) => <a key={label} href={`#ops-panel-${index}`}>{label}</a>)}
          </nav>

          <section id="ops-panel-0" className={styles.heroPanel} aria-labelledby="overview-heading">
            <div><p className={styles.eyebrow}>תיק נבחר</p><h2 id="overview-heading">{selectedCase ? <code dir="ltr">{selectedCase}</code> : "לא נבחר תיק"}</h2></div>
            <div className={styles.warning}>חוסר מידע או חסם אינם אפס. כל פלט נשאר טיוטה פנימית עד אישור hash מדויק.</div>
          </section>

          <section className={styles.reasonPanel} aria-labelledby="reason-heading">
            <label id="reason-heading" htmlFor="ops-reason">נימוק להחלטה (חובה, נרשם בביקורת)</label>
            <input id="ops-reason" type="text" value={operatorReason} onChange={(event) => setOperatorReason(event.target.value)} minLength={8} maxLength={500} autoComplete="off" />
            {actionStatus ? <p role="status" aria-live="polite"><code dir="ltr">{actionStatus}</code></p> : null}
          </section>

          <section id="ops-panel-1" className={styles.panel} aria-labelledby="payment-heading">
            <PanelHeading id="payment-heading" index="01" title="התאמת תשלום" />
            <ProjectionSummary value={bundle?.payment} fallback="לא נטענה אסמכתת תשלום מאומתת." />
            <button type="button" disabled={!canCommand(state, "payment_reconcile", selectedCase, operatorReason)} onClick={() => void submitAction("payment_reconcile")}>בצעו התאמה מחדש</button>
          </section>

          <section id="ops-panel-2" className={styles.panel} aria-labelledby="documents-heading">
            <PanelHeading id="documents-heading" index="02" title="מסמכים" />
            <ProjectionSummary value={bundle?.documents} fallback="אין הפניות אטומות למסמכים." />
            <p className={styles.note}>מוצגים metadata ו-hash בלבד; אין נתיב מקומי או OCR גולמי.</p>
          </section>

          <section id="ops-panel-3" className={styles.panel} aria-labelledby="extraction-heading">
            <PanelHeading id="extraction-heading" index="03" title="בקרת חילוץ" />
            <ProjectionSummary value={bundle?.extraction} fallback="אין snapshot חילוץ לביקורת." />
            <button type="button" disabled={!canCommand(state, "extraction_review", selectedCase, operatorReason)} onClick={() => void submitAction("extraction_review")}>שלחו החלטת בודק</button>
          </section>

          <section id="ops-panel-4" className={styles.panel} aria-labelledby="facts-heading">
            <PanelHeading id="facts-heading" index="04" title="פתרון עובדות" />
            <ProjectionSummary value={bundle?.facts} fallback="אין snapshot עובדות מאושר." />
            <button type="button" disabled={!canCommand(state, "fact_resolution", selectedCase, operatorReason)} onClick={() => void submitAction("fact_resolution")}>אשרו עובדות מסומנות</button>
            <p className={styles.note}>אין אישור גורף לשדות קריטיים; הערה אינה משנה ערך קנוני.</p>
          </section>

          <section id="ops-panel-5" className={styles.panelWide} aria-labelledby="legal-heading">
            <PanelHeading id="legal-heading" index="05" title="מוכנות משפטית — שבעה נושאים" />
            <div className={styles.readinessGrid}>
              {readiness.map((item) => (
                <article className={item.status === "READY" ? styles.readyCard : styles.blockedCard} key={item.topic}>
                  <p>{TOPIC_LABELS[item.topic]}</p><strong>{statusLabel(item.status)}</strong>
                  {item.blocker_codes.length > 0 ? <ul>{item.blocker_codes.map((code) => <li key={code}><code dir="ltr">{code}</code></li>)}</ul> : <p>ללא חסמים</p>}
                </article>
              ))}
            </div>
          </section>

          <section id="ops-panel-6" className={styles.panel} aria-labelledby="analysis-heading">
            <PanelHeading id="analysis-heading" index="06" title="ניתוח" />
            <ProjectionSummary value={bundle?.analysis} fallback="לא הופעלה ריצת ניתוח." />
            <button type="button" disabled={!canCommand(state, "analysis_request", selectedCase, operatorReason)} onClick={() => void submitAction("analysis_request")}>בקשו ניתוח קנוני</button>
          </section>

          <section id="ops-panel-7" className={styles.panel} aria-labelledby="report-heading">
            <PanelHeading id="report-heading" index="07" title="דוח" />
            <ProjectionSummary value={bundle?.report} fallback="אין טיוטת דוח." />
            <div className={styles.actions}>
              <button type="button" disabled={!canCommand(state, "report_submit", selectedCase, operatorReason)} onClick={() => void submitAction("report_submit")}>העבירו לאישור</button>
              <button type="button" disabled={!canCommand(state, "report_approve", selectedCase, operatorReason)} onClick={() => void submitAction("report_approve")}>אשרו hash מדויק</button>
              <button type="button" disabled={!canCommand(state, "report_reject", selectedCase, operatorReason)} onClick={() => void submitAction("report_reject")}>החזירו לתיקון</button>
              <button type="button" disabled={!canCommand(state, "report_manual_export", selectedCase, operatorReason)} onClick={() => void submitAction("report_manual_export")}>ייצוא ידני מקומי</button>
            </div>
            <p className={styles.watermark}>טיוטה פנימית · לא למסירה ללקוח</p>
          </section>

          <section id="ops-panel-8" className={styles.panelWide} aria-labelledby="audit-heading">
            <PanelHeading id="audit-heading" index="08" title="שרשרת ביקורת" />
            <ProjectionSummary value={bundle?.audit} fallback="אין אירועי ביקורת להצגה." />
            <p className={styles.note}>מוצגים metadata ו-hash בלבד.</p>
          </section>
        </main>
      </div>
    </div>
  );
}

function PanelHeading({ id, index, title }: Readonly<{ id: string; index: string; title: string }>) {
  return <div className={styles.sectionTitle}><span>{index}</span><h2 id={id}>{title}</h2></div>;
}

function ProjectionSummary({ value, fallback }: Readonly<{ value: unknown; fallback: string }>) {
  if (!value || typeof value !== "object") return <p className={styles.empty}>{fallback}</p>;
  const record = value as Record<string, unknown>;
  const revision = typeof record.revision === "number" ? `גרסה ${record.revision}` : null;
  const status = typeof record.status === "string" ? record.status : null;
  const count = Array.isArray(record.documents) ? `${record.documents.length} מסמכים` : Array.isArray(record.facts) ? `${record.facts.length} עובדות` : Array.isArray(record.runs) ? `${record.runs.length} ריצות` : null;
  return <p>{[revision, status, count].filter(Boolean).join(" · ") || "ההיטל נטען בהצלחה."}</p>;
}

function safeProblem(value: unknown): string {
  if (value && typeof value === "object" && "code" in value && typeof (value as { code: unknown }).code === "string") return (value as { code: string }).code;
  return "OPS_BACKEND_UNAVAILABLE";
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function queueItems(value: unknown): readonly QueueItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is QueueItem => Boolean(item && typeof item === "object" && typeof item.case_id === "string" && typeof item.revision === "number" && typeof item.blocker_count === "number"));
}

function normalizedReadiness(value: unknown): readonly ReadinessItem[] {
  if (value && typeof value === "object" && "topics" in value && Array.isArray((value as { topics?: unknown }).topics)) {
    const provided = (value as { topics: unknown[] }).topics;
    return TOPICS.map((topic) => {
      const found = provided.find((item) => item && typeof item === "object" && (item as { topic?: unknown }).topic === topic) as Partial<ReadinessItem> | undefined;
      return Object.freeze({ topic, status: found?.status ?? "BLOCKED_NOT_READY", blocker_codes: stringArray(found?.blocker_codes), decision_sha256: found?.decision_sha256 ?? null });
    });
  }
  return TOPICS.map((topic) => Object.freeze({ topic, status: "BLOCKED_NOT_READY" as const, blocker_codes: ["OPS_CASE_NOT_SELECTED"], decision_sha256: null }));
}

function statusLabel(status: ReadinessItem["status"]): string {
  if (status === "READY") return "מוכן";
  if (status === "NOT_APPLICABLE") return "לא חל";
  return "חסום — לא מוכן";
}

function canCommand(state: ConsoleState, action: string, caseId: string | null, reason: string): boolean {
  return caseId !== null && reason.trim().length >= 8 && state.capabilities.includes(`command.${action}`);
}

function buildOperation(action: string, caseId: string, bundle: CaseBundle | null): Readonly<{ path: string; expectedRevision: number; payload: Record<string, unknown> }> | null {
  const overview = record(bundle?.overview);
  const expectedRevision = numberField(overview, "revision");
  if (expectedRevision === null) return null;
  if (action === "payment_reconcile") {
    const reference = stringField(record(bundle?.payment), "reference_sha256");
    return reference ? { path: `cases/${encodeURIComponent(caseId)}/payment/reconcile`, expectedRevision, payload: { action, case_id: caseId, payment_reference_sha256: reference } } : null;
  }
  if (action === "extraction_review") {
    const extraction = record(bundle?.extraction);
    const snapshot = stringField(extraction, "snapshot_sha256");
    const fields = objectArray(extraction.fields).map((item) => stringField(item, "field_id")).filter((item): item is string => item !== null);
    return snapshot && fields.length ? { path: `cases/${encodeURIComponent(caseId)}/extraction/review`, expectedRevision, payload: { action, case_id: caseId, extraction_snapshot_sha256: snapshot, field_ids: fields, decision: "approved" } } : null;
  }
  if (action === "fact_resolution") {
    const facts = record(bundle?.facts);
    const snapshot = stringField(facts, "snapshot_sha256");
    const ids = objectArray(facts.facts).map((item) => stringField(item, "fact_id")).filter((item): item is string => item !== null);
    return snapshot && ids.length ? { path: `cases/${encodeURIComponent(caseId)}/facts/resolve`, expectedRevision, payload: { action, case_id: caseId, facts_snapshot_sha256: snapshot, fact_ids: ids, decision: "confirmed" } } : null;
  }
  if (action === "analysis_request") {
    const factsSnapshot = stringField(record(bundle?.facts), "snapshot_sha256");
    const mode = stringField(overview, "mode");
    return factsSnapshot && (mode === "real" || mode === "synthetic_test") ? { path: `cases/${encodeURIComponent(caseId)}/analysis/request`, expectedRevision, payload: { action, case_id: caseId, analysis_run_id: null, mode, requested_topics: TOPICS, input_snapshot_sha256: factsSnapshot } } : null;
  }
  const report = record(bundle?.report);
  const reportId = stringField(report, "report_id");
  const reportRevision = numberField(report, "report_revision");
  const reportSha = stringField(report, "report_sha256");
  const analysisSha = stringField(report, "analysis_result_sha256");
  if (!reportId || reportRevision === null || !reportSha || !analysisSha) return null;
  if (action === "report_submit" || action === "report_approve" || action === "report_reject") {
    const suffix = action.slice("report_".length);
    const decision = action === "report_submit" ? "submitted" : action === "report_approve" ? "approved" : "changes_requested";
    return { path: `cases/${encodeURIComponent(caseId)}/report/${suffix}`, expectedRevision, payload: { action, case_id: caseId, report_id: reportId, report_revision: reportRevision, report_sha256: reportSha, analysis_result_sha256: analysisSha, decision } };
  }
  if (action === "report_manual_export") {
    const receipt = stringField(report, "exact_hash_approval_receipt_sha256");
    return receipt ? { path: `cases/${encodeURIComponent(caseId)}/report/export`, expectedRevision, payload: { action, case_id: caseId, report_id: reportId, report_revision: reportRevision, report_sha256: reportSha, approval_receipt_sha256: receipt, format: "pdf", destination: "local_operator_download" } } : null;
  }
  return null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  return typeof value[key] === "string" ? value[key] : null;
}

function numberField(value: Record<string, unknown>, key: string): number | null {
  return typeof value[key] === "number" && Number.isInteger(value[key]) ? value[key] : null;
}

function objectArray(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}
