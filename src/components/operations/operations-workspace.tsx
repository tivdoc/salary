"use client";

import { useState } from "react";
import styles from "./operations-workspace.module.css";
import { GroundTruthQueuePanel } from "./ground-truth-queue-panel";
import { LegalReviewPanel } from "./legal-review-panel";

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

type OperationsWorkspaceProps = Readonly<{ csrfToken: string }>;
type QueueItem = Readonly<{ case_id: string; revision: number; state: string; blocker_count: number; next_action_code: string }>;
type Topic = Readonly<{ topic: (typeof TOPICS)[number]; status: string; blocker_codes: readonly string[] }>;
type Bundle = Readonly<{
  overview: Record<string, unknown>;
  facts: Record<string, unknown>;
  readiness: Record<string, unknown>;
  analysis: Record<string, unknown>;
  report: Record<string, unknown>;
}>;

export function OperationsWorkspace({ csrfToken }: OperationsWorkspaceProps) {
  const [queue, setQueue] = useState<readonly QueueItem[]>([]);
  const [capabilities, setCapabilities] = useState<readonly string[]>([]);
  const [selectedCase, setSelectedCase] = useState<string | null>(null);
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [reason, setReason] = useState("בדיקה סינתטית מתועדת");
  const [notice, setNotice] = useState("הגישה אומתה. יש לטעון את תור העבודה.");
  const [busy, setBusy] = useState(false);

  async function loadQueue() {
    setBusy(true);
    try {
      const [capabilityResponse, queueResponse] = await Promise.all([operationsGet("capabilities"), operationsGet("queue")]);
      if (!capabilityResponse.ok || !queueResponse.ok) throw new Error("operations_unavailable");
      const capabilityBody = await capabilityResponse.json() as { data?: { capabilities?: unknown } };
      const queueBody = await queueResponse.json() as { data?: { items?: unknown } };
      setCapabilities(stringArray(capabilityBody.data?.capabilities));
      setQueue(queueItems(queueBody.data?.items));
      setNotice("תור העבודה והרשאות הפעולה נטענו.");
    } catch {
      setQueue([]);
      setCapabilities([]);
      setNotice("לא ניתן לטעון את סביבת התפעול.");
    } finally {
      setBusy(false);
    }
  }

  async function loadCase(caseId: string) {
    setBusy(true);
    setSelectedCase(caseId);
    try {
      const names = ["overview", "facts", "readiness", "analysis", "report"] as const;
      const responses = await Promise.all(names.map((name) => operationsGet(`cases/${encodeURIComponent(caseId)}${name === "overview" ? "" : `/${name}`}`)));
      if (responses.some((response) => !response.ok)) throw new Error("case_unavailable");
      const bodies = await Promise.all(responses.map((response) => response.json() as Promise<{ data?: unknown }>));
      setBundle(Object.freeze(Object.fromEntries(names.map((name, index) => [name, record(bodies[index].data)]))) as Bundle);
      setNotice("התיק נטען מהשירות הקנוני.");
    } catch {
      setBundle(null);
      setNotice("לא ניתן להציג את התיק בהרשאה הנוכחית.");
    } finally {
      setBusy(false);
    }
  }

  async function submit(action: "fact_resolution" | "analysis_request" | "report_approve") {
    if (!selectedCase || !bundle || reason.trim().length < 8) {
      setNotice("נדרשת סיבת פעולה מפורטת.");
      return;
    }
    const operation = buildOperation(action, selectedCase, bundle);
    if (!operation) {
      setNotice("חסרים נתונים קנוניים לביצוע הפעולה.");
      return;
    }
    const nonce = crypto.randomUUID();
    const response = await fetch(`/api/operations/${operation.path}`, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json", "x-tivdoc-csrf": csrfToken },
      body: JSON.stringify({
        schema_version: "tivdoc-operations-command",
        command_id: `command-${nonce}`,
        idempotency_key: `operation-${nonce}`,
        expected_revision: operation.expectedRevision,
        reason: reason.trim(),
        payload: operation.payload,
      }),
    });
    setNotice(response.ok ? "הפעולה התקבלה ונרשמה." : response.status === 409 ? "המידע השתנה. יש לטעון את התיק מחדש." : "הפעולה נדחתה לפי מדיניות ההרשאות.");
    if (response.ok) await loadCase(selectedCase);
  }

  const topics = topicItems(bundle?.readiness.topics);
  return (
    <div className={styles.page} dir="rtl" lang="he">
      <a className={styles.skip} href="#operations-content">מעבר לתוכן הראשי</a>
      <header className={styles.header}>
        <div><p>Tivdoc · סביבת תפעול פנימית</p><h1>מסוף בקרת תיק</h1><span>אין מסירה ללקוח ואין עקיפת חסמים.</span></div>
        <button data-testid="load-operations" type="button" onClick={() => void loadQueue()} disabled={busy}>טעינת תור והרשאות</button>
      </header>
      <div className={styles.workspace}>
        <aside className={styles.queue} aria-label="תור עבודה">
          <div className={styles.queueTitle}><h2>תור עבודה</h2><span>{queue.length}</span></div>
          {queue.length === 0 ? <p>אין תיקים להצגה.</p> : null}
          <ul>{queue.map((item) => <li key={item.case_id}><button type="button" aria-pressed={selectedCase === item.case_id} onClick={() => void loadCase(item.case_id)}><code dir="ltr">{item.case_id}</code><span>גרסה {item.revision} · {item.blocker_count} חסמים</span></button></li>)}</ul>
        </aside>
        <main id="operations-content" className={styles.main}>
          <p className={styles.notice} role="status" aria-live="polite">{notice}</p>
          {!bundle ? <section className={styles.empty}><h2>בחרו תיק מתור העבודה</h2><p>פרטי התיק יוצגו רק לאחר בדיקת הרשאות בצד השרת.</p></section> : (
            <>
              <section className={styles.summary}>
                <div><p>תיק פעיל</p><h2><code dir="ltr">{selectedCase}</code></h2></div>
                <dl><div><dt>גרסה</dt><dd>{numberField(bundle.overview, "revision") ?? "—"}</dd></div><div><dt>מצב</dt><dd>{stringField(bundle.overview, "state") ?? "—"}</dd></div></dl>
              </section>
              <section className={styles.panel} aria-labelledby="readiness-title">
                <h2 id="readiness-title">מוכנות שבעת התחומים</h2>
                <div className={styles.topicGrid}>{TOPICS.map((topic) => {
                  const item = topics.find((candidate) => candidate.topic === topic);
                  return <article key={topic}><h3>{TOPIC_LABELS[topic]}</h3><p>{item?.status === "READY" ? "מוכן" : "חסום לבדיקה"}</p><small>{item?.blocker_codes.length ?? 0} חסמים</small></article>;
                })}</div>
              </section>
              <section className={styles.panel} aria-labelledby="actions-title">
                <h2 id="actions-title">פעולות מבוקרות</h2>
                <label htmlFor="operator-reason">סיבת הפעולה</label>
                <textarea id="operator-reason" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} />
                <div className={styles.actions}>
                  <button data-testid="resolve-fact" type="button" disabled={!capabilities.includes("command.fact_resolution")} onClick={() => void submit("fact_resolution")}>אישור עובדה לבדיקה</button>
                  <button data-testid="run-analysis" type="button" disabled={!capabilities.includes("command.analysis_request")} onClick={() => void submit("analysis_request")}>הפעלת ניתוח סינתטי</button>
                  <button data-testid="approve-report" type="button" disabled={!capabilities.includes("command.report_approve")} onClick={() => void submit("report_approve")}>אישור גיבוב הדוח המדויק</button>
                </div>
              </section>
              <section className={styles.panel} aria-labelledby="facts-title"><h2 id="facts-title">עובדות והצהרות</h2><pre dir="ltr">{safeSummary(bundle.facts)}</pre></section>
            </>
          )}
          <LegalReviewPanel csrfToken={csrfToken} />
          <GroundTruthQueuePanel />
        </main>
      </div>
    </div>
  );
}

