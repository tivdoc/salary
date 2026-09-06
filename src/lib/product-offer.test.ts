import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
    expect(offer.access).toMatchObject({ link_token_ttl_hours: 6, challenge_cookie_minutes: 15, code_ttl_minutes: 10, code_max_attempts: 5, session_ttl_days: 30 });
  });

  // Site S4 (3.1/3.2). This was a list of six files; a list is a thing that goes
  // stale, and it did — it still named a component the S5 rewrite deleted, so it
  // was asserting about a file that no longer existed rather than about the ones
  // that do. It sweeps the whole source tree now.
  //
  // Two rules, both about the same failure: the product must not state a figure
  // it does not read from configuration, and must not show a customer an amount
  // that no check produced. The second is the one that reached the site's share
  // card in an earlier wave and stayed there until S4.
  it("states no price and no sample amount anywhere in the source", () => {
    const PRICE_LITERAL = /(?<![\d.])9\.99(?![\d])/u;
    // A number of three digits or more next to a shekel mark: what a finding
    // looks like. Small numbers pass — "5 ימים", a section, a year.
    const SAMPLE_AMOUNT = /[\d][\d,]{2,}\s*(?:₪|ש"ח)/u;

    // The engine's synthetic fixtures are inputs to a calculation, never
    // rendered to anyone; the configuration is where the real price lives.
    const skip = new Set(["node_modules", ".next", "output", "config", "fixtures"]);
    const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      if (skip.has(entry.name)) return [];
      const full = join(directory, entry.name);
      if (entry.isDirectory()) return walk(full);
      if (!/\.(?:tsx?|css)$/u.test(entry.name)) return [];
      // Tests and the offer's own module are allowed to name the figure they check.
      if (/\.test\.[jt]sx?$/u.test(entry.name) || entry.name === "product-offer.ts") return [];
      return [full];
    });

    // Comments are stripped first. The rule is about what the product SHOWS,
    // and a file that documents D-10.2's ceiling in a header comment is
    // explaining the rule rather than printing a figure at anyone.
    const withoutComments = (source: string): string =>
      source.replaceAll(/\/\*[\s\S]*?\*\//gu, " ").replaceAll(/(^|[^:])\/\/.*/gmu, "$1 ");

    const offenders: string[] = [];
    for (const file of walk(join(process.cwd(), "src"))) {
      const source = withoutComments(readFileSync(file, "utf8"));
      const relative = file.slice(process.cwd().length + 1).replaceAll("\\", "/");
      if (PRICE_LITERAL.test(source)) offenders.push(`${relative}: price literal`);
      const amount = SAMPLE_AMOUNT.exec(source);
      if (amount) offenders.push(`${relative}: sample amount ${amount[0]}`);
    }
    expect(offenders).toEqual([]);
  });
});
