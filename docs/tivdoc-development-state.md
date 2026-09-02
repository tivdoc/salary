# Tivdoc development state

- wave: V0.10.11
- base: 76363009fd3f85b8e3e6c48b66ef321b2f63563c
- head: pending
- frozen_head: pending
- date: 2026-09-02

## Ledger

| id | item | status | evidence |
|---|---|---|---|
| W1 | chain replay complete on DEV | delivered (21 verbatim + 2 compensated = 23/23) | output/v0.10.11/supabase/chain-replay.json; replay-inventory.json |
| W2 | evidence custody: loss record, partition, preservation sweep | delivered | evidence-loss.v0.10.11.json; reference-disposition.v0.10.11.json; preserved-references.v0.10.11.json |
| W3 | runtime decoupled from local provisioning, both modes serve | delivered | output/v0.10.11/runtime/serve-dev.json, serve-production.json |
| W4 | operations journey against DEV | partial (13/16) | output/v0.10.11/browser/journey.json |
| W5 | 71/71 durable projection | todo | not started; W4's open gate blocks the queue surface |
| W6 | dynamic matrices on DEV | partial | role and refusal matrix proven at the HTTP boundary; database-level matrix not re-run |
| W7 | B-28 and B-38 | partial | output/v0.10.11/audit/entrypoint-counters.json; B-38 not re-proven |
| W8 | state file and freeze | delivered | this file |
| W9 | frozen-head matrix | see report | output/v0.10.11/matrix/ |
| W10 | tracker delta | delivered | output/v0.10.11/tracker-delta.md |

## Decisions

- **The §1 ignore gate failed again and was repaired first.** Each wave adds its
  own `/output/<version>/` rule and none existed for this one, so
  `output/v0.10.11/probe.json` was not ignored. The rule was added, both a
  nested and a deep path were re-checked, and only then did work start. The
  brief's own warning about the bare-directory form is correct: it still
  matches a blank CRLF line at `.gitignore:49`.

- **§3.1 resolved at step 1.** `postgres` holds `tivdoc_governance_owner` WITH
  ADMIN OPTION, so the grant ran as `postgres` and succeeded. That removed the
  admin-option obstacle but exposed the real one below.

- **Two statement families in `202609010005` cannot execute on this platform by
  any reachable role, and the chain is applied around them rather than through
  them.** `alter role ... nosuperuser` needs a superuser: `postgres` is
  `rolsuper=false` and returns `42501` on that one attribute while accepting the
  other six (probe: `output/v0.10.11/audit/alter-role-probe.txt`).
  `revoke ... from anon, authenticated, service_role` is refused by `supautils`
  for reserved roles. Both are defensive — the same migration creates those
  roles NOSUPERUSER and the reserved roles were never granted the governance
  owner — so the file is applied from its own bytes minus those lines, every
  dropped line is recorded verbatim in the receipt, and the intended end state
  is asserted afterwards: all five roles `rolsuper=false rolcanlogin=false
  rolcreatedb=false rolcreaterole=false rolinherit=false rolreplication=false
  rolbypassrls=false`, and zero forbidden memberships.

- **`alter table ... owner to` needs the incoming owner to hold CREATE on the
  target schema.** A cluster superuser bypasses that check, which is how the
  chain passes locally. The narrow explicit grant stands in for the bypass, is
  derived from the refusal message itself, and is recorded per file.

- **W2 is a record of a fact, not an adjusted denominator.** `V041_MISMATCH_004`
  is classed `permanently_lost` with an immutable loss record; `recovered` stays
  at what the live registry actually observes, and `recovered + permanently_lost
  = 5` keeps the original number true as a sum. The partition is exhaustive and
  non-overlapping, a class may not change without a matching loss record, a
  silently dropped reference fails, and nine mutation cases prove it.

- **Forensic evidence read from a live working-tree file is not custody.** All
  four recovered references survived only in a live file or an ignored `output/`
  tree — the same shape that lost `004`. They are now committed under
  `src/engine/wave23/evidence-incident/preserved-bytes/`, classed
  `preserved_v0_10_11` and never as recoveries, with provenance, and
  `.gitattributes` marks `*.preserved.bin` and `*.recovered.bin` `-text` so git
  never normalizes the line endings whose loss made `004` unreconstructable.

- **The loopback guard was extended, not weakened.** The driver refused every
  non-loopback host outright. It now accepts exactly one, and only when the
  caller declared that host, port and database in advance; the database name
  must still match the disposable pattern, a partial declaration is refused
  rather than defaulted, and an undeclared host still returns
  `POSTGRES_TARGET_NOT_LOOPBACK`. A pooler username `<role>.<ref>` is accepted
  only when the suffix equals the declared project ref, so role separation is
  unchanged. Nine cases pin the refusals.

- **`initdb` was never the blocker.** Windows Application Control still blocks
  `initdb.exe`, and it no longer matters: the runtime takes its four connection
  URLs from configuration and provisions nothing. Both modes now serve.

- **A stale `next dev` server for this repository (PID 21088, port 3319, left
  from an earlier wave) held the project lock and made the dev-mode check
  impossible.** It was stopped so the gate could be verified. Next itself
  identified the process and its directory.

## Blockers

| id | blocker | class | evidence |
|---|---|---|---|
| BL-1 | the nested `/api/operations/legal-review/*` routes answer 404 to a verified reviewer session; the page route answers 200, so the session and database path are fine and the durable legal-review capability is not reaching the composed operations service | product_defect | output/v0.10.11/browser/journey.json steps 2-4 |
| BL-2 | Windows Application Control blocks `initdb.exe`; no local cluster can be created | blocked_external | unchanged, no longer on any critical path |
| BL-3 | `V041_MISMATCH_004` bytes are gone; recorded, not re-baselined | evidence_integrity | evidence-loss.v0.10.11.json |
| BL-4 | hours/overtime official artifact unavailable | blocked_external | carried forward |
| BL-5 | min-wage and Knesset convalescence byte changes await human legal review | blocked_human | carried forward; blocks no engineering item |
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

## Live DEV inventory after 23/23

schemas 3, tables 73, RLS enabled 71, RLS forced 29, policies 119, indexes 216,
functions 128, SECURITY DEFINER 85 of which 85 carry a pinned `search_path`,
triggers 60, grants to anon/authenticated/service_role 114. Legal review surface
present: `private.governance_legal_review_packets` and
`private.governance_legal_review_actions`, both RLS enabled and forced, both
owned by `tivdoc_governance_owner`, 2 policies.

B-28 recomputed at this head: strict 40, MC-29 19, denominator 84, difference 21
— unchanged, and per the §3.2 ruling neither number is ever adjusted.

## Resume point

- next todo: BL-1. `createDurableGovernanceOperationsRouteAdapter` is bound at
  `durable-local-runtime.ts:204`, yet `createOperationsHttpHandler` answers 404
  on the nested paths, which the handler does when the resolved service has no
  durable legal review capability. Fixing that closes W4 and unblocks W5 and the
  database half of W6 in one step; everything else they need is provisioned.
- the DEV runtime database is `tivdoc_v09_devruntime01` with the full chain and
  four least-privilege login roles; credentials are in `~/.tivdoc-dev/credentials.env`.
- known blocks that must not be retried: corpus acquisition, creating a second
  Supabase project, resetting the DEV default database.
- do not reopen §3 or `B-55`.
