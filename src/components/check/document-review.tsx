"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FileArrowUp, FilePdf, X } from "@phosphor-icons/react/dist/ssr";
import { trackEvent } from "@/lib/analytics";
import { customerErrorFromResponse, customerErrorMessage } from "@/lib/customer-copy";
import { countPdfPages, measureImage, type ReadabilityReport } from "@/lib/document-readability";
import {
  lastCompleteMonth,
  MAX_PAYSLIPS,
  slotForDocumentType,
  validateUploadDescriptor,
  type DocumentType,
} from "@/lib/validation";

// Site S2 (S2.1, S2.2, S2.5). The screen that stands between choosing a file
// and paying for it. Every refund this wave exists to prevent starts with a
// document nobody looked at until after the money moved, so: a preview, a page
// count, a readability verdict, a named month, replace, delete — and only then
// the payment.

type Chosen = {
  id: string;
  documentType: DocumentType;
  slot: string;
  file: File;
  previewUrl: string;
  pages: number | null;
  readability: ReadabilityReport | null;
  periodMonth: string;
  status: "ready" | "uploading" | "uploaded" | "failed";
  sent: number;
  error: string | null;
};

function formatSize(size: number) {
  return size < 1024 * 1024 ? `${Math.round(size / 1024)}KB` : `${(size / 1024 / 1024).toFixed(1)}MB`;
}

function monthLabel(month: string) {
  const [year, index] = month.split("-");
  const names = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];
  return `${names[Number(index) - 1] ?? month} ${year}`;
}

/** The last twelve complete months, newest first — what a payslip can plausibly cover. */
function recentMonths(): string[] {
  const now = new Date();
  return Array.from({ length: MAX_PAYSLIPS }, (_, index) => {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1 - index, 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  });
}

