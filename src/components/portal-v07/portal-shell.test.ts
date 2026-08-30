import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { STATUS_LABELS_HE } from "../../server/product/customer-portal/contracts";
import { createHarness, seedEvidenceAndReport } from "../../server/product/customer-portal/test-fixtures";
import { PortalEmptyState, PortalErrorState, PortalLoadingState, PortalShell } from "./portal-shell";

describe("Hebrew RTL portal surface", () => {
  it("renders semantic owner projection content and truthful released report wording", () => {
    const { service, repository, ownerA } = createHarness();
    seedEvidenceAndReport(repository, { coverageComplete: false, blockerCodes: ["coverage_incomplete"] });
    const html = renderToStaticMarkup(createElement(PortalShell, { projection: service.getCaseProjection(ownerA, "synthetic-case-a") }));
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('lang="he"');
    expect(html).toContain('href="#portal-main"');
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain("מספר תיק");
    expect(html).toContain("תשובה שתימסר תישמר כהצהרה");
    expect(html).toContain("אין לראות בו חישוב מלא");
    expect(html).not.toMatch(/[—–]/);
  });

  it("provides all required coarse customer states without legal conclusions", () => {
    const labels = Object.values(STATUS_LABELS_HE);
    expect(labels).toEqual(expect.arrayContaining([
      "ממתינים לאימות התשלום",
      "ממתינים למסמכים",
      "הבדיקה בתהליך",
      "נדרש ממך מידע נוסף",
      "הבדיקה ממתינה להשלמת מידע או ביקורת",
      "דוח ששוחרר זמין",
      "הגישה לדוח מושהית",
    ]));
    expect(labels.join(" ")).not.toMatch(/ייעוץ|זכאי|חייב|סכום/);
  });

  it("renders no-case, loading, and error states with non-disclosing copy", () => {
    const noCase = renderToStaticMarkup(createElement(PortalEmptyState));
    const loading = renderToStaticMarkup(createElement(PortalLoadingState));
    const error = renderToStaticMarkup(createElement(PortalErrorState));
    expect(noCase).toContain("לא נמצא תיק להצגה");
    expect(loading).toContain('role="status"');
    expect(error).toContain('role="alert"');
    expect(`${noCase}${loading}${error}`).not.toContain("synthetic-case");
  });

  it("uses mobile-first, focus-visible, dual-mode, reduced-motion CSS with no forbidden viewport height", () => {
    const css = readFileSync(new URL("./portal.module.css", import.meta.url), "utf8");
    expect(css).toContain("min-height: 100dvh");
    expect(css).not.toContain("height: 100vh");
    expect(css).toContain("prefers-color-scheme: dark");
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain(":focus-visible");
    expect(css).toContain("@media (max-width: 47.99rem)");
  });
});
