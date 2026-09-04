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

## Freeze — the full matrix at this head

Local: vitest 257/258 files, 1785/1789 tests (3 skipped) — the one failure,
`hermetic-session.test.ts`, is order-dependent under full-suite parallelism
and passes 7/7 alone; `git-audit.test.ts` timed out under load on one run
and passes 3/3 alone; no file either test covers was touched by this run.
tsc clean. eslint 0 errors, 10 pre-existing unused-variable warnings in two
test files untouched here. `next build` clean.

DEV, as the runtime roles: RLS force 62/62 tenant-scoped, unforced 0.
Definer surface 92 (two new: history read and queue list, both gated in
body), ungated 2 (the known pair), unexpected 0, reserved-execute 14.
Service-role closure: policy tables 0, exposure 0, widening 0. Identity
negative matrix 8/8. Invalidation effects 10/10. Grant execution: 22
executed, 0 denied, 18 context failures (lapsed-session setup, not denial).
Dynamic matrix 14 checks, 10 supported, 10 passed, 4 not supported. Claims
95, mismatched 9 (`claims_unwired_target_reachable`), 9 open ids named.
Supersession: `projected 0 + blocked_active 2 + blocked_superseded 69 = 71`,
`packets_from_supersession = 69`, replay adds nothing. Review package v4:
69 items, 7 OCR, zip `f5c68bb2…`, second build matches. Ground truth matrix
23/23; queue map 12/12; parser isolation `PARSER_OS_SANDBOX_NOT_VERIFIED`,
5/5 pins observed; evidence custody 6/6, walk valid. Owner reassignment:
25 accounted, 0 newly reassigned, 16 not owned by the target. Journey 16/16
over HTTP against a production server on DEV.

Counters unchanged: HUMAN_GROUND_TRUTH_LOCKED 0, REAL_* 0, DEPLOYMENTS 0,
REMOTE_PRODUCTION_MIGRATIONS 0, LIVE_PROVIDER_CALLS 0.

## Addendum 5 — draft parameters and offline shadow: surveyed, not started

The owner's statement that the research dossier is "approved until proven
otherwise" maps to one owner action recorded with the dossier's hash and to
nothing else; no source, parameter, RuleSpec or topic changes state, and the
database's two-distinct-identities rule for a parameter stands. Counters
unchanged. The survey found what each pool needs and where it is blocked;
no D, P or Q unit was executed, and nothing was fetched or drafted.

**Blocked before any unit can start**

- `blocked_dependency` — Addendum 4 (H/R/S) is not in this session and not
  in the repository (`tivdoc-continuous-mode.md`,
  `tivdoc-continuous-addendum-4.md` absent). R-14 (durable executor), S-1
  (shadow envelope), R-2 and R-9 as Addendum 4 defines them are unknown here.
  The nearest existing pieces: `DurableOfflineShadowScheduler` over
  `LocalFileDurableShadowStateStore` with the
  `tivdoc-durable-offline-shadow-envelope-v0.10.0` envelope (its pins assert
  `active_real_parameter_count: 0`, `mode: synthetic_placeholder_only`),
  the in-process `executeRuleSpec` / `executeRuleSpecAtomic` and
  `runRuleSpecMutationSuite`, and the R-2-shaped
  `buildRuleSpecAuthoringSkeleton` (`non_operative_human_authoring_template`).
  Q-8 is blocked on R-14/S-1 by the addendum's own rule.
- `blocked_dependency` — the research dossier
  (`tivdoc-legal-research-dossier.md`, 2026-09-03) is not in the repository;
  the only dossier here is `docs/wave2-minimum-wage-dossier-v0.4.md`. The
  owner action needs the dossier's hash and every P-pool draft needs
  `dossier_sha256`; neither can be computed until the file is added.

**Pool D — feasibility per target, from the fetch tool as it exists**
(`fetchLegalSourceBytes`: allowlist gov.il, main/fs.knesset.gov.il,
btl.gov.il; media pdf/html/text; 20 MiB; redirect chain recorded)

- D-1 btl minimum-wage page: fetchable (html; already registered as
  `IL_MIN_WAGE_OFFICIAL_RATES`); its Excel is outside the media allowlist —
  would record `failed_retrieval: media_format_unsupported` unless the
  allowlist is extended first.
- D-2 btl average-wage page: fetchable (html), not yet registered.
- D-3 btl Minimum Wage Law PDF: fetchable; registered as `IL_MIN_WAGE_LAW`.
- D-4 Knesset ספר החוקים 3072: fetchable host; the 474 is recorded per the
  addendum after one retry.
- D-5 gov.il convalescence 2016 order: registered
  (`IL_CONVALESCENCE_EXTENSION_ORDER_2016`, target
  `ACQ-V02-CONVALESCENCE-2016`); the 1998 agreement has no registered target.
- D-6 nevo 2025 law: `failed_retrieval: domain_not_allowlisted` (nevo is not
  on the allowlist; robots per the addendum); not bypassed.
- D-7 youth regulations: no official target registered — resolve first.
- D-8 2018 permit and 42-hour order: registered
  (`IL_GENERAL_OVERTIME_PERMIT_2018`, `IL_SHORT_WORK_WEEK_EXTENSION_ORDER_2018`).
- D-9 pension 2011 and 2016 orders: registered.
- D-10 travel 2016 order: registered.
- D-11 vacation and sick-pay laws: registered as btl PDFs
  (`IL_ANNUAL_VACATION_LAW`, `IL_SICK_PAY_LAW`); nevo not needed.
- D-12 ילקוט הפרסומים 4.3.2026: no official target registered — resolve first.

The observation classification vocabulary the addendum names (`unchanged`,
`pending_diff_review`, `failed_retrieval`, `candidate_successor`) exists in
no file here; the durable import (`governance_legal_observation_import`,
`legalObservationCandidateSchema`, kind `source_bytes`) can carry it in
provenance once Addendum 4's rules are in hand.

**Pool P — what the schemas allow today.** The durable candidate
(`tivdoc-parameter-candidate-v0.6.0`) has no `draft` state and no
`alternatives_of`; the database states are `candidate_inactive` →
`awaiting_second_attestation` → `dual_attested_inactive`, activation never
allowed. The engine's `numericParameterDraftSchema` has `draft` with
`dossier_sha256` and `source_set_sha256` and no alternatives link either.
Pairing alternatives needs a schema decision (Addendum 4 R-9 territory) before
P-5a/b, P-24a/b, P-33a/b, P-34a/b and the convalescence period can be drafted
as the addendum requires. Every value in the addendum stays a value in a memo
until it is bound to a fetched artifact's hash.

**Pool Q** — seven skeletons exist (R-2 shape); executable drafts use
`tivdoc-rulespec-v0.6.0` with `catalog_boundary: real_inactive`; the
sensitivity run (Q-8) waits on R-14/S-1.

## Addendum 4 — Session A (Sonnet), continuous grind, base `ba80cc2`

D-00 (`e920066`): `/output/next/` added to `.gitignore`, the receipt directory
for this session, resolved and committed alone before any other unit.

D-0 (`011c3a6`): the owner's research dossier copied byte-for-byte into
`docs/legal/research-dossier-2026-09-03.md`. `dossier_sha256 =`
`6ad2caa0995b67e42dc85bc6bb8690b0901f8679ffeb2440713964813c806422`. This is
the hash every Pool P draft candidate binds to and the hash the owner
action (Addendum 5) references; nothing is reviewed or attested by copying
it. Single sanctioned copy from the OneDrive folder into the repository.

### Pool H — hygiene

- **H-1** (`a6d40c5`) — `hermetic-session.test.ts`'s reported order-dependent
  failure was not order-dependent and was not shared state: a genuine
  ~1-in-16 random flake, reproduced in complete isolation with no other file
  involved. The token's HMAC signature is 32 bytes; 32 mod 3 is 2, so the
  final base64url character of any such digest carries two bits nothing
  decodes, and "w"/"x"/"y"/"z" share the same meaningful top four bits at
  that position — the test tampered the token by swapping its last
  character between exactly two of those four. Fixed by tampering the
  middle character instead (inside the payload segment, hashed as opaque
  UTF-8, no such ambiguity). 25/25 runs pass with the fix. The two ambient
  `process.env` reads the manager makes outside its injectable seam
  (`NODE_ENV`, `VERCEL_ENV`) are pinned in a `beforeEach` as defense in
  depth; no leak into them was found.
- **H-2** (`d77781e`) — `git-audit.test.ts`'s reported load-timeout measured:
  13.5s isolated, 33.5s under full-suite parallelism (real contention from
  ~90 synchronous `git` subprocess spawns racing dozens of other vitest
  workers for the same cores), exceeding the prior 30s budget. Raised to
  90s, comfortably over 2x both measurements. `git-audit.ts` itself is
  unchanged.
- **H-3** (`e6e1a68`) — `correction_started` over a committed lock, exercised
  for the first time. The semantics were already implemented
  (`governance_gt_manifest_append`, since 202609010004): a correction opens
  a brand new manifest chain naming the locked one via
  `supersedes_manifest_id`, never touching the locked manifest's own rows.
  `ground-truth-matrix.mts` now commits a second, independent manifest
  chain for real (not rolled back — `HUMAN_GROUND_TRUTH_LOCKED` is a
  declared policy constant asserted across receipts, not a live count, so a
  synthetic lock in a run-scoped tenant does not move it), corrects it, and
  proves the locked manifest's content digests are byte-identical across
  the full five-revision chain before and after. The mutation test: the
  operations runtime role holds no grant at all on
  `governance_gt_manifest_versions`, so a raw `UPDATE` against the locked
  row is refused with permission denied before any trigger runs — no path
  to that table exists but the one just exercised. 27/27 observations pass.
