# Wave 1 isolated persistence verification V0.3.1

## Outcome

`PERSISTENCE_ISOLATED_ENVIRONMENT_BLOCKED`

The exact migration was **not applied** and database semantics were **not verified**. Docker and Supabase CLIs were unavailable, and no independently verified local or expiring disposable target identity was supplied. No credentials were inspected as a substitute. No Production, shared Preview, external Supabase, deployment, customer data, document bytes, PII, secrets, or raw prompts were accessed.

The reviewed migration is `supabase/migrations/202608290001_engine_persistence_foundation.sql`, SHA-256 `60d152027c7fe09e7cff84da835dd0f759b9e3214a1c563bd396d602dbebabbd` at base `34a4bff98a1ae8771a932916ece4e2a408d7e501`.

## Redacted environment fingerprint

| Field | Value |
| --- | --- |
| Platform | `win32` / `x64` |
| Node | `v22.22.2` |
| Docker CLI | unavailable |
| Supabase CLI | unavailable |
| Hostname / username / absolute paths | omitted |
| Credentials | not inspected |

`scripts/wave1-persistence-static.mts` emits deterministic JSON evidence under the ignored `output/parallel-wave-1/persistence-isolated` directory and exits `2` for the expected fail-closed environment outcome. It performs no network or database operation.

## Completed offline evidence

- Structural SQL checks inventory all nine engine tables, expected constraints/indexes/foreign-key and history guards, RLS enablement, browser-role revocations, service-role grants, append-only grants, and legacy-document compatibility.
- Repository source checks cover analysis runs, conversations/messages, read-only documents, extractions, snapshots, hypotheses, findings, confirmations, durable jobs, idempotent duplicate handling, and optimistic status guards.
- A deterministic in-memory **model probe, not a PostgreSQL emulator**, exercises all repository record kinds, two neutral synthetic actors/tenants/cases, case isolation, idempotent and conflicting duplicates, retry-shaped job updates, stale concurrent writes, atomic rollback, and partial failure.
- The target-identity gate permits only a loopback local target or a non-shared, non-Production disposable target with a future expiry. Missing or unsafe identity blocks before any migration runner can proceed.
- Strict safe-log source checks confirm that document bytes and raw prompts are not accepted fields. Evidence includes no raw values or database messages.

These checks establish source structure and deterministic model behavior only. They do not prove PostgreSQL syntax or runtime behavior.

## Forward rebuild and rollback strategy

For a future approved verification, start a fresh isolated Supabase instance from zero, record a redacted target fingerprint, verify it through the fail-closed identity gate, apply migrations in repository order, run the database test matrix, then destroy the disposable instance. Forward repair must use a new additive migration; the reviewed migration must not be edited after application.

Rollback testing must use only the disposable instance. Before application, take a schema-only baseline; wrap test fixtures in transactions where possible; exercise explicit failed statements and verify no partial rows; then destroy and rebuild from zero to prove reproducibility. Do not use down migrations against any shared or Production environment. Private Storage object cleanup requires a separately approved durable workflow and remains a gap.

## Database verification still required

An approved isolated environment must still prove migration execution from zero; table/constraint/index/FK/trigger creation; anon/authenticated denial and service-role boundaries; two-actor tenant/case isolation using real RLS; repository writes; retries; duplicates; optimistic/concurrent writes; rollback and partial failure; cascade behavior; forward rebuild; and safe database/application logs. Until that evidence exists, no migration-verification claim is authorized.
