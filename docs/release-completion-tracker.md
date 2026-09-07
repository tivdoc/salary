# Release completion tracker

Authoritative execution: [P00–P13 plan](release-specs/tivdoc-full-development-execution-plan-v1.0-he.md), [UI/UX v1.2](release-specs/tivdoc-uiux-execution-plan-v1.2-he.md). Public copies redact existing customer identifiers; hashes are in the manifest.

Base: `45abb7e70c1001f88192c983b75008f5f5e198c1`, fetched 2026-09-07; PR #1 contains `06ee5f1`. Both GitHub CI runs completed successfully. Dedicated integration branch: `codex/tivdoc-release-completion`. Website work remains in its author's checkout/branch `codex/website-v1-3`; integrate committed changes, never overwrite its uncommitted work.

| Package | Status | Evidence / next action |
|---|---|---|
| P00 | VERIFIED | 75 migrations replayed; five installed upload definitions/ACLs match; privilege checks and 16 closure/replay tests pass. Hosted adapter remains P01/B-002. See release-baseline.md |
| P01 | IMPLEMENTED | Seven baseline failures fixed; 23 tests pass (six files), tsc/lint pass; original upload DB proof rerun. Hosted PostgREST and expanded lifecycle remain open under B-002/P10. |
| P02 | IMPLEMENTED | 46 focused tests, tsc, lint and build pass; five real PostgreSQL checks pass. Saved-report route and v2 provenance contract implemented. Browser and writer composition continue in P05/P08/P11. |
| P03 | IN_PROGRESS | Real extraction and provenance |
| P04 | TODO | Primary-source legal research and seven topics |
| P05 | TODO | Durable engine/product orchestration |
| P06 | TODO | Request lifecycle, SLA and scheduler |
| P07 | TODO | Session rolling/logout and provider delivery |
| P08 | TODO | Saved reports, QA and publication |
| P09 | TODO | Separate orders and entitlements |
| P10 | TODO | Privacy, lifecycle, restore and private case investigation |
| P11 | TODO | Integrate parallel website work and customer surfaces |
| P12 | TODO | Real metrics, monitoring and recovery controls |
| P13 | TODO | Acceptance, rehearsal and release readiness |

Evidence status is never inferred from code existence. An unresolved external substep does not close its package or stop independent implementation. Each checkpoint records its commit in Git history and subsequent entries here.

P00 checkpoint: `aaa5f7a` pushed. P01: original worker objects restored from the engineering archive; signed hashes unchanged, comparison reuses the existing SQL digest contract. Worktree validation checks reciprocal pointers and common object storage.

P02 checkpoint: no real route imports report fixtures. Initial incomplete-basis amounts, inverted ranges, inactive parameters and more than three checked topics fail validation; no checked topics cannot publish. V2 binds order, period, evidence, projection digest and approval input. Legacy safe projections remain readable without fabricated v2 metadata. New migration applied only to isolated release DB, not hosted PostgREST or production. Evidence: `P02-report-db.json`.
