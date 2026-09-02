# Tivdoc development state

- wave: V0.10.9
- base: 391a54ed5c212ec7c9ed16a4be86dd23181d86e4
- head: pending
- frozen_head: pending
- date: 2026-09-02

## Ledger

| id | item | status | evidence |
|---|---|---|---|
| W1 | Wave 1 reconciliation invariant derived, mutation-proof, committed baseline | delivered | src/engine/wave2/evidence-audit/wave1-artifact-partition.v0.10.9.json; artifact-reconciliation.test.ts |
| W2 | byte-pinned chain replay driver, guard-gated, fails closed | delivered (execution blocked_external) | scripts/supabase-dev-guard/chain-replay.mts; output/v0.10.9/supabase/chain-replay.json |
| W3 | browser journey retargeted at DEV | blocked_external | same credential gap as W2 |
| W4 | product runtime gate | blocked_external | output/v0.10.9/devserver.log; src/server/product/runtime/durable-local-config.ts:64 |
| W5 | corpus closure without re-acquisition | delivered | 14-file review package, identical hash on two rebuilds |
| W6 | current-head reachability audit | delivered | output/v0.10.9/audit/w6-classification.json |
| W7 | canonical observation denominator | partial | N=71 derived and locally verified; durable N/N proof blocked_external |
| W8 | state file and freeze | delivered | this file |
| W9 | frozen-head matrix | see report | output/v0.10.9/matrix/ |
| W10 | tracker delta | delivered | output/v0.10.9/tracker-delta.md |

## Decisions

- The brief's §3.1 premise that the byte-change partition moved 3 -> 8 is not what the evidence shows. The diff ledger still holds exactly 3 unreviewed byte changes and 2 rejected challenge observations. What actually drifted is that `fetch-state.json` is append-only across acquisition runs: 25 rows covering 17 distinct source versions, and a second failure row for the same already-unavailable artifact. Deduplicating to the latest observation per source version restores every original figure. Chosen reading: fix the counting, do not re-baseline anything, because no legal fact changed.
- Two snapshot counts that were row artifacts moved to distinct source versions (fetch observation records 23 -> 17, valid raw artifact versions 20 -> 17, and the test's registered corpus raw artifacts 20 -> 17). Safer because the derived number equals the 17 registered sources and no longer drifts when a source is legitimately re-acquired.
- Migration pins use two hashing conventions: some over raw on-disk bytes, some over LF-normalized text. The replay driver records both and requires a pin to match one, rather than silently picking a convention.
- §3.2 authorized resetting the DEV database password through the management API. No exposed endpoint does this, and minting a login role through the only available SQL channel would place its password in plain text in the transcript. Chosen reading: do not disclose a credential; record the blocker.
- The historical "node:crypto causes the root HTTP 500" hypothesis is disproved at this head. All three routes return 500 with CAPABILITY_RUNTIME_NOT_INSTALLED, which is the fail-closed posture of an uninitialized durable runtime, not a bundling fault.

## Blockers

| id | blocker | class | evidence |
|---|---|---|---|
| BL-1 | no reachable way to obtain a DEV database credential without disclosing it | blocked_external | no MCP password endpoint; execute_sql would put a role password in the transcript |
| BL-2 | product routes need the durable runtime configured with four database URLs | blocked_external | durable-local-config.ts:64; devserver.log |
| BL-3 | hours/overtime official artifact unavailable | blocked_external | fetch-state failures, safe codes html_challenge_or_error_page and declared_mime_mismatch |
| BL-4 | min-wage and Knesset convalescence byte changes await human legal review | blocked_human | 3 pending_change_review dispositions in the committed baseline |
| BL-5 | entrypoint disposition strict vs MC-29 semantics | blocked_human | strict 40, MC-29 19, both preserved |
| BL-6 | synthetic-property-suite scanner finding needs a placement decision | blocked_human | OWNER_POLICY_REQUIRED, not product-reachable |

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

## Resume point

- next todo: W2 execution, W3, W4 — all three unblock together the moment a DEV database connection string exists in the ignored env as TIVDOC_DEV_DATABASE_URL.
- known blocks that must not be retried: corpus acquisition (would move the partition again), local PostgreSQL provisioning (Windows code-integrity 0xC0E90002), creating a second Supabase project.
