# Tivdoc development state

- wave: V0.10.12
- base: bd00b0c4efea29c5ed783c65ece6bf8596fe6394
- head: pending
- frozen_head: pending
- date: 2026-09-02

## Ledger

| id | item | status | evidence |
|---|---|---|---|
| W1 | close the legal-review API 404 | delivered | the API now reaches the durable service; `output/v0.10.12/browser/journey.json` |
| W2 | browser journey to 16/16 | partial (14/16) | two GETs answer 422 `OPS_COMMAND_REJECTED` from the durable transaction |
| W3 | `71/71` durable projection | blocked_external | the queue read is the surface it projects into, and that read is the open 422 |
| W4 | dynamic matrices on DEV, database half | partial | HTTP-boundary role and refusal matrix green; database-level matrix not re-run |
| W5 | `B-28` and `B-38` | partial | counters carried forward unchanged; `B-38` not re-proven |
| W6 | state file and freeze | delivered | this file |
| W7 | frozen-head matrix | see report | `output/v0.10.12/matrix/` |
| W8 | tracker delta | delivered | `output/v0.10.12/tracker-delta.md` |

## Decisions

- **The §1 ignore gate failed again and was repaired first.** Every wave adds
  its own `/output/<version>/` rule and none existed for this one. Added, then
  a nested and a deep path were both re-checked before any work started.

- **The 404 root cause was none of the four §9 candidates.** Routing was fine,
  the flag was set, the governance adapter *was* the installed service, and the
  session boundary was present. The cause was the fifth possibility the analysis
  did not list: `authenticateProductIdentity` requires the request origin to
  equal the configured origin exactly, and a route handler's request URL is
  reconstructed with the server's own loopback label while the configuration
  used the other one. The page route never hit it because `productPageSession`
  builds its own `Request` from the configured origin, so it always matched.
  Every API route was therefore unreachable to a session the page accepted.

- **Origin equality was not relaxed.** `identity-session.test.ts` deliberately
  asserts that `http://localhost:PORT` is refused against a configured
  `http://127.0.0.1:PORT`, and that assertion stands untouched. What changed is
  configuration: `strictLocalOrigin` and the internal-ops runtime class now
  accept the exact loopback set (`127.0.0.1`, `localhost`, `[::1]`) as a
  *configured* origin — the same set `canonicalProductIdentityOrigin` already
  accepted — so a deployment can declare the label its own server uses. The
  request origin still has to equal it exactly.

- **§3.2 applied, and then twice more.** A bare 404 that hides its own cause is
  a defect: the external response stays byte-identical and bodyless for every
  cause, while five distinct internal reason codes are recorded through a
  code-only path. The same treatment was extended to identity refusals
  (thirteen codes, including which side of an origin mismatch was loopback) and
  to `OPS_COMMAND_REJECTED`, whose catch-all now records the failure class and
  any SQLSTATE. Those three traces are what turned a two-run mystery into a
  located defect inside one run; nothing recorded is ever more than a code and a
  timestamp.

- **§3.4 route matrix.** `LEGAL_REVIEW_ROUTES` is now the single declaration the
  handler routes from, and the matrix test asserts against that same list:
  non-404 on every declared endpoint for an authorized reviewer, 404 without a
  session, 404 on the wrong method. A hand-maintained copy could drift; this
  cannot.

- **§3.3 did not apply.** The journey never calls a packet detail endpoint — it
  walks queue, topics and actions, all three of which are routed. The detail
  endpoint was not built, because building an endpoint nothing calls would widen
  the surface for nothing.

- **Chain result, stated per §3.1:** 23/23 applied — 21 verbatim byte-pinned, 2
  platform-compensated (`alter role … nosuperuser`; `supautils` reserved-role
  refusal), dropped lines recorded, end state asserted.

- **One freeze cycle was spent on a real flake, not a regression.** The first
  frozen-head matrix failed on `incident-registry.test.ts` with `status: null`
  — a killed subprocess, not a failed assertion. The Python diagnostic walks
  every worktree and takes ~110s alone against a 120s budget, so under a
  parallel suite it died by signal. Both the spawn budget and the test timeout
  now reflect the work. No expectation was touched.

## Blockers

| id | blocker | class | evidence |
|---|---|---|---|
| BL-1 | `legal-review/queue` and `legal-review/topics` answer 422 `OPS_COMMAND_REJECTED`; the recorded class is `POSTGRES_TRANSACTION_FAILED` with no SQLSTATE, so the durable transaction fails before reaching a statement. `private.runtime_context_install` refuses a hand-made call with `42501 RUNTIME_CONTEXT_SESSION_NOT_CURRENT`, which is the next thing to check against the real verified actor's `sid`/`jti`. | product_defect | `output/v0.10.12/audit/ops-role-probe.txt`; server log `ops_command_rejected POSTGRES_TRANSACTION_FAILED` |
| BL-2 | Windows Application Control blocks `initdb.exe` | blocked_external | not on any critical path |
| BL-3 | `V041_MISMATCH_004` bytes are gone; recorded, not re-baselined | evidence_integrity | `evidence-loss.v0.10.11.json` |
| BL-4 | hours/overtime official artifact unavailable | blocked_external | carried forward |
| BL-5 | min-wage and Knesset convalescence byte changes await human legal review | blocked_human | blocks no engineering item |
| BL-6 | `synthetic-property-suite` scanner finding needs a placement decision | blocked_human | `OWNER_POLICY_REQUIRED` |

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

B-28 unchanged and not re-derived this run: strict 40, MC-29 19, denominator 84.

## Resume point

- next todo: BL-1. The request now reaches the durable service, so the remaining
  work is inside the transaction, not the route. Start from
  `private.runtime_context_install` — it selects `public.product_identity_sessions`
  by `sid` + `current_jti`, unrevoked and within validity, and raises
  `RUNTIME_CONTEXT_SESSION_NOT_CURRENT` otherwise. The journey seeds those rows
  and upserts their validity window, so compare what the verified actor carries
  against what the seeded row holds. `POSTGRES_TRANSACTION_FAILED` with a null
  SQLSTATE points earlier still: at the transaction wrapper, before any
  statement runs.
- the DEV runtime database is `tivdoc_v09_devruntime01` with the full chain and
  four least-privilege login roles; credentials are in `~/.tivdoc-dev/credentials.env`.
- known blocks that must not be retried: corpus acquisition, creating a second
  Supabase project, resetting the DEV default database.
- do not reopen §3 or `B-55`.
