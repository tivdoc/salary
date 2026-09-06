"use client";

// Site S6.1/S6.2/S6.3. The report review queue and M01's eight numbers.
//
// What the operator can do here is deliberately narrow: read why a report is
// waiting, write a sentence about a finding, and approve, publish or reject.
// There is no field for a number, and that is not a UI decision — the row this
// panel writes to has no numeric column, so a figure has nowhere to go even if
// someone built a control for one. The engine is the only thing that moves a
// number, by writing a new projection.
//
// M01 shows a dash rather than a percentage when a number has no denominator.
// The board is read to decide whether the product works, and 0% and "nothing
// has happened yet" are opposite answers.

import { useState } from "react";
import styles from "./operations-workspace.module.css";
import { AUTOMATIC_FINDING_CEILING_MINOR_UNITS } from "@/server/product/reports/publication-gate";

type QueueRow = Readonly<{
  id: string;
  case_id: string;
  report_kind: "initial" | "full";
  document_track: "automatic" | "human";
  state: string;
  queue_reasons: readonly string[];
  wording: Readonly<Record<string, string>>;
  queued_at: string;
  published_at: string | null;
}>;

type Ratio = Readonly<{ numerator: number; denominator: number; rate: number | null; available: boolean }>;

type Board = Readonly<{
  steps: Readonly<Record<string, Ratio>>;
  automatic_track: Ratio;
  review_minutes_per_case: number | null;
  source: Readonly<{ events_counted: number; reports_counted: number; generated_at: string }>;
}>;

const REASON_TEXT: Readonly<Record<string, string>> = Object.freeze({
  full_report: "דוח מלא — תמיד אנושי (D-10.3)",
  document_not_automatic_track: "המסמך לא במסלול האוטומטי",
  finding_at_low_certainty: "ממצא בוודאות נמוכה",
  contradiction_marked: "סימון סתירה",
  // The ceiling is D-10.2's, read from the gate rather than retyped here.
  finding_over_ceiling: `ממצא מעל ${(AUTOMATIC_FINDING_CEILING_MINOR_UNITS / 100).toLocaleString("he-IL")} ₪`,
});

const STEP_TEXT: Readonly<Record<string, string>> = Object.freeze({
  landing_to_start: "כניסה ← התחלה",
  start_to_case: "התחלה ← תיק",
  case_to_upload: "תיק ← תלוש",
  upload_to_payment: "תלוש ← תשלום",
  payment_to_finding: "תשלום ← S04",
  finding_to_full_report: "S04 ← דוח מלא",
});

const STATE_TEXT: Readonly<Record<string, string>> = Object.freeze({
  queued: "ממתין לבקרה",
  recheck_required: "נדרשת בדיקה חוזרת",
  approved: "אושר",
  published: "פורסם",
  rejected: "נדחה",
});

function rateText(value: Ratio | undefined): string {
  if (!value || !value.available || value.rate === null) return "—";
  return `${Math.round(value.rate * 1000) / 10}%`;
}

function reasonText(code: string): string {
  return REASON_TEXT[code] ?? (code.startsWith("parameter_changed:") ? `פרמטר השתנה: ${code.slice("parameter_changed:".length)}` : code);
}

