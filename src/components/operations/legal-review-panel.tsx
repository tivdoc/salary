"use client";

// Nested Legal Review panel. It reads and writes only through the protected
// /api/operations/legal-review endpoints, which run on the canonical durable
// Postgres adapter inside the operations session transaction. Nothing here
// activates a source, parameter or rule, and no customer data reaches it.

import { useState } from "react";
import styles from "./operations-workspace.module.css";

type LegalReviewPanelProps = Readonly<{ csrfToken: string }>;

type TopicRow = Readonly<{
  topic: string;
  ready: boolean;
  blocked_gates: readonly string[];
  cleared_gates: readonly string[];
}>;

type QueueRow = Readonly<{
  packet_id: string;
  packet_sha256: string;
  revision: number;
  state: string;
  topic: string | null;
  source_version_id: string;
  parser_version: string;
  normalizer_version: string;
  queue_priority: number;
  blocked_reason_codes: readonly string[];
  superseded_by_packet_id: string | null;
  activation_allowed: boolean;
  enqueued_at: string;
  updated_at: string;
}>;

const STATE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  pending_review: "ממתין לבדיקה",
  in_review: "בבדיקה",
  changes_requested: "נדרשים תיקונים",
  approved: "אושר — לא מופעל",
  rejected: "נדחה",
  superseded: "הוחלף",
});

const DECISIONS = Object.freeze([
  { value: "claim", label: "התחל בדיקה" },
  { value: "request_changes", label: "בקש תיקונים" },
  { value: "approve", label: "אשר (ללא הפעלה)" },
  { value: "reject", label: "דחה" },
  { value: "supersede", label: "החלף" },
] as const);

