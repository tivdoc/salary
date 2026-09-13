# DEV financial flow: source and composition review

Reviewed 2026-09-09 against the `695cc25672b6c0d423645ea2148b33af2a2e7f36` interim baseline. This document records an independent AI code/source review and a proposed engineering test boundary. It is not human legal verification, a parameter attestation, a rule activation, or evidence that an end-to-end test has passed. The implementation owner must attach execution receipts separately.

## Selected bounded example

Use **June 2026, minimum wage, an explicitly synthetic adult hourly employee in the general 182-hour framework**. The test defines 100 regular hours and ILS 3,300.00 recorded regular base pay for those hours. It defines no additional eligible regular-pay components, no overtime mixed into that pay, no special population or sector regime, and no disputed payroll period. These are fixture assumptions; an actual payslip cannot establish all of them by itself.

The independently specified arithmetic oracle is:

| Quantity | Exact value |
|---|---:|
| Published hourly comparison parameter for the selected framework | 3,540 agorot |
| Regular hours in the selected month | 100 |
| Expected recorded regular pay under the test assumptions | 354,000 agorot |
| Documented regular base-pay component | 330,000 agorot |
| Signed expected-minus-recorded difference | **24,000 agorot / ILS 240.00** |

The oracle is defined independently of the RuleSpec interpreter: `100 * 3540 - 330000 = 24000`, with integer arithmetic and no rounding needed for this vector. It is an engineering expectation, not a legal golden case. A changed document recording 340,000 agorot must produce 14,000 agorot, and an identified answer changing the initially absent hours to 100 must cause a new financial analysis run. No completed finding or report may be inserted by the fixture.

Do not use gross salary as the recorded operand. Do not describe the signed comparison as money proved unpaid by the employer. A payslip records a component; it does not prove settlement or the completeness of all legally eligible components. Preserve zero and negative signed results rather than manufacturing a positive finding.

## Primary sources and existing byte evidence

