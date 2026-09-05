// Pool P batch 18 (run 11, L11-4 / D3.4). The convalescence-year reading of
// the 2026 rate, as its own version.
//
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \
//     scripts/legal-review-projection/pool-p-batch-18-havraa-year.mts
//
// The lawyer-approved opinion (5.9.2026) resolved the period the 2026 order's
// 451.50 covers: neither the calendar year 2026 nor "from the signature" —
// the convalescence year 2026, 1.7.2025 to 30.6.2026, known from the order's
// publication on 18.8.2026 and retroactive. That is a third branch of the
// existing decision, and it needs a version whose effective period says so:
//
//   il.convalescence.daily_rate@2026.3.0   451.50 ILS   1.7.2025 – 30.6.2026   branch havraa_year
//
// The figure is cited exactly as the two earlier versions cite it — the same
// instrument selection over the same gazette page — so the three branches
// differ in period alone. The knowledge time (18.8.2026) and the retroactive
// flag live in src/engine/legal-quality/convalescence-rate-table.ts beside
// this version's id. Draft; nothing attested.
import "../production-refusal.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { HAVRAA_RATE_TABLE } from "../../src/engine/legal-quality/convalescence-rate-table.ts";
import { buildCandidate, importPoolPBatch, selectionCitation, TENANT } from "./pool-p-parameter-import.mts";

const RECEIPT_ROOT = path.join("output", "next", "pool-p");
const ORDER_2026 = { source_id: "IL_CONVALESCENCE_EXTENSION_ORDER_2026", source_version: "discovery-v0.2" };
const CHUNK_2026 = "IL_CONVALESCENCE_EXTENSION_ORDER_2026@discovery-v0.2#s0001-3242816cc02a";
const CONVALESCENCE_ANCHOR = "גובה השתתפות המעסיק בהוצאות ההבראה";
const PERIOD_DECISION = `${TENANT}.decision.convalescence_2026_rate_period`;

const row = HAVRAA_RATE_TABLE.find((entry) => entry.havraa_year === 2026);
if (!row || row.parameter_version_id !== "il.convalescence.daily_rate@2026.3.0") throw new Error("L114_RATE_TABLE_ROW_MISSING");

const havraaYear = buildCandidate({
  parameter_id: "il.convalescence.daily_rate",
  parameter_version: "2026.3.0",
  topic: "convalescence",
  value: { kind: "money", value: { currency: "ILS", minor_units: row.rate_minor_units } },
  unit: "currency.ils",
  rounding_policy: "exact",
  effective_from: row.valid_from,
  effective_to: row.valid_to,
  sectors: ["general"],
  populations: ["general"],
  support_roles: ["primary_binding"],
  decision_id: PERIOD_DECISION,
  branch: "havraa_year",
  citations: [selectionCitation(ORDER_2026, CHUNK_2026,
    `Convalescence extension order 2026 §3, instrument selection over gazette 14863 page 9134: the employer's participation per convalescence day for the convalescence year 2026 (מחיר יום הבראה) stands at 451.50 new shekels. Branch havraa_year of the period decision: the convalescence year runs 1.7.2025–30.6.2026 (the lawyer-approved opinion of 5.9.2026, question 5), the order was published 18.8.2026 and applies retroactively to the whole year; the knowledge time is recorded in the rate table beside this version.`,
    ["451.50"], CONVALESCENCE_ANCHOR)],
});

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  await importPoolPBatch("batch-18-havraa-year", [havraaYear]);
  const receipt = {
    schema_version: "tivdoc-pool-p-batch-18-v1",
    unit: "L11-4 / D3.4",
    tenant: TENANT,
    registered: [`${havraaYear.parameter_id}@${havraaYear.parameter_version}`],
    candidate_sha256: havraaYear.candidate_sha256,
    decision_id: PERIOD_DECISION,
    branch: "havraa_year",
    effective_period: { from: row.valid_from, to: row.valid_to },
    knowledge_time: { known_at: row.known_at, retroactive: row.retroactive },
    provenance_grade: "selection",
    selection_cited: CHUNK_2026,
    state: "draft",
    attestations: 0,
  };
  writeFileSync(path.join(RECEIPT_ROOT, "batch-18-havraa-year.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  console.log(`L11_4_BATCH18 ${JSON.stringify({ registered: 1, branch: "havraa_year", known_at: row.known_at })}`);
}

await main();
