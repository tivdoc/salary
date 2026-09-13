# Document review calculations: sources and interpretation boundary

Reviewed 11 September 2026. This is an AI research and engineering record, not a human signature or approval. Customer source files, identifiers and case results remain outside the repository. Examples below are synthetic.

## Four distinct conclusions

| Conclusion | Required evidence | What it does not establish |
|---|---|---|
| Printed arithmetic | Source-bound operands, units, complete subtotal inventory and an explicit rounding candidate | Legal eligibility of the items or payment to a bank/fund |
| Observed ratio | Two source amounts for the same identified base/component/period; nonzero denominator | A percentage printed on the document, the legally required percentage, or receipt of deposits |
| Conditional entitlement calculation | Source-backed rule/parameters and explicitly accepted applicability conditions, with unresolved alternatives retained | An active REAL catalog entry or human professional approval |
| Actual remittance | Identified bank/fund receipt and linkage to contribution/period | Accuracy of the original payroll basis by itself |

For example, a printed contribution of 300.00 and a printed base of 5,000.00 establish an **observed ratio** of 6%. No missing deposit receipt prevents that calculation. Conversely, 6% must not be inserted into an empty source percentage cell. A combined employer amount is a combined ratio unless evidence identifies its components.

## Primary sources checked

1. **2016 pension contribution increase order, section 3(1)–(3), page 2.** The [Ministry copy](https://www.gov.il/BlobFolder/dynamiccollectorresultitem/extention-order-pension-insurance-2016/he/extention-order-pension-insurance-2016.pdf) is archived at `docs/release-evidence/legal-source-pages/IL_GENERAL_PENSION_INCREASE_EXTENSION_ORDER_2016.pdf`, SHA-256 `f3e7de9d9b36900e18efa33f0286a1eeddbb8e062d8a19e102af94967921dd70`. Its image page was freshly rendered and visually read for this package. The January 2017 provisions distinguish 6% employee contributions, 6.5% employer contributions and the severance provision, with insurance-product qualifications and protection for existing arrangements. These provisions do not identify a particular document's combined employer split, pensionable components, better contractual terms or deposit receipt. An observed ratio is independent of those legal questions.
2. **2018 shorter workweek order, sections 2.1, 2.5–2.12.** [Ministry source](https://www.gov.il/BlobFolder/dynamiccollectorresultitem/extension-order-short-week-2018/he/extension-order-short-week-2018.pdf), archived as `docs/release-evidence/legal-source-pages/IL_SHORT_WORK_WEEK_EXTENSION_ORDER_2018.pdf`, SHA-256 `fa27b689656194ef65d207fd6f68ec7c54c2c78d4362b2a5a2a5d3a207831a4b`. Page 2 was freshly rendered and visually read. It addresses the reduced day, shift arrangements, the 182-hour monthly basis, preservation of better terms and the section 30(a) exclusion. Text extraction misread several digits, including 182 as 122; the rendered page controls this reading. A weekly 42-hour rule does not by itself choose each worker's daily threshold or identify payable breaks.
3. **Hours of Work and Rest Law and permits.** The [Knesset record](https://main.knesset.gov.il/apps/legislation/main/laws/2000019) and existing repository amendment index preserve the original law and subsequent publications separately. The repository records that the Knesset's linked consolidated text is not an official consolidated artifact. The [Ministry permit guidance](https://www.gov.il/he/service/request-for-employment-during-weekend-or-extra-hours) was freshly located: its night-work definition requires at least two working hours between 22:00 and 06:00, and it distinguishes ordinary hours from maximum permitted employment. Guidance is not a workplace permit. No new workplace-specific permit or exception was established here.
4. **2026 minimum-wage administrative table.** The [National Insurance table](https://www.btl.gov.il/Mediniyut/GeneralData/Pages/%D7%A9%D7%9B%D7%A8%20%D7%9E%D7%99%D7%A0%D7%99%D7%9E%D7%95%D7%9D.aspx) was opened on 11 September 2026 and lists the adult rates effective 1 April 2026, including 6,443.85 monthly and 35.40 per hour on the 182-hour basis. It expressly says the site is general information rather than binding statutory text. This does not resolve the existing exact-monthly/182 versus rounded-hourly interpretation. The June-specific candidate cannot silently be relabelled for another month.

## Time representation and classification

- Preserve raw `HH:MM`, decimal export quantity, source label and normalized classification separately. Converting minutes to an exact rational is a representation transform, not an inference about hidden payroll precision.
- Clock readings establish recorded timing. A break or residential rest interval is not automatically unpaid, paid ordinary work, or an exclusion from the law. Missing facts about freedom from duties remain specific applicability blockers.
- An asterisk beside a clock value has no assumed semantic meaning. Overnight date rollover requires identified date evidence; do not infer it from an asterisk that also appears on daytime rows.
- A night-window overlap computed from **working intervals** can support a candidate night classification. Merely spanning the window with an interval that includes unclassified rest is insufficient to certify two hours of work in that window.
- Ordinary hours, overtime bands and separately printed rest hours can be reconciled as document classifications. A 50% premium may overlap a base hour; it must not add a second worked hour to attendance totals. Daily and weekly overtime also require explicit overlap handling before money is summed.
- A contractual sentence referring to long shifts is not by itself the legal threshold for overtime. A permit's maximum shift length and the threshold for additional pay answer different questions.

## Existing interpreter, not a second engine

Arithmetic and conditional candidates must execute through `executeRuleSpec`. Source parsing may produce exact typed inputs, but must not calculate the answer and then dress it as an interpreter trace. Money multiplication keeps its explicit final rounding. Ratios use the existing rational `divide` operation on two source-derived values with the same currency dimension; the trace records that representation and does not turn the ratio into a rule parameter.

Missing, unknown, conflicting, stale and expired evidence remain separate. A missing remittance is a remittance limitation; a missing work schedule blocks a schedule entitlement calculation, not an unrelated printed sum. A blocked result has no invented zero shortfall. Old private receipts and historical source bytes are immutable.

## Decisions still needed for a rights conclusion

The remaining decision is case-specific acceptance of source period, role/sector coverage, actual working intervals and breaks, relevant better contractual terms, component eligibility, and any live alternative concerning calculation precision. A code reviewer count is an internal trust policy, not proof that the law mandates that number of reviewers. This package does not change REAL authority requirements, create attestation records, or turn conditional calculation into authenticated professional review.
