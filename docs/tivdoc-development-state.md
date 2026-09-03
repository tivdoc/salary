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

One unit, one commit. `blocked_*` is a result, not a failure. The class matters:
`blocked_external` means something outside this repository and outside DEV
refuses the work; `blocked_dependency` means it becomes workable the moment
something inside reach lands. Two entries were carrying the wrong class and are
corrected below.

### Pool C — canonical entrypoint claims: 21/21 decided, all 60 accounted

The pool said 63. That figure is not reproducible: the sweep that produced it did
not record its predicate, and three defensible readings of its own prose give 34,
49 and 88. Its named list holds 49 ids, plus 11 cli records it described but did
not name — 60, reported as 63. Every one of those 60 is accounted for by id in
`claim-pool-reconciliation.mts`, which re-evaluates each under the original rule
and then under each correction in the order it landed.

| resolved by | count |
|---|---:|
| never disagreed once the record's own claim is read (12 EXTERNAL_OR_HUMAN_BLOCKED, 6 CONTRACT_ONLY/PARTIAL) | 18 |
| a cli record names a script, and scripts are evidence entrypoints | 13 |
| PARTIAL is not a claim that nothing is wired | 9 |
| the record was restated because its blocker had gone stale | 6 |
| Next.js metadata files were entrypoints the graph did not know | 3 |
| the symbol the record names is used by nothing, so the record was right | 2 |
| still open, each with its reason recorded in the claim matrix | 9 |

### Pool A — RLS forcing: 14/30 forced, `rls_forced` 45/74

A-0 through A-7 are done: the mechanism proven on DEV in a rolled-back
transaction, fourteen tables forced and verified by every DEV matrix, and every
owner-connection writer and reader corrected — the RLS matrix seed, the browser
seed and its two blind reads, the repair cleanup and its inspection, and the
terminal-history proof.

A-8..A-23, the remaining sixteen tables: **`blocked_dependency`**, corrected from
`blocked_external`. Their writers are fixed; what is missing is the execution
that proves them. That execution needs the marathon harness against a local
Postgres cluster, and `initdb.exe` is refused on this host by Windows
Application Control — the pre-existing BL-6, which is the genuinely external
block. The tables themselves depend on that run, not on anything outside the
repository.

### Pool B — definer owner reassignment: 5/25

B-1 and B-2 reassigned five with the proof each earns: two refusal triggers
matched their exact SQLSTATE and message before and after, two more have bodies
that are a single unconditional raise and so cannot behave differently under
another owner, and `enforce_engine_analysis_run_history` matched P0001
"Terminal analysis runs are immutable" both ways.

B-3..B-7, five history guards: `blocked_dependency`. Their tables are empty so
the probe never fires, and unlike the refusal triggers their bodies read rows —
the harness declines to reassign on a vacuous probe rather than count a silent
no-op as a pass. A fixture per trigger unblocks them.

B-8..B-20, the salary and controlled-import definers: open, with the reason
recorded. Each needs its owner granted the table privileges its body uses before
reassignment, which is the shape that broke identity registration in Wave 3, and
the measured benefit is nil — the definer surface matrix reports no site ungated
by ownership, and `tivdoc_dev_migrator` is neither superuser nor BYPASSRLS.

### Pool E — parse the 69: 69/69

| id | item | status | evidence |
|---|---|---|---|
| E-0 | pinned Python extraction path | done | `output/pdf-venv`, Python 3.13.5, pypdf 6.16.2, PyMuPDF 1.26.4, pip freeze recorded; nothing under `node_modules` touched |
| E-1 | parse the text-layer documents | done | 62 parsed, parser `pypdf-6.16.2-layout`, normalizer `legal-normalizer-v0` |
| E-2 | say which problem each failure has | done | the extractor reports the font census, separating a scan from unmappable glyphs |
| E-3 | OCR the seven scans | done | Tesseract 5.4.0 with Hebrew data at 300 DPI; 7 parsed, `ocr_derived`, logical order |

1,242 chunks across 69 artifacts, 68 distinct normalized hashes. Two paths, kept
distinct because they are not the same evidence: 62 from an embedded text layer,
in visual order with digit runs reversed; 7 derived by a recognizer, in logical
order, carrying `ocr_derived` with the recognizer version, language and DPI.
Derived text never satisfies a citation needing exact bytes and needs human
attestation. Nothing written to a database, nothing activated, nothing marked
reviewed, no blocked record touched.

### Security finding — the service_role premise

Wave 3 concluded `tivdoc_service_tenant_scope` "widens nothing, because it is
granted to service_role and service_role holds no privilege on those 33 tables".
The premise is false: RLS matching uses `has_privs_of_role`, and
`tivdoc_dev_migrator` inherits `service_role` and holds full DML on all 33 — 33
widening rows on a role that can log in and does not bypass RLS.

The conclusion survives for a different reason, and the difference matters. That
role *owns* those tables: on the 16 unforced it bypasses every policy anyway, and
on the 17 forced it could turn FORCE off. The only other inheriting role is
`postgres`, which has BYPASSRLS. No principal reaches a table through that policy
that it could not reach otherwise — a statement about ownership, not about the
policy being unbound. The closure is computed by `service-role-closure-matrix.mts`
and the definer matrix now consults membership instead of comparing role names,
which surfaced four caller-settable tables on `enforce_engine_case_scope` that
name equality could not see.

### Carried items

| id | item | status |
|---|---|---|
| X-1 | controlled-import grant restored | done — 202609020005 revoked the grant its own header said nothing used |
| X-2 | permission denial names itself | done — 42501 was reported as `IMPORT_ROW_MALFORMED` |
| X-3 | ignore `output/agents/` and `output/pdf-venv/` | done |
| X-4 | narrow the eight `public.*_salary_*` grants | open — §3.6 requires moving three `supabase.rpc` callers first, and they are payment and attribution paths. An unattended run should not refactor money-adjacent callers |
| X-5 | name the last 2 of the 71 | done — `ACQOBS:WAVE1:1f87feb13c8c6778758e52f9235461dc` and `:3247017fdd24d0b9c86ed8f3916f7578`, both `BYTES_REJECTED_DUPLICATE`, one shared sha256 |
| X-6 | supersession table and three-state invariant | done — `accounted = projected + blocked_active + blocked_superseded = 71`, with `packets_from_supersession = blocked_superseded` asserted alongside |

## Resume point

- next unit: **A-8**, on a host where `initdb.exe` is permitted. The sixteen
  writers are corrected; only the marathon execution is missing.
- then B-3..B-7 once a fixture exists per history guard, then X-4 when moving the
  payment callers is in scope for a supervised run.
- known blocks that must not be retried: corpus acquisition, a second Supabase
  project, resetting the DEV default database, and forcing the remaining sixteen
  tables without a marathon run.
