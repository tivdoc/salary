# Tivdoc development state

- wave: 2 of the rolling queue — journey-scope closure of `B-28` and `B-38`
- base: 0e3c700b7dd9e603fc389d733fdc55672693aa13
- head: pending
- frozen_head: pending
- date: 2026-09-02

## Ledger

| lane | id | item | status | evidence |
|---|---|---|---|---|
| A | W2-1 | B1 — effect booleans made honest | delivered | `effect-honesty.test.ts`; `postgres-port.ts` derives all six |
| A | W2-2 | B3 — `B-38` per-path disposition | delivered | `journey-scope-disposition.ts` + test |
| A | W2-3 | `B-28` counters recomputed, journey subset recorded | partial | `output/wave2/audit/entrypoint-counters.json`; no orphan seam wired, deliberately |
| A | W2-4 | B4 — complete DEV dynamic matrix at this head | delivered | `output/wave2/audit/dynamic-matrix.json` — 14 checks, 10 supported, 10 passed, 4 not supported |
| A | W2-5 | scanner finding on new code repaired | delivered | `scripts/local-postgres-dev/provision.mts` builds URLs through the URL API |
| B | effects | consumer enumeration | delivered | `output/wave2/agents/effects/findings.md` |
| B | orphans | caller search across claimed services | delivered | `output/wave2/agents/orphans/findings.md` — 6 more |
| B | secdef | `SECURITY DEFINER` least-privilege audit | delivered | `output/wave2/agents/secdef/findings.md` — 114 functions, 35 violation sites |
| B | scanner | import-graph re-proof | delivered | `output/wave2/agents/scanner/findings.md` |

## Decisions

- **The four effect booleans were not an incomplete feature; the verifier was in
  on it.** `assertApplied` and `assertReceipt` both demanded `=== true` on every
  effect field, so an honest port reporting what it measured would have been
  rejected as `GLOBAL_INVALIDATION_APPLY_INCOMPLETE`. The producer invented the
  literal and the verifier certified it back — tautological self-certification.
  Both now check the *shape* of an outcome and the one relation that is real
  (`historical_evidence_preserved` iff `historical_versions_deleted === 0`),
  never that a particular effect occurred.

- **Three fields are `"unknown"`, and that is not a placeholder.**
  `approval_invalidated` had a real count that was computed and discarded, so it
  is now `approvalsInvalidated > 0`. `cache_versioned` follows from the epoch
  row update the method already asserts. `historical_evidence_preserved` follows
  from a measured deletion count. But `stale_execution_blocked`,
  `stale_approval_blocked` and `stale_download_blocked` have **no computation at
  all** — nothing in the transaction blocks anything, and the only enforcement,
  `withCurrentAuthorization`, has no caller. Reporting `false` would claim
  "we looked and nothing was blocked", which is as untrue as `true`. The type is
  `boolean | "unknown"` and readers must handle the third case.

- **`receipt_sha256` changes, and that is correct.** The effect fields are inside
  the canonical hash, so a receipt written before this change hashes differently
  from one written after. The values genuinely differ; a stable hash across a
  content change would be the defect.

- **B-38 is `not_applicable_at_current_scope` on all three journey paths, with
  the fact that decides it pinned by test.** A review packet has no case:
  `governance_legal_review_packets` contains no `case_id` at all, while
  `engine_global_dependency_state` is keyed by `(tenant_id, canonical_case_id)`.
  No run, report, approval or grant depends on a packet while
  `activation_allowed` is constrained to `false`. Inventing a case id to give
  the invalidation something to write would fabricate the dependency it claims
  to track. The test asserts both facts, so if a packet ever gains a case the
  disposition fails rather than going stale.

- **Eight services are recorded `implemented_uncalled` rather than wired.**
  §3.3 forbids building surface nothing calls and §3.10 forbids inventing a
  caller to satisfy a claim. Four of the eight carry a claim somewhere —
  `installInternalOpsPorts` and `resolveInternalOpsRuntime` in
  `canonical-entrypoints.v0.10.0.json` CEP-080,
  `installCanonicalProductRouteServices` in a V0.8.0 trace receipt,
  `createPortalApi` in `docs/overnight-v0.7-p6.md`. Wiring them would add a
  second construction path for a service that already has a working one, which
  is precisely the confusion that cost earlier runs. The frozen entrypoint
  ledger was not edited: deleting an owner-facing claim is the owner's call.

- **A scanner finding on code this session introduced was repaired, not
  permitted.** `scripts/local-postgres-dev/provision.mts` hand-assembled
  `scheme://user:pass@host`, which the `credential_url` rule cannot distinguish
  from an embedded credential — correctly, since it should not have to. It now
  builds through the `URL` API, which also fixes the escaping. The two other new
  hits are test files and fall inside the existing `TEST_ONLY` class.

## Blockers

