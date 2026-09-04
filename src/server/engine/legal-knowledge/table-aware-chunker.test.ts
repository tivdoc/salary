// L4-1 / D2. The table-aware chunker, `legal-structure-chunker-v1`.
//
// The fixture below is synthetic and modelled on the shape of the defect, not
// copied from any source: a heading, a column-header block, then rows whose
// first cell is a date. Under v0 every one of those dates matches the heading
// pattern `\d{1,3}[.)]`, so the table comes apart. Under v1 it does not.
import { describe, expect, it } from "vitest";
import {
  chunkLegalPages,
  chunkLegalPagesTableAware,
  isTableRowLine,
  markTableLines,
  LEGAL_CHUNKER_VERSION,
  LEGAL_CHUNKER_VERSION_V1,
  LEGAL_CHUNKER_V1_MAX_TABLE_CHARACTERS,
} from "./normalization.ts";
import type { LegalSource } from "../../../engine/legal-knowledge/contracts.ts";

const SOURCE = {
  source_id: "SYNTHETIC_TABLE_SOURCE",
  source_version: "test-v0",
  topics: ["minimum_wage"],
  sectors: ["general"],
  effective_period: { from: "2000-01-01", to: null },
  authority: "primary_legislation",
} as unknown as LegalSource;

const ARTIFACT = "a".repeat(64);

const TABLE_PAGE = [
  "1. Rates",
  "Header column one",
  "Header column two",
  "01.04.2026",
  "297.4 257.75 34.64",
  "",
  "01.04.2025",
  "288.35 249.90 33.58",
  "",
  "1.04.2023 257.16 222.87 29.95",
  "Closing prose that is not a table row at all.",
].join("\n");

const chunk = (text: string, tableAware: boolean) =>
  (tableAware ? chunkLegalPagesTableAware : chunkLegalPages)(SOURCE, ARTIFACT, [{ page: 1, text }]);

describe("isTableRowLine", () => {
  it("accepts lines whose every token is a number, date, percentage or money figure", () => {
    for (const line of ["01.04.2026", "297.4 257.75 34.64 35.4 6443.85", "1.1.2014 %6 %5.5 %6 %17.5", "2.5% 0.834% 0.833% 1.1.2008", "5,571.75", "0.0"]) {
      expect(isTableRowLine(line), line).toBe(true);
    }
  });

  it("rejects anything carrying a word, and anything empty or overlong", () => {
    for (const line of ["שכר מינימום לשעה", "186 שעות", "1. Rates", "5,300.00 ILS", "", " ", "9 ".repeat(120)]) {
      expect(isTableRowLine(line), JSON.stringify(line)).toBe(false);
    }
  });
});

describe("markTableLines", () => {
  it("needs two numeric lines: one stray figure in prose is not a table", () => {
    expect(markTableLines(["prose", "42", "more prose"])).toEqual([false, false, false]);
  });

  it("spans blank lines between rows and stops at the first prose line", () => {
    expect(markTableLines(["prose", "1.1", "", "2.2", "prose"])).toEqual([false, true, true, true, false]);
  });
});

describe("legal-structure-chunker-v1", () => {
  it("v0 cuts the table into date-only and value-only chunks — the defect, still reproducible", () => {
    const chunks = chunkLegalPages(SOURCE, ARTIFACT, [{ page: 1, text: TABLE_PAGE }]);
    expect(chunks.length).toBeGreaterThan(4);
    const orphan = chunks.find((entry) => entry.text === "297.4 257.75 34.64");
    expect(orphan, "a row chunk with no header and no words").toBeDefined();
    expect(chunks.some((entry) => entry.text === "01.04.2026")).toBe(true);
  });

  it("v1 keeps the header block and every row in one chunk", () => {
    const chunks = chunk(TABLE_PAGE, true);
    const table = chunks.find((entry) => entry.text.includes("33.58"));
    expect(table).toBeDefined();
    expect(table!.text).toContain("Header column one");
    expect(table!.text).toContain("Header column two");
    expect(table!.text).toContain("01.04.2026");
    expect(table!.text).toContain("1.04.2023 257.16 222.87 29.95");
    // Every row that was its own chunk under v0 is inside this one.
    expect(chunks.filter((entry) => entry.text === "01.04.2026")).toHaveLength(0);
  });

  it("v1 chunk ids carry a `t` marker and cannot collide with v0 ids", () => {
    const zero = new Set(chunk(TABLE_PAGE, false).map((entry) => entry.chunk_id));
    const one = chunk(TABLE_PAGE, true);
    expect(LEGAL_CHUNKER_VERSION_V1).not.toBe(LEGAL_CHUNKER_VERSION);
    for (const entry of one) {
      expect(entry.chunk_id).toMatch(/#t\d{4}-[0-9a-f]{12}$/u);
      expect(zero.has(entry.chunk_id)).toBe(false);
    }
  });

  it("resolves every locator: the recorded range is exactly the chunk text", () => {
    const normalized = TABLE_PAGE;
    for (const entry of chunk(normalized, true)) {
      expect(normalized.slice(entry.character_from, entry.character_to)).toBe(entry.text);
    }
  });

  it("is deterministic — the same page twice is the same bytes", () => {
    expect(JSON.stringify(chunk(TABLE_PAGE, true))).toBe(JSON.stringify(chunk(TABLE_PAGE, true)));
  });

  it("leaves prose alone: a page with no table chunks exactly as v0 does, modulo the id marker", () => {
    const prose = ["1. First clause", "Some prose about entitlement.", "2. Second clause", "More prose entirely."].join("\n");
    const zero = chunk(prose, false);
    const one = chunk(prose, true);
    expect(one.map((entry) => entry.text)).toEqual(zero.map((entry) => entry.text));
    expect(one.map((entry) => [entry.character_from, entry.character_to])).toEqual(zero.map((entry) => [entry.character_from, entry.character_to]));
  });

  it("bounds a table chunk rather than letting it grow without limit", () => {
    // The cap is a soft ceiling checked after each line, exactly as v0's 3500
    // is, so a chunk may overshoot by the one line that crossed it — and a
    // table row is capped at 200 characters by `isTableRowLine`.
    const rows = Array.from({ length: 4_000 }, (_unused, index) => `1.1.20${String(index % 90).padStart(2, "0")} ${index}.5 ${index}.75`);
    const chunks = chunk(["1. Rates", "Header", ...rows].join("\n"), true);
    expect(chunks.length).toBeGreaterThan(1);
    for (const entry of chunks) expect(entry.text.length).toBeLessThanOrEqual(LEGAL_CHUNKER_V1_MAX_TABLE_CHARACTERS + 201);
  });
});
