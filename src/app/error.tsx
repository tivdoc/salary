"use client";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main id="main-content" className="state-page">
      <span className="wordmark"><span className="wordmark__mark" aria-hidden="true">T</span>Tivdoc</span>
      <p className="mono">ERROR</p>
      <h1>משהו לא הסתדר.</h1>
      <p>המידע שהזנת לא נמחק מהעמוד. אפשר לנסות שוב.</p>
      <button className="button button--primary" type="button" onClick={reset}>ניסיון נוסף</button>
    </main>
  );
}
