# Completion-round SECURITY DEFINER source review — 2026-09-11

The CI inventory expected 307 textual definitions before migration
`20260911063456_managed_dev_completion_rounds.sql`; that migration adds exactly
seven. The reviewed count is 314. The exhaustive empty `search_path` check remains
unchanged, and a new assertion pins the seven names and both ACL groups rather
than exempting a migration from the check.

| Definition | Reviewed boundary |
| --- | --- |
| `private.managed_completion_scope` | Exact DEV database, enrolled QA June case, identity membership, verified contact, allowlisted capability recipient, enabled/unexpired capability and non-revoked machine session. |
| `private.managed_completion_ready` | Current input head and dispatch dependency, succeeded job, exact terminal source/payload hashes, same tenant/case/completed analysis, June/minimum-wage scope and one paid active entitlement; only current unanswered requests. |
| `private.managed_completion_has_new` | Suppresses request IDs already dispatched in a completion round or attempted through the previous per-request outbox. |
| `private.managed_completion_event_current` | Exact case, round, delivery, request set and current ready analysis; does not independently grant a caller access. |
| `public.case_notification_completion_pending` | Existing DEV worker capability verifier, enrolled identity/case scope, ready terminal analysis and unnotified request set; bounded result count. |
| `public.case_notification_completion_enqueue` | Capability verification, case/identity/recipient pins, locked case/round, current request set, existing outbox enqueue, and idempotent immutable dispatched round. |
| `public.case_notification_managed_dispatch` | Capability verification, exact current outbox lease owner/fence/expiry, suppression and case scope, current event/round; records dispatch once and holds repeats. |

All seven declarations pin `search_path=''`. All four private helpers revoke
EXECUTE from PUBLIC, anon, authenticated, service_role and all three runtime
roles. The three public entry points revoke PUBLIC/anon/authenticated/service_role,
web and operations access, granting EXECUTE only to `tivdoc_worker_runtime`.
Their existing `private.managed_dev_worker_capability` verifier also checks the
actual `session_user`, the isolated DEV database and live capability expiry.
The new private round table enables RLS and revokes direct access from every
listed runtime role.

The migration's six anchored `pg_get_functiondef` replacements preserve existing
headers and ACLs; they extend current-event/mirror behavior, disable legacy
per-question enqueueing, and keep aggregated deliveries out of the generic
claim path. These are replacements of existing functions, not seven additional
public grants. A changed expected anchor fails the migration instead of silently
patching another body.

This is a source review and focused inventory/search-path test. It does not
independently prove deployed function ownership, effective grants, RLS behavior,
provider delivery, or production readiness; those require their separate actual
DB and delivery evidence. No SQL, provider request or deployment was executed for
this review.
