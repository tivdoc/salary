import Link from "next/link";

export default function NotFound() {
  return (
    <main id="main-content" className="state-page">
      <span className="wordmark"><span className="wordmark__mark" aria-hidden="true">T</span>Tivdoc</span>
      <p className="mono">404</p>
      <h1>העמוד הזה לא נמצא.</h1>
      <Link className="button button--primary" href="/">חזרה לעמוד הבית</Link>
    </main>
  );
}
