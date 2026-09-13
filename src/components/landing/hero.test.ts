import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Hero } from "./hero";

it("explains salary analysis and offers contact when sales are closed", () => {
  const html = renderToStaticMarkup(
    createElement(Hero, { salesAvailable: false }),
  );
  expect(html).toContain("תלושי השכר והמסמכים שלך");
  expect(html).toContain("בדיקות חדשות עדיין אינן זמינות לרכישה.");
  expect(html).toContain("mailto:");
  expect(html).not.toContain('href="/check"');
  expect(html).not.toContain("התחילו בדיקת שכר");
});
it("offers salary check only when the caller supplies an available service", () => {
  const html = renderToStaticMarkup(
    createElement(Hero, { salesAvailable: true }),
  );
  expect(html).toContain("התחילו בדיקת שכר");
  expect(html).toContain('href="/check"');
  expect(html).toContain("בדיקה ראשונית בתשלום");
  expect(html).not.toContain("בדיקות חדשות עדיין אינן זמינות לרכישה.");
});