- **H-4** — the 9 open sweep ids from the claim-reachability matrix
  (`claims_unwired_target_reachable`), reclassified with fresh evidence
  against this head. No frozen receipt is edited: `canonical-entrypoints.v0.10.0.json`
  and its siblings are the owner-facing ledger a prior decision already
  declined to touch, and wiring any of these services would add a second
  construction path for one that already has a working path — precisely
  the confusion an earlier run flagged as a cost, not a fix. So every one
  below is `record the rest by id`; none was code-resolved this unit.

  | id | class | finding |
  |---|---|---|
  | CEP-013 | checker wrong | `startCanonicalApplicationPostgres` is called from the startup root (`durable-local-runtime.ts:128`); the matrix's reachability check cannot distinguish "called from *something*" from "called from the specific route the blocker names," so it flags a mismatch on a claim that is still true — the route itself never calls it. |
  | CEP-014 | checker wrong | Same mechanism as CEP-013, a different target. |
  | CEP-015 | checker wrong | Same mechanism as CEP-013; the claim also references `LIVE_PROVIDER_CALLS: 0`, a runtime invariant no static reachability check can speak to either way. |
  | CEP-027 | checker wrong | `PostgresJobsOutboxAuditRepository` is constructed at `canonical-postgres.ts:273`, which the matrix counts as reachable; the claim is that no resident worker process runs continuously to drain it, a deployment fact construction alone doesn't establish. |
  | CEP-028 | both | Same checker imprecision as CEP-027 on its primary claim, plus a second, real, already-known gap it also names: an external effect adapter that is not wired (the `implemented_uncalled` class BL-4 already tracks). |
  | CEP-080 | checker wrong (root cause confirmed) | The reachability graph hardcodes `src/server/product/internal-ops/runtime.ts` as a `product_entrypoint` at `scripts/product-integration/reachability/verify.mts:191`, in the same rule as genuinely framework-loaded files (`instrumentation.ts`, `middleware.ts`). Checked directly: no non-test file in `src/` imports `internal-ops/runtime.ts` at all (the one hit outside tests, `journey-scope-disposition.ts`, is a string-literal anchor in disposition metadata, not an `import`), and the file matches no Next.js loading convention. The hardcoding is unjustified for this specific file and produces a false "reachable." The underlying claim (BL-4: `InternalOpsService`'s ports are not installed) is true. Not fixed this unit — the same script's counts are asserted against three frozen receipts (`canonical-entrypoints.v0.10.0.json`, `inventory.v0.10.0.json`, `integration-repair-audit.v0.10.1.json`); changing the classification rule needs its own unit to re-verify all three deliberately, not as a side effect of a sweep classification pass. |
  | CEP-081 | checker wrong (same root cause) | Same hardcoded-entrypoint rule, same file, covering `src/server/product/customer-portal/api.ts` instead. Checked directly: no non-test import exists for this file either. `CustomerPortalService` is genuinely constructed only by the harness and fixtures, matching the claim; not fixed this unit, for the same frozen-receipt reason as CEP-080. |
  | CEP-082 | checker wrong | `authenticateProductIdentity`-adjacent key resolution is reachable (`configured-verification-key.ts` exists and is wired); the claim is that it resolves one configured PEM rather than backing onto a managed key service — a claim about *which kind* of implementation exists, an axis reachability doesn't measure. Spot-checked: no managed-key-service implementation exists in `src/server/platform/auth/`. Claim stands. |
  | CEP-083 | claim wrong | Filed as a wiring/reachability claim, but its substance — `MANAGED_IDENTITY_NOT_PROVEN` — is about the trustworthiness of an external identity provider, not about whether anything is called. Confirmed reachable: `authenticateProductIdentity` is called at `durable-session-boundary.ts:54`, real product code. As a *wiring* claim this one is simply wrong; the provider-proof concern is real but was never a wiring question. |

  Net for H-4: 7 `checker wrong` (2 with a confirmed, named, unfixed root
  cause), 1 `both`, 1 `claim wrong`, 0 `code wrong`, 0 newly resolved. All 9
  recorded by id above; none needed re-litigating beyond what the matrix's
  own prior notes already said, which this pass independently confirmed
  against the current tree rather than took on faith.

- **H-5** — investigated, none moved; all eight grants `blocked_dependency`
  on a role-plumbing gap that does not exist yet, recorded with the exact
  reason rather than attempted. The eight are `claim_salary_ga4_purchase`,
  `claim_salary_meta_purchase`, `claim_salary_payment_completed`,
  `complete_salary_ga4_purchase`, `complete_salary_meta_purchase`,
  `release_salary_ga4_purchase`, `release_salary_meta_purchase`,
  `verify_salary_payment` — all `SECURITY DEFINER`, owned by
  `tivdoc_dev_migrator`, `EXECUTE` granted to `service_role`. All eight are
  live, not dead: `claim`/`complete`/`release_salary_ga4_purchase` from
  `src/lib/ga4-server.ts`, the `_meta_` triplet from
  `src/lib/meta-purchase.ts`, `claim_salary_payment_completed` from
  `src/app/api/cases/status/route.ts`, `verify_salary_payment` from
  `src/lib/verify-payment.ts` — every one of the "three payment-path
  `supabase.rpc` callers" the prior run named, plus the GA4/Meta analytics
  pair each has, all reached the same way.

  Every one of those four files calls `supabase.rpc(...)` through the one
  shared admin client `getSupabaseAdmin()` (`src/lib/supabase-admin.ts`),
  authenticated with `SUPABASE_SERVICE_ROLE_KEY` over PostgREST. PostgREST
  selects a Postgres role from the JWT's `role` claim, and Supabase issues
  that claim only as `anon`, `authenticated` or `service_role` — there is no
  JWT that selects an arbitrary narrower Postgres role over PostgREST.
  "Move the caller to the runtime path" therefore is not a grant change or
  a connection-string swap: it needs a runtime role that PostgREST can
  actually select (which does not exist for this purpose), or it needs
  these four call sites rewritten off `supabase.rpc` entirely onto a direct
  Postgres connection carrying that role's own credentials — a real
  architecture change to four live files on the payment-completion and
  ad-conversion-tracking paths, not a per-function grant move. That is a
  materially bigger and riskier unit than "prove the payment path completes
  end to end after each," and it is exactly what the prior run's caution
  named. `blocked_dependency`: a PostgREST-selectable narrow runtime role
  (or an agreed non-PostgREST calling convention for these eight) has to
  exist before any of the eight can move; none was attempted unattended.

- **H-6** (`c88cfb6`) — a walk over every `.ts`/`.tsx`/`.mts`/`.cts` file
  under `src/engine` fails the suite on the first relative import specifier
  without a recognized extension. `eslint-plugin-import` would be the
  conventional fix but needs an `npm install`, forbidden standing. Verified
  both ways: clean on the current tree, fails with the file and specifier
  named when a bare import is injected by hand (then reverted, confirmed by
  an empty `git diff`).

- **H-7** — checked `~/.tivdoc-dev/credentials.env` for
  `TIVDOC_DEV_STORAGE_SERVICE_KEY` at preflight: absent. `blocked_dependency:
  storage key`, recorded once, nothing printed. The managed-bucket restore
  drill (against the DEV project's private `salary-documents` bucket) stays
  unrun until the owner places that key; the local-provider half of K-3
  already ran and passed (31/31 objects byte-equal, prior run).

- **H-8** — no rebuild needed; recorded rather than fabricated. "Rebuild
  the review package (v5) so it reflects H-4's resolutions" presupposes an
  H-4 that changed the 69 legal observations `review-package-v4.mts`
  packages — a prior addendum's H-4 apparently did. This session's H-4 (the
  9 open sweep ids under Addendum 4 §Pool H, `claims_unwired_target_reachable`)
  is entrypoint-wiring classification, not legal-observation review, and
  resolved 0 of 9. There is nothing new for a "v5" to carry, and cutting one
  anyway — a version bump with no underlying change — would be exactly the
  fabricated-effect class the standing rules forbid. Re-ran the existing
  build instead, as the real available verification: `review-package-v4.mts`
  under wave `v4` (where its inputs live) still builds twice to the same
  hash `f5c68bb2eaeac42d` as the last freeze, unaffected, as expected, by
  entrypoint-claim work in an unrelated domain.

### P-0 — `draft` state and durable open decisions (Addendum 6 §A6-2)

`d8497ed`, migrations `202609020018`–`202609020020`. Before any Pool P
parameter unit: `governance_parameter_versions_state_check` gains `draft`
and `rejected_by_decision`, drops the never-used `candidate_inactive`;
`decision_id`/`branch` columns are added with paired/format `CHECK`s so a
draft parameter can name which owner decision it is a candidate branch of,
and which named branch (e.g. `47.5pct`, `50pct`) it is. A new
`private.legal_open_decisions` table (RLS-forced, one
`governance_legal_open_decision_guard()` trigger) and
`private.governance_legal_open_decision_register(...)` function let a
decision be registered once and referenced by every candidate branch under
it — never picked silently, per Addendum 5's "every open decision is
carried as separate draft candidates on both branches" rule.
`governance_parameter_attestation_append` gained a decision-resolution
cascade: when one branch reaches `dual_attested_inactive`, every sibling
branch under the same `decision_id` is rejected (`rejected_by_decision`)
and the decision itself marked resolved, all through
`governance_finish_mutation` (not a hand-rolled insert) so the rejection is
visible to `governance_aggregate_read`/`readCurrent`, not only to a direct
table read no runtime role has.

Two genuine bugs, both caught only by writing and running
`scripts/legal-review-projection/parameter-decision-matrix.mts` end to end
against DEV, not by inspection:

- The new trigger guard function kept Postgres's default `PUBLIC EXECUTE`
  grant — caught by the `reserved_executable_secdef` count moving 14→15
  after applying `018`. Fixed by `019` (explicit revoke, matching the
  convention every other definer in this schema already follows).
- The cascade wrote the sibling's rejected revision straight into
  `governance_parameter_versions` but never into
  `governance_aggregate_snapshots` — the table `readCurrent` actually
  reads — so the version-history row existed and nothing could see it.
  Fixed by `020`, routing the cascade through `governance_finish_mutation`.

Contract and count updates that had to move together with the schema:
`governanceMutationStateSchema` (`contracts.ts`) renamed
`candidate_inactive`→`draft`, added `rejected_by_decision`;
`parameterCandidateSchema` gained `decision_id`/`branch` with a
`superRefine` pairing check; `EXPECTED_SECURITY_DEFINER_DEFINITIONS`
128→133; the migration-chain sha list, `foundation.test.mjs`'s counts
(40→43 migrations, 41→44 commands), and the chain-replay tail-filename pin
all moved together. Final proof script: 13 named cases, all passing,
reproducible across two independent runs.

### Pool D — acquire the official artifacts (Addendum 5, 12 units + D-1b)

Every unit below is a real network fetch through
`scripts/legal-sources.mts fetch` (not `legal-acquisition.mts`, which is
the separate owner-manual-import path) against the existing
`fetchLegalSourceBytes` allowlist/media-validation boundary, writing to
git-ignored `eval/legal-knowledge/`. Only the manifest registration
(`legal-sources.v0.json`) and any supporting code are tracked.

- **D-1** BTL minimum-wage table (`IL_MIN_WAGE_OFFICIAL_RATES`, HTML) —
  already registered and fetched pre-session; verified still fetched this
  session. Its Excel companion is D-1b, below.
- **D-2** (`8d3019e`) BTL average-wage table, Sections 1 and 2
  (`IL_AVERAGE_WAGE_OFFICIAL_RATES`, HTML,
  `btl.gov.il/.../שכר ממוצע.aspx`). Fetched. The 47.5%-of-average-wage
  minimum-wage derivation (P-1..P-4) cites Section 1 only, recorded in the
  entry's own notes so a later unit can't reach for Section 2 by mistake.
- **D-3** (`6c73202`) BTL Minimum Wage Law PDF
  (`IL_MIN_WAGE_LAW`) — already registered and fetched pre-session;
  annotated this session as `consolidated_through_2015` per the dossier,
  with an explicit note that Sefer HaChukim 3072 (D-4) is not folded into
  this consolidated text.
- **D-4** (`1f6c709`) Knesset ספר החוקים 3072, 1.8.2023
  (`IL_SEFER_HACHUKIM_3072_2023`, PDF,
  `fs.knesset.gov.il/25/law/25_lsr_3020007.pdf`). The dossier records this
  target as having returned HTTP 474 to a prior automated fetch; retried
  once with the repository's own fetch tool per Addendum 6 §A6-3 and it
  succeeded outright (608521 bytes, `application/pdf`) — no retry needed
  in practice, recorded `fetched`.
- **D-5** gov.il convalescence extension order 2016 PDF
  (`IL_CONVALESCENCE_EXTENSION_ORDER_2016`) — already registered and
  fetched pre-session; confirmed. The dossier's second half, "the 1998
  agreement PDF," is a different, real document (the 13.7.1998 general
  collective agreement on convalescence pay, agreement no. 19987038) whose
  only located copy is on `workagreements.labor.gov.il` — a Ministry of
  Labor subdomain genuinely official but **not** in
  `LEGAL_SOURCE_ALLOWED_HOSTS`. Not registered: widening the allowlist to a
  new host is an infrastructure/trust-boundary change this session does not
  make unilaterally. Recorded `blocked_dependency: host_not_allowlisted`
  (distinct from `blocked_external` — an official host exists, it is simply
  not one this manifest may fetch from yet). This resolves the "1988 vs
  1998" ambiguity flagged mid-session: `IL_CONVALESCENCE_EXTENSION_ORDER_1988`
  (Yalkut HaPirsumim 3596, confirmed from the extracted PDF text itself) and
  the 1998 general agreement are two different, correctly-distinguished
  instruments — not a naming error — and the 1998 one is the piece still
  outstanding.
- **D-6** convalescence freeze law 2025
  (`IL_CONVALESCENCE_REDUCTION_FREEZE_LAW_2025`) — already registered and
  fetched pre-session via `fs.knesset.gov.il` (not nevo, which stays
  outside the allowlist per Addendum 6 §A6-3); confirmed.
- **D-7** (`370f4c9`) youth minimum-wage regulations
  (`IL_MIN_WAGE_YOUTH_APPRENTICES_REGULATIONS_1987`, PDF,
  `btl.gov.il/Laws1/02_0021_100000.pdf` — the same host and URL family as
  D-3's `00_0021_000000.pdf`). Fetched (56769 bytes, `application/pdf`, no
  challenge-page rejection) — **not** `blocked_external`; P-7..P-10 bind to
  this artifact rather than staying unbound.
- **D-8** working-hours general permit 19.3.2018 and the 42-hour extension
  order (`IL_GENERAL_OVERTIME_PERMIT_2018`,
  `IL_SHORT_WORK_WEEK_EXTENSION_ORDER_2018`) — already registered and
  fetched pre-session via `www.gov.il`; confirmed both.
- **D-9** pension extension order consolidated 2011 and the 2016 increase
  order (`IL_GENERAL_PENSION_EXTENSION_ORDER_2011`,
  `IL_GENERAL_PENSION_INCREASE_EXTENSION_ORDER_2016`) — already registered
  and fetched pre-session via `www.gov.il`; confirmed both.
- **D-10** travel extension order 2016
  (`IL_GENERAL_TRAVEL_EXTENSION_ORDER_2016`) — already registered and
  fetched pre-session via `www.gov.il`; confirmed.
- **D-11** Annual Vacation Law and Sick Pay Law (`IL_ANNUAL_VACATION_LAW`,
  `IL_SICK_PAY_LAW`) — already registered and fetched pre-session via
  `www.btl.gov.il` (not nevo, which is robots-blocked); confirmed both.
- **D-12** ילקוט הפרסומים notice of 4.3.2026 (minimum wage, issue 14324,
  ט"ו באדר התשפ"ו) — searched `main.knesset.gov.il`/`fs.knesset.gov.il` and
  the `www.gov.il` official Reshumot archive; no direct official-host PDF
  URL for this specific issue could be confirmed (only non-official mirrors
  — a payroll vendor, an industry association — surfaced, none registrable
  under the allowlist). Not registered — a manifest entry requires a
  `canonical_url`, and fabricating one from a memo is exactly what this
  manifest exists to prevent. Recorded `failed_retrieval:
  official_host_unavailable` per Addendum 6 §A6-3's own fallback: the
  minimum-wage-update parameter this notice would have supported binds
  instead to the next official source up the hierarchy (the Minimum Wage
  Law text / the average-wage official table, D-2), or stays unbound.
- **D-1b** (`9b27863`) — Addendum 6 §A6-4's BTL-only spreadsheet exception.
  Registers `IL_MIN_WAGE_OFFICIAL_RATES_HISTORY_XLSX`
  (`btl.gov.il/.../sharminimum.xlsx`), the historical rate-table Excel
  linked directly from D-1's HTML page. Required real implementation, not
  just registration: extended the media allowlist to
  `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` /
  `application/vnd.ms-excel` scoped to the BTL host only
  (`isBtlSpreadsheetEnvelope` in `security.ts` — every other allowlisted
  host still refuses these content-types for any format, and a BTL "table"
  source still refuses any other content-type), added ZIP/OLE magic-byte
  validation at the same rigor as the PDF check, and added a deterministic
  xlsx reader (`scripts/legal-xlsx-extract.py`, pinned `openpyxl` 3.1.5 in
  the existing Python venv, one CSV page per worksheet) wired into both the
  build pipeline and the reproducibility clean-room path, recording its own
  `legal-xlsx-extractor-v0` parser version. Verified end to end: fetched
  (25828 bytes), envelope-validated, parsed into 118 chunks of genuine
  Hebrew historical minimum-wage rate data including the youth/apprentice
  columns D-7's regulations govern. Six new tests in `security.test.ts`
  cover the BTL-only gate specifically (accepts real .xlsx/.xls from BTL,
  rejects bad magic bytes, rejects truncation, rejects the same
  content-type from a non-BTL host or a non-`table` format on BTL itself).
  Two pre-existing hardcoded manifest-size canaries
  (`canonical-inventory.ts`'s `loadCanonicalRoleInventory`, and
  `manifest-and-changes.test.ts`) moved 17→21 alongside D-2/D-4/D-7/D-1b,
  each verified by running the test rather than only computing the new
  count.

Pool D is closed: 12/12 units accounted for (10 resolved and bound to a
fetched official artifact, D-5's second half and D-12 correctly recorded
as blocked with evidence, not silently dropped), plus D-1b. Nothing in
Pool D widened `LEGAL_SOURCE_ALLOWED_HOSTS`, bypassed robots.txt, or bound
a draft parameter to a URL in a memo instead of a fetched hash.

### Pool P — draft parameters bound to Pool D artifacts (Addendum 5)

Framework: `scripts/legal-review-projection/pool-p-parameter-import.mts`
(`5ba732e`). Draft-only import through
`private.governance_parameter_import` (no attestation, no trust stack —
Pool P's own "zero attestations" requirement made P-0's full reviewer
flow unnecessary). Every candidate's citation is checked at run time
against the actual built chunk text of the cited Pool D artifact
(`citation()`'s `must_contain`) — not typed from memory or the research
dossier's own summary tables. This caught several real problems before
anything was written to DEV, documented in each batch commit; the
recurring shape is "the fetched/built text does not actually say what the
dossier's prose implies," which is a citation-integrity check working
exactly as intended, not a false alarm.

Two conventions this session established, not specified by any addendum,
flagged for the owner to confirm or override (both are cheap to change —
nothing here is attested or activated):
- **Tenant**: `legal.reference.il`, fixed rather than random-per-run, so
  the draft catalog persists and Session B can find it. Needed a
  `reviewer_org_id` placeholder value on the session (a label, not a
  verified trust organization — no FK ties it to
  `governance_reviewer_organizations`) purely because
  `runtime_context_install` requires a non-null one for every session
  under the operations role, attestation or not.
- **DependencyBindings computation for a real (non-synthetic) source**:
  `source_bytes_sha256`/`citations_sha256` hash real fetched-artifact
  hashes and real chunk citations; `rule_spec_sha256`/`golden_cases_sha256`/
  `reviewer_decisions_sha256` are deterministic "unassigned" sentinels
  (same pattern `synthetic-fixtures.ts`'s `syntheticBindings` already
  uses) since Pool Q hasn't produced a RuleSpec or GoldenCaseSet yet, and
  zero attestations exist by design. R-8 (semantic invalidation) stays
  deferred to Session B — this only fixes how bindings are populated at
  draft-creation time, not how they get compared later.

**Registered (18 draft candidates, 22 database rows counting decision
records, 5 commits):**

- **Batch 1** (`5ba732e`) — **P-1..P-4**: minimum wage monthly 2023-2026
  (5,571.75 / 5,880.02 / 6,247.67 / 6,443.85 ILS), each bound to the
  Minimum Wage Law §6 47.5% derivation (D-3) + the average-wage table's
  §1 row for that year (D-2) + BTL's own published monthly figure (D-1)
  as corroboration. **P-5a/P-5b**: the ÷182 (35.40 ILS) vs ÷186 (34.64
  ILS) hourly alternatives, registered as true alternatives via a real
  `legal_open_decisions` row. **P-6**: daily rates, 6-day (257.75) and
  5-day (297.40). Two real mistakes caught before import: D-3's
  consolidated-through-2015 text does not contain the ÷186 divisor clause
  the dossier's prose implies (a later amendment, consistent with D-3's
  own annotation), and D-8's own PDF text is corrupted at exactly the
  "182" figure (extracts as "122") — P-5a cites D-8 for the 42-hour-week
  clause it states cleanly instead.
- **Batch 2** (`845d83b`) — **P-7..P-10**: youth/apprentice minimum wage,
  monthly and hourly, all four categories (70%/75%/83%/60% of D-7). The
  per-agora amounts are BTL's own historical-rate-spreadsheet figures
  (D-1b), not computed here by multiplying — independently deriving them
  would have landed one agora off BTL's own number on three of the four
  monthly figures, and the dossier's own summary table disagrees with
  BTL's table on three of the four hourly figures by the same kind of
  rounding drift. 8/8 clean on the first real attempt.
- **Batch 3** (`026804b`) — **P-17**: the 42-hour weekly threshold (D-8).
- **Batch 4** (`e1d86a2`) — **P-24a/P-24b**: the pension mandatory-wage-cap
  alternatives (§1: 13,566 ILS vs §2: 13,769 ILS), true alternatives via a
  second `legal_open_decisions` row. **P-25**: the travel daily
  reimbursement cap (22.60 ILS, effective 1.2.2016, D-10).
- **Batch 5** (`44da0cb`) — **P-30**: the 2024 convalescence
  partial-reduction wage threshold (6,000 ILS). **P-34** (both halves,
  registered as two plain parameters, not alternatives — see below):
  vacation full-year/partial-year employment-relationship day thresholds,
  200 and 240. **P-35** (both halves): sick-pay accrual (1.5 days/month)
  and cap (90 days).

**A real ambiguity resolved, not just an artifact gap.** The research
dossier flags "200 or 240 days — the explanatory source is confused about
which applies to whom" as an open decision for the vacation topic. Reading
Annual Vacation Law §3(b)/(c) directly (chunk
`IL_ANNUAL_VACATION_LAW@discovery-v0#0001-838721e06653`) shows they are
not competing figures at all: §3(b)'s 200-day threshold governs an
employment relationship spanning the full work-year, §3(c)'s 240-day
threshold governs one spanning only part of it. Registered as two plain
parameters rather than `decision_id`-linked alternatives, because there is
no genuine disagreement left to carry forward once the primary text is
read directly.

**Not registered — recorded `blocked_dependency`, each with a one-line,
corpus-anchored reason (never a fabricated citation to close the gap):**

- **P-11..P-14** (overtime 125%/150%, rest-day 150%, overtime-on-rest-day
  175%/200%): no built chunk anywhere in the corpus contains "125%",
  "150%", "175%", or "200%" (grepped every built `chunks.json`). The
  Hours of Work and Rest Law artifact in the corpus is pinned to the
  original 1951 promulgation (its own registered note says so); the
  consolidated/amended text carrying §16/§17's actual pay-rate clauses is
  the exact gap the dossier's own "מה עורך הדין מכריע" #1 for this topic
  (tracker 6.24) already flags as open.
- **P-15/P-16** (daily thresholds 8.6/8 hours): not present in the
  42-hour extension order's extracted text in any form checked (`8.6`,
  `7.6`, `8,6`, `7,6`).
