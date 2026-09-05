import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { siteContent, siteContentSchema, sectionsAvailable } from "@/lib/site-content";
import { productOffer } from "@/lib/product-offer";

// Site S5's acceptance, as the brief states it: no sample data ships, no
// contact literal lives outside configuration, and a section with nothing
// behind it renders nothing at all.

const V5_DIR = path.join(process.cwd(), "src", "components", "landing", "v5");
const PAGE = path.join(process.cwd(), "src", "app", "page.tsx");

function v5Sources(): Array<{ file: string; text: string }> {
  return readdirSync(V5_DIR)
    .filter((name) => (name.endsWith(".tsx") || name.endsWith(".ts")) && !name.endsWith(".test.ts"))
    .map((name) => ({ file: name, text: readFileSync(path.join(V5_DIR, name), "utf8") }))
    .concat([{ file: "app/page.tsx", text: readFileSync(PAGE, "utf8") }]);
}

describe("site S5: the home page ships no sample data", () => {
  it("carries no contact literal outside the configuration file", () => {
    for (const { file, text } of v5Sources()) {
      expect(text, `${file} carries a phone literal`).not.toMatch(/0?58-?5960615/u);
      expect(text, `${file} carries the support address`).not.toContain("info@tivdoc.com");
    }
  });

  it("carries none of the canvas's example figures or invented people", () => {
    // Every one of these is in design/landing-v5 and none of them has a source:
    // the review count, the rating, the payslip tally, a case id, a finding sum,
    // and the two bracketed placeholder names.
    const forbidden = ["312 ביקורות", "4.8 מתוך 5", "2,400", "48213", "₪330", "[שם]"];
    for (const { file, text } of v5Sources()) {
      for (const needle of forbidden) {
        expect(text, `${file} carries the unsourced ${needle}`).not.toContain(needle);
      }
    }
  });

  it("shows no amount in the hero visual: D-6.3 is mechanical, and a marketing page is where it would break first", () => {
    const hero = readFileSync(path.join(V5_DIR, "hero.tsx"), "utf8");
    expect(hero).not.toMatch(/₪\s*\d/u);
    expect(hero).toContain("הנתון נשען על המסמכים");
    expect(hero).toContain("הנתון תלוי במה שמסרת");
    expect(hero).toContain("אי אפשר לקבוע סכום, וזה מה שיעלה את הוודאות");
  });

  it("keeps the four data-less sections omitted until their slot is filled", () => {
    const available = sectionsAvailable();
    expect(available.proof_strip).toBe(false);
    expect(available.video).toBe(false);
    expect(available.story).toBe(false);
    expect(available.testimonials).toBe(false);
  });

  it("refuses a placeholder: an empty string is not a filled slot", () => {
    const content = siteContent();
    expect(content.assets.founder_photo).toBeNull();
    // The schema, not the page, is what refuses "" — the page only asks whether the slot is null.
    const withEmpty = { ...content, content: { ...content.content, story: { paragraphs: [""], attribution: "" } } };
    expect(() => siteContentSchema.parse(withEmpty)).toThrow();
  });

  it("reads every figure it renders from the offer configuration", () => {
    const offer = productOffer();
    const sections = readFileSync(path.join(V5_DIR, "sections.tsx"), "utf8");
    const faq = readFileSync(path.join(V5_DIR, "faq.tsx"), "utf8");
    // No hardcoded price or estimate anywhere in the page's own source.
    for (const text of [sections, faq]) {
      expect(text).not.toContain(offer.initial_check.price.amount);
      expect(text).not.toContain(offer.full_report.price.amount);
      expect(text).not.toMatch(/15 דק|3 ימי עסקים|10 ימים/u);
    }
    expect(sections).toContain("formatPrice");
    expect(faq).toContain("productOffer()");
  });
});
