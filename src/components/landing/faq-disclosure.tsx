"use client";
import type { ReactNode } from "react";
import { trackEvent } from "@/lib/analytics";
export function FaqDisclosure({
  children,
  index,
}: {
  children: ReactNode;
  index: number;
}) {
  return (
    <details
      onToggle={(event) => {
        if (event.currentTarget.open)
          trackEvent("faq_opened", { question: "faq-" + (index + 1) });
      }}
    >
      {children}
    </details>
  );
}
