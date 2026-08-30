# V0.7 P1 — Persistence, jobs and transactional outbox

## Scope and capability

This lane adds production-shaped persistence contracts, a deterministic local durable-shaped implementation, a forward-only PostgreSQL migration, and static verification. It does not replace canonical Facts, RuleInputs, legal versions, Analysis Runs, topic results, traces, reports, reviews, Money or lifecycle models. Repository payloads bind those models by canonical SHA-256 and immutable version identity.

No disposable local Docker, Supabase or PostgreSQL target is proven by the frozen V0.7 execution contract. No database connection or migration apply was attempted. Dynamic PostgreSQL verification is therefore `SKIPPED_ENVIRONMENT_DEPENDENCY`; local tests prove only adapter behavior and static/contract properties.

## Repository mapping

`CANONICAL_REPOSITORY_MAPPING` is the machine-readable inventory. Every entry declares its table, primary key, tenant/case ownership, revision and hash columns, retention class, authorized roles and delete policy. It covers cases and lifecycle history, verified payment references, documents, extractions, canonical Facts, RuleInputs, legal pins, Analysis Runs and stages, topic results, calculation traces, reports, review tasks, idempotency, jobs, outbox, audit and object-write reservations.

The V0.7 migration is additive. The historical `202608290001_engine_persistence_foundation.sql` remains byte-identical. New canonical payload tables use explicit foreign keys with `on delete restrict`, unique version/idempotency constraints, status checks, immutable append-only triggers and claim indexes. RLS is enabled with no anonymous/authenticated grants; P2 owns final policies and authorization behavior.

## Transaction boundary

`LocalDurablePlatformStore.execute` serializes a transaction-shaped operation and atomically commits:

1. tenant/scope idempotency reservation;
2. expected case and entity revision comparison;
3. immutable domain versions and downstream invalidation;
4. hash-chained audit event;
5. transactional outbox rows;
6. the exact idempotency result receipt.

Same-key/same-command replays return the original receipt. Same-key/different-command fails before mutation. All writes use canonical payload hashes and compare-and-swap revisions. Injected failures after reservation, domain mutation, audit append, or outbox append leave the committed state unchanged.

Snapshots are local test adapters, not a database substitute. Rehydration preserves the exact stored dependency pins, and missing pins fail instead of falling forward to newer legal or template versions.

## Jobs and outbox

The job graph is `queued → leased → running → succeeded | retry_wait | cancelled | dead_letter`. Claims are serialized locally and specified as `for update skip locked` in SQL. Every claim or expired-lease reclaim increases a monotonically increasing fencing token. Heartbeat, terminal transitions and logical-effect commits require the current owner/token. Bounded attempts lead to immutable dead-letter history; replay creates a new linked job. Cancellation never rewrites prior history.

Outbox transport is explicitly at-least-once. A lease and fencing token prevent stale publication, while `logical_effect_id` plus its exact hash makes the logical effect idempotent. There is no exactly-once transport claim.

## Object-write saga

The local adapter models `reserve → stage → verify → finalize`. Keys are opaque and content-addressed. Staging verifies bounded length and SHA-256. Reserved, staged, verified, quarantined and failed records are invisible. Final metadata visibility and its outbox identity are committed together; injected failure at finalization leaves the verified record invisible.

## Commands

Focused tests:

```powershell
npx vitest run src/server/platform/persistence src/server/platform/jobs --reporter=verbose
```

Static/contract verification:

```powershell
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/platform/persistence/verify.mts
```

Type and lint checks:

```powershell
npx tsc --noEmit --pretty false
npx eslint src/server/platform/persistence src/server/platform/jobs scripts/platform/persistence --max-warnings=0
```

## Disposable PostgreSQL continuation

Only after a human/operator proves that the target is local and disposable:

1. confirm no linked project, remote hostname, production/preview credential or customer data is present;
2. create a new empty disposable database and record its local process/container identity;
3. apply all migrations from baseline, then repeat baseline-to-head upgrade on a second empty database;
4. dump both schemas and compare normalized output;
5. inject a migration transaction failure and prove rollback;
6. run independent PostgreSQL sessions for 32-command idempotency, two-writer CAS, 16-worker claims, fencing, lease expiry, outbox deduplication and approval-versus-invalidation;
7. terminate/restart the disposable service and prove resume uses exact pinned versions;
8. destroy only the explicitly named disposable resources.

Until those steps pass, dynamic database, restart and migration claims remain pending. No remote migration, external Supabase connection, customer read, legal activation, invented legal value, deployment or delivery is authorized by this lane.
