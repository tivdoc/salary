"use client";

// L7-8 (S-8). Nested offline-shadow summary panel. Read-only: it shows what
// the durable shadow scheduler holds and what the last draft run counted —
// mode, pins, job states, refusals by reason, grades, hashes — through the
// protected /api/operations/shadow/summary endpoint. No content reaches it:
// no snapshot, no output, no delta, no trace. Nothing here activates,
// promotes or delivers anything; the projection says so on every response.

import { useState } from "react";
import styles from "./operations-workspace.module.css";

type Pin = Readonly<{
  draft_parameter_versions: number;
  synthetic_inputs: number;
  active_real_parameter_count: number;
  extraction_used: boolean;
  corpus_sha256: string;
  tenant_id: string;
}>;

type Job = Readonly<{
  run_id: string;
  state: string;
  execution_mode: string;
  envelope_sha256: string;
  result_sha256: string | null;
  updated_at: string;
}>;

type LatestRun = Readonly<{
  run_id: string;
  execution_mode: string;
  draft_input_pin: Pin;
  counts: Readonly<Record<string, number>>;
  refusals_by_reason: Readonly<Record<string, number>>;
  grades: Readonly<Record<string, number>>;
  result_sha256: string;
  traces_included: number;
  traces_replayed_from_database: number;
  decisions_compared: ReadonlyArray<Readonly<{ decision_id: string; cases_compared: number; cases_differing: number }>>;
  completed_at: string;
}>;

type Summary = Readonly<{
  scheduler_paused: boolean;
  kill_switch: Readonly<{ engaged: boolean; reason_code: string | null }>;
  jobs_by_state: Readonly<Record<string, number>>;
  jobs: readonly Job[];
  audit_chain: Readonly<{ valid: boolean; event_count: number }>;
  latest_draft_run: LatestRun | null;
  content_included: boolean;
  activation_allowed: boolean;
}>;

const MODE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  offline_synthetic_only: "סינתטי בלבד (לא-מקוון)",
  draft_parameters_synthetic_inputs: "פרמטרי טיוטה על קלט סינתטי",
});

const GRADE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  verified: "מאומת",
  lexicon: "לקסיקון",
  declared: "מוצהר",
  derived: "נגזר",
  inferred: "מוסק",
  administrative: "מנהלי",
});

const short = (sha: string | null) => (sha ? `${sha.slice(0, 16)}…` : "—");

