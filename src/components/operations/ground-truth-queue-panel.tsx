"use client";

// Nested Ground Truth queue panel. Read-only: it lists the durable annotation
// queue through the protected /api/operations/ground-truth/queue endpoint,
// which runs on the canonical durable Postgres adapter inside the operations
// session transaction. The projection carries identity, state, claimant and
// lease and never a payload, so nothing here can show, edit or lock ground
// truth; claims and appends stay on their own lane-scoped commands.

import { useState } from "react";
import styles from "./operations-workspace.module.css";

type QueueEntry = Readonly<{
  work_item_id: string;
  workflow_kind: string;
  aggregate_id: string;
  aggregate_version: string;
  work_kind: string;
  required_role: string;
  document_sha256: string | null;
  object_version_id: string | null;
  input_sha256: string;
  state: string;
  claimant_id: string | null;
  fencing_token: number;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
}>;

const STATE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  pending: "ממתין",
  claimed: "בטיפול",
  released: "שוחרר לתור",
  completed: "הושלם",
});

const KIND_LABELS: Readonly<Record<string, string>> = Object.freeze({
  ground_truth_visual_eligibility: "בדיקה חזותית",
  ground_truth_annotation: "סימון",
  ground_truth_adjudication: "הכרעה",
  ground_truth_lock: "נעילה",
});

export function GroundTruthQueuePanel() {
  const [rows, setRows] = useState<readonly QueueEntry[]>([]);
  const [notice, setNotice] = useState("תור הסימון לא נטען.");
  const [busy, setBusy] = useState(false);

  async function loadQueue() {
    setBusy(true);
    try {
      const response = await fetch("/api/operations/ground-truth/queue", {
        cache: "no-store", credentials: "same-origin",
      });
      if (!response.ok) {
        const problem = await response.json().catch(() => null) as { code?: string } | null;
        setRows([]);
        setNotice(`התור אינו זמין: ${problem?.code ?? response.status}`);
        return;
      }
      const body = await response.json() as { data?: { entries?: unknown; content_included?: unknown } };
      const entries = Array.isArray(body.data?.entries) ? body.data.entries as readonly QueueEntry[] : [];
      setRows(entries);
      setNotice(`נטענו ${entries.length} פריטי תור. ללא תוכן: זהות, מצב ותפיסה בלבד.`);
    } catch {
      setRows([]);
      setNotice("לא ניתן לטעון את תור הסימון.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.panel} aria-label="תור אמת-יסוד">
      <h2>תור אמת-יסוד (Ground Truth)</h2>
      <p className={styles.notice}>{notice}</p>
      <p className={styles.notice}>
        לקריאה בלבד. הפאנל אינו מציג תוכן מסמכים, אינו תופס פריטים ואינו נועל אמת-יסוד;
        כל פעולה נעשית בפקודות הנתיב שלה עם בדיקת תפקיד משלה.
      </p>
      <button type="button" onClick={loadQueue} disabled={busy}>טען תור סימון</button>

      <table>
        <caption>פריטי תור אמת-יסוד</caption>
        <thead>
          <tr>
            <th scope="col">פריט</th>
            <th scope="col">סוג</th>
            <th scope="col">מצב</th>
            <th scope="col">תפקיד נדרש</th>
            <th scope="col">מסמך (sha256)</th>
            <th scope="col">תופס</th>
            <th scope="col">פג תוקף התפיסה</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.work_item_id}>
              <td><code dir="ltr">{row.work_item_id}</code></td>
              <td>{KIND_LABELS[row.work_kind] ?? row.work_kind}</td>
              <td>{STATE_LABELS[row.state] ?? row.state}</td>
              <td><code dir="ltr">{row.required_role}</code></td>
              <td><code dir="ltr">{row.document_sha256 ? `${row.document_sha256.slice(0, 16)}…` : "—"}</code></td>
              <td>{row.claimant_id ?? "—"}</td>
              <td>{row.lease_expires_at ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
