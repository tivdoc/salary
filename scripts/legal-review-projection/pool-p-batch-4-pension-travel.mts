// Pool P batch 4 (Addendum 5): P-24a/P-24b and P-25. P-21..P-23 (the
// current 6%/6.5%/6% pension contribution rates, effective 1.1.2017) are
// NOT registered here — recorded blocked_dependency in the state-doc
// checkpoint. The 2011 base order (D-9 first half) is built and readable,
// but its own escalation table only reaches 17.5% total / 6% / 5.5% / 6%
// effective 1.1.2014; the 1.1.2017 increase to 18.5% total / 6.5% employer
// pension comes from the 2016 increase order, D-9's second half
// (IL_GENERAL_PENSION_INCREASE_EXTENSION_ORDER_2016), which failed to
// build (document_sanity_minimum_content_failed) — a pre-existing gap,
// not re-diagnosed here.
import { buildCandidate, citation, importPoolPBatch } from "./pool-p-parameter-import.mts";

const D2 = { source_id: "IL_AVERAGE_WAGE_OFFICIAL_RATES", source_version: "discovery-v0" };
const D10 = { source_id: "IL_GENERAL_TRAVEL_EXTENSION_ORDER_2016", source_version: "discovery-v0" };

const avgWageChunk = "IL_AVERAGE_WAGE_OFFICIAL_RATES@discovery-v0#0002-00fe06cb93a9";
const PENSION_WAGE_CAP_DECISION = "legal.reference.il.decision.pension_wage_cap_section";

const p24a = buildCandidate({
  parameter_id: "il.pension.mandatory_wage_cap",
  parameter_version: "2026.1.0",
  topic: "pension",
  value: { kind: "money", value: { currency: "ILS", minor_units: 1356600 } },
  unit: "currency.ils",
  rounding_policy: "exact",
  effective_from: "2026-01-01",
  effective_to: null,
  sectors: ["general"],
  populations: ["general"],
  support_roles: ["official_implementation"],
  citations: [citation(D2, avgWageChunk,
    "Average wage per National Insurance Law §1 (\"קצבאות\"/\"דמי ביטוח\"), effective 1.1.2026 — the research dossier's open decision (topic 3) is whether the mandatory-pension extension order's wage cap tracks the §1 or §2 figure; this branch is §1",
    ["13,566"])],
  decision_id: PENSION_WAGE_CAP_DECISION,
  branch: "section1",
});
const p24b = buildCandidate({
  parameter_id: "il.pension.mandatory_wage_cap",
  parameter_version: "2026.2.0",
  topic: "pension",
  value: { kind: "money", value: { currency: "ILS", minor_units: 1376900 } },
  unit: "currency.ils",
  rounding_policy: "exact",
  effective_from: "2026-01-01",
  effective_to: null,
  sectors: ["general"],
  populations: ["general"],
  support_roles: ["official_implementation"],
  citations: [citation(D2, avgWageChunk,
    "Average wage per National Insurance Law §2, effective 1.1.2026 — the §2 branch of the same open decision as P-24a",
    ["13,769"])],
  decision_id: PENSION_WAGE_CAP_DECISION,
  branch: "section2",
});

const p25 = buildCandidate({
  parameter_id: "il.travel.daily_reimbursement_cap",
  parameter_version: "2016.1.0",
  topic: "travel",
  value: { kind: "money", value: { currency: "ILS", minor_units: 2260 } },
  unit: "currency.ils",
  rounding_policy: "exact",
  effective_from: "2016-02-01",
  effective_to: null,
  sectors: ["general"],
  populations: ["general"],
  support_roles: ["primary_binding"],
  citations: [citation(D10, "IL_GENERAL_TRAVEL_EXTENSION_ORDER_2016@discovery-v0#0001-152cb60b209f",
    "General travel-expense-reimbursement extension order, published 11.8.2016, in force 1.2.2016, §2: the daily travel-expense reimbursement rate shall be up to 22.60 new shekels per work day",
    ["22.60"])],
  // Research dossier Finding 4: 26.40 ILS (the 2014 order's rate) is widely
  // but wrongly cited as current. Not registered as a superseded_2014
  // sibling here: every source found for 26.40 (Protocol, an academic
  // staff association) is an explanatory secondary source, not an official
  // one, and no 2014-order artifact is in the D-pool to bind it to instead
  // — recorded blocked_dependency: no_official_artifact_for_2014_order
  // rather than bound to a URL in a memo.
});

await importPoolPBatch("batch-4-pension-travel", [p24a, p24b, p25], [
  {
    decision_id: PENSION_WAGE_CAP_DECISION,
    topic: "pension",
    question: "Research dossier topic 3, open decision: the general mandatory pension extension order caps the pensionable wage at the average wage in the economy, but the average wage is published under two different National Insurance Law sections with two different current figures (§1: 13,566 ILS; §2: 13,769 ILS, both effective 1.1.2026). Which section does the pension order's own wage-cap clause reference?",
    dossier_anchor: "docs/legal/research-dossier-2026-09-03.md#3-פנסיית-חובה, פרמטרים נוכחיים",
  },
]);