The [National Insurance Institute rate table](https://www.btl.gov.il/Mediniyut/GeneralData/Pages/%D7%A9%D7%9B%D7%A8%20%D7%9E%D7%99%D7%A0%D7%99%D7%9E%D7%95%D7%9D.aspx), opened on 2026-09-09, lists rates effective 2026-04-01: ILS 35.40 for the 182-hour framework, ILS 34.64 for 186 hours, and ILS 6,443.85 monthly. The page is official implementation corroboration, not an independently operative instrument. In particular, `182 * 35.40 = 6,442.80`; this hourly calculation must not be presented as the monthly floor.

The [official consolidated Minimum Wage Law PDF](https://www.btl.gov.il/Laws1/00_0021_000000.pdf), opened as a five-page PDF on 2026-09-09, contains the adult/full-time, part-time and absence provisions in section 2, and the included/excluded wage-component provisions in section 3, on PDF page 1. Sections 1 and 6 concern the monthly definition/publication mechanism. Their text does not by itself prove this customer's employment regime or the completeness of the historical amendment chain. The current text visibly mentions a 2017 amendment in a page-1 footnote, so the old repository annotation `consolidated_through_2015` is insufficient evidence of the current file's consolidation boundary. No fresh-byte equality to the archived hash was established in this review.

The [2018 extension order](https://www.gov.il/BlobFolder/dynamiccollectorresultitem/extention-order-short-week-2018/he/extention-order-short-week-2018.pdf) is the primary order already identified in the release research for the 42-hour framework. A fresh web open returned **403** in this review. Its existing two-page archive was found and its raw hash verified locally; that verification is byte identity, not fresh publication verification. Sections 2.1 and 2.8 are the locators recorded by the earlier research. This review did not independently re-render and verify those two section locators.

| Source/evidence | Version, locator and hash | Verification performed here |
|---|---|---|
| Minimum Wage Law, existing dossier | `IL_MIN_WAGE_LAW@discovery-v0`; page 1 chunks `#0001-899646b34a0f` and `#0002-bcf9eab6819e`; archived artifact SHA-256 `4674f07928a2397b626db362c6c9b98b7c4e77e693e397463fdabd83c7f4f161`; parsed SHA-256 `73bc54903838255950f3236af7a7b55c903a86591f445763839ad8eee9e27446` | Read the repository dossier and current official web PDF text. The raw archived law file was not present in this checkout; these are recorded hashes, not newly reverified raw bytes. |
| BTL rate table, existing dossier | `IL_MIN_WAGE_OFFICIAL_RATES@discovery-v0`; logical page 1, chunk `#0002-ec7402f2ab89`; archived artifact SHA-256 `1d8c2d67faabc435f66b76ccf45dda94d5c16a96c534f6bc7732d4f70366946b`; parsed SHA-256 `d4c01a484bb0b8ca6efeca33f839204346c26da118a3a1577eb68dfab34cdd1d` | Current official page confirms the chosen rate/date. Its archived raw HTML was not present in this checkout; no claim of byte equality to the current page. |
| 2018 order archive | `docs/release-evidence/legal-source-pages/IL_SHORT_WORK_WEEK_EXTENSION_ORDER_2018.pdf`; 179,205 bytes, two pages; SHA-256 `fa27b689656194ef65d207fd6f68ec7c54c2c78d4362b2a5a2a5d3a207831a4b`; archived retrieval 2026-08-29T18:10:03.468Z | `Get-FileHash` matched `P04-source-manifest.json`; `pdfinfo` confirmed page/byte counts. Fresh web fetch was 403. |
| Dossier record itself | `src/engine/legal-knowledge/review-dossier/minimum-wage-evidence.v0.4.json`; SHA-256 `1354756f6b87ec1454a93b0e96cc7c4020946143d6174bf1183bfec90945ce19` | Raw local hash computed. The dossier explicitly lists unresolved review/activation gates. |

The attempted fresh open of [the 2023 gazette artifact already listed in the source manifest](https://fs.knesset.gov.il/25/law/25_lsr_3020007.pdf) failed in the web tool. This review does not treat that artifact as inspected or the amendment history as resolved. The absent `eval/legal-knowledge/manifests/` tree also prevents independently rerunning the old Pool P source importer against its original built chunks from this checkout.

## Existing executable code and the activation boundary

`src/engine/legal-quality/sensitivity-rulespecs.ts` exports `MINIMUM_WAGE_HOURLY_SPEC`: `il.rulespec.minimum.wage.hourly.entitlement@1.0.0`, effective from 2026-04-01, `catalog_boundary: real_inactive`. It multiplies an hourly monetary input by a dimensionless hours multiplier with half-up rounding. The referenced golden set is explicitly blank. This is a narrow arithmetic specification and contains no complete applicability decision or comparison to recorded pay.

`scripts/legal-review-projection/pool-p-batch-1-minimum-wage.mts` declares the draft parameter `il.minimum_wage.hourly@2026.1.0`, 3,540 agorot, branch `182`, effective 2026-04-01. It binds the official rate table and 2018 order through the existing importer. The bare RuleSpec declaration uses `il.minimum.wage.hourly` while the sensitivity binding/register uses `il.minimum_wage.hourly`. A new exact binding must resolve that identifier difference explicitly; do not pass it through as if the identities match. New rule hashes also require a new explicitly derived parameter binding, without mutating any old candidate or giving it attestations.

`src/engine/calculations/source-trace.ts` can replay full saved facts, RuleSpec and parameter packages with hashes. Its authority remains `arithmetic_provenance_only`. It accepts only confirmed fact operands, checks parameter/rule bindings, and requires its facts snapshot to name the same analysis run. `src/engine/findings/source-comparison.ts` requires a final explicit subtraction and a documented recorded-pay fact; it deliberately returns `is_finding: false` and `pricing_allowed: false`. These protections must remain intact for the real path.

The real catalog (`src/engine/legal-operations/catalog.ts`) has zero active sources, parameters and rules. Real candidates have unverified citations, intervals and population/sector scope, no human review and no activation. `CaseAnalysisService` independently recomputes readiness; supplying a different executor does not authorize a rule. `runSavedMonthAnalysis` uses the real catalog and an executor that throws `SAVED_RULE_EXECUTOR_NOT_ACTIVATED`. The PostgreSQL canonical completion path calls `assertFindingsDisabled`, and the ordinary report builder rejects arithmetic-only source traces as `ARITHMETIC_PROVENANCE_NOT_PUBLISHABLE`.

Real-client readiness therefore still requires source identity and amendment/interval evidence, applicable population/sector and wage-component evidence, the required independent parameter attestations, reviewed RuleSpec/golden evidence, explicit activation and a live extraction accuracy proof. This review grants none of those. An AI service promise does not turn AI research into human review.

## Recommended engineering composition

Create an explicitly engineering-only **financial analysis run** with its own deterministic ID, linked to the completed canonical parent run and exact saved input revision/SHA. The canonical parent remains legally blocked. Do not relabel its existing topic result as calculated or append a finding into its disabled canonical finding table.

The financial run should own a derived facts snapshot and a transformation receipt that binds the exact parent facts snapshot SHA, each preserved fact ID/value/provenance, and any separately identified customer missing-field answer. Its own snapshot and trace use the financial run ID. Persist the derived financial finding, run, comparison, HTML and PDF together under that same ID. The report identifies the parent and financial run IDs and explains the engineering-only boundary. A result-to-report link alone is insufficient if the evidence can come from a different run.

For units, normalized `regular_hours` is `hours_per_month`, not `hours` or `ratio`. Keep that unit in the source fact and first divide by an explicit unit-one constant with the same `hours_per_month` unit in the RuleSpec. The resulting ratio can enter the existing `money.scale` operation. Then use an explicit final `subtract(expected, recorded_base_pay)`. No hidden numeric conversion or factual trust promotion belongs in the report projection.

Admission must require the actual allowlisted isolated DEV database/project, a saved `is_qa` case, purchased June/minimum-wage scope and the verified scoped worker session. An environment flag or client-supplied `is_qa` is not sufficient. Read access must use the existing authenticated identity-to-case ownership and a separate engineering artifact contract; ordinary publication policy and customer financial-result types remain unchanged. No sale, payment, refund or production switch is part of this lane.

Hold `lockCurrentSource` through result persistence and setting the current engineering report pointer. It serializes the case row and checks the exact input head. After a replacement or answer revision, an older job must fail with `ANALYSIS_INPUT_SUPERSEDED`; it must not regain a current pointer through replay. Use unique deterministic run/result/publication identities and compare existing immutable payload hashes on retry. A process restart must load saved checkpoints and artifacts rather than insert another logical finding.

## Literal missing input and request authorization review

Existing `document_field:*` requests can confirm a present, low-confidence `regular_hours` candidate, and `SavedCaseSnapshot` incorporates that exact identified reading. They **cannot** solve a genuinely absent/null field: `documentFieldTargetSchema` intentionally rejects it. Testing only low confidence must not be reported as a literal missing-field test.

For a null hours field, a separate DEV-only missing-reading target can use the existing number-answer UI and identified answer ledger. It must pin case, product document, immutable version/hash, June, `work.regular_hours`, purchased topic, extraction checkpoint and opening input revision. Only the engineering facts transformation may interpret that identified decimal answer; the real canonical facts must continue to represent the original missing extraction. The transformation receipt must explicitly say `customer supplied reading`, preserving request ID, immutable answer revision, identity and source locator. It is not a machine/OCR reading.

Static inspection of the current migration chain found these pitfalls:

- `public.case_request_open` is the original invoker insert function, with broad runtime table policy. It supplies neither identity nor an explicit month. It is a convenience, not sufficient authorization for the new financial target. No actual-role DB invocation was performed in this review.
- `private.pin_request_statement_month` defaults a generic inserted question to `cases.check_period_month` and then forbids changing that scope. For this one-month lane, assert the primary month is June or introduce a precise target-aware branch in a new migration; never backfill scope after opening.
- The public identified-answer function verifies `case_identity_cases` and locks case before request. Original answer identity and append-only correction revisions already enter the source journal, causing input invalidation.
- Existing source-change rejection in `guard_document_field_answer` applies to the `document_field:*` prefix. A new DEV code needs its own equivalent checks; borrowing the generic answer endpoint does not supply them.
- Corrections insert directly into `private.case_request_answer_versions`; a guard only on `public.case_requests` misses that path. Validate the exact target, current version and actor for both the initial answer and correction. Expired/closed targets, foreign identities and superseded versions must not become engineering operands.
- Generic number validation permits signed and large values. The DEV hours boundary must validate a bounded nonnegative exact decimal independently in the server/DB and transformer, including zero as distinct from missing. Do not broaden that change to unrelated product requests.
- The one-open-request index is on case and code. Derive the code from an immutable target hash to prevent two versions/months sharing a question or receiving an answer intended for another target. On conflict/retry, read and verify the existing exact target; an empty `INSERT ... RETURNING` is not proof of success.

## What this review proves and leaves to execution

This review proves the current code composition gaps and records independently specified arithmetic plus the primary rate corroboration. It does not prove DB permissions, migrations, request behavior, extraction, rendering, source authorization or restart behavior. Required execution evidence remains: actual uploaded synthetic source bytes, worker extraction checkpoint, missing answer and new financial run, derived findings and report bytes from that run, stale-run refusal, restart/retry identity, HTML/PDF parity, foreign case/source rejection and cleanup receipts. Injected OCR and live OCR must have distinct results and artifact provenance. A generated synthetic PDF read only by an injected extractor is not evidence of OCR reading the PDF.
