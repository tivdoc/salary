"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { formatPrice, productOffer } from "@/lib/product-offer";

const steps = [
  { path: "/check", label: "כמה פרטים" },
  { path: "/check/upload", label: "מסמכים" },
  { path: "/check/payment", label: "תשלום" },
  { path: "/check/received", label: "התקבל" },
];

export function CheckHeader() {
  const pathname = usePathname();
  const current = Math.max(0, steps.findIndex((step) => step.path === pathname));

  return (
    <header className="check-header">
      <div className="check-shell check-header__top">
        <Link className="wordmark" href="/" aria-label="Tivdoc, חזרה לעמוד הבית">
          <span className="wordmark__mark" aria-hidden="true">T</span>
          Tivdoc
        </Link>
        <span className="check-header__price mono">{formatPrice(productOffer().initial_check.price)}</span>
      </div>
      <div className="check-shell check-progress" aria-label={`שלב ${current + 1} מתוך ${steps.length}`}>
        {steps.map((step, index) => (
          <div className={index <= current ? "check-progress__step is-active" : "check-progress__step"} key={step.path}>
            <span className="mono">{String(index + 1).padStart(2, "0")}</span>
            <b>{step.label}</b>
          </div>
        ))}
      </div>
    </header>
  );
}