| id | blocker | class | evidence |
|---|---|---|---|
| BL-1 | four identity-session functions filter on a caller-supplied `tenant` argument instead of `runtime_verified_tenant()`, are unowned so they run as the table owner, and `public.product_identity_sessions` has no forced RLS — cross-tenant read, rotate and revoke are reachable by any caller controlling the tenant argument | security_defect | `output/wave2/agents/secdef/findings.md`; `202609010002:130,153,196,232`, `202609010003:19,43` |
| BL-2 | 35 `SECURITY DEFINER` sites have no `alter function … owner to`, so they run as the migration executor and tenant policies are inert for them | security_defect | same findings file |
| BL-3 | the security scanner computes no reachability; its permitted findings rest on absence from a stale 753-node graph, and its stored receipt is 11 commits behind HEAD | evidence_defect | `output/wave2/agents/scanner/findings.md` |
| BL-4 | eight services are `implemented_uncalled`, four of them claimed by a contract or receipt | product_gap | `output/wave2/agents/orphans/findings.md` |
| BL-5 | 69 of the 71 observations are byte-complete but unparsed | external | Wave 3 scope |
| BL-6 | Windows Application Control blocks `initdb.exe` | blocked_external | not on any critical path |
| BL-7 | `V041_MISMATCH_004` bytes are gone; recorded, not re-baselined | evidence_integrity | `evidence-loss.v0.10.11.json` |
| BL-8 | min-wage and Knesset convalescence byte changes await human legal review | blocked_human | blocks no engineering item |
| BL-9 | `synthetic-property-suite` scanner finding needs a placement decision | blocked_human | `OWNER_POLICY_REQUIRED` |

## Counters

REAL_LEGAL_TOPICS_READY: 0/7
REAL_SOURCES_ACTIVE: 0
REAL_PARAMETERS_ACTIVE: 0
REAL_RULES_ACTIVE: 0
REAL_CALCULATIONS_OR_FINDINGS: 0
REAL_CUSTOMER_DATA_READS: 0
HUMAN_GROUND_TRUTH_LOCKED: 0
CUSTOMER_SHADOW_AUTHORIZED: NO
PRODUCTION_DELIVERY_ENABLED: NO
DEPLOYMENTS: 0
REMOTE_PRODUCTION_MIGRATIONS: 0
LIVE_PROVIDER_CALLS: 0
OPENAI_CALLS: 0

B-28 recomputed at this head: strict 40, MC-29 19, denominator 84, difference 21.
8 of the 40 lie on the journey, all `CAPABILITY_GATED_CANONICAL_SOURCE`, so the
strict-versus-MC-29 divergence does not touch it.

Chain unchanged: 26/26 applied — 24 verbatim byte-pinned, 2 platform-compensated
(`alter role … nosuperuser`; `supautils` reserved-role refusal), dropped lines
recorded, end state asserted.

## Units

One unit, one commit. `blocked_*` is a result, not a failure: a unit recorded
with evidence is done for the purpose of moving on, and is not retried.

### Pool C — canonical entrypoint claims: 21/21 decided

The backlog said 63. That count came from a graph missing 188 files, and from
asking every record a question only some of them answer. Recomputed at this head
the disagreement is 21 records, all in one direction, and all of them are now
decided.

| id | item | status | evidence |
|---|---|---|---|
| C-1 | Next.js metadata files as entrypoints | done | `robots.ts`, `sitemap.ts`, `opengraph-image.tsx` — CEP-010/011/012 were right, the graph was wrong |
| C-2 | ask each record the question its kind answers | done | 45 of 95 are `cli` records naming scripts, never product-reachable; 16 false mismatches went to 0 |
| C-3 | CONTRACT_ONLY is not a wiring claim | done | all five are blocked on human content gates; CEP-048/057/058/059 retired |
| C-4 | judge the symbol, not the module | done | `SupabasePrivateBlobProvider` is constructed by nothing; CEP-016/017 retired |
| C-7 | CEP-078, CEP-079 restated | done | composition root installs at durable-local-runtime.ts:230; routes resolve at durable-registration.ts:89 |
| C-8 | CEP-006/007/020/025 restated | done | all four routes resolve the installed service; MANAGED_IDENTITY_NOT_PROVEN stands |
| C-9 | CEP-082 restated | done | `PostgresIdentitySessionStateReader` wired at :160 and exercised by the identity negative matrix |
| C-10 | the nine that stand | done | each carries its reason in the matrix open set; a tenth arrival fails the check |

### Pool A — RLS forcing: 14/30 forced, `rls_forced` 45/74

