# Tivdoc development state

- wave: 1 of the rolling queue — close the durable journey
- base: a0761d286b5a81322c4f5f3215c871de0049b07d
- head: pending
- frozen_head: pending
- date: 2026-09-02

## Ledger

| lane | id | item | status | evidence |
|---|---|---|---|---|
| A | W1-1 | 422 root cause, fix, regression test | delivered (prior commit `b34765b`) | `legal-review-runtime-grants.test.ts` |
| A | W1-2 | journey 16/16 against DEV | delivered | `output/wave1/browser/journey.json` |
| A | W1-3 | 71/71 durably accounted, replay adds nothing | delivered | `output/wave1/projection/projection.json` |
| A | W1-4 | A1 blocked-record store, append-only, RLS forced | delivered | `supabase/migrations/202609020002_legal_review_observation_blocks.sql` |
| A | W1-5 | A3 breakdown by reason code | delivered | `output/wave1/audit/reason-breakdown.json` |
| A | W1-6 | A4 wrapper origin preservation | delivered | `origin-preservation.test.ts` |
| A | W1-7 | A5 grant coverage proven by execution | delivered | `output/wave1/audit/grant-execution-proof.json` — 15 commands, 0 denied |
| A | W1-8 | dynamic matrices on DEV | partial | role and refusal halves proven; conflict, race, rollback and outbox atomicity not re-run |
| B | B-28 | counter recomputation and journey subset | delivered | `output/wave1/agents/b28/findings.md` |
| B | B-38 | invalidation path map | delivered | `output/wave1/agents/b38/findings.md` |
| B | wrappers | origin-destroying wrapper sweep | delivered | `output/wave1/agents/wrappers/findings.md` |
| B | grants | product-path command inventory | delivered | `output/wave1/agents/grants/findings.md` |

## Decisions

- **The `.gitignore` gate failed again and was repaired first.** The rolling
  queue introduces wave-named output directories; rules for all four plus the
  probe path were added and re-checked on a nested and a deep path before work
  started.

- **A1 built as approved, with the anti-graduation rule enforced by
  construction rather than by policy.** The blocked table holds no hash, version
  or binding column at all, so there is nothing to backfill; the append-only
  trigger forbids `UPDATE` outright, and a `superseded_by` column was
  deliberately *not* added because it would be the one mutable field and the one
  path by which a block could become a packet. A future genuine parse produces a
  new artifact and a new packet, related by sharing the observation id.

- **Append-only is proven by showing no actor can mutate, not by a probe that
  matches nothing.** Rows are visible only inside a `SECURITY DEFINER` function
  called by a runtime role, because `runtime_verified_tenant()` requires
  `session_user` to be one of the three runtime roles and the policy targets the
  owning role. An `UPDATE`/`DELETE` probe from any reachable connection matches
  zero rows and "succeeds" without the row trigger ever firing — it would prove
  the opposite of what it claims. The receipt instead records that the trigger is
  attached to `governance_forbid_mutation`, and that `anon`, `authenticated`,
  `service_role` and all four runtime roles hold no `select`, `insert`, `update`
  or `delete` on the table.

- **A2 satisfied: `accounted = projected + blocked` is read from the database.**
  `private.governance_legal_review_projection_accounting(tenant)` returns the
  three counts as a relation. The run receipt records `{"projected":"0",
  "blocked":"71","accounted":"71"}` from that function, not from the projector's
  own arithmetic, and a second pass from a fresh process returned the identical
  triple.

- **A3, and one correction to the wave's framing.** Of the 71: 69
  `BYTES_PRESENT_NOT_PARSED`, 2 `BYTES_REJECTED_DUPLICATE`, 0
  `RETRIEVAL_FAILED_NO_BYTES`. The 403/404 family is *not* part of the 71 — it
  lives in `remaining_gaps` (15 HTTP 403, 1 HTTP 404) and is a separate
  population that never entered `acquired_files`. So the answer to "are any of
  these recoverable parsing work" is: 69 are byte-complete and unparsed, which
  is parsing work, not acquisition work. Not acted on this wave.

- **A4 found four more instances of the same defect class, not just one
  wrapper.** The sweep confirmed `cause` is never set anywhere in `src/server`.
  The fix carries the origin SQLSTATE through `GovernanceRepositoryError` and
  teaches the classifier that `42501` is a refusal (`OPS_FORBIDDEN`), not an
  unclassified rejection. Separately, the command inventory found four
  governance import functions granted to the worker but executed as operations —
  four more 42501s waiting for their first caller, repaired in
  `202609020003`.

- **B-38 cannot be shown green in journey scope, and that is a finding, not a
  gap in this wave's work.** The `/operations` journey exercises none of the
  invalidation machinery: `create_dependency_invalidation` and
  `withCurrentAuthorization` have zero callers repo-wide. Wiring is Wave 2 Lane A
  scope. The agent also found that `approval_invalidated` and three sibling
  booleans are hardcoded `true` while the computed count is discarded
  (`postgres-port.ts:488,:570-573,:602`) — a truthfulness defect that belongs in
  the same pass.

## Blockers

| id | blocker | class | evidence |
|---|---|---|---|
| BL-1 | 69 of the 71 are byte-complete but unparsed; producing normalized text, manifest, parser and normalizer versions is a parsing workstream | blocked_external | `output/wave1/audit/reason-breakdown.json` |
| BL-2 | B-38 has no journey-reachable path; the invalidation service has zero callers | product_gap | `output/wave1/agents/b38/findings.md` |
| BL-3 | `approval_invalidated` and three sibling effect booleans are hardcoded true | product_defect | `dependency-invalidation/postgres-port.ts:570-573` |
| BL-4 | Windows Application Control blocks `initdb.exe` | blocked_external | not on any critical path |
| BL-5 | `V041_MISMATCH_004` bytes are gone; recorded, not re-baselined | evidence_integrity | `evidence-loss.v0.10.11.json` |
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

B-28 unchanged: strict 40, MC-29 19, denominator 84. 8 of the 40 lie on the
journey, all `CAPABILITY_GATED_CANONICAL_SOURCE`.

Chain: 26/26 applied — 24 verbatim byte-pinned, 2 platform-compensated
(`alter role … nosuperuser`; `supautils` reserved-role refusal), dropped lines
recorded, end state asserted.

## Resume point

- next wave: 2 — journey-scope closure of `B-28` and `B-38`
- next todo: wire `create_dependency_invalidation` to a journey caller, then
  prove atomic invalidation along the paths the journey exercises; fix the
  hardcoded effect booleans in the same pass. Lane B's Wave 1 findings name every
  anchor.
- known blocks that must not be retried: corpus acquisition, creating a second
  Supabase project, resetting the DEV default database.
