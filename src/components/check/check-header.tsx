"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { formatPrice, productOffer } from "@/lib/product-offer";
import {
  FUNNEL_STAGES,
  funnelFraction,
  funnelValueText,
  useFunnelProgress,
} from "./funnel-progress";

// Site S4 (2.1). The funnel's one progress indicator — see funnel-progress.tsx
// for why there is exactly one and where its number comes from.

export function CheckHeader() {
  const pathname = usePathname();
  const { substep } = useFunnelProgress();
  const current = Math.max(0, FUNNEL_STAGES.findIndex((stage) => stage.path === pathname));
  const fraction = funnelFraction(current, substep);
  const valueText = funnelValueText(current, substep);

  return (
    <header className="check-header">
      <div className="check-shell check-header__top">
        <Link className="wordmark" href="/" aria-label="Tivdoc, חזרה לעמוד הבית">
          <span className="wordmark__mark" aria-hidden="true">T</span>
          Tivdoc
        </Link>
        <span className="check-header__price mono">{formatPrice(productOffer().initial_check.price)}</span>
      </div>
      <div className="check-shell">
        {/* No aria-live: this bar moves on every step, and a live region on a
            moving element talks over everything else. The step change is
            announced by focus moving to the new heading. */}
        <div
          className="check-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(fraction * 100)}
          aria-valuetext={valueText}
        >
          <span className="check-progress__fill" style={{ width: `${Math.round(fraction * 1000) / 10}%` }} />
          {FUNNEL_STAGES.map((stage, index) => (
            <div className={index <= current ? "check-progress__step is-active" : "check-progress__step"} key={stage.path}>
              <span className="mono" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
              <b>{stage.label}</b>
            </div>
          ))}
        </div>
        {substep ? (
          <p className="check-progress__within mono">שאלה {substep.index} מתוך {substep.count}</p>
        ) : null}
      </div>
    </header>
  );
}
