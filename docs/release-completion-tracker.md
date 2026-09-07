# Release completion tracker

Authoritative execution: [P00–P13 plan](release-specs/tivdoc-full-development-execution-plan-v1.0-he.md), [UI/UX v1.2](release-specs/tivdoc-uiux-execution-plan-v1.2-he.md). Public copies redact existing customer identifiers; hashes are in the manifest.

Base: `45abb7e70c1001f88192c983b75008f5f5e198c1`, fetched 2026-09-07; PR #1 contains `06ee5f1`. Both GitHub CI runs completed successfully. Dedicated integration branch: `codex/tivdoc-release-completion`. Website work remains in its author's checkout/branch `codex/website-v1-3`; integrate committed changes, never overwrite its uncommitted work.

| Package | Status | Evidence / next action |
|---|---|---|
| P00 | VERIFIED | 75 migrations replayed; five installed upload definitions/ACLs match; privilege checks and 16 closure/replay tests pass. Hosted adapter remains P01/B-002. See release-baseline.md |
| P01 | IMPLEMENTED | Seven baseline failures fixed; 23 tests pass (six files), tsc/lint pass; original upload DB proof rerun. Hosted PostgREST and expanded lifecycle remain open under B-002/P10. |
| P02 | IMPLEMENTED | 46 focused tests, tsc, lint and build pass; five real PostgreSQL checks pass. Saved-report route and v2 provenance contract implemented. Browser and writer composition continue in P05/P08/P11. |
| P03 | IMPLEMENTED | Verified saved-upload adapter + existing v2.1 pipeline, 0.95 acceptance, absolute arithmetic tolerance, bounded PDF/raster input and explicit untrusted-document prompt. 101 extraction/provider tests + five new boundary tests pass; preprocessing tests, tsc/lint/build pass. Durable invocation P05; live provider/calibration B-004. |
| P04 | IMPLEMENTED | Seven-topic research, 51/51 v15 hashes, seven visual readings, 42 AI expectations + seven refusal checks, safer travel/sick RuleSpecs and leave reconciliation. 224 tests/25 files + tsc/lint pass. Full applicability, human goldens/activation and unresolved branches remain B-005. |
| P05 | PARTIAL | Atomic source journal/outbox and bridge to existing canonical job queue; eight real DB checks and five fencing tests. Full saved-extraction → canonical composition → projection transaction and hosted two-case journey remain open. |
| P06 | IMPLEMENTED / integration pending | Field-preserving requests, typed answers, durable drafts/corrections, expiry/reminder intentions, worker CLI and Jerusalem business clock. 129 tests, 11 actual DB checks, typecheck/lint/build pass. Hosted schedule, provider delivery, order-bound SLA and browser proof remain. |
| P07 | PARTIAL | Cookie/DB expiry alignment and logout, encrypted Resend outbox, Svix inbox, provider receipts, suppression and reminder bridge. 12 actual DB checks; focused tests pass. Provider/DNS/browser proof and contact-change re-verification remain; flags off. |
| P08 | IMPLEMENTED / integration pending | Saved report history, identity-scoped PDF/source, correction intake, actual QA preview/assignment/approval fingerprint, immutable published content and transactional delivery intention. 9 review + 4 retained-source DB checks; browser and canonical correction/calculation composition remain. |
| P09 | PARTIAL | Independent immutable order scope/price, atomic checkout claim, worker verification/entitlement, report binding and persisted clocks. 14 order + 10 review + 4 source DB checks, 37 focused tests, tsc/lint pass. Provider receipts/refunds, full historical capacity and canonical/browser integration remain. |
| P10 | PARTIAL | Owner privacy/export, retention fences and audited draft sweep; 12 DB + 4 real Storage checks. Actual 118-table restore and private read-only inquiry complete. Full purge, contact re-verification and browser/operational proof remain. |
| P11 | PARTIAL | Merged ac319bf branding into current flows; four-destination case shell and saved-state overview. 13 focused tests + lint pass. Final build/typecheck/browser blocked by disk/system memory; actual example, clock and broader acceptance remain. |
| P12 | TODO | Real metrics, monitoring and recovery controls |
| P13 | TODO | Acceptance, rehearsal and release readiness |

Evidence status is never inferred from code existence. An unresolved external substep does not close its package or stop independent implementation. Each checkpoint records its commit in Git history and subsequent entries here.

P00 checkpoint: `aaa5f7a` pushed. P01: original worker objects restored from the engineering archive; signed hashes unchanged, comparison reuses the existing SQL digest contract. Worktree validation checks reciprocal pointers and common object storage.

P02 checkpoint: no real route imports report fixtures. Initial incomplete-basis amounts, inverted ranges, inactive parameters and more than three checked topics fail validation; no checked topics cannot publish. V2 binds order, period, evidence, projection digest and approval input. Legacy safe projections remain readable without fabricated v2 metadata. New migration applied only to isolated release DB, not hosted PostgREST or production. Evidence: `P02-report-db.json`.

P03: `saved-payslip.ts` composes the existing extractor and fact resolver; it does not introduce a legal engine. Storage coordinates come from a case+version SQL lookup and immutable bytes are rehashed before use. Changed prompt/resolution versions are explicit; model unchanged. Model high=0.94 remains 0.94 and cannot alone meet the 0.95 release threshold. This is conservative acceptance, not measured 95% accuracy. The saved-source test uses generated PDF bytes and injected ports; it is not DB/provider evidence.

P03 verification correction: the first saved-pipeline build found a missing required `declared_document_type` on the extraction request. It was fixed immediately after checkpoint `981e9ce`; the previous pass claim was premature. The follow-up check/commit records the actual result.

P07 final checkpoint: 51 focused tests pass; typecheck and lint pass with zero warnings. The PostgreSQL proof passes 12 checks, including late token receipts and cancellation of answered reminders before claim. Reminder enqueue/link is atomic. Build completed before the final race guards with an ENOSPC cache persistence warning; the final edits are covered by typecheck/lint, not a clean final build. HEAD-based route closure runs immediately after this checkpoint commit. No provider mail, hosted schedule, DNS or production change.

P07 checkpoint pushed: `44ed78a` (implementation `2ed96fd`), including 8 HEAD route tests. P08 additionally corrected the full capability registry denominators (110 entries / 99 product-stable / 42 dispatch roots), which the prior focused route checks did not cover. Broadened capability checks now accompany route registration.
