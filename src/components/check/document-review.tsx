"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FileArrowUp, FilePdf, X } from "@phosphor-icons/react/dist/ssr";
import { trackEvent } from "@/lib/analytics";
import { countPdfPages, measureImage, type ReadabilityReport } from "@/lib/document-readability";
import { lastCompleteMonth, MAX_PAYSLIPS, validateUploadDescriptor, type DocumentType } from "@/lib/validation";
import { uploadNextPath, type DocumentUpload, type SavedDocument, type UploadSnapshot } from "@/lib/document-upload";
import { transferDocuments } from "./document-transfer";
import { documentCapacity, uploadMonthOptions } from "@/lib/document-capacity";
import "./document-review.css";

type Chosen = {
  id: string; documentType: DocumentType; file: File; previewUrl: string;
  pages: number | null; readability: ReadabilityReport | null; periodMonth: string;
  replace?: { documentId: string; versionId: string };
  sent: number;
};
const labels = { payslip: "תלוש", contract: "חוזה", attendance: "דוח נוכחות" };
function formatSize(size: number) {
  return size < 1024 * 1024 ? `${Math.round(size / 1024)}KB` : `${(size / 1024 / 1024).toFixed(1)}MB`;
}
function monthLabel(month: string) {
  return new Intl.DateTimeFormat("he-IL", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`));
}
function recentMonths(): string[] {
  const now = new Date();
  return Array.from({ length: MAX_PAYSLIPS }, (_, i) => {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1 - i, 1));
    return date.toISOString().slice(0, 7);
  });
}
async function post(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "ההעלאה לא הושלמה. אפשר לנסות שוב.");
  return data;
}

export function DocumentReview({ initial, initialRequestId }: { initial: UploadSnapshot; initialRequestId?: string }) {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState(initial);
  const [chosen, setChosen] = useState<Chosen[]>([]);
  const [checkMonth, setCheckMonth] = useState(initial.checkPeriodMonth ?? lastCompleteMonth());
  const [requestId, setRequestId] = useState(initialRequestId ?? (initial.documents.some((doc) => doc.document_type === "payslip")
    ? "" : initial.requests.find((request) => request.code === "document_missing")?.id ?? ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [batchId, setBatchId] = useState<string | null>(null);
  const [recoveryReady, setRecoveryReady] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const chosenRef = useRef<Chosen[]>([]);
  const manifestRef = useRef<DocumentUpload | null>(null);
  const workingRef = useRef(false);
  const storageKey = `tivdoc:document-upload:v1:${initial.caseId}`;
  const recent = useMemo(() => recentMonths(), []);
  const capacity = documentCapacity(snapshot.capacity);
  const months = uploadMonthOptions(capacity, recent, snapshot.documents.map(doc => doc.period_month));
  useEffect(() => {
    // Only an opaque batch id is persisted; no files, names or signed URLs.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate external tab storage after SSR; initial HTML must be identical on server and client.
    try { setBatchId(sessionStorage.getItem(storageKey)); } catch { /* memory-only retry still works */ }
    setRecoveryReady(true);
    return () => {
      abortRef.current?.abort();
      for (const item of chosenRef.current) URL.revokeObjectURL(item.previewUrl);
    };
  }, [storageKey]);
  function updateChosen(items: Chosen[]) { chosenRef.current = items; setChosen(items); }
  function remember(id: string | null) {
    setBatchId(id);
    try { if (id) sessionStorage.setItem(storageKey, id); else sessionStorage.removeItem(storageKey); } catch { /* optional recovery cache */ }
  }
  const replaced = new Set(chosen.flatMap((item) => item.replace ? [item.replace.documentId] : []));
  const kept = snapshot.documents.filter((doc) => !replaced.has(doc.id));
  const payslips = [...kept.filter((doc) => doc.document_type === "payslip").map((doc) => doc.period_month),
    ...chosen.filter((doc) => doc.documentType === "payslip").map((doc) => doc.periodMonth)];
  const availableMonths = [...new Set(payslips.filter((month): month is string => Boolean(month)))].sort().reverse();
  const paid = uploadNextPath(snapshot) !== "/check/payment";
  const effectiveCheckMonth = availableMonths.includes(checkMonth) ? checkMonth : availableMonths[0];
  const locked = busy || batchId !== null || !recoveryReady;

  async function add(documentType: DocumentType, file?: File, replace?: SavedDocument) {
    if (!file || workingRef.current || batchId) return;
    const problem = validateUploadDescriptor(file);
    if (problem) { setError(problem); return; }
    const current = chosenRef.current;
    const count = snapshot.documents.filter((doc) => doc.document_type === documentType).length
      + current.filter((doc) => doc.documentType === documentType && !doc.replace).length;
    if (!replace && count >= (documentType === "payslip" ? capacity.maxPayslips : 1)) {
      setError("אין מקום למסמך נוסף מסוג זה. להחלפה, יש לבחור במסמך השמור."); return;
    }
    const pending = current.filter(item => !replace || item.replace?.documentId !== replace.id);
    if (pending.length >= capacity.maxBatchFiles || pending.reduce((sum, item) => sum + item.file.size, file.size) > capacity.maxBatchBytes) {
      setError("הבחירה הגיעה למגבלת העלאה אחת. יש לשמור את הקבצים שנבחרו, ואז לצרף את הבאים."); return;
    }
    workingRef.current = true; setBusy(true); setError("");
    try {
      const [pages, readability] = await Promise.all([countPdfPages(file), measureImage(file)]);
      const prior = replace ? current.find((item) => item.replace?.documentId === replace.id) : undefined;
      if (prior) URL.revokeObjectURL(prior.previewUrl);
      updateChosen([...current.filter((item) => item !== prior), {
        id: crypto.randomUUID(), documentType, file, pages, readability, previewUrl: URL.createObjectURL(file),
        periodMonth: replace?.period_month ?? months[0]!, sent: 0,
        ...(replace ? { replace: { documentId: replace.id, versionId: replace.version_id } } : {}),
      }]);
    } catch { setError("לא הצלחנו לקרוא את הקובץ. אפשר לבחור אותו שוב."); }
    finally { workingRef.current = false; setBusy(false); }
  }
  function remove(id: string) {
    const item = chosenRef.current.find((doc) => doc.id === id);
    if (item) URL.revokeObjectURL(item.previewUrl);
    updateChosen(chosenRef.current.filter((doc) => doc.id !== id));
  }
  function putFile(url: string, file: File, clientId: string, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new DOMException("aborted", "AbortError")); return; }
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", url, true);
      xhr.setRequestHeader("content-type", file.type);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) updateChosen(chosenRef.current.map((row) => row.id === clientId ? { ...row, sent: event.loaded } : row));
      };
      const abort = () => xhr.abort();
      const finish = (problem?: Error) => { signal.removeEventListener("abort", abort); if (problem) reject(problem); else resolve(); };
      xhr.onload = () => finish(xhr.status >= 200 && xhr.status < 300 ? undefined : new Error("השליחה לא הושלמה. אפשר לנסות שוב."));
      xhr.onerror = () => finish(new Error("החיבור נקטע. אפשר לנסות שוב."));
      xhr.onabort = () => finish(new DOMException("aborted", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      xhr.send(file);
    });
  }
  function accept(result: UploadSnapshot) {
    setSnapshot(result); setRequestId(""); manifestRef.current = null; remember(null);
    for (const item of chosenRef.current) URL.revokeObjectURL(item.previewUrl);
    updateChosen([]);
  }
  async function submit() {
    if (workingRef.current) return;
    if (!batchId && chosen.length === 0) { router.push(uploadNextPath(snapshot)); return; }
    workingRef.current = true; setBusy(true); setError("");
    const controller = new AbortController(); abortRef.current = controller;
    try {
      let result: UploadSnapshot;
      if (batchId && !manifestRef.current) {
        // A reload has no File objects. Finish the exact prior batch, or offer explicit cancellation.
        result = await post("/api/documents/complete", { caseId: snapshot.caseId, batchId }, controller.signal) as UploadSnapshot;
      } else {
        if (!manifestRef.current) {
          const id = crypto.randomUUID();
          const files = await Promise.all(chosenRef.current.map(async (item) => ({
            clientId: item.id, documentType: item.documentType, name: item.file.name, type: item.file.type as DocumentUpload["files"][number]["type"], size: item.file.size,
            sha256: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await item.file.arrayBuffer())), (byte) => byte.toString(16).padStart(2, "0")).join(""),
            ...(item.documentType === "payslip" ? { periodMonth: item.periodMonth } : {}),
            ...(item.replace ? { replace: item.replace } : {}),
          })));
          manifestRef.current = { caseId: snapshot.caseId, batchId: id, files,
            ...(!paid && effectiveCheckMonth ? { checkPeriodMonth: effectiveCheckMonth } : {}),
            ...(requestId ? { requestId } : {}),
          };
          remember(id);
        }
        result = await transferDocuments({ manifest: manifestRef.current, files: new Map(chosenRef.current.map((item) => [item.id, item.file])), signal: controller.signal, post, put: putFile }) as UploadSnapshot;
      }
      accept(result);
      trackEvent("payslip_uploaded", { document_count: result.documents.length });
      router.push(uploadNextPath(result)); router.refresh();
    } catch (caught) {
      if (!(caught instanceof DOMException && caught.name === "AbortError")) setError(caught instanceof Error ? caught.message : "ההעלאה לא הושלמה. אפשר לנסות שוב.");
    } finally { workingRef.current = false; setBusy(false); abortRef.current = null; }
  }
  async function cancelAttempt() {
    if (!batchId || workingRef.current) return;
    workingRef.current = true; setBusy(true); setError("");
    try {
      const result = await post("/api/documents/complete", { caseId: snapshot.caseId, batchId, action: "cancel" }) as UploadSnapshot;
      accept(result); router.refresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "הביטול לא הושלם. אפשר לנסות שוב."); }
    finally { workingRef.current = false; setBusy(false); }
  }

  return (
    <div className="upload-form document-review">
      <div className="check-page-heading">
        <span className="mono">מסמכים</span>
        <h1>{paid ? "השלמת מסמכים לתיק" : "נראה שהתלוש קריא — לפני שמשלמים."}</h1>
        <p>אפשר לשמור עד {capacity.maxPayslips} תלושים בתיק. הבדיקה הראשונית מתייחסת לחודש אחד; היקף הדוח המלא נקבע בהזמנה ששולמה.</p>
      </div>
      {snapshot.documents.length > 0 ? <section aria-label="מסמכים שמורים">
        <h2>המסמכים השמורים בתיק</h2>
        <ul className="document-review__list">{snapshot.documents.map((doc) => <li className="document-card" key={doc.id}>
          <FilePdf aria-hidden="true" />
          <div className="document-card__body">
            <p className="document-card__name">{doc.original_filename}</p>
            <p>{labels[doc.document_type]} · {formatSize(doc.size)}{doc.period_month ? ` · ${monthLabel(doc.period_month)}` : ""}</p>
            <p role="status">{replaced.has(doc.id) ? "נבחר קובץ להחלפה. המסמך השמור נשאר עד לסיום." : "שמור בתיק"}</p>
          </div>
          <label className="button button--ghost">החלפת מסמך
            <input type="file" aria-label={`החלפת ${doc.original_filename}`} accept="application/pdf,image/jpeg,image/png" disabled={locked}
              onChange={(event) => { void add(doc.document_type, event.target.files?.[0], doc); event.target.value = ""; }} />
          </label>
        </li>)}</ul>
      </section> : null}
      <div className="document-review__pickers">
        {(["payslip", "contract", "attendance"] as const).map((type) => {
          const count = snapshot.documents.filter((doc) => doc.document_type === type).length + chosen.filter((doc) => doc.documentType === type && !doc.replace).length;
          return <label className="button button--ghost" key={type}>
            <FileArrowUp aria-hidden="true" /> הוספת {labels[type]}
            <input type="file" aria-label={`הוספת ${labels[type]}`} accept="application/pdf,image/jpeg,image/png" disabled={locked || count >= (type === "payslip" ? capacity.maxPayslips : 1)}
              onChange={(event) => { void add(type, event.target.files?.[0]); event.target.value = ""; }} />
          </label>;
        })}
      </div>
      <ul className="document-review__list">{chosen.map((item) => <li className="document-card" key={item.id}>
        <div className="document-card__preview">{item.file.type === "application/pdf" ? <FilePdf aria-hidden="true" />
          // eslint-disable-next-line @next/next/no-img-element -- local object URL
          : <img src={item.previewUrl} alt={`תצוגה מקדימה של ${item.file.name}`} />}</div>
        <div className="document-card__body">
          <p className="document-card__name">{item.file.name}</p>
          <p>{item.replace ? "החלפה ממתינה" : "מסמך חדש"} · {formatSize(item.file.size)}{item.pages === null ? "" : ` · ${item.pages} עמודים`}</p>
          {item.readability?.message ? <p role="status">{item.readability.message}</p> : null}
          {item.documentType === "payslip" ? <label>חודש התלוש
            <select value={item.periodMonth} disabled={locked} onChange={(event) => updateChosen(chosenRef.current.map((row) => row.id === item.id ? { ...row, periodMonth: event.target.value } : row))}>
              {[...new Set([item.periodMonth, ...months])].sort().reverse().map((month) => <option key={month} value={month}>{monthLabel(month)}</option>)}
            </select>
          </label> : null}
          {item.sent > 0 ? <p role="status">נשלח {formatSize(item.sent)} מתוך {formatSize(item.file.size)} · ממתין לשמירה בתיק</p> : null}
        </div>
        <button type="button" className="document-card__remove" aria-label={`הסרת ${item.file.name} מהבחירה`} disabled={locked} onClick={() => remove(item.id)}><X aria-hidden="true" /></button>
      </li>)}</ul>
      {!paid && availableMonths.length > 0 ? <label className="document-review__check-month">חודש הבדיקה הראשונית
        <select value={effectiveCheckMonth} disabled={locked || chosen.length === 0} onChange={(event) => setCheckMonth(event.target.value)}>
          {availableMonths.map((month) => <option key={month} value={month}>{monthLabel(month)}</option>)}
        </select><span>היקף הדוח המלא נקבע בנפרד, לפי התקופה שבהזמנה.</span>
      </label> : null}
      {snapshot.requests.length > 0 ? <label>בקשת ההשלמה שהמסמך עונה עליה
        <select value={requestId} disabled={locked} onChange={(event) => setRequestId(event.target.value)}>
          <option value="">צירוף מסמך ללא מענה לבקשה</option>
          {snapshot.requests.map((request) => <option key={request.id} value={request.id}>{request.question}</option>)}
        </select>
      </label> : null}
      <p className="upload-limit">PDF, JPG או PNG. עד 10MB לקובץ, עד 25MB בהעלאה אחת ועד {formatSize(capacity.maxCaseBytes)} בתיק.</p>
      {batchId ? <p role="status">יש ניסיון העלאה שטרם אישרנו את סיומו. המסמכים השמורים נשמרו. אפשר לנסות להשלים אותו או לבטל את הניסיון.</p> : null}
      {error ? <div className="form-error" role="alert">{error}</div> : null}
      <div className="document-review__actions">
        <button className="button button--primary button--wide" type="button" disabled={busy || !recoveryReady || (payslips.length === 0 && !batchId)} onClick={() => void submit()}>
          {busy ? "מעלים…" : batchId ? "ניסיון נוסף להשלמת ההעלאה" : paid ? "שמירה וחזרה לתיק" : "אישור ומעבר לתשלום"}
        </button>
        {busy ? <button className="button button--ghost" type="button" onClick={() => abortRef.current?.abort()}>עצירת השליחה</button> : null}
        {batchId && !busy ? <button className="button button--ghost" type="button" onClick={() => void cancelAttempt()}>ביטול ניסיון ההעלאה</button> : null}
      </div>
    </div>
  );
}
