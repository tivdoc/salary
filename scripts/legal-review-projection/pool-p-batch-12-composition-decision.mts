// Pool P batch 12 (L6-4 / D2). One open decision, no parameters.
//
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \
//     scripts/legal-review-projection/pool-p-batch-12-composition-decision.mts
//
// What an overtime hour on the weekly rest pays is not a figure the law
// states. §17(א)(1) says 1½ for rest-day hours and §16(א) says 1¼ / 1½ for
// overtime; the premium for both at once is a composition of the two, and the
// composition rule is a reading. P-13 and P-14 (175% / 200%) are retired as
// corpus parameters and re-recorded here as that reading, with both branches:
// additive (the rest premium plus the overtime increment) and multiplicative
// (the rest premium times the overtime premium). Each branch is its own
// RuleSpec over the same three registered parameters; no figure 175 or 200 is
// authored anywhere, and the sensitivity report shows both on the rest-day
// scenarios.
import "../production-refusal.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { REST_DAY_OVERTIME_COMPOSITION_DECISION } from "../../src/engine/legal-quality/sensitivity-rulespecs.ts";
import { importPoolPBatch, TENANT } from "./pool-p-parameter-import.mts";

const RECEIPT_ROOT = path.join("output", "next", "pool-p");

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  if (!REST_DAY_OVERTIME_COMPOSITION_DECISION.startsWith(`${TENANT}.decision.`)) throw new Error("L6_4_DECISION_ID_NOT_ON_TENANT");
  await importPoolPBatch("batch-12-composition-decision", [], [{
    decision_id: REST_DAY_OVERTIME_COMPOSITION_DECISION,
    topic: "working_time",
    question: "How does the weekly-rest premium of §17(א)(1) (1½) combine with the overtime premiums of §16(א) (1¼ for the first two hours, 1½ after them) for an overtime hour worked on the weekly rest? Branch additive: the rest premium plus the overtime increment (1¾, then 2). Branch multiplicative: the rest premium times the overtime premium (1⅞, then 2¼). Neither figure is stated in the law; the report shows both computations on the rest-day scenarios.",
    dossier_anchor: "Hours of Work and Rest Law 1951 §16(א) and §17(א)(1), page 4 of the promulgation (visual citations, batch 11); the composition is a reading, not a citation",
  }]);
  const receipt = {
    schema_version: "tivdoc-pool-p-batch-12-v1",
    unit: "L6-4 / D2",
    tenant: TENANT,
    registered: [],
    open_decisions: [REST_DAY_OVERTIME_COMPOSITION_DECISION],
    retired_targets: [
      { ids: "P-13 / P-14", figure: "175% / 200% overtime on the weekly rest", disposition: "retired as corpus parameters — not figures in the law; re-recorded as the open decision above, both branches computed by the executor from the three §16/§17 parameters" },
    ],
    branches: { additive: "il.rulespec.working.time.rest.day.overtime.additive", multiplicative: "il.rulespec.working.time.rest.day.overtime.multiplicative" },
  };
  writeFileSync(path.join(RECEIPT_ROOT, "batch-12-composition-decision.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  console.log(`L6_4_BATCH12 ${JSON.stringify({ decisions: 1, registered: 0 })}`);
}

await main();
