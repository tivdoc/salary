import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { REFERENCE_CLASSES } from "./reference-partition.ts";

// V0.10.11 custody. Every recovered reference used to survive only in a live
// working-tree file or an ignored `output/` directory, which is how
// V041_MISMATCH_004 was lost to an ordinary edit. These copies are committed,
// marked `-text` in .gitattributes so git never normalizes them, and checked
// here against the digests they were preserved under.

const MANIFEST = JSON.parse(readFileSync(path.resolve(
  "src", "engine", "wave23", "evidence-incident", "preserved-references.v0.10.11.json",
), "utf8")) as {
  schema_version: string;
  preserved_count: number;
  entries: Array<{
    reference_id: string;
    class: string;
    repository_path: string;
    preserved_path: string;
    sha256: string;
    byte_count: number;
    source_kind: string;
    source_path: string;
    source_state: string;
    preserved_at: string;
  }>;
};

describe("V0.10.11 preserved forensic evidence", () => {
  it("preserves every reference the live registry counts as recovered", () => {
    expect(MANIFEST.schema_version).toBe("tivdoc-evidence-preservation-v0.10.11");
    expect(MANIFEST.entries).toHaveLength(MANIFEST.preserved_count);
    expect(MANIFEST.entries.map((entry) => entry.reference_id)).toEqual([
      "FORENSIC_REF_005", "FORENSIC_REF_007", "FORENSIC_REF_010", "V041_MISMATCH_003",
    ]);
  });

  it("holds bytes that still match the digest they were preserved under", () => {
    for (const entry of MANIFEST.entries) {
      const file = path.resolve(entry.preserved_path);
      expect(existsSync(file), entry.preserved_path).toBe(true);
      const bytes = readFileSync(file);
      expect(bytes.byteLength, entry.reference_id).toBe(entry.byte_count);
      expect(createHash("sha256").update(bytes).digest("hex"), entry.reference_id).toBe(entry.sha256);
    }
  });

  it("never claims a preserved copy is a recovery", () => {
    for (const entry of MANIFEST.entries) {
      expect(entry.class).toBe("preserved_v0_10_11");
      expect(REFERENCE_CLASSES as readonly string[]).not.toContain(entry.class);
    }
  });

  it("records provenance for every copy", () => {
    for (const entry of MANIFEST.entries) {
      expect(entry.source_path, entry.reference_id).not.toBe("");
      expect(["live_working_tree", "untracked_output_tree"]).toContain(entry.source_kind);
      expect(entry.source_state, entry.reference_id).not.toBe("");
      expect(entry.preserved_at).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      expect(entry.repository_path, entry.reference_id).not.toBe("");
    }
  });

  it("keeps the preserved bytes out of git's text normalization", () => {
    const attributes = readFileSync(path.resolve(".gitattributes"), "utf8");
    expect(attributes).toContain("*.preserved.bin -text");
    // The loss was caused by normalization, so a rule that only covers new
    // copies would leave the existing recovery tree exposed.
    expect(attributes).toContain("*.recovered.bin -text");
  });
});
