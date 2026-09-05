// Pool P batch 16 (L7-9 / D6). One parameter, one open decision.
//
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \
//     scripts/legal-review-projection/pool-p-batch-16-daily-threshold.mts
//
// §2(א) of the Hours of Work and Rest Law 1951: "יום עבודה לא יעלה על שמונה
// שעות עבודה". The figure is the word שמונה, on page 1 of the promulgation, in
// the table-aware chunk's logical text, and it binds through
// legal-numeral-lexicon-v1 as eight — text_verified, no page image needed.
//
// The daily threshold is nonetheless an open decision. The Labour Ministry
// directive of 10.6.2018 reads the day as 8.6 hours on a five-day week and
// 7.6 on a six-day week; its official text is not discoverable on gov.il
// (BL-24), a copy on a non-official site is a mirror and is not acceptable,
// and no fetch is made. That branch is recorded on the decision as UNBOUND
// and is never run; if the owner's session finds the directive on an official
// host it goes through the acquisition import and binds at administrative
// grade. Nothing here reads a document; the citation is checked against the
// normalized chunk the corpus already holds.
import "../production-refusal.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { WORKING_TIME_DAILY_THRESHOLD_DECISION } from "../../src/engine/legal-quality/sensitivity-rulespecs.ts";
import { buildCandidate, importPoolPBatch, lexiconCitation, TABLE_AWARE_CITATIONS, TENANT } from "./pool-p-parameter-import.mts";

const RECEIPT_ROOT = path.join("output", "next", "pool-p");
const LAW = { source_id: "IL_HOURS_WORK_REST_LAW", source_version: "discovery-v0" };
const PAGE1 = "IL_HOURS_WORK_REST_LAW@discovery-v0#t0001-9c1a29457d03";

const dailyThreshold = buildCandidate({
  parameter_id: "il.working_time.daily_overtime_threshold_hours",
  parameter_version: "1951.1.0",
  topic: "working_time",
  value: { kind: "integer", value: 8, unit: "hours" },
  unit: "hours",
  rounding_policy: "exact",
  effective_from: "1951-09-27",
  effective_to: null,
  sectors: ["general"],
  populations: ["general"],
  support_roles: ["primary_binding"],
  decision_id: WORKING_TIME_DAILY_THRESHOLD_DECISION,
  branch: "statute",
  citations: [lexiconCitation(LAW, PAGE1,
    "Hours of Work and Rest Law 1951 §2(א), page 1 of the promulgation (ס\"ח 76): a working day shall not exceed eight hours of work; the figure is the word שמונה, resolved through legal-numeral-lexicon-v1",
    "שמונה", "יום עבודה לא יעלה על", { numerator: "8", denominator: "1" })],
});

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  if (!WORKING_TIME_DAILY_THRESHOLD_DECISION.startsWith(`${TENANT}.decision.`)) throw new Error("L7_9_DECISION_ID_NOT_ON_TENANT");
  await importPoolPBatch("batch-16-daily-threshold", [dailyThreshold], [{
    decision_id: WORKING_TIME_DAILY_THRESHOLD_DECISION,
    topic: "working_time",
    question: "What is the daily hours threshold beyond which an hour of a working day is overtime? Branch statute: §2(א) of the Hours of Work and Rest Law 1951 — eight hours (bound, il.working_time.daily_overtime_threshold_hours@1951.1.0, through the lexicon from the word שמונה). Branch administrative: the Labour Ministry directive of 10.6.2018 — 8.6 hours on a five-day week, 7.6 on a six-day week — whose official text is not discoverable on gov.il (BL-24); a copy on a non-official site is a mirror and is not acceptable; unbound, not run, would bind at administrative grade.",
    dossier_anchor: "Hours of Work and Rest Law 1951 §2(א), page 1 of the promulgation (lexicon citation, batch 16); Labour Ministry directive of 10.6.2018 — BL-24, target ACQ-V06-LABOUR-DIRECTIVE-DAILY-HOURS-2018, not fetched",
  }]);
  const receipt = {
    schema_version: "tivdoc-pool-p-batch-16-v1",
    unit: "L7-9 / D6",
    tenant: TENANT,
    registered: ["il.working_time.daily_overtime_threshold_hours@1951.1.0"],
    provenance_grade: "text_verified",
    lexicon_bindings: [{ parameter_version_id: "il.working_time.daily_overtime_threshold_hours@1951.1.0", chunk_id: PAGE1, surface: "שמונה", numerator: "8", denominator: "1" }],
    table_aware_citations: TABLE_AWARE_CITATIONS.map((entry) => ({ chunk_id: entry.chunk_id, anchor: entry.anchor })),
    open_decisions: [WORKING_TIME_DAILY_THRESHOLD_DECISION],
    branches: {
      statute: { bound: true, parameter_version_id: "il.working_time.daily_overtime_threshold_hours@1951.1.0", rule_spec_id: "il.rulespec.working.time.overtime.from.hours.worked" },
      // L11-5 / D3.6: attribution corrected — the figures are the steering
      // committee's reading of the 42-hour order (24.4.2018) via kolzchut; the
      // 10.6.2018 directive concerns the 182 divisor. The row itself carries the
      // correction as an annotation (bl24-attribution-annotation.mts).
      // L12-1 / D1: bound as a derived figure (batch 20): 43/5 hours from the 2018
      // order's 42 and its one-hour reduction under the assumption
      // five_day_even_distribution; grade derived, never text or administrative.
      administrative: { bound: true, parameter_version_id: "il.working_time.daily_overtime_threshold_hours@2018.1.0", grade: "derived", derivation: "batch-20-derived-daily-norm", assumption_slot: "five_day_even_distribution", rule_spec_id: "il.rulespec.working.time.overtime.five.day.norm", corroboration: ["steering_committee_2018-04-24", "kolzchut"] },
    },
    blocked_ledger: "BL-24 closes as bound_derived_pending_V11: the administrative branch is bound at grade derived on a stated assumption V11 can invalidate; no official artifact carries 8.6 / 7.6 and none is claimed; the owner-recorded default now executes",
  };
  writeFileSync(path.join(RECEIPT_ROOT, "batch-16-daily-threshold.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  console.log(`L7_9_BATCH16 ${JSON.stringify({ registered: 1, decisions: 1, grade: "text_verified" })}`);
}

await main();
