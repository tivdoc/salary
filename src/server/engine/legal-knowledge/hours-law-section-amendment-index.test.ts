// L6-1 / D3. The section amendment index is a derived artifact: built from the
// official amendment publications' own text, committed so its conclusion can be
// read without the corpus, and checked here so the conclusion cannot drift from
// the evidence it carries.
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const index = require("./hours-law-section-amendment-index.v1.json") as {
  schema_version: string;
  publications: Array<{
    source_id: string; status: string; kind: string; hours_law_sections: string[];
    touches: Record<string, { kind: "substantive" | "terminological"; evidence: Array<{ reference: string; sentence: string }> }>;
    terminology_scope: { whole_law: boolean; sentence: string } | null;
    logical_text_sha256?: string; artifact_sha256?: string;
  }>;
  sections: Record<string, {
    substantive_publications: Array<{ source_id: string; evidence: Array<{ sentence: string }> }>;
    terminological_publications: Array<{ source_id: string; evidence: Array<{ sentence: string }> }>;
    authoritative_text_for_figures: string;
  }>;
};
const manifest = require("./legal-sources.v0.json") as { sources: Array<{ source_id: string }> };

describe("hours-law section amendment index (L6-1, D3)", () => {
  it("covers every official amendment publication the manifest registers, all parsed", () => {
    expect(index.schema_version).toBe("tivdoc-hours-law-section-amendment-index-v1");
    const registered = manifest.sources.map((source) => source.source_id).filter((id) => /^IL_HOURS_WORK_REST_LAW_(AMENDMENT_\d\d|ERRATUM_1951)$/u.test(id)).sort();
    expect(registered).toHaveLength(19);
    expect(index.publications.map((entry) => entry.source_id).sort()).toEqual(registered);
    for (const entry of index.publications) {
      expect(entry.status, entry.source_id).toBe("parsed");
      expect(entry.artifact_sha256, entry.source_id).toMatch(/^[a-f0-9]{64}$/u);
      expect(entry.logical_text_sha256, entry.source_id).toMatch(/^[a-f0-9]{64}$/u);
    }
  });

  it("every touch carries the sentence it was read from", () => {
    for (const entry of index.publications) {
      for (const [section, touch] of Object.entries(entry.touches)) {
        expect(touch.evidence.length, `${entry.source_id} ${section}`).toBeGreaterThan(0);
        for (const evidence of touch.evidence) expect(evidence.sentence.length, `${entry.source_id} ${section}`).toBeGreaterThan(10);
      }
    }
  });

  it("the per-section conclusions are exactly what the publications say — recomputed, not copied", () => {
    for (const section of ["section_16", "section_17", "section_18"]) {
      const substantive = index.publications.filter((entry) => entry.touches[section]?.kind === "substantive").map((entry) => entry.source_id);
      const terminological = index.publications.filter((entry) => entry.touches[section]?.kind === "terminological").map((entry) => entry.source_id);
      expect(index.sections[section].substantive_publications.map((entry) => entry.source_id)).toEqual(substantive);
      expect(index.sections[section].terminological_publications.map((entry) => entry.source_id)).toEqual(terminological);
    }
  });

  it("§16, §17 and §18 are amended by no official publication substantively, and by the 2014 term replacement by word", () => {
    for (const section of ["section_16", "section_17", "section_18"]) {
      expect(index.sections[section].substantive_publications, section).toEqual([]);
      expect(index.sections[section].terminological_publications.map((entry) => entry.source_id), section).toEqual(["IL_HOURS_WORK_REST_LAW_AMENDMENT_14"]);
      expect(index.sections[section].terminological_publications[0].evidence[0].sentence).toContain("למעט המילה");
      expect(index.sections[section].authoritative_text_for_figures).toMatch(/^IL_HOURS_WORK_REST_LAW@discovery-v0/u);
    }
    const termLaw = index.publications.find((entry) => entry.source_id === "IL_HOURS_WORK_REST_LAW_AMENDMENT_14");
    expect(termLaw?.terminology_scope?.whole_law).toBe(true);
  });

  it("the direct amendments name the sections they touch, and none of them is §16–§18", () => {
    const direct = index.publications.filter((entry) => entry.kind === "direct");
    expect(direct).toHaveLength(12);
    for (const entry of direct) {
      expect(entry.hours_law_sections.length, entry.source_id).toBeGreaterThan(0);
      expect(entry.hours_law_sections.filter((key) => /^1[678]/u.test(key)), entry.source_id).toEqual([]);
    }
  });
});
