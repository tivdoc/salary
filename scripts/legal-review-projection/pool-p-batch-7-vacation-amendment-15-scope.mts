// Pool P batch 7 (Session B, B-7). What D-16 actually unblocks, and a defect
// it exposes in what Session A already registered.
//
// Reading amendment 15's own operative text rather than its headline figure,
// it makes TWO changes to §3(a)(1) of the Annual Vacation Law, not one:
//
//   במקום "מ־4" יבוא "מ־5" ובמקום "14" יבוא "16"
//   ("in place of 'from 4' comes 'from 5', and in place of '14' comes '16'")
//
// The seniority band moved as well as the day count. So the post-2017 rule is
// 16 calendar days for each of the first **five** years, not the first four.
// Session A's `il.vacation.calendar_days_years_1_to_4` carries the right number
// against the wrong population: its run-time citation check asserted the chunk
// contains "16" and "14", which it does, and a citation check cannot notice
// that the scope in the parameter disagrees with the scope in the clause. That
// is precisely the "citation-checked but still wrong" failure this discipline
// exists to prevent, and it is recorded rather than papered over.
//
// The candidate table is append-only and the import only ever inserts revision
// 1, so the mis-scoped row cannot be corrected or removed. What can be done is
// register the correct parameter under its own id and record the old one as
// superseded-by-scope wherever anything might otherwise bind to it — which is
// what `rulespec-drafts.ts` now does.
//
// D-16 also carries a temporary provision nobody had registered: for the window
// between 1 July 2016 and the commencement day, §3(a)(1) reads "15" rather than
// "14" — the band still four years, only the count raised. That is a clean,
// bounded, fully-cited parameter and it is registered here too.
import { buildCandidate, citation, importPoolPBatch } from "./pool-p-parameter-import.mts";

const D16 = { source_id: "IL_ANNUAL_VACATION_LAW_AMENDMENT_15_2016", source_version: "discovery-v0" };
const CHUNK = "IL_ANNUAL_VACATION_LAW_AMENDMENT_15_2016@discovery-v0#0002-ada0a7cfcc75";

const p32b = buildCandidate({
  parameter_id: "il.vacation.calendar_days_years_1_to_5",
  parameter_version: "2017.1.0",
  topic: "vacation",
  value: { kind: "integer", value: 16, unit: "calendar_days" },
  unit: "calendar_days",
  rounding_policy: "exact",
  effective_from: "2017-01-01",
  effective_to: null,
  sectors: ["general"],
  populations: ["seniority_years_1_to_5"],
  support_roles: ["primary_binding"],
  citations: [citation(D16, CHUNK,
    "Annual Vacation Law (Amendment No. 15 and Temporary Provision), 5776-2016, s.1(1) amending §3(a)(1): in place of \"from 4\" comes \"from 5\" and in place of \"14\" comes \"16\" — the band and the count move together",
    ["16", "14", "5", "4"])],
});

const p32c = buildCandidate({
  parameter_id: "il.vacation.calendar_days_interim_2016",
  parameter_version: "2016.1.0",
  topic: "vacation",
  value: { kind: "integer", value: 15, unit: "calendar_days" },
  unit: "calendar_days",
  rounding_policy: "exact",
  effective_from: "2016-07-01",
  // The temporary provision runs up to, and not including, the commencement
  // day of 1 January 2017 — so the last day it governs is 31 December 2016.
  effective_to: "2016-12-31",
  sectors: ["general"],
  populations: ["seniority_years_1_to_4"],
  support_roles: ["primary_binding"],
  citations: [citation(D16, CHUNK,
    "Annual Vacation Law (Amendment No. 15 and Temporary Provision), 5776-2016, s.2(b): in the period from 25 Sivan 5776 (1 July 2016) until the commencement day, §3(a)(1) of the principal law is read with \"15\" in place of \"14\"",
    ["15", "14"])],
});

await importPoolPBatch("batch-7-vacation-amendment-15-scope", [p32b, p32c]);
