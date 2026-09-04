import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalReadinessJson } from "../../legal-knowledge/canonical-readiness/evaluate-legal-readiness.ts";
import { corpusLifecycleReconciliation } from "./lifecycle.ts";

// B-0, second half. `lifecycle-reconciliation.json` reached the same failure
// mode as the Wave-1 partition from the opposite direction: it DOES have a
// deterministic builder, but the document is frozen — `corpusLifecycleReconciliation()`
// takes no input and reads a hardcoded seed table for seventeen Wave-1 source
// versions — while its consumer compared those totals against the live corpus.
// Corpus growth therefore read as reconciliation failure.
//
// The scope decision is recorded in `overnight-v07/inventory.ts`: the frozen
// document names its own subject matter and is compared against exactly that.
// What is guarded here is the other half — that the generated artifact on disk
// is still what the builder produces, so a hand edit of the local file cannot
// pass unnoticed either.

const ARTIFACT_PATH = path.resolve("output/parallel-wave-2.3/workers/w2-corpus-trust/lifecycle-reconciliation.json");
const REGENERATE = "REGENERATE_VIA_scripts/wave23-corpus-trust/generate-evidence.mts";

describe("corpus lifecycle reconciliation is derived, not hand-edited (B-0)", () => {
  it("the generated artifact matches the builder byte for byte, when it is present", async () => {
    // The artifact lives under the git-ignored `output/` tree, so a clean
    // checkout legitimately has no copy. Absence is not drift; a copy that
    // disagrees with the builder is.
    if (!existsSync(ARTIFACT_PATH)) {
      expect(existsSync(ARTIFACT_PATH)).toBe(false);
      return;
    }
    const rebuilt = canonicalReadinessJson(corpusLifecycleReconciliation());
    const onDisk = (await readFile(ARTIFACT_PATH, "utf8")).replaceAll("\r\n", "\n");
    if (rebuilt !== onDisk) throw new Error(REGENERATE);
    expect(rebuilt).toBe(onDisk);
  });

  it("accounts for exactly the seventeen frozen Wave-1 source versions it claims", () => {
    const document = corpusLifecycleReconciliation();
    expect(document.totals.source_count).toBe(17);
    expect(document.sources).toHaveLength(17);
    expect(new Set(document.sources.map((entry) => entry.source_version_id)).size).toBe(17);
  });

  it("its own totals are internally closed: extracted - quarantined = resolved = retrievable", () => {
    const { totals } = corpusLifecycleReconciliation();
    expect(totals.extracted_chunks - totals.quarantined_chunk_cardinality).toBe(totals.instrument_resolved_chunks);
    expect(totals.retrievable_review_chunks).toBe(totals.instrument_resolved_chunks);
    expect(totals.canonical_binding_candidate_chunks + totals.explanatory_or_corroborative_chunks)
      .toBe(totals.retrievable_review_chunks);
    // Nothing in this frozen accounting is reviewed, active or operative, and
    // regenerating it must never be able to change that.
    expect(totals.reviewed_sources).toBe(0);
    expect(totals.active_sources).toBe(0);
    expect(totals.operative_sources).toBe(0);
  });
});