export function LegalReviewPanel({ csrfToken }: LegalReviewPanelProps) {
  const [rows, setRows] = useState<readonly QueueRow[]>([]);
  const [selected, setSelected] = useState<QueueRow | null>(null);
  const [decision, setDecision] = useState<string>("claim");
  const [reasonCode, setReasonCode] = useState("REVIEW_STARTED");
  const [reason, setReason] = useState("בדיקה פנימית מתועדת");
  const [actorId, setActorId] = useState("");
  const [signature, setSignature] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [topics, setTopics] = useState<readonly TopicRow[]>([]);
  const [notice, setNotice] = useState("תור הבדיקה המשפטית לא נטען.");
  const [busy, setBusy] = useState(false);

  async function loadQueue() {
    setBusy(true);
    try {
      const response = await fetch("/api/operations/legal-review/queue", {
        cache: "no-store", credentials: "same-origin",
      });
      if (!response.ok) {
        const problem = await response.json().catch(() => null) as { code?: string } | null;
        setRows([]);
        setSelected(null);
        setNotice(`התור אינו זמין: ${problem?.code ?? response.status}`);
        return;
      }
      const body = await response.json() as { data?: { entries?: unknown } };
      const entries = Array.isArray(body.data?.entries) ? body.data.entries as readonly QueueRow[] : [];
      setRows(entries);
      setNotice(`נטענו ${entries.length} מנות בדיקה.`);
    } catch {
      setRows([]);
      setNotice("לא ניתן לטעון את תור הבדיקה המשפטית.");
    } finally {
      setBusy(false);
    }
  }

  async function loadTopics() {
    setBusy(true);
    try {
      const response = await fetch("/api/operations/legal-review/topics", {
        cache: "no-store", credentials: "same-origin",
      });
      if (!response.ok) {
        setTopics([]);
        setNotice("לוח שבעת התחומים אינו זמין.");
        return;
      }
      const body = await response.json() as { data?: { readiness?: { topics?: unknown } } };
      const rows = Array.isArray(body.data?.readiness?.topics) ? body.data.readiness.topics as readonly TopicRow[] : [];
      setTopics(rows);
      setNotice(`נטענו ${rows.length} תחומים. אף תחום אינו מוכן להפעלה.`);
    } catch {
      setTopics([]);
      setNotice("לא ניתן לטעון את לוח התחומים.");
    } finally {
      setBusy(false);
    }
  }

  async function submitAction() {
    if (!selected) return;
    if (!actorId.trim() || !signature.trim() || !idempotencyKey.trim()) {
      setNotice("נדרשים מזהה בודק, חתימה ומפתח אידמפוטנטיות.");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/operations/legal-review/actions", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-tivdoc-csrf": csrfToken },
        body: JSON.stringify({
          schema_version: "tivdoc-operations-command",
          idempotency_key: idempotencyKey,
          occurred_at: new Date().toISOString(),
          packet: { packet_id: selected.packet_id, packet_sha256: selected.packet_sha256 },
          action: {
            action_id: idempotencyKey,
            packet_id: selected.packet_id,
            packet_sha256: selected.packet_sha256,
            expected_revision: selected.revision,
            decision,
            reason_code: reasonCode,
            reason,
            attestation: { actor_id: actorId, signature_sha256: signature },
            cited_chunk_ids: [],
          },
        }),
      });
      const body = await response.json().catch(() => null) as { code?: string } | null;
      // Conflicts are surfaced exactly as returned; nothing is retried here.
      setNotice(response.ok
        ? "הפעולה נרשמה. אין בכך הפעלה של מקור, פרמטר או כלל."
        : `הפעולה נדחתה: ${body?.code ?? response.status}`);
      if (response.ok) await loadQueue();
    } catch {
      setNotice("הפעולה נכשלה. לא בוצע ניסיון חוזר אוטומטי.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.panel} aria-label="בדיקה משפטית">
      <h2>בדיקה משפטית פנימית</h2>
      <p className={styles.notice}>{notice}</p>
      <p className={styles.notice}>
        מצב הפעלה: לא מופעל. אישור מנה אינו מפעיל מקור, פרמטר או כלל, ואינו מחשב זכאות.
      </p>
      <button type="button" onClick={loadQueue} disabled={busy}>טען תור בדיקה</button>
      <button type="button" onClick={loadTopics} disabled={busy}>טען לוח שבעת התחומים</button>

      {topics.length > 0 ? (
        <table>
          <caption>מוכנות שבעת התחומים המשפטיים</caption>
          <thead>
            <tr><th scope="col">תחום</th><th scope="col">מוכן</th><th scope="col">שערים חסומים</th></tr>
          </thead>
          <tbody>
            {topics.map((row) => (
              <tr key={row.topic}>
                <td>{row.topic}</td>
                <td>{row.ready ? "כן" : "לא"}</td>
                <td>{row.blocked_gates.length === 0 ? "—" : row.blocked_gates.join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      <table>
        <caption>תור מנות בדיקה</caption>
        <thead>
          <tr>
            <th scope="col">מנה</th>
            <th scope="col">מצב</th>
            <th scope="col">נושא</th>
            <th scope="col">גרסת מקור</th>
            <th scope="col">גרסה</th>
            <th scope="col">חסימות</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.packet_id}>
              <td>
                <button type="button" onClick={() => setSelected(row)} disabled={busy}>
                  {row.packet_id}
                </button>
              </td>
              <td>{STATE_LABELS[row.state] ?? row.state}</td>
              <td>{row.topic ?? "—"}</td>
              <td>{row.source_version_id}</td>
              <td>{row.revision}</td>
              <td>{row.blocked_reason_codes.length === 0 ? "—" : row.blocked_reason_codes.join(", ")}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {selected ? (
        <div>
          <h3>פרטי מנה</h3>
          <dl>
            <dt>מזהה בלתי משתנה</dt><dd>{selected.packet_id}</dd>
            <dt>טביעת אצבע</dt><dd>{selected.packet_sha256}</dd>
            <dt>גרסת מקור</dt><dd>{selected.source_version_id}</dd>
            <dt>גרסת מנתח</dt><dd>{selected.parser_version}</dd>
            <dt>גרסת נרמול</dt><dd>{selected.normalizer_version}</dd>
            <dt>עדיפות בתור</dt><dd>{selected.queue_priority}</dd>
            <dt>הוחלף על ידי</dt><dd>{selected.superseded_by_packet_id ?? "—"}</dd>
            <dt>חסימות</dt>
            <dd>{selected.blocked_reason_codes.length === 0 ? "—" : selected.blocked_reason_codes.join(", ")}</dd>
            <dt>הפעלה מותרת</dt><dd>{selected.activation_allowed ? "כן" : "לא"}</dd>
            <dt>נכנס לתור</dt><dd>{selected.enqueued_at}</dd>
            <dt>עודכן</dt><dd>{selected.updated_at}</dd>
          </dl>

          <h3>אימות כפול והעברת RuleSpec</h3>
          <p className={styles.notice}>
            לקריאה בלבד: אימות כפול והעברת RuleSpec נשארים לא מופעלים בגרסה זו ואין להם פקד הפעלה.
          </p>

          <h3>פעולת בודק</h3>
          <label htmlFor="legal-review-decision">החלטה</label>
          <select
            id="legal-review-decision"
            value={decision}
            onChange={(event) => setDecision(event.target.value)}
          >
            {DECISIONS.map((entry) => (
              <option key={entry.value} value={entry.value}>{entry.label}</option>
            ))}
          </select>

          <label htmlFor="legal-review-actor">מזהה בודק</label>
          <input id="legal-review-actor" value={actorId} onChange={(event) => setActorId(event.target.value)} />

          <label htmlFor="legal-review-signature">חתימה (sha256)</label>
          <input id="legal-review-signature" value={signature} onChange={(event) => setSignature(event.target.value)} />

          <label htmlFor="legal-review-idempotency">מפתח אידמפוטנטיות</label>
          <input
            id="legal-review-idempotency"
            value={idempotencyKey}
            onChange={(event) => setIdempotencyKey(event.target.value)}
          />

          <label htmlFor="legal-review-reason-code">קוד סיבה</label>
          <input
            id="legal-review-reason-code"
            value={reasonCode}
            onChange={(event) => setReasonCode(event.target.value)}
          />

          <label htmlFor="legal-review-reason">נימוק</label>
          <textarea id="legal-review-reason" value={reason} onChange={(event) => setReason(event.target.value)} />

          <button type="button" onClick={submitAction} disabled={busy}>שלח פעולה</button>
        </div>
      ) : null}
    </section>
  );
}
