// Pool P batch 19 (run 11, L11-4 / D3.5). One new open decision, no parameter.
//
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \
//     scripts/legal-review-projection/pool-p-batch-19-rest-day-daily-threshold.mts
//
// The lawyer-approved opinion (5.9.2026, question 4) resolved the rest-day
// composition to the additive reading and, in passing, named a smaller
// question it did not decide with confidence: beyond how many hours on the
// weekly rest is an hour overtime — the worker's own daily norm (as the
// payslip or the attendance record declares it), or the statute's eight?
// The opinion's default is the worker's daily norm and its confidence is
// low. Registered here as a decision row with both branches; both branches
// run in the sensitivity report as two computations over the same rest-day
// scenarios (src/engine/legal-quality/sensitivity-rulespecs.ts). No
// resolution is recorded for it: the owner-recorded resolutions are the six
// the opinion decided, and this one is open.
import "../production-refusal.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { REST_DAY_DAILY_THRESHOLD_DECISION } from "../../src/engine/legal-quality/sensitivity-rulespecs.ts";
import { importPoolPBatch, TENANT } from "./pool-p-parameter-import.mts";

const RECEIPT_ROOT = path.join("output", "next", "pool-p");

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const decision = {
    decision_id: REST_DAY_DAILY_THRESHOLD_DECISION,
    topic: "working_time" as const,
    question:
      "Beyond how many hours worked on the weekly rest day is an hour overtime on that day? Branch worker_daily_norm (the opinion's default, low confidence): the worker's own daily norm as the payslip or attendance record declares it — 8.6 on a five-day week by the steering-committee reading, 9 where a nine-hour day is declared. Branch statute_8: the eight hours of §2(א) of the Hours of Work and Rest Law 1951, the same threshold as an ordinary day. The premium composition is the additive one the same opinion resolved (owner-recorded); the two branches differ in the hours, not the rates. Confidence is stated low by the opinion: no case law or directive addresses the rest day's own threshold.",
    dossier_anchor: "tivdoc-open-decisions-legal-opinion.md (sha256 3ddad7e8c9fd81ec9715e84b3df65e9d780cc06ec09072eab4c6b73740acad6e), question 4, the new decision rest_day_daily_threshold; approval record section 2",
  };
  await importPoolPBatch("batch-19-rest-day-daily-threshold", [], [decision]);
  const receipt = {
    schema_version: "tivdoc-pool-p-batch-19-v1",
    unit: "L11-4 / D3.5",
    tenant: TENANT,
    registered: [],
    open_decisions: [REST_DAY_DAILY_THRESHOLD_DECISION],
    branches: { worker_daily_norm: { default: true, confidence: "low" }, statute_8: { default: false, confidence: "low" } },
    resolution: "none — the six owner-recorded resolutions do not include this decision",
    runs_in: "sensitivity report (both branches, rest-day scenarios); not in the offline shadow (no canonical fact path carries the rest day's hours worked or the worker's declared daily norm)",
  };
  writeFileSync(path.join(RECEIPT_ROOT, "batch-19-rest-day-daily-threshold.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  console.log(`L11_4_BATCH19 ${JSON.stringify({ registered: 0, decisions: 1 })}`);
}

await main();