export function ReportQaPanel({ csrfToken }: { csrfToken: string }) {
  const [queue, setQueue] = useState<readonly QueueRow[]>([]);
  const [board, setBoard] = useState<Board | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [topic, setTopic] = useState("minimum_wage");
  const [sentence, setSentence] = useState("");
  const [notice, setNotice] = useState("תור הבקרה לא נטען.");
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    try {
      const [queueResponse, boardResponse] = await Promise.all([
        fetch("/api/operations/report-qa/queue", { cache: "no-store", credentials: "same-origin" }),
        fetch("/api/operations/report-qa/board", { cache: "no-store", credentials: "same-origin" }),
      ]);
      if (!queueResponse.ok || !boardResponse.ok) throw new Error("report_qa_unavailable");
      const queueBody = await queueResponse.json() as { data?: { items?: QueueRow[] } };
      const boardBody = await boardResponse.json() as { data?: Board };
      setQueue(queueBody.data?.items ?? []);
      setBoard(boardBody.data ?? null);
      setNotice(`בתור: ${queueBody.data?.items?.length ?? 0} דוחות.`);
    } catch {
      setQueue([]);
      setBoard(null);
      setNotice("לא ניתן לטעון את תור הבקרה.");
    } finally {
      setBusy(false);
    }
  }

  async function post(path: string, body: Record<string, unknown>) {
    return fetch(`/api/operations/report-qa/${path}`, {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-tivdoc-csrf": csrfToken },
      body: JSON.stringify(body),
    });
  }

  async function saveWording() {
    if (!selected) return;
    setBusy(true);
    try {
      const response = await post("wording", { qa_id: selected, wording: { [topic]: sentence } });
      const parsed = await response.json().catch(() => null) as { data?: { refusals?: ReadonlyArray<{ topic: string; code: string }> } } | null;
      const refusals = parsed?.data?.refusals ?? [];
      if (refusals.length > 0) {
        setNotice(refusals.map((refusal) => `${refusal.topic}: ${refusal.code === "carries_a_figure" ? "הניסוח מכיל סכום — מספר משתנה רק דרך המנוע" : refusal.code}`).join("; "));
        return;
      }
      if (!response.ok) throw new Error("wording_failed");
      setNotice("הניסוח נשמר ונרשם בלוג.");
      setSentence("");
      await load();
    } catch {
      setNotice("שמירת הניסוח נכשלה.");
    } finally {
      setBusy(false);
    }
  }

  async function decide(state: "approved" | "published" | "rejected") {
    if (!selected) return;
    setBusy(true);
    try {
      const response = await post("decide", { qa_id: selected, state });
      if (!response.ok) throw new Error("decision_failed");
      setNotice(state === "published" ? "הדוח פורסם וההודעה נשלחה לערוץ שאומת." : `הדוח סומן: ${STATE_TEXT[state]}.`);
      setSelected(null);
      await load();
    } catch {
      setNotice("הפעולה נכשלה.");
    } finally {
      setBusy(false);
    }
  }

  const current = queue.find((row) => row.id === selected) ?? null;

  return (
    <section className={styles.panel} aria-label="תור בקרת דוחות">
      <h2>בקרת דוחות ולוח משפך</h2>
      <p className={styles.notice}>{notice}</p>
      <p className={styles.notice}>
        המפעיל עורך ניסוח בלבד. מספר משתנה רק כשהמנוע כותב חוזה חדש — אין כאן שדה שמספר יכול לעבור בו.
        כל פעולה נרשמת בלוג עם זהות המפעיל.
      </p>
      <button type="button" onClick={load} disabled={busy}>טען תור ולוח</button>

      {board && (
        <dl>
          <dt>שמונת המספרים (D-11)</dt>
          <dd>
            <code dir="ltr">
              {Object.keys(STEP_TEXT).map((step) => `${STEP_TEXT[step]}=${rateText(board.steps[step])}`).join(" · ")}
            </code>
          </dd>
          <dt>מסלול אוטומטי</dt>
          <dd>
            {rateText(board.automatic_track)}
            {board.automatic_track.available ? ` (${board.automatic_track.numerator}/${board.automatic_track.denominator})` : " — אין עדיין דוחות"}
          </dd>
          <dt>דקות בקרה לתיק</dt>
          <dd>{board.review_minutes_per_case === null ? "—" : board.review_minutes_per_case}</dd>
        </dl>
      )}

      {queue.length > 0 && (
        <ul>
          {queue.map((row) => (
            <li key={row.id}>
              <button type="button" onClick={() => setSelected(row.id)} disabled={busy}>
                {row.report_kind === "full" ? "דוח מלא" : "דוח ראשוני"} · {STATE_TEXT[row.state] ?? row.state} · מסלול {row.document_track === "automatic" ? "אוטומטי" : "אנושי"}
              </button>
              <span> {row.queue_reasons.map(reasonText).join("; ")}</span>
            </li>
          ))}
        </ul>
      )}

      {current && (
        <div>
          <h3>ניסוח לתיק שנבחר</h3>
          <label>
            נושא
            <select value={topic} onChange={(event) => setTopic(event.target.value)}>
              {["minimum_wage", "working_time", "pension", "travel", "convalescence", "vacation", "sick_leave"].map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </label>
          <label>
            ניסוח הממצא (בלי סכומים)
            <textarea value={sentence} onChange={(event) => setSentence(event.target.value)} rows={3} />
          </label>
          <button type="button" onClick={saveWording} disabled={busy || sentence.trim().length < 4}>שמור ניסוח</button>
          <button type="button" onClick={() => decide("approved")} disabled={busy}>אשר</button>
          <button type="button" onClick={() => decide("published")} disabled={busy}>פרסם</button>
          <button type="button" onClick={() => decide("rejected")} disabled={busy}>דחה</button>
        </div>
      )}
    </section>
  );
}
