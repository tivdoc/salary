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

### Wave 5 — durable Ground Truth workflow: G-3..G-9 proven on DEV

`scripts/legal-review-projection/ground-truth-matrix.mts` runs the durable
workflow as the operations runtime role and records twenty-three observations,
every one a refusal or an acceptance read back from DEV: trust stack durable
(organisation, policy, four reviewers, four keys proven by their reviewers);
annotation_1 accepted; the same identity refused for annotation_2 by the port
and, called past the port, by the definer (`GOVERNANCE_GT_ANNOTATION_2_TRANSITION_INVALID`);
a second identity accepted; disagreement recorded unsigned; an annotator
refused as adjudicator by the port and by the definer
(`GOVERNANCE_GT_ADJUDICATION_TRANSITION_INVALID`); a third identity accepted; a
tampered lock refused; the annotation_1 command replayed as an idempotent
no-op; current aggregate and full revision chain read back as the runtime role
(`1:annotation_1 2:annotation_2 3:disagreement 4:human_adjudication`); the
chain unreadable without a verified tenant. G-7: a lock by an annotator
refused by the definer; the lock by the lock reviewer appended through the
port inside a transaction that is then discarded — revision 5,
`locked_ground_truth`, a second lock refused while one is active
(`GOVERNANCE_GT_LOCK_TRANSITION_INVALID`) — and the committed chain still
ends at revision 4. G-9: two concurrent claims on one item yield one winner
(`for update skip locked`), a reclaim advances the fencing token 1 -> 2, the
stale token is fenced (`GOVERNANCE_WORK_RELEASE_FENCED`), and after every
connection is closed and reopened the durable claim still acts. G-3 is now a
real chain break: a lock manifest with a valid digest over changed sections,
refused by the definer (`GOVERNANCE_GT_IMMUTABLE_CHAIN_MISMATCH`) through the
port and called directly. Zero content: synthetic fixture manifests
re-attributed to run-scoped reviewers, run-scoped document digest, no lock
committed. HUMAN_GROUND_TRUTH_LOCKED 0.

Running it settled the actor model the definers impose: work items are
`governance.queue`'s, claims and key registrations the reviewer's, the unsigned
disagreement `ground.truth.system`'s, and a signed manifest the admitted
reviewer's — one session per subject, each command under the session it names.
Each run is its own synthetic tenant because the queue hands a claimant the
oldest eligible item tenant-wide and a released item returns to the same queue.

Three defects surfaced on first real call and are fixed: `governance_trust_policy_append`
raised 42702 (variable shadowed a column; `202609020014`); the governance
port parsed aggregate version "1" with the id schema (three characters
minimum), so no manifest below revision 100 could be admitted; and the lock
and correction branches of `governance_gt_manifest_append` raised the same
42702 — `document_sha256` shadowed the lock tables' column
(`202609020016`), invisible until the lock branch ran because the annotation
branches never read those tables. A history-read definer (`202609020015`,
owner `tivdoc_governance_owner`, verified-tenant gated, runtime roles only)
was added because no runtime role could read a manifest's revision chain.
Chain 39/39 applied; definer definitions 127.

The engine's relative imports carry explicit extensions now (52 rewritten,
checked against the filesystem, directory targets to `/index.ts`): the matrix
loads the engine's fixture and validator under `--experimental-strip-types`,
which resolves nothing implicitly. tsc, eslint and the engine and governance
suites (82 files, 564 tests) are clean on the rewrite.

G-1, G-2, G-10, G-11 — `scripts/legal-review-projection/ground-truth-queue-map.mts`,
eleven observations. G-1: five process-local stores on the ground-truth path,
anchored at run time — `TrustedGroundTruthWorkflow` (trusted-workflow.ts:23),
`InMemoryReviewerTrustStore` (reviewer-trust-store.ts:117, constructed only by
the CLI `scripts/human-trust/verify.mts`), `AppendOnlyLegalOperationsStore`
(state-machine.ts:121, constructed once by `LegalOperationsService`),
`ExternalEvidenceHandoffLedger` (evidence-handoff.ts:114), and
`LegalOperationsService`'s own golden-case and trusted-decision maps
(service.ts:31–39) — none reachable from a product constructor:
`implemented_uncalled`, all five. G-2: the queue was already durable; its
properties are now asserted from the catalog — RLS on and forced, owner
`tivdoc_governance_owner`, one owner-bound `runtime_verified_tenant()` policy,
no table grant outside the owner, execute on enqueue to owner + operations +
worker, on claim and release to owner + operations, on complete_claim and
claim_assert to owner only, nothing to anon, authenticated, service_role or
public, no immutability trigger (work items move by definer only) — and
proven by execution: 47 enqueues as the operations runtime role, every
receipt read back, and a second run replaying all 47 from the idempotency
ledger. G-10: the engine's 42 blank templates (7 topics × 6 scenarios) sit on
the queue as `golden_case_outputs` work for `human_golden_case_reviewer`,
carrying template id, version, topic, scenario and the template's content
digest — no answers, no bindings. G-11: the 5 customer-derived payslip
composites sit on the queue as `ground_truth_visual_eligibility` work for
`human_ground_truth_eligibility_reviewer`, carrying only the review
manifest's neutral ids and digests; the composite images were never opened,
and the owner's visual review is human and stays open.

