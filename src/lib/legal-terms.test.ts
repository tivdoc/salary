// Site S4 (2.6) acceptance. The consent record is only worth keeping if it
// names the terms it was given for, and the page and the record have to name
// the same ones.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TERMS_VERSION, termsVersionLabel } from "./legal-terms.ts";

describe("the terms version", () => {
  it("is a date, so a reader can tell which text they agreed to", () => {
    expect(TERMS_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(Number.isNaN(Date.parse(TERMS_VERSION))).toBe(false);
  });

  it("prints the way the terms page prints it", () => {
    expect(termsVersionLabel("2026-08-22")).toBe("22.8.2026");
  });

  it("is the only place the version is written down", () => {
    // The failure this prevents: the page saying one date in prose while the
    // consent row stores another, which makes every stored consent ambiguous.
    const page = readFileSync(join(process.cwd(), "src", "app", "terms", "page.tsx"), "utf8");
    expect(page).toContain("termsVersionLabel()");
    expect(page).not.toMatch(/\d{1,2}\.\d{1,2}\.20\d\d/u);
  });

  it("is what the payment route records, and it is not taken from the caller", () => {
    const route = readFileSync(join(process.cwd(), "src", "app", "api", "payments", "start", "route.ts"), "utf8");
    expect(route).toContain("terms_version: TERMS_VERSION");
    // The body may say whether the box was ticked; it may not say which terms.
    expect(route).not.toMatch(/body\??\.\s*termsVersion/u);
    expect(route).toContain("terms_not_accepted");
  });
});
