import { describe, expect, it } from "vitest";
import { diffOfficialCatalogEntries, loadLegalCatalogRegistry, parseOfficialCatalogHtml } from "./catalogs.ts";

describe("official catalog discovery", () => {
  it("registers extension-order and work-permit catalogs without treating detections as authority", async () => {
    const registry = await loadLegalCatalogRegistry();
    expect(registry.catalogs.map((catalog) => catalog.catalog_id)).toEqual([
      "IL_EXTENSION_ORDERS_CATALOG", "IL_WORK_PERMITS_CATALOG",
    ]);
    expect(registry.catalogs.flatMap((catalog) => catalog.required_detection).every((item) => item.evidence_role === "catalog_discovery_only_not_source_authority")).toBe(true);
  });

  it("creates reviewable additions, removals, and metadata changes deterministically", () => {
    const first = parseOfficialCatalogHtml('<a href="/he/item/a">צו הרחבה א</a><a href="/he/item/b">היתר עבודה ב</a>', "https://www.gov.il/catalog");
    const second = parseOfficialCatalogHtml('<a href="/he/item/a">צו הרחבה א מתוקן</a><a href="/he/item/c">היתר עבודה ג</a>', "https://www.gov.il/catalog");
    const diff = diffOfficialCatalogEntries(first, second);
    expect(diff.review_required).toBe(true);
    expect(diff.additions.map((entry) => entry.url)).toContain("https://www.gov.il/he/item/c");
    expect(diff.removals.map((entry) => entry.url)).toContain("https://www.gov.il/he/item/b");
    expect(diff.metadata_changes).toHaveLength(1);
  });

  it("never accepts a non-government catalog link as an entry URL", () => {
    const [entry] = parseOfficialCatalogHtml('<a href="https://gov.il.evil.example/item">צו זדוני</a>', "https://www.gov.il/catalog");
    expect(entry.url).toBeNull();
  });
});