G-12 — the queue panel, nested under `/operations` inside the existing 11-tab
contract, read-only by declaration. `202609020017` adds
`private.governance_work_queue_list(tenant, workflow_kind, limit)`: owner
`tivdoc_governance_owner`, verified-tenant gated, executable by the operations
principal only, returning identity, state, claimant and lease and never
`payload_json`. The port (`PostgresGovernanceWorkRepository.listQueue`, strict
row schema — a payload field is a decode failure), the application
(`readGroundTruthQueue`, readers `extraction_reviewer`, `legal_reviewer`,
`report_approver`, `auditor`, `break_glass_admin`; every other role, an
unverified actor, a missing tenant, a malformed correlation id and an
out-of-range limit refused before any statement), the route
(`GET /api/operations/ground-truth/queue`, session-verified, no CSRF because
there is no action, the five distinguishable 404 causes recorded with one
identical external response) and the panel
(`ground-truth-queue-panel.tsx`, mounted beside the legal-review panel) each
carry their negative matrix: 13 tests. From DEV as the runtime role the list
returns the 42 golden templates and 5 composites with no payload field on any
entry. Chain 40/40 applied; definer definitions 128.

Wave 5 is complete except for one path not exercised: `correction_started`
superseding an active lock, which needs a committed lock. The database does not verify Ed25519 signatures (no
pgcrypto Ed25519); that check stays in the TypeScript port and is stated, not
proven, by the matrix.

### Wave 6 — custody and parser isolation: K-1, K-2, K-3 executed; K-4 contracted; K-5 blocked_external

K-1/K-2 — `src/server/platform/custody/evidence-store.ts`: an immutable
local evidence store whose every file is named in an append-only,
hash-chained index and whose every append, read and walk is named in an
append-only, hash-chained access log with actor and purpose. The walk
verifies both chains and the tree against each other and fails on any
break; the store refuses to append or read while either chain is broken.
Seven tests produce each break by hand — a changed byte, a missing file, an
unindexed file, an edited index line, an edited log line, an overwrite.
`evidence-custody.mts` seals this run's 31 audit receipts (242,559 bytes)
into `output/v4/evidence/store`, append-only across runs (a changed receipt
is sealed again under a digest suffix, never over its predecessor); the walk
is valid and the log names 63 accesses on the first run and every one since.

K-3 — the restore drill ran against the local immutable private provider,
the non-managed lane's real storage adapter: 31 objects quarantined,
promoted, restored to a clean location and compared byte-for-byte, both
digests per object in the receipt, 31 equal. The managed half — the DEV
project's private `salary-documents` bucket — is `blocked_dependency`: this
host holds Postgres role passwords only, and a Storage write needs a Storage
API key; the receipt names the key (`TIVDOC_DEV_STORAGE_SERVICE_KEY` in the
credentials file, never committed) and the transport that would run the same
drill against the bucket.

K-4 — the fail-closed detector already existed and still says
`PARSER_OS_SANDBOX_NOT_VERIFIED` on this host; no OS sandbox primitive is
claimed. Added on the same module: the closing environment as a typed
contract — pinned image, kernel isolation, demonstrated no-network, pinned
toolchain, each NOT_VERIFIED with its artefact, runtime check and acceptable
implementations, plus hard resource limits and the receipt binding.
`parser-isolation-contract.mts` records how Pool E actually ran (pypdf and
Tesseract as plain child processes: a process boundary, acceptable for
public documents whose output is derived and for nothing else) and pins the
toolchain observed here: Python 3.13.5 (sha256 9350167…), pypdf 6.16.2,
PyMuPDF 1.26.4, tesseract v5.4.0.20240606 (sha256 babb405…), heb.traineddata
(sha256 7da6ea6…).

K-5 — off-host replicated custody stays `blocked_external`
(`OFF_HOST_AUDIT_CUSTODY_PENDING`, `DURABLE_REPLICATED_CUSTODY_NOT_IMPLEMENTED`).
`docs/off-host-custody-requirements.md` writes the destination, replication,
signed-receipt and witnessed-restore requirements against the existing
`CustodyDestinationPort` contract, precisely enough to hand to whoever
provisions it, and names the four pieces of evidence that would close it.

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

- next: the freeze — one full matrix at this head, then the ten-line report.
- after the freeze, still open: X-4 (the eight `public.*_salary_*` grants),
  the managed-bucket half of K-3 (needs a Storage key), K-5 (needs a
  provisioned destination), `correction_started` over a committed lock, and
  the owner's visual review of the five composites (human, open).
- B-3..B-7 once a fixture exists per history guard.
- known blocks that must not be retried: corpus acquisition, a second Supabase
  project, resetting the DEV default database, `initdb.exe` under Windows
  Application Control (BL-6).
