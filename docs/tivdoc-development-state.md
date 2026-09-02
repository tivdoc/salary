# Tivdoc development state

- wave: V0.10.13
- base: e539019938c3addbff790e3c150119b6d323cc33
- head: pending
- frozen_head: pending
- date: 2026-09-02

## Ledger

| id | item | status | evidence |
|---|---|---|---|
| W1 | make the failure name itself | delivered | `output/v0.10.13/audit/` server log `postgres_failure … stage=operation`; `failure-descriptor.test.ts` |
| W2 | identify and fix the 422 | delivered | `supabase/migrations/202609020001_legal_review_runtime_execute_grants.sql`; `legal-review-runtime-grants.test.ts`; `connection-targets.test.ts` |
| W3 | journey to 16/16 | delivered | `output/v0.10.13/browser/journey.json` — 16/16 |
| W4 | `71/71` durable projection | partial | `output/v0.10.13/projection/projection.json` — 71/71 accounted, 0 projectable, 71 blocked with reason codes |
| W5 | dynamic matrices on DEV | partial | role and refusal matrix green at the HTTP boundary; database-level matrix not re-run |
| W6 | `B-28` and `B-38` | partial | `output/v0.10.13/audit/entrypoint-counters.json`; `B-38` not re-proven |
| W7 | state file and freeze | delivered | this file |
| W8 | frozen-head matrix | see report | `output/v0.10.13/matrix/` |
| W9 | tracker delta | delivered | `output/v0.10.13/tracker-delta.md` |

## Decisions

- **The §1 ignore gate failed again and was repaired first.** Every wave adds
  its own `/output/<version>/` rule and none existed for this one. Added, then a
  nested and a deep path were both re-checked before any work started.

- **The null SQLSTATE was an artefact of an intermediate wrapper, not of the
  original error.** §9 deduced correctly that a null rules out a Postgres server
  error *at the classification site*, and that deduction pointed at Branch A. It
  was right about the shape and wrong about the origin: the thrown thing at the
  boundary was a plain application error carrying `code=GOVERNANCE_QUERY_FAILED`,
  and *behind it* was a genuine `DatabaseError`, SQLSTATE `42501`,
  `routine=aclcheck_error`. The intermediate wrapper erased the SQLSTATE before
  the classifier saw it. One instrumented reproduction settled in minutes what
  three runs of deduction could not.

- **Root cause: a whole function family reachable only by its owning role.**
  Migration `202609010011` created the three legal review entry points as
  SECURITY DEFINER functions owned by `tivdoc_governance_owner`, revoked them
  from `public`, `anon`, `authenticated` and `service_role`, and granted execute
  to the owning role only. It never granted them to the runtime principals that
  call them. Every other governance family in migration `005` carries those
  grants; this one was omitted. Verified on DEV before the fix:
  `ops=false worker=false` on all three, against a control of `ops=true` on
  `governance_work_enqueue`.

- **The repair is the missing half of least privilege, not a widening.**
  `202609020001` grants execute on exactly the signatures each principal
  invokes — queue_list and action_append to operations, packet_enqueue to
  operations and worker. Ownership stays with the governance owner, the
  functions stay SECURITY DEFINER, and the revocations from `public` and the
  reserved Supabase roles are re-asserted. Verified after: `anon`,
  `authenticated` and `service_role` remain false on all three.

- **§3.1 error fidelity is now structural.** The classifier records stage,
  constructor name, a token-shaped `code`, `errno`, `severity`, `routine` and
  SQLSTATE — never a message, a parameter, an identifier or a connection string
  fragment. `stage` distinguishes `acquire` / `begin` / `operation` / `commit` /
  `rollback` / `release`, which converts "fails before any statement" from an
  inference into a fact. The external contract is byte-identical and tested.

- **§3.2 connection targets are asserted at startup.** All eight database URL
  keys are classified by host class alone. The four product keys must resolve to
  one target; a single key falling back to loopback while the rest point at a
  declared target now fails at startup with
  `DURABLE_LOCAL_PRODUCT_CONNECTION_TARGET_SPLIT` rather than surfacing as a 422.
  The hypothesis it forecloses did not fire this run, and the assertion stays.

- **W4 is honestly 0 projected, not silently deferred.** The canonical 71 are
  the staged, unregistered acquisitions from the V0.4.1 crosswalk — 72 acquired
  URL results, 71 unique byte objects, 1 registered overlap. Every one of the 71
  is accounted for with a stable observation id and a distinct idempotency key,
  and every one is blocked on the same four fields: no normalized-text hash, no
  manifest hash, no parser version, no normalizer version. `packet_enqueue`
  requires all four. Supplying them would mean fabricating binding evidence, so
  none were projected. What is still owed is a durable, immutable home for the
  71 blocked records; they exist today only as a run receipt.

- **§3.3 honoured again.** No detail endpoint was built. The journey's detail
  step reads the selected packet's fields out of the queue payload, which is
  what the product panel does; there is no caller for a separate endpoint.

- **One freeze cycle moved three chain-length assertions with the chain.**
  Appending a forward repair migration is how this chain has always grown —
  `008`, `009` and `010` did the same — so the pinned count and the pinned last
  filename move with it. The digest map is unchanged for all 23 existing files
  and the new one is pinned like the rest; no expectation about content moved.

## Blockers

| id | blocker | class | evidence |
|---|---|---|---|
| BL-1 | the 71 blocked projection records have no durable immutable store; the packets table cannot hold them because `packet_enqueue` requires binding fields the observations do not have | product_gap | `output/v0.10.13/projection/projection.json` |
| BL-2 | the 71 observations lack normalized text, manifest hash, parser and normalizer versions; producing them means parsing the corpus, which is a separate acquisition-side workstream | blocked_external | blocked reason histogram, 71 on each of four fields |
| BL-3 | Windows Application Control blocks `initdb.exe` | blocked_external | not on any critical path |
| BL-4 | `V041_MISMATCH_004` bytes are gone; recorded, not re-baselined | evidence_integrity | `evidence-loss.v0.10.11.json` |
| BL-5 | hours/overtime official artifact unavailable | blocked_external | carried forward |
| BL-6 | min-wage and Knesset convalescence byte changes await human legal review | blocked_human | blocks no engineering item |
| BL-7 | `synthetic-property-suite` scanner finding needs a placement decision | blocked_human | `OWNER_POLICY_REQUIRED` |

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

B-28 recomputed at this head: strict 40, MC-29 19, denominator 84, difference 21
— unchanged, and per the standing ruling neither number is ever adjusted.

Chain: 24/24 applied — 22 verbatim byte-pinned, 2 platform-compensated
(`alter role … nosuperuser`; `supautils` reserved-role refusal), dropped lines
recorded, end state asserted. The chain grew by one forward repair migration,
appended and digest-pinned.

## Resume point

- next todo: BL-1. Decide where the 71 blocked projection records live durably.
  The packets table is the wrong home — its enqueue validates a binding these
  observations cannot supply. A sibling append-only table keyed by observation
  id, holding the reason codes and the idempotency key, is the shape the ledger
  item implies; it is a new table, so it needs a forward migration, runtime
  grants alongside it, and the same replay-adds-nothing proof.
- the DEV runtime database is `tivdoc_v09_devruntime01` with the full chain plus
  the grant repair, and four least-privilege login roles; credentials are in
  `~/.tivdoc-dev/credentials.env`.
- known blocks that must not be retried: corpus acquisition, creating a second
  Supabase project, resetting the DEV default database.
- do not reopen §3 or `B-55`.
