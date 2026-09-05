"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

// External review #1, finding 8. The page a case link opens renders nothing
// but this: on mount it exchanges the token once (a POST body, never a query
// string), receives the challenge cookie, and replaces the URL with the case
// id. No content, no outbound link, no Referer worth having.
export function LinkExchange({ token, fallbackHref }: { token: string; fallbackHref: string }) {
  const router = useRouter();
  const started = useRef(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      try {
        const response = await fetch("/api/cases/access/request", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ exchange: true, token }),
        });
        if (!response.ok) throw new Error(String(response.status));
        const result = (await response.json()) as { next?: string };
        router.replace(typeof result.next === "string" ? result.next : fallbackHref);
      } catch {
        setFailed(true);
      }
    })();
  }, [router, token, fallbackHref]);

  if (failed) {
    return (
      <div className="received-card received-card--error">
        <h1>הקישור אינו תקף, נוצל כבר או שפג תוקפו.</h1>
        <p>אפשר להיכנס בכל רגע עם הטלפון או האימייל שאימתת.</p>
        <a className="button button--primary" href={fallbackHref}>כניסה עם טלפון או אימייל</a>
      </div>
    );
  }
  return <div className="received-card" aria-busy="true"><div className="status-skeleton" /><p>מחליפים את הקישור בקוד כניסה…</p></div>;
}
