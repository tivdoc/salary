// Pool P batch 6 (Addendum 5 P-32, unblocked by Addendum 7 A7-5's D-16).
//
// Only the years-1-4 figure is registered here, not the full calendar-days
// table by seniority. D-16 (Amendment 15) cleanly and unambiguously
// establishes 16 days for years 1-4 — its own text states the change
// directly ("instead of '14' comes '16'"). For years 5+, the pre-2017
// IL_ANNUAL_VACATION_LAW text (16/18/21/+1-per-year-to-28) and the
// research dossier's own summary table (17/18/19/20.../26) genuinely
// disagree, and amendment 15 is documented as touching only years 1-4 —
// so at least one of those two sources is wrong about years 5+, or a
// different amendment touched them that isn't in either artifact this
// session has. Not resolved here: registering either table's years-5+
// figures without knowing which is right would be exactly the kind of
// citation-checked-but-still-wrong parameter this session's own
// discipline exists to prevent. Left for a dedicated unit once a genuinely
// current, reconciled source is available (D-13-adjacent research).
import { buildCandidate, citation, importPoolPBatch } from "./pool-p-parameter-import.mts";

const D16 = { source_id: "IL_ANNUAL_VACATION_LAW_AMENDMENT_15_2016", source_version: "discovery-v0" };

const p32 = buildCandidate({
  parameter_id: "il.vacation.calendar_days_years_1_to_4",
  parameter_version: "2017.1.0",
  topic: "vacation",
  value: { kind: "integer", value: 16, unit: "calendar_days" },
  unit: "calendar_days",
  rounding_policy: "exact",
  effective_from: "2017-01-01",
  effective_to: null,
  sectors: ["general"],
  populations: ["seniority_years_1_to_4"],
  support_roles: ["primary_binding"],
  citations: [citation(D16, "IL_ANNUAL_VACATION_LAW_AMENDMENT_15_2016@discovery-v0#0002-ada0a7cfcc75",
    "Annual Vacation Law (Amendment No. 15 and Temporary Provision), 5776-2016, amending §3(a)(1): for each of the first four work-years, in place of \"14\" days comes \"16\"",
    ["16", "14"])],
});

await importPoolPBatch("batch-6-vacation-current-table", [p32]);