function operationsGet(path: string): Promise<Response> {
  return fetch(`/api/operations/${path}`, { cache: "no-store", credentials: "same-origin" });
}

function buildOperation(action: "fact_resolution" | "analysis_request" | "report_approve", caseId: string, bundle: Bundle) {
  const expectedRevision = numberField(bundle.overview, "revision");
  if (expectedRevision === null) return null;
  if (action === "fact_resolution") {
    const snapshot = stringField(bundle.facts, "snapshot_sha256");
    const facts = objectArray(bundle.facts.facts);
    const factId = facts.length > 0 ? stringField(facts[0], "fact_id") : null;
    return snapshot && factId ? { path: `cases/${encodeURIComponent(caseId)}/facts/resolve`, expectedRevision, payload: { action, case_id: caseId, facts_snapshot_sha256: snapshot, fact_ids: [factId], decision: "confirmed" } } : null;
  }
  if (action === "analysis_request") {
    const snapshot = stringField(bundle.facts, "snapshot_sha256");
    return snapshot ? { path: `cases/${encodeURIComponent(caseId)}/analysis/request`, expectedRevision, payload: { action, case_id: caseId, analysis_run_id: null, mode: "synthetic_test", requested_topics: TOPICS, input_snapshot_sha256: snapshot } } : null;
  }
  const reportId = stringField(bundle.report, "report_id");
  const reportRevision = numberField(bundle.report, "report_revision");
  const reportSha = stringField(bundle.report, "report_sha256");
  const analysisSha = stringField(bundle.report, "analysis_result_sha256");
  return reportId && reportRevision !== null && reportSha && analysisSha
    ? { path: `cases/${encodeURIComponent(caseId)}/report/approve`, expectedRevision, payload: { action, case_id: caseId, report_id: reportId, report_revision: reportRevision, report_sha256: reportSha, analysis_result_sha256: analysisSha, decision: "approved" } }
    : null;
}

function queueItems(value: unknown): readonly QueueItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is QueueItem => Boolean(item) && typeof item === "object" && typeof item.case_id === "string" && Number.isInteger(item.revision) && typeof item.state === "string" && Number.isInteger(item.blocker_count));
}

function topicItems(value: unknown): readonly Topic[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Topic => Boolean(item) && typeof item === "object" && TOPICS.includes(item.topic) && typeof item.status === "string" && Array.isArray(item.blocker_codes));
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function objectArray(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  return typeof value[key] === "string" ? value[key] : null;
}

function numberField(value: Record<string, unknown>, key: string): number | null {
  return typeof value[key] === "number" && Number.isInteger(value[key]) ? value[key] : null;
}

function safeSummary(value: Record<string, unknown>): string {
  const facts = objectArray(value.facts).map((fact) => ({ fact_id: stringField(fact, "fact_id"), canonical_path: stringField(fact, "canonical_path"), status: stringField(fact, "status") }));
  return JSON.stringify({ snapshot_sha256: stringField(value, "snapshot_sha256"), facts }, null, 2);
}
