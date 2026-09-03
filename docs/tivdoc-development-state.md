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
recorded, end state asserted.## Units

One unit, one commit. `blocked_*` is a result, not a failure, and the class
matters: `blocked_external` means something outside the repository and outside
DEV refuses the work; `blocked_dependency` names the thing inside reach that
unblocks it.

### Pool A — RLS forcing: 30/30, `rls_forced` 62/75 (every tenant-scoped table)

F1 was right that the pool had one dependency and it had not landed. The run
had gone round it — measuring that the migrator reaches these tables through
`tivdoc_service_tenant_scope` by inheriting service_role — and left sixteen
tables stalled on a fixture proof this host cannot execute. A-0 landed the
owner-access policy on all 33 tables the migrator writes as owner; the sixteen
were forced in the same migration and verified by every DEV matrix. The writer
corrections stay as hygiene.

### Pool B — definer owner reassignment: 25/25 accounted

| outcome | count | detail |
|---|---:|---|
| reassigned, proven twice | 5 | two refusal triggers matched their exact SQLSTATE and message before and after; two have bodies that are a single unconditional raise; `enforce_engine_analysis_run_history` matched P0001 "Terminal analysis runs are immutable" both ways |
| `blocked_dependency` on a fixture | 5 | the history guards read rows, their tables are empty, and the harness declines to reassign on a probe that never fired |
| `not_reassigned` with reason | 15 | `tivdoc_governance_owner` holds no privilege on any table these bodies write; the grant step D4 requires first would widen a governance role into the customer `payments` and `cases` tables for a benefit the definer surface matrix measures as nil |

### Pool C — canonical entrypoint claims: 21/21 decided, 60 sweep ids accounted

The 63 is not reproducible. The sweep's named list holds 49 ids plus 13 cli
records it described but did not name; of those 13, eleven resolve by the cli
question, CEP-065 by the alias fix and CEP-068 because PARTIAL is not a
not-wired claim. 49 + 13 = 62; the sweep's own subtotal said 35 where its list
held 34. So the three between 63 and 60: two are CEP-065 and CEP-068, which the
sweep filed under the cli group and which resolved for other reasons, and one is
the sweep's arithmetic.

### Pool E — parse the 69: 69/69, superseded on DEV

From the database, as the operations runtime role:

    projected 0 + blocked_active 2 + blocked_superseded 69 = 71
    packets_from_supersession = 69

The two `blocked_active` are `ACQOBS:WAVE1:1f87feb13c8c6778758e52f9235461dc`
and `ACQOBS:WAVE1:3247017fdd24d0b9c86ed8f3916f7578`, both
`BYTES_REJECTED_DUPLICATE`, one shared sha256 `f56c47027a69ea6b…`, 88,142
bytes — two gov.il collector URLs for one document.

Seven of the sixty-nine packets carry `ocr_derived: true` with the recognizer
version; the review package v4 holds all sixty-nine, builds twice to one hash,
and every item is not_reviewed, not_signed, not_activated, not_delivered.
Counters unchanged.

### Security finding — closed

`tivdoc_service_tenant_scope` bound `tivdoc_dev_migrator` on all 33 tables it
sat on: the migrator inherits service_role, RLS matches with
`has_privs_of_role`, and the policy's test was a caller-settable GUC. The
closure of service_role is five roles; two inherit; postgres bypasses RLS and
the migrator owns the tables — so nothing reached a table through the policy it
could not reach otherwise, which is a fact about ownership and not the claim the
Wave 3 ledger made. The policy is dropped on all 33 behind the owner-access
path; the closure matrix reads policy_tables 0, widening_rows 0. The Wave 3
statement is corrected in place in the definer surface matrix.

### Carried items

| id | item | status |
|---|---|---|
| X-1 | controlled-import grant | done |
| X-2 | permission denial names itself | done |
| X-4 | narrow the eight `public.*_salary_*` grants | open — moving three payment-path `supabase.rpc` callers is not for an unattended run |
| X-5 | name the last 2 of the 71 | done, from DEV |
| X-6 | supersession table and three-state invariant | done, asserted from DEV |

## Resume point

- next: Wave 5 G-2 once G-1's enumeration lands; then G-3..G-12; then Wave 6.
- B-3..B-7 once a fixture exists per history guard.
- known blocks that must not be retried: corpus acquisition, a second Supabase
  project, resetting the DEV default database, `initdb.exe` under Windows
  Application Control (BL-6).
