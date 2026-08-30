import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InternalOpsConsole } from "./internal-ops-console";

describe("V07-P5-OPS-UI", () => {
  it("renders an accessible Hebrew RTL shell with all guarded workflow stages", () => {
    const html = renderToStaticMarkup(createElement(InternalOpsConsole, { apiEnabled: false }));
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('lang="he"');
    expect(html).toContain("תשלום");
    expect(html).toContain("בקרת חילוץ");
    expect(html).toContain("פתרון עובדות");
    expect(html).toContain("מוכנות משפטית");
    expect(html).toContain("שרשרת ביקורת");
    expect(html).toContain("לא למסירה ללקוח");
    expect((html.match(/חסום — לא מוכן/g) ?? [])).toHaveLength(7);
    expect(html).toContain("OPS_CASE_NOT_SELECTED");
  });

  it("ships mutation controls disabled until both a role capability and a case are present", () => {
    const html = renderToStaticMarkup(createElement(InternalOpsConsole, { apiEnabled: true }));
    expect((html.match(/disabled=""/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(html).not.toContain("deliver");
    expect(html).not.toContain("markPaid");
    expect(html).not.toContain("forceReady");
  });
});
