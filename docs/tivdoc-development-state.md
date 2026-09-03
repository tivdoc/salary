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

Wave 4 runs one unit per commit. `blocked_*` is a result, not a failure: a unit
recorded with evidence is done for the purpose of moving on, and is not retried.

| id | item | status | evidence | blocked_reason |
|---|---|---|---|---|
| 4A-1 | scanner reachability at head | done | 4 findings, 0 product-reachable, 0 unpermitted, on the 237-file graph | — |
| 4A-2 | recompute B-28 | done | 40 / 19 / 84, delta 0/0/0; journey subset recomputes to 8, matching the recorded 8 | — |
| 4A-3 | re-run graph-derived inventories | done | effect asserters 9 ON_JOURNEY shape-only, unchanged | — |
| 4A-4 | graph entrypoint + alias guard | done | both proven by mutation: pass=false, reachable 237→180 and 237→114 | — |
| 4A-5 | controlled-import lock flake | done | `controlled_import_concurrency_lock_timeout` under parallel load; budget 5s→30s, stale takeover unaffected | — |
| 4B-1 | DEV invalidation fixture + convert the 9 assertions | done | 10/10 observed against DEV through the real port, driver and operations role | — |
| 4B-2 | decide `withCurrentAuthorization` | done | zero production callers at the corrected graph — only tests and the disposition record; stays uncalled, the three effects stay `unknown` | — |
| 4B-3 | guard: a shape-only assertion on a claimed effect fails | done | the guard now requires the matrix to reach a database, run the real port, and compare a before and an after reading per effect | — |
| 5E-0 | name the last 2 of the 71 | done | `ACQOBS:WAVE1:1f87feb13c8c6778758e52f9235461dc` and `:3247017fdd24d0b9c86ed8f3916f7578`, both `BYTES_REJECTED_DUPLICATE`, one shared sha256 | — |
| 5E-1..69 | parse the 69 observations | blocked_dependency | all 71 are `application/pdf`; the only PDF dependency is `pdf-lib`, whose API writes text and cannot read it; no OCR dependency; no `extractPdfText` producer anywhere in `src/` or `scripts/` | needs a CID-aware PDF text extractor plus an OCR fallback — a new capability, and `npm install` is forbidden |

### Pools

- A — force RLS, 0/30 resolved. All 30 are `public.*`, all owned by `tivdoc_dev_migrator`, all carrying `tivdoc_service_tenant_scope` granted `to service_role`.
- B — owner reassignment, 0/25 resolved. 9 are trigger functions (no arity, no grant); 16 need re-execution with their exact argument lists.
- E — parse observations, 0/69, pool blocked as above; the separate unit naming the last 2 of the 71 is done.

### What the graph correction changed

`@/*` resolved to the bare remainder rather than `src/*`, so all 232 aliased
edges pointed at nothing and were silently dropped. Product-reachable files went
180 → 237. Together with the `instrumentation.ts` gap fixed in 7389f04 that is
188 files the canonical graph could not see, across runs that all reported
`pass: true`. Both classes are now counted and both fail the gate.

Two conclusions move as a result, and are open units rather than facts: Lane B
reports 28 records claiming NOT wired whose target is now reachable, and 5 of
the 8 `IMPLEMENTED_UNCALLED_SERVICES` entries in `journey-scope-disposition.ts`
naming symbols that are now product-reachable. Reachable is not called, so each
needs checking individually before anything is restated.

## Resume point

- next unit: **pool C** (the 63 mismatched ledger claims), which D6 makes the dependency-free fallback as well as the next queue item. Previous next unit was 4B-1 — build the DEV invalidation fixture (verified actor,
  locked case, idempotency record, created and torn down inside the proof) and
  convert all 9 ON_JOURNEY effect assertions to observe state. Authorized by
  §3.4; it is one unit, fixture and conversion together or neither.
- then 4B-2, 4B-3, then pool A (A-0 first, since the owner-access policy is the
  only dependency the pool has), then pool B, then Wave 4C.
- known blocks that must not be retried: corpus acquisition, creating a second
  Supabase project, resetting the DEV default database, and parsing the 69
  observations without a PDF text extractor.
- correction owed to my own Wave 3 work: migration `202609020005` revoked
  `service_role` EXECUTE from six controlled-import functions on the stated
  reasoning that every caller goes through a connection authenticated as a
  runtime role. Verified on DEV: no runtime role holds EXECUTE, and
  `tivdoc_dev_migrator` is a *member* of the runtime roles rather than their
  parent, so nothing on the runtime path can execute them. Nothing broke,
  because the ledger has no caller at all — but the reasoning was wrong, and the
  claim gets corrected in unit 4C-1 rather than in the applied migration.
