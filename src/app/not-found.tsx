import Link from "next/link";
import {BrandLogo} from "@/components/brand-logo";

export default function NotFound() {
  return (
    <main id="main-content" className="state-page">
      <BrandLogo />
      <p className="mono">404</p>
      <h1>העמוד הזה לא נמצא.</h1>
      <Link className="button button--primary" href="/">חזרה לעמוד הבית</Link>
    </main>
  );
}
