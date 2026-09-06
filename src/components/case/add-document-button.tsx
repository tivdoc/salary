"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { customerErrorFromResponse, customerErrorMessage } from "@/lib/customer-copy";

// Site S2.3. A button rather than a link, because reaching the upload screen
// from a case requires the server to point the funnel at that case first — the
// upload screens decide which case a file belongs to from the funnel's cookie,
// and a plain link would land on whichever case the browser last worked on.

export function AddDocumentButton({ publicId, label }: { publicId: string; label: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function open() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/cases/${encodeURIComponent(publicId)}/upload-session`, { method: "POST" });
      if (!response.ok) throw new Error(await customerErrorFromResponse(response, "upload_session_failed"));
      const result = (await response.json()) as { next?: string };
      router.push(result.next ?? "/check/upload");
    } catch (caught) {
      setError(customerErrorMessage({ error: caught instanceof Error ? caught.message : null }, "upload_session_failed"));
      setBusy(false);
    }
  }

  return (
    <>
      <button className="button button--primary" type="button" onClick={open} disabled={busy}>
        {busy ? "רגע…" : label}
      </button>
      {error ? <p className="field-error" role="alert">{error}</p> : null}
    </>
  );
}