- **P-18..P-20** (permit caps 12/day, 16 OT/week, 58 night): source
  `IL_GENERAL_OVERTIME_PERMIT_2018` failed to build
  (`instrument_selector_pending_human_review`), pre-existing.
- **P-21..P-23** (current pension contribution 6%/6.5%/6%, effective
  1.1.2017): the 2011 base order's own escalation table is built and
  readable but only reaches 17.5% total / 6% / 5.5% / 6% at 1.1.2014; the
  1.1.2017 increase to 18.5%/6.5% is in the 2016 increase order, which
  failed to build (`document_sanity_minimum_content_failed`),
  pre-existing.
- **P-26** (2023 convalescence rate, 418): source parse_failed
  (`instrument_selector_pending_human_review`), pre-existing.
- **P-27/P-28** (2026 convalescence order rate + effective period, public
  511.6): a new finding, not a pre-existing one — the registered source
  `IL_CONVALESCENCE_EXTENSION_ORDER_2026`
  (`gov.il/BlobFolder/dynamiccollectorresultitem/order14863/...`) fetches
  successfully and parses into 14 chunks, but **none of the 14 chunks
  contain the word "convalescence" (הבראה) in either letter order** — the
  actual content is a set of unrelated government-appointment notices
  (a deputy minister's cessation of office). `gov.il`'s
  `dynamiccollectorresultitem` numeric-id URLs are not stable permalinks;
  this is most plausibly the id being reassigned to different content
  since the source was first registered, not a wrong URL from the start.
  Not re-fetched or re-diagnosed this session — recorded as a content
  mismatch on an already-registered source, for Session B or the owner to
  re-source.
- **P-29** (seniority bands 5/6/7/8/9/10 days): not found in the 1988
  order's 4 built chunks; the dossier's own tracker 6.17 already flags
  this exact instrument's page-boundary segmentation as unreliable.
- **P-31** (2025 half-day threshold, 6,150): the sibling 2024 law's 6,000
  threshold (registered as P-30) is clean in its own text, but the 2025
  law's PDF text layer is materially more garbled — several multi-digit
  numbers extract as fragments that are clearly wrong (`5219`, `5319`, and
  similar) — and no clean `6,150`/`6150` occurrence exists to cite. The
  2025 law's own frozen rates (418 private / 471.4 public) ARE clean in
  this same document, but that is a different figure than P-31 asks for.
- **P-25's "superseded_2014" sibling** (26.40 ILS): every source found for
  26.40 is an explanatory secondary source (a services blog, an academic
  staff association), not an official one, and no 2014 travel-order
  artifact is in the D-pool to bind it to instead.
- **P-32, P-33a/P-33b** (vacation calendar-days table; 5-day workday
  conversion 11 vs 12): a new finding — the fetched
  `IL_ANNUAL_VACATION_LAW` gives 14 days for years 1-4 in its own
  §3(a)(1), the pre-amendment-15 (2017) figure, not the current 16 the
  dossier and addendum both expect (this artifact's own amendment
  footnote list stops at 2013, confirming it predates 2017's amendment
  15). Binding a "current" parameter to a stale law text would be wrong
  regardless of citation rigor — not registered. P-33's own working-day
  conversion has no official source at all per the dossier's own account
  (only an explanatory site is cited for it anywhere) — a genuine absence,
  not a corpus gap to close.
- **P-36/P-37** (sick-pay payment tiers 0%/50%/100%): not found anywhere
  in `IL_SICK_PAY_LAW`'s 5 built chunks — the same "primary clause not in
  the fetched text" pattern as the overtime-rate and pension-increase
  gaps above.

**Net**: 18 of 37 addendum-listed parameters registered as draft
candidates (counting each half of an a/b or monthly/hourly pair
separately), all DEV-verified and citation-checked; the remainder blocked
with a specific, corpus-anchored reason each, not attempted with a
fabricated or memory-sourced citation. Closing the blocked half of Pool P
needs new acquisition work outside this session's scope: a current
consolidated Hours of Work and Rest Law text, the 2016 pension increase
order (re-fetch or a different official copy), a correct 2026
convalescence-order artifact (current one is mismatched content), and a
current (post-2017) Annual Vacation Law consolidation.

## Addendum 7 — decisions on Session A's findings, corrections, continue into S

### A7-1 — three guards on `legal.reference.il` (`1023455`)

Migration `202609020021`. `private.legal_reference_tenant_id()` is the one
named SQL-side constant; `product_identity_session_register` refuses
(`42501`) when the runtime-resolved tenant is the reference tenant, so no
identity session can ever be issued for it; a new
`private.governance_parameter_operative_read(tenant, parameter_id,
parameter_version)` is the only read path granted to `tivdoc_web_runtime`,
refusing any row that is not `activation_allowed` — which, by a table
`CHECK` constraint (`check (not activation_allowed)`), is every row in
this database, today, unconditionally. Proven 6/6 by execution as the
actual runtime roles (`legal-reference-tenant-guards.mts`).

Caught mid-build and worth repeating for Session B: the migration was
first applied via the Supabase MCP tool, which targets this project's
*default* `postgres` database — not `tivdoc_v09_devruntime01`, the actual
application database. DDL for this project goes through
`output/next/apply-migration.mjs` (the admin connection string from
`~/.tivdoc-dev/credentials.env`), never the MCP database tools.

Also discovered by execution, not assumption: `governance_parameter_versions`
and `governance_parameter_attestations` are not directly `SELECT`-able by
*any* connectable role — not `tivdoc_operations_runtime`, which writes to
both. Every read goes through `governance_aggregate_read` (or the new
operative-read function). There is no login role for
`tivdoc_governance_owner` at all; its privileges exist only inside
`SECURITY DEFINER` function bodies.

### A7-2 — the eleven-dimension dependency-hash formula (this commit)

The formula, exactly as implemented in
`scripts/legal-review-projection/pool-p-dependency-hash.mts`
(`computeElevenDimensionBindings`): canonical JSON (stable key order, the
same `legalOperationsSha256` every candidate hash already uses) over each
of the eleven dimensions, folded into the five `DependencyBindings` fields
that carry real (non-sentinel) data for a Pool P candidate — the 8-field
shape itself is unchanged, since every existing candidate (including the
18 already imported) depends on it:

| Dimension | Field | Source |
|---|---|---|
| 1. artifact SHA-256 | `source_bytes_sha256` | `eval/legal-knowledge/manifests/fetch-state.json` |
| 2. parsed version hash | `source_bytes_sha256` | `build-state.json`'s `parsed_version_id` |
| 3. parser version | `source_bytes_sha256` | `build-state.json`'s `parser_version` |
| 3. normalizer version | `source_bytes_sha256` | `build-state.json`'s `normalizer_version` |
| 4. exact citation locator | `citations_sha256` | each citation's `chunk_id` + locator text |
| 5. value | `parameter_set_sha256` | the candidate's own value |
| 6. unit | `parameter_set_sha256` | the candidate's own unit |
| 7. effective interval | `interval_sha256` | `effective_from`/`effective_to` |
| 8. sector | `scope_sha256` | `sectors` |
| 9. population | `scope_sha256` | `populations` |
| 10. dossier SHA-256 | `citations_sha256` | the D-0 dossier hash, `6ad2caa0…6422` |
| 11. source-set hash | `source_bytes_sha256` | the sorted `{source_id, source_version}` set, independent of those sources' own bytes |

`rule_spec_sha256`/`golden_cases_sha256`/`reviewer_decisions_sha256` stay
deterministic "unassigned" sentinels — no RuleSpec, GoldenCaseSet, or
attestation exists at draft-import time.

Proof: `pool-p-dependency-hash.test.mjs`, one test per dimension (14 tests
total, pure, no DEV connection — mutating exactly one dimension changes
`legalOperationsSha256(bindings)`, the same aggregate the DB compares as
`bindings_sha256`), plus `pool-p-dependency-hash-invalidation-proof.mts`,
executed against DEV, confirming a fresh import lands
`state=draft, revision=1` — which this state machine makes definitionally
equivalent to zero attestations, since the only transition out of `draft`
is `governance_parameter_attestation_append` and `governance_parameter_import`
always inserts at revision 1, unconditionally, for a parameter_id/version
never imported before.

**The 18 already-imported candidates keep their pre-A7-2 bindings.**
`governance_parameter_versions` is append-only (an update/delete trigger
forbids it) and `governance_parameter_import` only ever inserts revision
1 for a given (parameter_id, parameter_version) — confirmed by execution:
re-running the existing batch scripts under the new formula hit
`GOVERNANCE_IDEMPOTENCY_COMMAND_MISMATCH` (same idempotency key, new
command hash) before any insert was attempted, so nothing was
double-written or corrupted. Retroactively rebinding those 18 would need a
deliberate new `parameter_version` for each, which is a content decision,
not a pure accounting fix — left to the owner or a dedicated follow-up
unit, not done silently here. Every Pool P unit from here forward
(D-13…D-16's unlocked parameters, and any other new import) uses the
eleven-dimension formula.

### A7-3 — `withdrawn` as its own resolution state (this commit)

Migration `202609020022`. `legal_open_decisions.resolution_state` gains
`withdrawn`, alongside two new companion columns required exactly when
that state applies (`withdrawn_reason`, `dissolution_citation_locator`),
enforced by a single `case`-based pairing constraint that names every
field for every state — not three independent checks that could pass
together by accident. The append-only guard trigger now permits exactly
two transitions out of `open` — to `resolved` (unchanged) or to
`withdrawn` (new) — and nothing else, ever, from any state. A new
`private.governance_legal_open_decision_withdraw(...)` function is the
only entrypoint: no reviewer identity, no trust stack, no sibling cascade
— an ill-posed decision was never validly split into branches to reject.

Proven 7/7 by execution (`legal-open-decision-withdrawal.mts`): a fresh
decision withdraws cleanly; withdrawal replays idempotently; **no runtime
role can mutate the table directly at all** (not just the append-only
trigger — `tivdoc_operations_runtime` is refused at the grant level, `42501`,
before the trigger would even run — two independent layers, discovered by
execution rather than assumed); withdrawing an already-withdrawn decision
under a fresh idempotency key is refused; withdrawing an unknown decision
id is refused; withdrawing without a reason is refused by the function's
own validation, before ever touching the table.

**The vacation "200 vs 240 days" question is now a real, evidenced
`withdrawn` record**, not only prose in a commit message: decision id
`legal.reference.il.decision.vacation_minimum_days_threshold_200_vs_240`,
`dissolution_citation_locator = "IL_ANNUAL_VACATION_LAW@discovery-v0#0001-838721e06653
(§3(b), §3(c))"`, `withdrawn_reason` recording that §3(b)/§3(c) are two
thresholds for two situations, not competing answers to one question.

### A7-4 — quarantine, not skip (this commit)

`legalSourceSchema` gains an optional `content_integrity` field (absent
entirely for every one of the 21 sources that never needed it — no edit
to any of them): `{ status: "verified" | "invalid_content_title_mismatch",
expected_title, observed_title, detected_at }`. A new `superRefine` check
forces `can_independently_support_monetary_rule` to `false` whenever
`status` is the mismatch value — enforced at registration, not left to
whoever writes the next citation to remember.

**`IL_CONVALESCENCE_EXTENSION_ORDER_2026`** is now flagged: `expected_title`
is the order this manifest entry claims to be; `observed_title` records
what its 14 fetched, byte-immutable chunks actually contain — Reshumot
issue 14863 (18.8.2026), a notice on a deputy minister's cessation of
tenure and unrelated government business, no occurrence of "convalescence"
anywhere. `can_independently_support_monetary_rule` flipped to `false`.
Defense in depth beyond the schema check: `pool-p-parameter-import.mts`'s
`citation()` now refuses (`POOL_P_SOURCE_QUARANTINED_TITLE_MISMATCH`) any
attempt to cite a quarantined source at all, before ever reading its
chunks — proven by execution, not left to the schema alone.

**`IL_ANNUAL_VACATION_LAW`** is annotated `consolidated_before_2017`,
exactly as D-3 was annotated `consolidated_through_2015`: kept (its
§3(b)/(c) day-count thresholds are still genuinely bound in Pool P batch
5, since amendment 15 is documented as touching only the years-1-4
figure, not those thresholds), not discarded, with the current
post-2017 consolidated text now D-16 (§A7-5) — a new acquisition target,
not a silent gap.

### A7-5 — D-13…D-16 (`5271a28`, `9eb402a`)

`workagreements.labor.gov.il` (a `.gov.il` subdomain — official by A7-5's
own rule) added to the fetch allowlist. **D-5 completed** (`dcb759b`):
the 13.7.1998 general collective agreement, fetched and parsed cleanly
(agreement metadata: subject, dates, "active" status, "all employees"
scope — no rate table of its own). **D-16 registered**: Annual Vacation
Law Amendment 15 (fs.knesset.gov.il, via the Knesset database's own
official Reshumot link), unblocking **P-32** (Pool P batch 6,
`9eb402a`) — years 1-4 only, 16 calendar days, its own text confirmed
directly ("instead of '14' comes '16'"). Years 5+ NOT registered: the
pre-2017 law text and the dossier's own summary table disagree on those
figures, and amendment 15 is documented as touching only years 1-4 — a
disagreement this session did not adjudicate rather than guess at.

**D-13, D-14, D-15 recorded blocked, each with concrete evidence:**
- **D-13** (current consolidated Hours of Work and Rest Law): the Knesset
  database's own page for this law has no consolidated-text link at all —
  confirms the dossier's own finding (tracker 6.24) directly from the
  source. `blocked_external: no_official_consolidated_text_found`.
- **D-14** (2016 pension increase order): the already-fetched PDF (64285
  bytes, correct URL) is a scan with no text layer — but this exact
  artifact already has a fully pinned, tested OCR toolchain from an
  earlier wave (`pension-ocr-runner.ts`,
  `PENSION_2016_OCR_TOOLCHAIN.source_pdf_sha256` matches this session's
  fetch byte-for-byte). Running it needs `tesseract` and `pdftoppm`
  binaries this environment does not have — confirmed absent by direct
  check, not assumed. Installing system tooling is not this session's
  call. `blocked_dependency: ocr_toolchain_present_binaries_absent`.
- **D-15** (correct 2026 convalescence order): no official-host URL found
  within a bounded search; the gov.il extension-orders catalog listing is
  Cloudflare-challenge-protected — not bypassed, per standing rules.
  `blocked_external: no_official_url_found_within_search_effort`.

## Wave 8 — offline synthetic shadow: S-1…S-8 (`34d4a0f`)

Most of this pool turned out to already exist from an earlier wave and
already pass — R-1's own framing ("recompute the executor's current state
against the tracker's last recorded failures") applied to S first: run
what exists before building anything new.

- **S-1** (envelope: immutable, hashed, durable, replay reproduces) —
  `durable-contracts.ts`'s `durableShadowRunEnvelopeSchema` self-verifies
  its own `envelope_sha256`; `control-plane.test.ts`'s "runs seven
  synthetic slots, compares pinned versions and replays exactly" already
  proves the replay half. Confirmed passing, not rebuilt.
- **S-2** (kill switch, default off, every runtime mode) —
  `flags.ts`/`readOfflineShadowFlags` already existed and already throws
  rather than defaults closed if any flag would be true under
  `NODE_ENV=production`; `durable-scheduler.test.ts` already covers
  pause/kill-switch/concurrency limits. New this unit:
  `flags.test.ts` (13 tests) — the one thing not explicitly covered,
  booting in every mode (test/development/production/unset) with nothing
  set resolves all-off.
- **S-3** (scheduler, retry, restart, no duplicate output) —
  `durable-scheduler.test.ts`'s "survives restart and completes a fenced
  lease", "recovers an expired crash lease and rejects the stale fencing
  token", "supports explicit cancel and bounded failed-run retry".
  Confirmed passing.
- **S-4** (comparison, deterministic diff, no automatic acceptance) —
  `comparison.test.ts`'s "reports field/topic deltas, blocked and
  uncertainty regressions without promotion". Confirmed passing.
- **S-5** (internal-only: no shadow output reaches any customer-facing
  exit) — `control-plane.test.ts`'s "blocks all real inactive slots with
  zero money, Findings and reports". Confirmed passing.
- **S-6** (audit chain, append-only, walks valid) —
  `durable-scheduler.test.ts`'s "detects committed-state tampering and
  ignores uncommitted partial snapshots"; `control-plane.test.ts`'s "is
  ordering/process stable, append-only audited and makes no network
  calls". Confirmed passing.
- **S-7** (observability: safe, redacted, no identifiers) —
  `shadow-observability.test.ts`'s "emits only hashed correlations and
  bounded synthetic/offline labels with retention deletion". Confirmed
  passing.
- **S-8** (product integration, protected read-only panel inside the
  existing 11-tab `/operations` contract, negative matrix as for the
  other panels) — genuinely new. Found the precedent: addendum 3's G-12
  built the exact same shape for the Ground Truth queue
  (`operations-http.ts`'s `ground-truth` branch,
  `operations-ground-truth-http.test.ts`'s negative matrix). Added a
  `shadow` branch the same way — `SHADOW_ROUTES` (one GET,
  `shadow/summary`), a `shadowCapability()` duck-typed guard, the same
  session-verify-without-CSRF handling — and
  `operations-shadow-http.test.ts` (8 tests) mirroring G-12's own negative
  matrix exactly: one identical 404 shape for five distinct internal
  refusal reasons (`SURFACE_DISABLED`, `SERVICE_ABSENT`,
  `CAPABILITY_ABSENT`, `PATH_NOT_ROUTED`, `SESSION_UNVERIFIED`), wrong
  method refused, exactly one route declared. Same steady state as Ground
  Truth: `readShadowSummary` has no implementation on the canonical
  service anywhere in the non-test tree (neither does Ground Truth's own
  `readGroundTruthQueue`), so the panel correctly 404s
  `CAPABILITY_ABSENT` until a real backing implementation is wired —
  routing and access control are proven now; wiring live (still zero)
  content behind it is a separate, later step.

Pool S: 8/8.

## Wave 7 — synthetic rule runtime closure: R-1…R-7, R-9…R-14 survey (`7c650e7`)

Same method as Pool S: run what exists against each unit's exact wording
before building anything, per R-1's own instruction. Result — most of this
pool already exists and already passes; two units are genuinely new work
(R-6, done) or genuinely not attempted this session (R-2, R-14's specific
trace-replay claim).

- **R-1** (recompute against last recorded failures) — this survey itself.
- **R-2** (seven blank RuleSpec templates, one per real topic, structure
  only, `non_operative`) — **not attempted**. `createRuleSpecPackage`
  exists generically (used for the seven *synthetic* fixtures), but a real,
  per-topic blank template needs real slot structures referencing this
  session's actual registered Pool P parameter ids — a design task, not a
  verification one, and Q-1…Q-7 cannot proceed without it (Addendum 6's
  own ordering: "Q-1..Q-7 once R-2 exists").
- **R-3** (golden vectors, changed trace fails) — `runtime.test.ts`'s
  "round-trips the trace through JSON with the same canonical hash".
  Confirmed passing.
- **R-4** (property coverage: fail-closed, own code, no partial output) —
  `runtime.test.ts`'s "rejects stale, inactive, unreviewed evidence",
  "cancels atomically and exposes no partial trace". Confirmed passing.
- **R-5** (determinism: timezone, locale, iteration order, process
  restart) — `runtime.test.ts`'s "replays identically across input order,
  host timezone, and locale operations" covers three of the four axes
  within one process; a literal fresh-*process* restart replay was not
  additionally proven this session. Confirmed passing for what it covers.
- **R-6** (money invariants, no floating point) — **new this session**,
  `money-path-no-floating-point.test.ts`: zero `parseFloat`, exactly one
  guarded `Number(...)`, exactly one bigint-only division, every rounding
  path traced explicitly. Verified the test catches a real regression
  (injected a bare float division, confirmed the failure, reverted to a
  byte-identical file).
- **R-7** (lifecycle `draft → shadow_eligible → active`, active
  unreachable without two attestations and legal approval) —
  `rulespec-lifecycle.test.ts`. Confirmed passing.
- **R-9** (parameter governance gate; single or same-identity-twice
  attestation refused by the definer) — substantiated by this session's
  own P-0 work: `governance_parameter_attestation_append`'s
  `GOVERNANCE_PARAMETER_REVIEWER_SEPARATION_REQUIRED` check refuses a
  second attestation from the same `reviewer_id` on the same
  (parameter_id, parameter_version) — read directly from
  `202609020020_parameter_attestation_decision_cascade_writes_snapshot.sql`.
  The adjacent, *stricter* cross-branch variant of the same guard was
  proven by execution in `parameter-decision-matrix.mts`
  (`cross_branch_attestation_by_same_reviewer_refused`); the same-branch
  case is the identical conditional one branch earlier in the same `if`,
  not re-executed separately this session (building a fresh trust-stack
  fixture just for this one branch, when the stricter sibling is already
  proven, was judged not worth repeating the whole apparatus for).
  `activation_allowed` reaching `true` is separately impossible at the
  database level regardless — `governance_aggregate_snapshots` has
  `check (not activation_allowed)` (found during Addendum 7 A7-1).
- **R-10** (hash-bound invalidation across the 11 binding dimensions) —
  already delivered as Addendum 7 A7-2: the same eleven dimensions, the
  same one-test-per-dimension proof. Nothing further needed.
- **R-11** (fact-path mapping registry: one registry, no bypass) —
  `rule-input.test.ts`'s "rejects ambiguous mappings", "fails closed when
  a required canonical fact path is absent", "permits only registered
  versioned transformations"; every non-test consumer of
  `knownFactPaths`/`factPathSchema` (13 files, checked) imports from the
  one definition in `fact-paths.ts`, no second list found. Confirmed
  passing.
- **R-12** (single seven-topic readiness evaluator, shared
  `decision_sha256`) — `evaluate-legal-readiness.test.ts`'s "passes one
  isolated synthetic READY case identically through all six delegates",
  "rejects alternate evaluator definitions and runtime direct imports".
  Confirmed passing.
- **R-13** (sector/population applicability: boundary, overlap, gap,
  ambiguous-lands-conflicted) — `synthetic-matrices.test.ts`'s "covers
  temporal, sector, population, amendment and knowledge-time boundaries",
  "selects exactly one instrument without leakage and quarantines
  ambiguity". Confirmed passing.
- **R-14** (wire the executor into the durable runtime; a synthetic run
  persists its trace and replays from the database) — **not specifically
  confirmed this session**. `durable-local-runtime.test.ts` proves the
  general durable product composition (role-separated boundaries,
  capabilities installed only after full construction), but a
  trace-persists-and-replays-from-DB proof specific to the rule executor
  was not located or built this session.

R-8 (global invalidation semantic closure) stays `deferred_to_session_b`,
not attempted, per the standing instruction.

## Pool Q — draft RuleSpecs: not started

Blocked on R-2 (no blank per-topic templates exist to fill), per Addendum
6's own ordering. Q-8 (the sensitivity run) stays `deferred_to_session_b`
regardless, per the standing instruction.

## Session B — B-0: the three red tests, fixed by scope and derivation

Session A's `NEXT` said "hand-update `wave1-artifact-partition.v0.10.9.json`".
That was wrong and Session B's brief says so: the partition asserts exhaustive,
non-overlapping accounting derived from the recorded ledger, and a file you edit
to match cannot assert that. Both red files needed a **scope decision recorded
in code** and a **derivation**, not an editor.

**Scope, `wave1-artifact-partition.v0.10.9.json`: frozen Wave-1 invariant over a
named source-version list.** Everything in the reconciliation says so — the
artifact is named for Wave 1 and pinned to V0.10.9, the builder is
`buildWave1ArtifactReconciliation`, and the assertions around it are Wave-1
absolutes (20 publications, 58 permits, 68 permit artifact urls, 72 acquired
files, 15×403 + 1×404) that later corpus growth was never meant to move. Its
second test is a tamper detector, which is a claim about a closed historical
accounting rather than about how large the corpus is today. The seventeen source
version ids are now named in `src/engine/wave2/evidence-audit/wave1-partition-scope.ts`;
the reconciliation reads the ledger, the manifest and the build state through
that scope, so Pool D's six new sources are out of subject matter **by
construction**. A Wave-1 source that vanishes or is reclassified still fails.

**Derivation**: the file had **no writer anywhere in the repository** — it was
hand-authored once, which is exactly why every legitimate change since read as
tampering. `wave1-artifact-partition-builder.ts` now derives it from the
append-only fetch state and the byte-diff ledger and is forbidden by
construction from reading its own previous output;
`scripts/wave2-evidence-audit/build-wave1-artifact-partition.mts` writes it.
Regenerating moved exactly one byte-level fact — `IL_MIN_WAGE_OFFICIAL_RATES@discovery-v0`
from `aa05c64b…` to `f1265224…`, the BTL page legitimately re-acquired during
Pool D — plus the note. Drift guard: `wave1-artifact-partition-drift.test.ts`
rebuilds and compares bytes, failing with
`REGENERATE_VIA_<builder command>`. A hand edit cannot land silently now.

**Scope, `lifecycle-reconciliation.json`: also frozen, and failing from the
opposite direction.** It *does* have a deterministic builder
(`scripts/wave23-corpus-trust/generate-evidence.mts` →
`corpusLifecycleReconciliation()`), but that function takes **no input**: it is a
hardcoded seed table for the same seventeen Wave-1 source versions. Regenerating
it therefore changes nothing, and the mismatch was never in the artifact — it was
in the consumer. `overnight-v07/inventory.ts` compared frozen totals against the
whole live corpus. It now compares them against exactly the source versions the
document names in its own `sources[]`, which is self-describing and needs no
second list to maintain. `lifecycle-drift.test.ts` guards the generated artifact
against hand edits the same way, and asserts the document stays internally
closed with `reviewed 0 / active 0 / operative 0`.

**One real defect found and fixed on the way**: `artifact-reconciliation.test.ts`
proved its tamper case by writing mutations over the committed baseline and
restoring it in a `finally`. Under full-suite parallelism that made the
committed file shared mutable state across test files, and the new drift guard
read mutated bytes — passing alone, failing in the suite. The baseline path is
now an input; the tamper test mutates a temp copy and no test writes the
committed file at all.

## Session B — R-2, R-14, R-8, Q-1…Q-8, B-7

**R-2 (seven blank RuleSpec templates).** Built ON the existing seven authoring
skeletons rather than beside them: each template carries the skeleton's id and
content hash as provenance and takes its fact paths from it, so the two cannot
drift. What the skeletons lacked is the slot vocabulary — inputs with per-input
allowed and forbidden provenance plus fail-closed blocker codes, parameter slots
naming the parameter, its unit and any open decision, citation slots naming the
step each clause must support, and the rounding, effective-period,
sector/population and precedence slots. Provenance reuses the fact registry's
own `factSourceTypeSchema` rather than a second enum; no template allows
`derived` or `inferred` on any input, because an agent's guess is not a basis
for a monetary claim. The refusal is machinery, not a label: `executeRuleSpec`
itself throws `RULESPEC_INPUT_MISSING` for all seven fixtures when parameters
are absent.

**R-14 (trace replay from the database).** New table
`private.legal_operations_execution_traces`, deliberately not
`public.engine_calculation_trace_versions` — that one is keyed by a customer
case and an analysis run, and inventing a case row to hold a synthetic trace
would put synthetic material on the customer path. Append-only (update and
delete both raise 42501), structurally non-operative via a named CHECK. The
inputs are stored beside the trace, because replaying from the database means
reconstructing the computation, not reading a blob back and agreeing with
itself. Two independent hashes: the engine's canonical hash from the caller, and
the database's own hash of the stored jsonb computed in the definer and never
accepted as a parameter. A genuinely fresh Node process replays byte-identically
in canonical form; a one-increment change to a persisted input is detected and
refused, and the refusal is provably about the recomputation — the database
witness and the stored blob hash both stay intact while only the caller hash
disagrees. 9/9 by execution.

**R-8 (semantic closure).** Over all twelve mutation kinds, not the journey
subset: the stale set is always a contiguous suffix running to the last stage, a
change to any fact, source, parameter or rule reaches every dependent stage, and
invalidation is monotone. Atomicity proven by failing each of the ten writing
statements in turn: the call rejects, nothing after the failure is attempted,
and the idempotency record is never committed. The three effects that stayed
`"unknown"` stay `"unknown"` — R-8 says wire them only if a genuine caller now
exists, and none does. That is now checked by execution (a grep for real
invocations of `withCurrentAuthorization`, cross-checked against the disposition
record's `implemented_uncalled` entry) rather than asserted in a comment: the
day someone calls it, the test fails.

**Q-1…Q-7 (seven draft RuleSpecs).** Each fills its template, pins it by hash,
and binds only parameters that exist as `draft` rows. Both branches of both open
decisions, never one. Three slots unbound, each naming its specific Pool P
block. Proven on DEV 8/8.

Worth recording for whoever comes next: **`governance_parameter_versions` is
unreadable by everything that can connect.** No SELECT grant for any login role,
and the admin migrator is refused `runtime_context_install` outright
(`RUNTIME_CONTEXT_ROLE_FORBIDDEN`). The sanctioned read is
`private.governance_aggregate_read(tenant, workflow_kind, aggregate_id,
aggregate_version)`, whose `content_json` column carries the full candidate.
Migration `202609020024` adds the missing read for `legal_open_decisions`, which
had a register function, a withdraw function, a guard, and no read path at all —
found by trying to use the system rather than by reading the schema.

**Q-8 (the decision-sensitivity report).** Internal only, hashed, on the offline
shadow envelope, never a Finding, never delivered. Two open questions with
exact, checkable differences read from the governance database in BigInt minor
units: `min_wage_hourly_divisor` 182 → 35.40 ILS vs 186 → 34.64 ILS (0.76), and
`pension_wage_cap_section` 13566.00 vs 13769.00 (203.00). Per-scenario
propagation is **not** computed and says so: the draft specs cannot execute
while their judgement slots are unbound, and the 42 golden cases are blank
templates with no input snapshot, so all 42 are recorded attempted-and-not-
runnable with both reasons named. `scenarios_run: 0`.

Two things the report records rather than works around: A7-3's proof fixtures
are permanent (the table is append-only with no delete path), so eight throwaway
decisions are listed as non-legal fixtures instead of appearing beside real
questions; and the one genuinely withdrawn legal decision carries `topic: "test"`
because A7-3's script registered it through the fixture helper. Neither is
correctable. The id namespace is the reliable discriminator and is what the
report uses.

**B-7 — what the new artifacts actually unblock, and a defect one of them
exposed.**

D-5 unblocks nothing. Reading its bytes rather than its metadata: the fetched
artifact is the Ministry of Labor registry's **index entry** for agreement
19987038 — number, subject, signing date, status, signatories, and a link — with
no operative text and no figure at all. The host is official and the page is
genuinely about the right agreement, which is exactly why it passes every
host-and-title check. Quarantined as
`invalid_content_catalogue_record_not_instrument`, a new status in A7-4's
vocabulary; the schema check now bars *any* non-`verified` integrity status from
supporting a monetary rule, so a status added later is barred by default.
P-26…P-29 stay `blocked_dependency` on the agreement text itself.

D-16 unblocks two parameters and exposes one defect. Amendment 15 makes **two**
changes to §3(a)(1), not one: `במקום "מ־4" יבוא "מ־5" ובמקום "14" יבוא "16"` —
the seniority band moved as well as the day count. Session A's
`il.vacation.calendar_days_years_1_to_4` therefore carries the right number
against the wrong population, and its run-time citation check could not catch
it: the chunk does contain "16" and "14", and a citation check cannot see that
the scope in the parameter disagrees with the scope in the clause. That is the
"citation-checked but still wrong" failure this discipline exists to prevent.
The table is append-only so the row cannot be corrected; `SUPERSEDED_BY_SCOPE`
in `rulespec-drafts.ts` names it, a test asserts nothing binds it, and Pool P
batch 7 registers `il.vacation.calendar_days_years_1_to_5@2017.1.0` in its
place. Batch 7 also registers the temporary provision nobody had noticed:
`il.vacation.calendar_days_interim_2016@2016.1.0` = 15 days for 1.7.2016 to
31.12.2016, band still four years.

Pool P now stands at 28 registered draft parameter versions.

## Pool E2 — the layer after Q-8

**E2-1 review package v6.** Manifest
`c21a35f0ef27e2310dd372aac087e7e4e2b7513e428380aedeeaefecc1fefe27`, 11 files,
built twice byte-identical (every member hash compared, not just the manifest).
Contents: the research dossier, the Hebrew reviewer runbook, the Q-8 sensitivity
report, the `legal_open_decisions` export with reasons, every bound draft
parameter with its eleven binding hashes and its artifact ids, the v0-vs-v1
citation re-check, the seven templates, the seven drafts, and the sixty-nine
supersession packets index. Every item `not_reviewed`, `not_signed`,
`not_activated`, `not_delivered`, stated per item.

The 42 scenario traces the brief asked for are **not** in it, because they do
not exist: the drafts cannot execute and the golden cases are blank. In their
place is `scenarios/scenarios-not-run.json` — all 42 attempted, both reasons
each, `traces_included: 0` — read out of the sensitivity report so the two can
never disagree. An empty `traces/` directory would have read as an oversight.

**E2-2 owner reviewer identity.** `keygen` writes an Ed25519 pair to the
git-ignored dev env file and prints only the public half and the registration
command. It is deliberately **not run here**: generating the owner's own signing
key unattended is not something to do on their behalf. `register` is an explicit
refusal that explains itself. The proof half extended the P-0 matrix with the
case E2-2 turns on — the same identity attesting the same candidate twice is
refused, and the refused attempt leaves the candidate exactly where it was.
15/15. Recorded: **a synthetic identity cannot be torn down** — every identity
table raises `GOVERNANCE_APPEND_ONLY` on update and delete, for anyone.

**E2-3 ground-truth write path.** Two POSTs beside G-12's read. G-4 independence
and G-7 lock semantics stay in the definers; the route passes the envelope
through whole. CSRF from the method, not a per-path exception. The capability
now requires all three methods, so a read-only service serves nothing rather
than a queue whose claim button 500s. 16 tests, zero annotation content,
`HUMAN_GROUND_TRUTH_LOCKED` 0.

**E2-4 logical-order Hebrew.** `legal-normalizer-v1`, 61 of 71 sources reordered,
71 new parsed versions beside immutable v0, zero rebinds. The finding it made by
accident is the important one: re-checking all 18 registered citations over 16
chunks, 10 had their text move and **not one changed status**. Every needle is
numeric — zero non-numeric across the whole corpus — so digits survive the
transform both ways and the check has never verified a word of Hebrew. That is
exactly how it passed on amendment 15 while the band was wrong.

**E2-5 the eight `public.*_salary_*` grants.** All eight `cannot_move`, recorded
per function with its own caller and its own consequence. Every caller reaches
Postgres through PostgREST with a service-role JWT, and PostgREST picks its role
from that claim, which Supabase issues only as `anon`, `authenticated` or
`service_role`. Revoking first would break paid-invoice verification and
once-only purchase tracking. The unblock precondition is written down so a
fourth session need not re-derive it.

**E2-6 permit retry.** 16/16 still blocked, every safe error code byte-identical
to the previous observation. Dated evidence that the block is still real.

**E2-7 reviewer runbook** (`docs/legal/reviewer-runbook.he.md`), mechanics only,
honest about which panels are live and what is still missing.

**E2-8 tracker delta v37** at `output/next/tracker-delta-v37.md` (ignored tree,
as specified). Five blockers closed, five opened: BL-10 the citation check
verifies no Hebrew; BL-11 the mis-scoped vacation parameter that cannot be
corrected; BL-12 the permanent A7-3 fixtures and the mislabelled real
withdrawal; BL-13 the pre-guard identity session; BL-14 D-5's catalogue-record
artifact.

**E2-9 eslint** 0 errors, 0 warnings, by removing dead parameters rather than
configuring an ignore pattern.

**E2-10 reference-tenant hygiene.** 28 candidates all draft, none activatable;
11 decisions (3 legal, 8 permanent fixtures); zero customer rows. Every private
governance table returns 42501 to the runtime role rather than an empty result.
Two things said plainly instead of rounded to zero: identity sessions are 2, not
0 (one sanctioned, one pre-guard residue that nobody can delete), and teardown
was not performed and should not be — a deletion path in an evidence ledger is
worth more to an attacker than to housekeeping.

## Freeze — Addendum 7 close, the full matrix at this head

Per A7-6: a session that stops runs the full matrix on its own final head
before the report; green does not travel across heads, and the 406-test
figure cited earlier in this file was the engine/governance suites, not
the whole repo. This is that run, at `41cfd25`, 36 commits since base
`ba80cc2`, working tree clean.

Local: vitest 261/263 files, 1829/1835 tests, 3 failing, 3 skipped
(140.25s). Both failures are the same root cause: this session's own Pool
D growth (17→23 sources) outran two derived/reconciliation snapshots that
compare the live corpus manifest against a stored count.
`src/engine/wave2/evidence-audit/artifact-reconciliation.test.ts` throws
`quarantine_or_change_partition_mismatch` from
`artifact-reconciliation.ts:430` against the git-tracked baseline
`wave1-artifact-partition.v0.10.9.json`, whose per-source
`disposition`/`artifact_sha256` list and aggregate counts predate the six
D-pool sources this session added. Re-running the apparent official
regenerator (`TIVDOC_LEGAL_NETWORK_DISABLED=1 node
scripts/wave2-evidence-audit/run-all.mts`) throws the identical error —
the fixture needs a correct, careful hand update (per-source entries plus
recomputed aggregates for D-5, D-16 and the others), which this session
did not attempt given the risk of silently encoding a wrong
`disposition`/hash this late. `src/server/product/integration/ready-integration.test.ts`
throws `P3_LIFECYCLE_RECONCILIATION_MISMATCH` from
`overnight-v07/inventory.ts:112` against the git-**ignored**, local-only
`output/parallel-wave-2.3/workers/w2-corpus-trust/lifecycle-reconciliation.json`
— lower severity, regenerable, not investigated further tonight. Running
`legal:sources:citations` mid-diagnosis correctly resynced
`citation-round-trip-report.json` (23 source versions, 468 chunks
checked) and cleared the first, milder variant of this second failure
(`P3_ONE_TO_ONE_CORPUS_STATE_REQUIRED`), leaving the lifecycle-count
mismatch above it. Neither failure touches anything this session wrote
directly; both are confirmed corpus-size/snapshot desync, not a code
regression (`git status` clean before this run — nothing to stash).

tsc clean (`tsc --noEmit`, exit 0). eslint 0 errors, 10 pre-existing
warnings in two files untouched this session
(`global-invalidation.test.ts`, `runtime-product-lane.test.ts`).
`next build` succeeds; every route compiles, including the new
`/api/operations/[...segments]` `shadow` branch; only the two
pre-existing dynamic-filesystem-access tracing warnings remain
(`browser-runtime.ts`, `deterministic-hebrew-pdf.ts`), unrelated to this
session.

Not re-run this close: the extended DEV-role sweep from the prior wave's
freeze above (RLS force, definer-surface census, service-role closure,
identity negative matrix, invalidation effects, grant execution, dynamic
matrix, supersession, review-package build, ground-truth matrix, owner
reassignment, HTTP journey) — nothing this session touched changes what
that sweep measures, and re-running the full DEV apparatus was judged out
of proportion for a checkpoint whose new surface (A7-1's guards, A7-3's
withdrawal path, S-8, R-6) already has its own execution-proof scripts
and tests, listed unit-by-unit above. It should be re-run in full before
anything from this branch is treated as production-ready.

Lane B (four continuously-refilled Haiku read-only agents) was not
launched this session, in either phase — recorded honestly as 0, not
fabricated.

Counters unchanged: HUMAN_GROUND_TRUTH_LOCKED 0, REAL_* 0, DEPLOYMENTS 0,
REMOTE_PRODUCTION_MIGRATIONS 0, LIVE_PROVIDER_CALLS 0.

## Resume point

- **Checkpoint at unit 10 (Session A, Sonnet, continuous grind, base
  `ba80cc2`).** D-00 (`e920066`), D-0 (`011c3a6`), H-1 (`a6d40c5`), H-2
  (`d77781e`), H-3 (`e6e1a68`), H-4 (`aab075d`), H-5 (`33091c3`), H-6/H-7
  (`b3550b4`), H-8 (`092aef0`) — 10 commits, 10 units, all resolved (X-4/H-5
  and the storage key/H-7 resolved to a correctly-recorded
  `blocked_dependency`, not left silent). Pool H is complete: 8/8.
- **Checkpoint at unit 16.** P-0 (`d8497ed`), D-2 (`8d3019e`), D-4
  (`1f6c709`), D-7 (`370f4c9`), D-1b (`9b27863`), D-3 (`6c73202`) — 6 more
  commits, 6 more units. Pool D is complete: 12/12 + D-1b (10 resolved and
  bound to a fetched artifact, D-5's second half and D-12 correctly
  recorded blocked with evidence rather than dropped or fabricated).
- **Checkpoint at unit 22.** Pool P batches 1-5 (`5ba732e`, `845d83b`,
  `026804b`, `e1d86a2`, `44da0cb`) — 5 commits, 5 units, 18 of 37
  addendum-listed parameters registered as DEV-verified draft candidates
  (tenant `legal.reference.il`, flagged for owner confirmation — see the
  Pool P write-up above), the rest recorded `blocked_dependency` with a
  specific corpus-anchored reason each. Two new findings surfaced along
  the way, both documented above: the registered
  `IL_CONVALESCENCE_EXTENSION_ORDER_2026` source's fetched content does
  not match its own title at all (content mismatch, not a wrong citation),
  and the fetched `IL_ANNUAL_VACATION_LAW` predates 2017's amendment 15
  (stale primary text, not safe to bind a "current" parameter to).
- **Checkpoint at unit 29 (Addendum 7).** A7-1 (`1023455`), A7-2
  (`783c8b9`), A7-3 (`c59bb20`), A7-4 (`c56c1c2`), A7-5's D-5 (`dcb759b`),
  A7-5's D-13…D-16 (`5271a28`), Pool P batch 6 / P-32 (`9eb402a`) — 7
  commits, 7 units. All three A7-1 guards proven by execution; the
  eleven-dimension hash formula implemented and tested per-dimension;
  `withdrawn` is now a real, distinct, evidenced decision state and the
  vacation "200 vs 240" finding has its own record; two sources
  quarantined structurally, not just by convention; one more official host
  allowlisted (a `.gov.il` subdomain) and D-16 registered. Addendum 7's
  own corrections (A7-6) are in force from here: no stopping at a domain
  boundary, and the chat only gets the ten-line report at the very end —
  this file carries everything else.
- **Checkpoint at unit 32.** Pool S (`34d4a0f`, `05f5828`) — S-1…S-8, 8/8:
  most already existed and already passed (envelope replay, kill switch,
  restart/crash recovery, comparison, zero-customer-exit, audit
  tamper-detection, redacted observability all confirmed by running what
  was there), S-2 got one more explicit runtime-mode test, S-8 (product
  integration) is genuinely new — a protected read-only `/operations`
  panel following G-12's exact precedent, 8/8 negative-matrix tests
  passing. Pool R survey (`7c650e7`) — R-1, R-3…R-5, R-7, R-9, R-11…R-13
  confirmed already passing against existing tests; R-6 newly built and
  proven; R-10 already satisfied by A7-2. **R-2 and R-14's specific claim
  are not attempted this session** — R-2 needs real per-topic slot design,
  not verification, and blocks all of **Pool Q, which is accordingly not
  started**. R-8 and Q-8 stay `deferred_to_session_b` as instructed.
- **Next for whoever resumes this**: R-2 (design seven real blank
  RuleSpec templates against this session's actual registered parameter
  ids) is the one open prerequisite before Pool Q can start at all;
  R-14's specific "executor trace persists and replays from the durable
  DB" claim wants its own targeted proof; the remaining Pool P units
  (P-11…P-16, P-21…P-23, P-27/P-28, P-33, years 5+ of P-32) need the
  acquisition or tooling work recorded blocked in the Pool P and A7-5
  write-ups above. The one full matrix and the ten-line report follow
  this checkpoint, per Addendum 6 / `tivdoc-next-run.md` as corrected by
  Addendum 7's A7-6 (no further stopping at a domain boundary was needed
  to reach this point; the backlog from here is genuinely new-design work
  each unit's own write-up names precisely). That matrix run and its two
  named, diagnosed failures are recorded above in "Freeze — Addendum 7
  close"; the `wave1-artifact-partition.v0.10.9.json` hand-update is the
  most concrete of the next steps.
- carried from before this session: K-3's managed-bucket half (needs the
  Storage key — H-7 re-confirmed absent this session), K-5 (needs a
  provisioned off-host destination), the owner's visual review of the five
  payslip composites (human, open), and the eight `public.*_salary_*`
  grants (H-5: needs a PostgREST-selectable narrow runtime role that does
  not exist, not a per-function grant move — do not retry as a plain grant
  change).
- B-3..B-7 once a fixture exists per history guard.
- known blocks that must not be retried: corpus acquisition, a second Supabase
  project, resetting the DEV default database, `initdb.exe` under Windows
  Application Control (BL-6).
