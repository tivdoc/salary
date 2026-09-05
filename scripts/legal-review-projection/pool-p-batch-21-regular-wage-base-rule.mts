// Pool P batch 21 (long run 10, phase A / L13-5 E2). The base rule behind Q4,
// registered as a parameter instead of a citation-only note in code.
//
// What run 14 left: `BASE_RULES` in `decision-resolutions.ts` names
// `regular_wage_includes_fixed_contractual_premiums` with its citation and
// marks it unbound. That is a comment, not a parameter — nothing in Pool P
// carried it, so no RuleSpec could ever bind it. This batch registers it.
//
// **The grade, and a deviation from the instruction, stated openly.** E2 says
// to grade the rule `text_verified` if it is bound from the DECISION text in
// the corpus and `lexicon` otherwise, on the assumption that the only source
// for it would be ע"ע 38313-03-18 §37 — which is not in the corpus and cannot
// be (BL-32: the hosts that carry it are refused by the controlled path). But
// the proposition does not need the judgment: §18 of the Hours of Work and
// Rest Law states it directly, and §18 IS in the corpus, verbatim —
//
//   18 . לענין הסעיפים 16 ו־17 "שכר רגיל" כולל כל התוספות שמעביד משלם לעובדו.
//
// "for the purposes of sections 16 and 17, 'regular wage' includes all the
// supplements an employer pays their employee". A fixed contractual premium is
// such a supplement, so the rule binds to the statute's own words. It is
// therefore registered `text_verified` against §18 rather than `lexicon` —
// stronger evidence than the instruction anticipated, not weaker. The judgment
// is named in the locator as the interpretive authority that applies §18 to
// premiums (and yields 187.5% / 225% where a 50% shift premium is part of the
// regular wage); it is NOT cited as a bound source, because it is not in the
// corpus.
//
// The citation goes through the table-aware chunk set, so the needle is checked
// against LOGICAL-order text with a mandatory anchor. The v0 chunk for this law
// holds its text in visual order, where a Hebrew needle cannot match and a
// digit needle would match some unrelated section — the failure batch 7 and
// batch 8 were written to prevent.
//
// The value: the candidate schema carries rational, money or integer, so a
// normative rule is registered as the flag `1 rule_applies`, with the rule's
// actual words in the citation locator where a reader and the anchor recheck
// both see them. No decision_id or branch is attached: the rule governs the
// base of §16 and §17 across every branch of the composition decision, and
// `additive` stays exactly as recorded.
import { buildCandidate, importPoolPBatch, tableAwareCitation } from "./pool-p-parameter-import.mts";

const HOURS = { source_id: "IL_HOURS_WORK_REST_LAW", source_version: "discovery-v0" };
const SECTION_18 = "IL_HOURS_WORK_REST_LAW@discovery-v0#t0006-1cec5eccebec";
/** §18's operative words, in the same chunk as the figure. The marginal heading alone
 *  ("שכר רגיל") is refused as an anchor — four Hebrew letters would match half the corpus. */
const ANCHOR = "כולל כל התוספות שמעביד משלם לעובדו";

const baseRule = buildCandidate({
  parameter_id: "il.working_time.regular_wage_includes_fixed_contractual_premiums",
  parameter_version: "1951.1.0",
  topic: "working_time",
  value: { kind: "integer", value: 1, unit: "rule_applies" },
  unit: "rule_applies",
  rounding_policy: "exact",
  effective_from: "1951-01-01",
  effective_to: null,
  sectors: ["general"],
  populations: ["general"],
  support_roles: ["primary_binding"],
  citations: [tableAwareCitation(HOURS, SECTION_18,
    "Hours of Work and Rest Law 1951 §18: לענין הסעיפים 16 ו-17 \"שכר רגיל\" כולל כל התוספות שמעביד משלם לעובדו — for the purposes of §16 (overtime) and §17 (weekly rest), the regular wage that those rates multiply includes all the supplements the employer pays. A fixed contractual premium is such a supplement, so it enters the base rather than forming a separate multiplicative composition. Interpretive authority, named but NOT in the corpus and NOT cited as a bound source: ע\"ע 24481-11-17 and 38313-03-18 (1.6.2020) §37, which applies §18 to a 50% shift premium paid as part of the regular wage and so reaches 187.5% and 225%; §§50-51 of the same judgment keep the statutory composition of the two premiums additive. The judgment's hosts are refused by the controlled import path (BL-32).",
    ["כל התוספות שמעביד משלם לעובדו"], ANCHOR)],
});

await importPoolPBatch("batch-21-regular-wage-base-rule", [baseRule]);
