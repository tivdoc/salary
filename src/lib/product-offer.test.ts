import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatDuration, formatPrice, initialCheckPriceNumber, productOffer } from "./product-offer.ts";

// UX Run 1 / U9 (D-4.3): one configuration for price and delivery; no literal
// price anywhere a customer reads it or an analytics event carries it.
describe("the product offer configuration", () => {
  it("is valid, and its figures are what the screens and the payment provider use", () => {
    const offer = productOffer();
    expect(offer.initial_check.price).toMatchObject({ amount: "9.99", currency: "ILS" });
    expect(initialCheckPriceNumber()).toBe(9.99);
    expect(formatPrice(offer.initial_check.price)).toBe("9.99 ₪");
    expect(formatPrice(offer.full_report.price)).toBe("149 ₪");
    expect(formatDuration(offer.initial_check.delivery.automatic)).toBe("15 דקות");
    expect(formatDuration(offer.initial_check.delivery.human)).toBe("יום עסקים אחד");
    expect(formatDuration(offer.full_report.delivery)).toBe("3 ימי עסקים");
    expect(offer.access).toMatchObject({ link_token_ttl_hours: 24, challenge_cookie_minutes: 15, code_ttl_minutes: 10, code_max_attempts: 5, session_ttl_days: 30 });
  });

  it("no component or landing page carries the price as a literal any more", () => {
    for (const file of [
      "src/components/landing/hero.tsx", "src/app/page.tsx", "src/components/check/check-header.tsx",
      "src/components/check/payment-handoff.tsx", "src/components/check/received-status.tsx", "src/app/api/cases/status/route.ts",
    ]) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/9\.99/u);
    }
  });
});