| id | item | status | evidence |
|---|---|---|---|
| A-0 | prove the force mechanism | done | on DEV in a rolled-back transaction: forced without the GUC gives 42501 on insert and zero rows; with it the insert reaches the domain constraint |
| A-1 | RLS matrix seed declares the tenant | done | admin seed pool per tenant; case-confirmation probe on one checked-out client |
| A-2 | force the 14 writer-clean tables | done | journey 16/16, dynamic 10/10, identity 8/8, invalidation 10/10, grants 19/0, projection balanced |
| A-3 | browser-e2e audit read | done | a pooled owner read of a now-forced table would have failed as a missing timeline action |
| A-5 | browser seed, repair cleanup | done | the cleanup deleted `tenant_id in ($1,$2)` under a policy that tests one value — it would have matched nothing and raised nothing |
| A-6 | the reads that go blind | done | `inspectDurableResult` counts two forced tables; the browser logical-effect read went through the pool |
| A-7..A-22 | the other 16 tables | blocked_external | their writers are corrected but unproven: both harnesses need a local Postgres cluster this host does not have, and forcing on a reading rather than an execution is what the per-table rule forbids |

### Pool B — definer owner reassignment: 5/25, 20 remain

| id | item | status | evidence |
|---|---|---|---|
| B-1 | the four pure refusal triggers | done | two probes fired and matched exactly before and after; two could not fire and are recorded `reassigned_probe_vacuous_body_only_raises`, because a body that is a single unconditional raise cannot behave differently under another owner |
| B-2 | `enforce_engine_analysis_run_history` | done | P0001 "Terminal analysis runs are immutable", identical before and after |
| B-3..B-7 | the other five history guards | blocked_dependency | their tables are empty so the probe never fires, and unlike the refusal triggers their bodies read rows — the harness declines to reassign on a vacuous probe |
| B-8..B-20 | the salary and controlled-import definers | open | each needs its owner granted the table privileges its body uses before reassignment, which is the shape that broke identity registration in Wave 3. Measured benefit is nil: the definer surface matrix reports no site ungated by ownership, and `tivdoc_dev_migrator` is neither superuser nor BYPASSRLS |

### Pool E — parse the 69: 62 parsed, 7 blocked

| id | item | status | evidence |
|---|---|---|---|
| E-0 | pinned Python extraction path | done | `output/pdf-venv`, Python 3.13.5, pypdf 6.16.2, `pip freeze` recorded; nothing under `node_modules` touched |
| E-1 | parse all 69 | done | 62 parsed, 642 chunks, 859,905 normalized characters, parser `pypdf-6.16.2-layout`, normalizer `legal-normalizer-v0` |
| E-2 | say which problem each failure has | done | the extractor reports the font census; all seven resolve to `TEXT_LAYER_ABSENT_SCANNED`, zero to `GLYPHS_UNMAPPABLE` |
| E-3..E-9 | the seven scans | blocked_external | every page carries zero font resources and one full-page image — 191 scanned pages needing OCR, and this host has Tesseract 5.4.0 with no Hebrew traineddata |

Four properties are recorded rather than corrected. The text comes out in
**visual order**, and the reversal covers digit runs as well as letters — 1951
extracts as 1591 — so anything citing an amendment number or a date has to undo
it first. Four of the 62 hold a page the parser could not read, now counted in
`pages_without_text`. And 62 artifacts carry 61 distinct normalized hashes: two
observations with different bytes normalize identically, which leaves them two
artifacts, not one.

Nothing was written to a database, nothing activated, nothing marked reviewed,
and no blocked record was touched.

### Carried items

| id | item | status | evidence |
|---|---|---|---|
| X-1 | controlled-import grant | done | 202609020005 revoked the grant its own header said nothing used; the dynamic harness authenticates as `service_role` (run.mts:375), restored by 202609020006 |
| X-2 | permission denial names itself | done | `mapDatabaseError` had no case for 42501 and reported it as `IMPORT_ROW_MALFORMED` |
| X-3 | ignore `output/agents/` and `output/pdf-venv/` | done | three agent files had reached a commit; untracked, not deleted |
| X-4 | narrow the eight `public.*_salary_*` grants | open | §3.6 requires moving the three `supabase.rpc` callers first, and they are payment and attribution paths in `src/lib/ga4-server.ts`, `src/lib/meta-purchase.ts`, `src/lib/verify-payment.ts` and `src/app/api/cases/status/route.ts`. An unattended run should not refactor money-adjacent callers |

## Owner decision required

A parsed observation is supposed to yield a new packet, with the blocked record
left immutable and linked by `superseded_by`. Two things make that a decision
rather than a task. The durable blocked-record table was deliberately built with
no `superseded_by` column so that graduation is impossible by construction, so
the link needs a new append-only table beside it. And the projection asserts
`accounted = projected + blocked` against a denominator of 71; 62 packets
alongside 71 immutable blocked records does not satisfy that invariant under any
reading, so the model has to distinguish an observation from an artifact derived
from it. Changing an asserted invariant is not something this run will do on its
own initiative.

## Resume point

- next unit: **A-7** — but only on a host that can run the marathon harness
  against a local Postgres cluster. The sixteen writers are corrected; what is
  missing is the execution that proves them.
- known blocks that must not be retried: corpus acquisition, a second Supabase
  project, resetting the DEV default database, OCR for the seven scanned
  observations, and forcing the remaining sixteen tables without a harness run.