export function DocumentReview() {
  const router = useRouter();
  const months = useMemo(() => recentMonths(), []);
  const [chosen, setChosen] = useState<Chosen[]>([]);
  const [checkMonth, setCheckMonth] = useState<string>(() => lastCompleteMonth());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const chosenRef = useRef<Chosen[]>([]);
  // The ref mirrors state for the async paths (the transfer loop and the unmount cleanup) that must
  // see the latest list without re-subscribing. Written in an effect, never during render.
  useEffect(() => { chosenRef.current = chosen; }, [chosen]);

  // Object URLs are a resource: released when the component goes away, and when a file is removed.
  useEffect(() => () => {
    for (const item of chosenRef.current) URL.revokeObjectURL(item.previewUrl);
    abortRef.current?.abort();
  }, []);

  const payslips = chosen.filter((item) => item.documentType === "payslip");

  // S4 (2.8). The check month is chosen from the months the payslips cover, so
  // changing a payslip's month could leave the stored choice pointing at a
  // month no longer on offer: the select fell back to nothing and the person
  // only learned at submit that the two disagreed.
  //
  // Derived rather than corrected. The stored value is the person's preference;
  // what the screen shows and what is submitted is that preference when it is
  // still available and the newest month otherwise, so the two can never be out
  // of step and the submit-time error is unreachable.
  const availableMonths = [...new Set(payslips.map((item) => item.periodMonth))].sort().reverse();
  const effectiveCheckMonth = availableMonths.includes(checkMonth) ? checkMonth : (availableMonths[0] ?? checkMonth);

  const add = useCallback(async (documentType: DocumentType, file: File | undefined) => {
    if (!file) return;
    const problem = validateUploadDescriptor(file);
    if (problem) {
      setError(`${file.name}: ${problem}`);
      trackEvent("upload_error", { reason: problem });
      return;
    }
    setError("");
    const current = chosenRef.current;
    if (documentType === "payslip" && current.filter((item) => item.documentType === "payslip").length >= MAX_PAYSLIPS) {
      setError(`אפשר לצרף עד ${MAX_PAYSLIPS} תלושים.`);
      return;
    }
    // A payslip takes the first free slot; a contract or an attendance report replaces its own.
    const used = new Set(current.map((item) => item.slot));
    const slot = documentType === "payslip"
      ? Array.from({ length: MAX_PAYSLIPS }, (_, index) => slotForDocumentType("payslip", index)).find((candidate) => !used.has(candidate))!
      : documentType;
    const existing = current.find((item) => item.slot === slot);
    if (existing) URL.revokeObjectURL(existing.previewUrl);

    const [pages, readability] = await Promise.all([countPdfPages(file), measureImage(file)]);
    const entry: Chosen = {
      id: `${slot}:${Date.now()}`,
      documentType,
      slot,
      file,
      previewUrl: URL.createObjectURL(file),
      pages,
      readability,
      periodMonth: months[Math.min(current.filter((item) => item.documentType === "payslip").length, months.length - 1)]!,
      status: "ready",
      sent: 0,
      error: null,
    };
    setChosen((items) => [...items.filter((item) => item.slot !== slot), entry]);
  }, [months]);

  function remove(id: string) {
    setChosen((items) => {
      const going = items.find((item) => item.id === id);
      if (going) URL.revokeObjectURL(going.previewUrl);
      return items.filter((item) => item.id !== id);
    });
  }

  function setMonth(id: string, month: string) {
    setChosen((items) => items.map((item) => (item.id === id ? { ...item, periodMonth: month } : item)));
  }

  function cancel() {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    setChosen((items) => items.map((item) => (item.status === "uploading" ? { ...item, status: "ready", sent: 0 } : item)));
  }

  /**
   * The transfer, per file, with real byte progress and a working cancel.
   * XMLHttpRequest rather than fetch: it is still the only way to observe bytes
   * leaving the browser, which is what S2.5 asks for.
   */
  function putFile(url: string, item: Chosen, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open("PUT", url, true);
      request.setRequestHeader("content-type", item.file.type);
      request.setRequestHeader("x-upsert", "true");
      request.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        setChosen((items) => items.map((row) => (row.id === item.id ? { ...row, sent: event.loaded } : row)));
      };
      request.onload = () => (request.status >= 200 && request.status < 300 ? resolve() : reject(new Error(`upload_${request.status}`)));
      request.onerror = () => reject(new Error("upload_network"));
      request.onabort = () => reject(new DOMException("aborted", "AbortError"));
      signal.addEventListener("abort", () => request.abort(), { once: true });
      request.send(item.file);
    });
  }

  async function submit() {
    if (payslips.length === 0) {
      setError("צריך לצרף לפחות תלוש שכר אחד.");
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError("");
    const manifest = {
      files: chosen.map((item) => ({
        documentType: item.documentType,
        slot: item.slot,
        name: item.file.name,
        type: item.file.type,
        size: item.file.size,
        ...(item.documentType === "payslip" ? { periodMonth: item.periodMonth } : {}),
      })),
      checkPeriodMonth: effectiveCheckMonth,
    };

    try {
      const signResponse = await fetch("/api/documents/sign", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(manifest), signal: controller.signal,
      });
      if (!signResponse.ok) throw new Error(await customerErrorFromResponse(signResponse, "upload_prepare_failed"));
      const signed = (await signResponse.json()) as { uploads: Array<{ slot: string; signedUrl?: string; path: string; token: string }> };

      for (const upload of signed.uploads) {
        const item = chosenRef.current.find((row) => row.slot === upload.slot);
        if (!item) throw new Error(customerErrorMessage({}, "upload_transfer_failed"));
        setChosen((items) => items.map((row) => (row.id === item.id ? { ...row, status: "uploading", sent: 0, error: null } : row)));
        const url = upload.signedUrl ?? `${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""}/storage/v1/object/upload/sign/salary-documents/${upload.path}?token=${upload.token}`;
        try {
          await putFile(url, item, controller.signal);
          setChosen((items) => items.map((row) => (row.id === item.id ? { ...row, status: "uploaded", sent: row.file.size } : row)));
        } catch (caught) {
          if (caught instanceof DOMException && caught.name === "AbortError") return;
          setChosen((items) => items.map((row) => (row.id === item.id ? { ...row, status: "failed", error: customerErrorMessage({}, "upload_transfer_failed") } : row)));
          throw new Error(customerErrorMessage({}, "upload_transfer_failed"));
        }
      }

      const completeResponse = await fetch("/api/documents/complete", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(manifest), signal: controller.signal,
      });
      if (!completeResponse.ok) throw new Error(await customerErrorFromResponse(completeResponse, "upload_complete_failed"));
      trackEvent("payslip_uploaded", { document_count: chosen.length });
      router.push("/check/payment");
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      const message = customerErrorMessage({ error: caught instanceof Error ? caught.message : null }, "upload_transfer_failed");
      setError(message);
      setBusy(false);
      trackEvent("upload_error", { reason: message });
    }
  }

  return (
    <div className="upload-form document-review">
      <div className="check-page-heading">
        <span className="mono">מסמכים</span>
        <h1>נראה שהתלוש קריא — לפני שמשלמים.</h1>
        <p>אפשר לצרף עד {MAX_PAYSLIPS} תלושים. הבדיקה הראשונית רצה על חודש אחד שתבחר; הדוח המלא מכסה את כולם.</p>
      </div>

      <div className="document-review__pickers">
        <label className="button button--ghost">
          <FileArrowUp aria-hidden="true" /> הוספת תלוש
          <input type="file" accept="application/pdf,image/jpeg,image/png" onChange={(event) => { void add("payslip", event.target.files?.[0]); event.target.value = ""; }} />
        </label>
        <label className="button button--ghost">
          חוזה עבודה
          <input type="file" accept="application/pdf,image/jpeg,image/png" onChange={(event) => { void add("contract", event.target.files?.[0]); event.target.value = ""; }} />
        </label>
        <label className="button button--ghost">
          דוח נוכחות
          <input type="file" accept="application/pdf,image/jpeg,image/png" onChange={(event) => { void add("attendance", event.target.files?.[0]); event.target.value = ""; }} />
        </label>
      </div>

      <ul className="document-review__list">
        {chosen.map((item) => (
          <li className={`document-card document-card--${item.status}`} key={item.id}>
            <div className="document-card__preview">
              {item.file.type === "application/pdf"
                ? <span className="document-card__icon"><FilePdf weight="duotone" aria-hidden="true" /></span>
                /* eslint-disable-next-line @next/next/no-img-element -- a local object URL, never a remote asset */
                : <img src={item.previewUrl} alt={`תצוגה מקדימה של ${item.file.name}`} />}
            </div>
            <div className="document-card__body">
              <p className="document-card__name">{item.file.name}</p>
              <p className="document-card__meta">
                {item.documentType === "payslip" ? "תלוש" : item.documentType === "contract" ? "חוזה" : "נוכחות"} · {formatSize(item.file.size)}
                {item.pages === null ? "" : ` · ${item.pages} עמודים`}
                {item.readability?.width ? ` · ${item.readability.width}×${item.readability.height}` : ""}
              </p>
              {item.readability?.message ? <p className="document-card__warn" role="status">{item.readability.message}</p> : null}
              {item.documentType === "payslip" ? (
                <label className="document-card__month">
                  חודש התלוש
                  <select value={item.periodMonth} onChange={(event) => setMonth(item.id, event.target.value)} disabled={busy}>
                    {months.map((month) => <option key={month} value={month}>{monthLabel(month)}</option>)}
                  </select>
                </label>
              ) : null}
              {item.status === "uploading" ? (
                <p className="document-card__progress" role="status">
                  נשלח {formatSize(item.sent)} מתוך {formatSize(item.file.size)}
                </p>
              ) : null}
              {item.status === "uploaded" ? <p className="document-card__done" role="status">נשלח</p> : null}
              {item.error ? <p className="form-error" role="alert">{item.error}</p> : null}
            </div>
            <button type="button" className="document-card__remove" aria-label={`הסרת ${item.file.name}`} onClick={() => remove(item.id)} disabled={busy}>
              <X aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>

      {payslips.length > 0 ? (
        <label className="document-review__check-month">
          חודש הבדיקה הראשונית
          <select value={effectiveCheckMonth} onChange={(event) => setCheckMonth(event.target.value)} disabled={busy}>
            {availableMonths.map((month) => (
              <option key={month} value={month}>{monthLabel(month)}</option>
            ))}
          </select>
          <span>הדוח המלא מכסה את כל החודשים שצירפת.</span>
        </label>
      ) : null}

      <p className="upload-limit">PDF, JPG או PNG. עד 10MB לקובץ ועד 25MB יחד.</p>
      {error ? <div className="form-error" role="alert">{error}</div> : null}
      <div className="document-review__actions">
        <button className="button button--primary button--wide" type="button" disabled={busy || payslips.length === 0} onClick={() => void submit()}>
          {busy ? "מעלים…" : "אישור ומעבר לתשלום"}
        </button>
        {busy ? <button className="button button--ghost" type="button" onClick={cancel}>ביטול</button> : null}
      </div>
    </div>
  );
}
