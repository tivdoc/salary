// Pool P batch 15 (L6-7 / D1, P-31). The 2025 convalescence law's wage
// threshold, read from the typeset page.
//
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \
//     scripts/legal-review-projection/pool-p-batch-15-threshold-visual.mts
//
// The 2025 law (ס"ח 3384, chapter 7, the gazette slice at pages 16–25 of the
// artifact) states, on page 19: a worker whose average monthly wage over
// October–December 2024 does not exceed 6,150 new shekels is outside the
// partial reduction. The text layer of that page fragments the figure into
// "6 ,15 0" (pypdf's layout mode splits the kerned glyph runs), and L5's
// normalizer does not join them; the lexicon has nothing to bind. The page,
// rendered by the operating system's own rasteriser from the extracted page
// bytes, shows 6,150 plainly.
//
//   il.convalescence.2025_partial_reduction_wage_threshold@2025.1.0   6,150.00 ILS   inferred_visual
//
// It pairs with the 2024 threshold (6,000, batch 5, text_verified) in the
// convalescence draft: two slots, one per year, so a reader sees both grades
// side by side.
import "../production-refusal.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildCandidate, importPoolPBatch, TABLE_AWARE_CITATIONS, TENANT, VISUAL_CITATIONS, visualCitation } from "./pool-p-parameter-import.mts";

const RECEIPT_ROOT = path.join("output", "next", "pool-p");
const LAW_2025 = { source_id: "IL_CONVALESCENCE_REDUCTION_FREEZE_LAW_2025", source_version: "discovery-v0.3.1" };
const PAGE19 = "IL_CONVALESCENCE_REDUCTION_FREEZE_LAW_2025@discovery-v0.3.1#t0004-00460caf38b0";

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const threshold = await visualCitation({
    kind: "stored_line", source: LAW_2025, chunk_id: PAGE19, page: 19, line_index: 29, text_layer_surface: null, visual_reading: "6,150", anchor: "ואם הוא מועסק",
    locator: "Convalescence-pay freeze and reduction law 2025 (ס\"ח 3384 p. 388 ff., artifact page 19): a worker whose average monthly wage over October–December 2024 does not exceed 6,150 new shekels; text layer line 29 carries the figure as the fragments '6 ,15 0', read from the rendered page as 6,150.",
  });
  const candidates = [buildCandidate({
    parameter_id: "il.convalescence.2025_partial_reduction_wage_threshold",
    parameter_version: "2025.1.0",
    topic: "convalescence",
    value: { kind: "money", value: { currency: "ILS", minor_units: 615_000 } },
    unit: "currency.ils",
    rounding_policy: "exact",
    effective_from: "2025-01-01",
    effective_to: null,
    sectors: ["general"],
    populations: ["general"],
    support_roles: ["primary_binding"],
    citations: [threshold],
  })];
  await importPoolPBatch("batch-15-threshold-visual", candidates, []);
  const receipt = {
    schema_version: "tivdoc-pool-p-batch-15-v1",
    unit: "L6-7 / D1 (P-31)",
    tenant: TENANT,
    registered: candidates.map((entry) => `${entry.parameter_id}@${entry.parameter_version}`),
    provenance_grade: "inferred_visual",
    visual_verification_required: true,
    visual_citations: VISUAL_CITATIONS,
    citations: TABLE_AWARE_CITATIONS,
    text_layer: { stored_line_29: "םילקש 6 ,15 0לע הלוע םילקש הניא 6 ,15 0202 4לע רבמצד הלוע הניא דע 202 4202 4רבמצד דע 202 4", note: "the figure is present as kerned fragments; no whole '6,150' exists in the text layer, so a text citation cannot be made and the lexicon has no word to bind" },
    paired_with: "il.convalescence.2024_partial_reduction_wage_threshold@2024.1.0 (batch 5, text_verified, 6,000)",
  };
  writeFileSync(path.join(RECEIPT_ROOT, "batch-15-threshold-visual.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  console.log(`L6_7_BATCH15 ${JSON.stringify({ registered: candidates.length, visual_citations: VISUAL_CITATIONS.length })}`);
}

await main();