export function ShadowSummaryPanel() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [notice, setNotice] = useState("סיכום הצל לא נטען.");
  const [busy, setBusy] = useState(false);

  async function loadSummary() {
    setBusy(true);
    try {
      const response = await fetch("/api/operations/shadow/summary", { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) {
        const problem = await response.json().catch(() => null) as { code?: string } | null;
        setSummary(null);
        setNotice(`סיכום הצל אינו זמין: ${problem?.code ?? response.status}`);
        return;
      }
      const body = await response.json() as { data?: { summary?: Summary; content_included?: boolean } };
      const next = body.data?.summary ?? null;
      setSummary(next);
      setNotice(next ? `נטען. ${next.jobs.length} ריצות במתזמן; ללא תוכן — מצב, ספירות וגיבובים בלבד.` : "התשובה ללא סיכום.");
    } catch {
      setSummary(null);
      setNotice("לא ניתן לטעון את סיכום הצל.");
    } finally {
      setBusy(false);
    }
  }

  const latest = summary?.latest_draft_run ?? null;
  return (
    <section className={styles.panel} aria-label="סיכום מצב צל">
      <h2>מצב צל לא-מקוון (Offline Shadow)</h2>
      <p className={styles.notice}>{notice}</p>
      <p className={styles.notice}>
        לקריאה בלבד. הריצה מבוצעת על פרמטרי טיוטה ועל עובדות סינתטיות בלבד; שום פלט אינו ממצא,
        שום דבר אינו מופעל ואינו נמסר. הפאנל מציג ספירות וגיבובים, לא תוכן.
      </p>
      <button type="button" onClick={loadSummary} disabled={busy}>טען סיכום צל</button>

      {summary && (
        <>
          <dl>
            <dt>מתזמן</dt>
            <dd>{summary.scheduler_paused ? "מושהה" : "פעיל"}; מתג חירום: {summary.kill_switch.engaged ? `מופעל (${summary.kill_switch.reason_code})` : "כבוי"}; שרשרת ביקורת: {summary.audit_chain.valid ? `תקינה, ${summary.audit_chain.event_count} אירועים` : "לא תקינה"}</dd>
            <dt>ריצות לפי מצב</dt>
            <dd><code dir="ltr">{Object.entries(summary.jobs_by_state).map(([state, count]) => `${state}=${count}`).join(" ") || "—"}</code></dd>
          </dl>

          {latest && (
            <>
              <h3>הריצה האחרונה — <code dir="ltr">{latest.run_id}</code></h3>
              <dl>
                <dt>מצב ריצה</dt>
                <dd>{MODE_LABELS[latest.execution_mode] ?? latest.execution_mode}</dd>
                <dt>נעיצה</dt>
                <dd>גרסאות טיוטה {latest.draft_input_pin.draft_parameter_versions}; קלטים סינתטיים {latest.draft_input_pin.synthetic_inputs}; פרמטרים פעילים {latest.draft_input_pin.active_real_parameter_count}; חילוץ בשימוש: {latest.draft_input_pin.extraction_used ? "כן" : "לא"}; דייר <code dir="ltr">{latest.draft_input_pin.tenant_id}</code>; קורפוס <code dir="ltr">{short(latest.draft_input_pin.corpus_sha256)}</code></dd>
                <dt>ספירות</dt>
                <dd><code dir="ltr">{Object.entries(latest.counts).map(([key, value]) => `${key}=${value}`).join(" ")}</code></dd>
                <dt>סירובים לפי סיבה</dt>
                <dd><code dir="ltr">{Object.entries(latest.refusals_by_reason).map(([key, value]) => `${key}=${value}`).join(" ") || "—"}</code></dd>
                <dt>דירוג מקורות</dt>
                <dd>{Object.entries(latest.grades).map(([grade, count]) => `${GRADE_LABELS[grade] ?? grade} ${count}`).join("; ") || "—"}</dd>
                <dt>עקבות</dt>
                <dd>{latest.traces_included} נשמרו, {latest.traces_replayed_from_database} שוחזרו מבסיס הנתונים</dd>
                <dt>הכרעות פתוחות</dt>
                <dd>{latest.decisions_compared.map((entry) => `${entry.decision_id.replace(/^.*decision\./u, "")}: ${entry.cases_differing}/${entry.cases_compared} שונים`).join("; ") || "—"}</dd>
                <dt>גיבוב תוצאה</dt>
                <dd><code dir="ltr">{latest.result_sha256}</code></dd>
              </dl>
            </>
          )}

          <table>
            <caption>ריצות במתזמן</caption>
            <thead>
              <tr>
                <th scope="col">ריצה</th>
                <th scope="col">מצב</th>
                <th scope="col">מצב ריצה</th>
                <th scope="col">מעטפה</th>
                <th scope="col">תוצאה</th>
                <th scope="col">עודכן</th>
              </tr>
            </thead>
            <tbody>
              {summary.jobs.map((job) => (
                <tr key={job.run_id}>
                  <td><code dir="ltr">{job.run_id}</code></td>
                  <td>{job.state}</td>
                  <td>{MODE_LABELS[job.execution_mode] ?? job.execution_mode}</td>
                  <td><code dir="ltr">{short(job.envelope_sha256)}</code></td>
                  <td><code dir="ltr">{short(job.result_sha256)}</code></td>
                  <td>{job.updated_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
