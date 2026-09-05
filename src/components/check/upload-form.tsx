"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FileArrowUp, FilePdf, Image as ImageIcon, X } from "@phosphor-icons/react";
import { trackEvent } from "@/lib/analytics";
import { customerErrorFromResponse, customerErrorMessage } from "@/lib/customer-copy";
import { getSupabaseBrowser } from "@/lib/supabase-browser";
import { validateUploadDescriptor } from "@/lib/validation";

type FileKey = "payslip" | "contract" | "attendance";
const fileConfig: Array<{ key: FileKey; title: string; note: string; required?: boolean }> = [
  { key: "payslip", title: "תלוש שכר", note: "PDF או צילום ברור", required: true },
  { key: "contract", title: "חוזה עבודה", note: "אופציונלי, משפר את הבדיקה" },
  { key: "attendance", title: "דוח נוכחות", note: "אופציונלי" },
];

function formatSize(size: number) {
  return size < 1024 * 1024 ? `${Math.round(size / 1024)}KB` : `${(size / 1024 / 1024).toFixed(1)}MB`;
}

export function UploadForm() {
  const router = useRouter();
  const [files, setFiles] = useState<Partial<Record<FileKey, File>>>({});
  const [status, setStatus] = useState<"idle" | "uploading">("idle");
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [error, setError] = useState("");

  function chooseFile(key: FileKey, file?: File) {
    if (!file) return;
    const validationError = validateUploadDescriptor(file);
    if (validationError) {
      setError(`${file.name}: ${validationError}`);
      trackEvent("upload_error", { reason: validationError });
      return;
    }
    setError("");
    setFiles((current) => ({ ...current, [key]: file }));
  }

  async function upload() {
    if (!files.payslip) {
      setError("צריך לצרף לפחות תלוש שכר אחד.");
      return;
    }

    setStatus("uploading");
    setError("");
    const manifest = {
      files: fileConfig.flatMap((item) => {
        const file = files[item.key];
        return file
          ? [{ documentType: item.key, name: file.name, type: file.type, size: file.size }]
          : [];
      }),
    };
    setProgress({ completed: 0, total: manifest.files.length });

    try {
      const signResponse = await fetch("/api/documents/sign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(manifest),
      });
      if (!signResponse.ok) throw new Error(await customerErrorFromResponse(signResponse, "upload_prepare_failed"));
      const signResult = await signResponse.json();

      const supabase = getSupabaseBrowser();
      for (const upload of signResult.uploads as Array<{ documentType: FileKey; path: string; token: string }>) {
        const file = files[upload.documentType];
        if (!file) throw new Error("קובץ שנבחר חסר לפני ההעלאה");
        const { error: uploadError } = await supabase.storage
          .from("salary-documents")
          .uploadToSignedUrl(upload.path, upload.token, file, {
            cacheControl: "0",
            contentType: file.type,
          });
        if (uploadError) {
          // UX Run 1 / U8: the storage provider's English never reaches the customer; the code is kept for the console.
          console.warn("Document upload failed", (uploadError as { name?: string }).name ?? "upload_error");
          throw new Error(customerErrorMessage({}, "upload_transfer_failed"));
        }
        setProgress((current) => ({ ...current, completed: current.completed + 1 }));
      }

      const completeResponse = await fetch("/api/documents/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(manifest),
      });
      if (!completeResponse.ok) throw new Error(await customerErrorFromResponse(completeResponse, "upload_complete_failed"));
      trackEvent("payslip_uploaded", { document_count: Object.keys(files).length });
      router.push("/check/payment");
    } catch (caught) {
      const message = customerErrorMessage({ error: caught instanceof Error ? caught.message : null }, "upload_transfer_failed");
      setError(message);
      setStatus("idle");
      trackEvent("upload_error", { reason: message });
    }
  }

  return (
    <div className="upload-form">
      <div className="check-page-heading"><span className="mono">מסמכים</span><h1>עכשיו נפתח את התלוש.</h1><p>הקבצים עולים ישירות לאחסון פרטי. הם לא נשלחים למעסיק.</p></div>
      <div className="upload-list">
        {fileConfig.map((item) => {
          const file = files[item.key];
          return (
            <div className={file ? "upload-item has-file" : "upload-item"} key={item.key}>
              <label>
                <input type="file" accept="application/pdf,image/jpeg,image/png" onChange={(event) => chooseFile(item.key, event.target.files?.[0])} />
                <span className="upload-item__icon">{file?.type === "application/pdf" ? <FilePdf weight="duotone" /> : file ? <ImageIcon weight="duotone" /> : <FileArrowUp weight="duotone" />}</span>
                <span className="upload-item__copy"><b>{item.title}{item.required ? " *" : ""}</b><small>{file ? `${file.name} · ${formatSize(file.size)}` : item.note}</small></span>
                <span className="upload-item__action">{file ? "החלפה" : "בחירת קובץ"}</span>
              </label>
              {file && <button type="button" className="upload-item__remove" aria-label={`הסרת ${item.title}`} onClick={() => setFiles((current) => { const next = { ...current }; delete next[item.key]; return next; })}><X aria-hidden="true" /></button>}
            </div>
          );
        })}
      </div>
      <p className="upload-limit">PDF, JPG או PNG. עד 10MB לקובץ ועד 25MB יחד.</p>
      {status === "uploading" && <div className="upload-progress" role="status"><span style={{ "--upload-progress": `${Math.max(8, (progress.completed / Math.max(progress.total, 1)) * 100)}%` } as React.CSSProperties} /><b>{progress.completed < progress.total ? `מעלים מסמך ${progress.completed + 1} מתוך ${progress.total}...` : "מאמתים ושומרים את המסמכים..."}</b></div>}
      {error && <div className="form-error" role="alert">{error}</div>}
      <button className="button button--primary button--wide" type="button" disabled={status === "uploading"} onClick={upload}>{status === "uploading" ? "העלאה מתבצעת..." : "שמירה ומעבר לתשלום"}</button>
    </div>
  );
}
