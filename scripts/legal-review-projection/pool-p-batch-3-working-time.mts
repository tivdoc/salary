// Pool P batch 3 (Addendum 5): P-17 only. P-11..P-16 and P-18..P-20 are
// recorded blocked_dependency in docs/tivdoc-development-state.md, not
// attempted here — see that write-up for the exact corpus gap each one
// hits (a missing consolidated law text, a numeral not present in the
// fetched order's extracted text, or a parse_failed source).
import { buildCandidate, citation, importPoolPBatch } from "./pool-p-parameter-import.mts";

const D8_182 = { source_id: "IL_SHORT_WORK_WEEK_EXTENSION_ORDER_2018", source_version: "discovery-v0.1" };

const p17 = buildCandidate({
  parameter_id: "il.working_time.weekly_overtime_threshold_hours",
  parameter_version: "2018.1.0",
  topic: "working_time",
  value: { kind: "integer", value: 42, unit: "hours_per_week" },
  unit: "hours_per_week",
  rounding_policy: "exact",
  effective_from: "2018-04-01",
  effective_to: null,
  sectors: ["general"],
  populations: ["general"],
  support_roles: ["primary_binding"],
  citations: [
    citation(D8_182, "IL_SHORT_WORK_WEEK_EXTENSION_ORDER_2018@discovery-v0.1#0001-c383d0ba2158",
      "General 42-hour work-week extension order, 19.3.2018 (in force 1.4.2018), §2.1: the work week is shortened by one hour so that the work week stands at 42 hours of work, with no reduction in pay",
      ["42"]),
  ],
});

await importPoolPBatch("batch-3-working-time", [p17]);
