"use client";

import { useState } from "react";
import { customerErrorMessage } from "@/lib/customer-copy";

// Site S4 (ב.12). The screen the opt-out link opens.
//
// It asks once rather than acting on arrival, because the link is reached by
// a GET and a GET is issued by things that are not the person: mail-client
// prefetchers, corporate link scanners, a browser guessing where you are about
// to go. Any of those would otherwise opt someone out of a message they never
// saw. One button, one POST, one sentence afterwards.

export function ReminderOptOut({ token }: { token: string | null }) {
  const [state, setState] = useState<"asking" | "working" | "done">("asking");
  const [error, setError] = useState("");

  async function optOut() {
    setState("working");
    setError("");
    try {
      const response = await fetch("/api/cases/reminders/off", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!response.ok) throw new Error("reminder_opt_out_failed");
      setState("done");
    } catch (caught) {
      setError(customerErrorMessage({ error: caught instanceof Error ? caught.message : null }, "reminder_opt_out_failed"));
      setState("asking");
    }
  }

  if (state === "done") {
    return (
      <div className="received-card">
        <h1>לא נשלח לך יותר תזכורות.</h1>
        <p>התיק עצמו נשאר שמור, ואפשר להיכנס אליו בכל רגע עם הטלפון או האימייל שאימתת.</p>
      </div>
    );
  }

  return (
    <div className="received-card">
      <h1>לבטל תזכורות על התיק?</h1>
      <p>לא נשלח לך יותר הודעות על הבדיקה הזו. התיק נשאר שמור, ואפשר להיכנס אליו בכל רגע.</p>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <button className="button button--primary" type="button" onClick={() => void optOut()} disabled={state === "working"}>
        {state === "working" ? "מבטלים…" : "כן, לבטל תזכורות"}
      </button>
    </div>
  );
}
