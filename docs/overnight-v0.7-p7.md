# Overnight V0.7 P7 — Reliability and operator runbook

## Capability truth

P7 implements server-side, provider-independent contracts for safe observability, coarse health/readiness, default-off controls, dry-run operator planning, and local fixture backup verification. Verification uses only synthetic bytes and local in-memory or temporary-filesystem adapters.

The frozen capability preflight reports no Docker, Supabase CLI, PostgreSQL CLI, or proven disposable local database. Therefore database backup/restore, schema/row/FK/RLS restoration, real job-state restoration, production RPO/RTO, off-host custody, and disaster-recovery readiness are not claimed. The isolated blocker is `ISOLATED_DATABASE_BACKUP_RESTORE_TARGET_UNAVAILABLE`.

## Safety properties

- Logs and spans accept fixed events/components/outcomes, opaque correlation identifiers, bounded duration, and fixed error codes. There is no arbitrary message or metadata field.
- Metrics accept only a fixed metric catalog and fixed bounded label dimensions. Customer identifiers, amounts, OCR, citations, report prose, object paths, hashes, tokens, and signed URLs cannot be labels.
- Health and readiness return only coarse status. They expose no credential, URL, schema detail, customer count, dependency error, or target identity.
- Analysis, Offline Shadow, customer processing, export, and delivery controls are disabled in a fresh process.
- Local operator commands are dry-run only. Every plan binds an opaque actor, fixed reason code, idempotency key, correlation ID, target reference, command hash, previous receipt hash, and timestamp. Same-key changes fail.
- Local backup manifests bind normalized relative paths, byte counts, object hashes, aggregate hash, source kind, watermark, expected key-version reference, and a manifest hash. Absolute/traversing/ADS paths, duplicate paths, symlinks, special files, empty backups, missing/altered/extra objects, wrong key versions, and altered manifests fail closed. The key-version field is metadata binding only; this lane does not implement or claim custom cryptography.
- Operator restore produces a dry-run plan only. The verification command additionally restores synthetic bytes into a new empty in-memory staging adapter; tests cover a generated temporary-filesystem staging adapter. Neither path writes a database, production storage target, or customer artifact.

Run focused verification:

```text
npx vitest run src/server/platform/observability src/server/platform/operations src/server/platform/backup --reporter=verbose
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/platform/reliability/verify.mts
npx tsc --noEmit --incremental false
```

## Operator command procedure

1. Authenticate through the future canonical server-side authorization layer. Do not accept browser-supplied roles or ownership.
2. Choose only a catalog action and reason code. Use opaque actor/target references; never put names, email, phone, document text, money, citations, URLs, tokens, or paths in the command.
3. Generate a unique idempotency key and correlation ID. Start with `dry_run=true`.
4. Review the returned plan and required kill switch. This lane never applies the plan.
5. Verify the audit chain before and after the operation. Escalate any gap or changed receipt hash.
6. A later mutation adapter must require explicit server authorization, an enabled default-off switch, optimistic revision, atomic audit/outbox, and the same command hash. Those dependencies are not simulated here.

## Backup drill procedure

1. Use only a validated disposable local target. Stop if any remote/shared/Production endpoint or credential is present.
2. Place deterministic synthetic state in a new empty local fixture root. Never copy customer data into a drill.
3. Build the manifest from exact opened bytes. Retain the watermark, object aggregate, manifest hash, and verifier result.
4. Clone into a distinct empty staging target and run the verifier before any restore plan.
5. Exercise altered bytes, a missing object, an extra object, and a modified manifest. Every case must be `REJECTED_CORRUPT`.
6. When an isolated database exists, a separate owned lane must add seed, dump, new-target restore, schema/row/FK/hash/audit/job/RLS/readability checks, and safe teardown. Until then retain the blocker and make no RPO/RTO claim.

## Incident runbooks

### Migration failure

Disable analysis, customer processing, export, and delivery. Stop new jobs. Preserve the migration error outside customer-visible/log payloads under a restricted incident record. Do not retry against an unproven target. Verify rollback and schema state on a disposable local database, then require an authorized forward-only repair.

### Job backlog or dead letter

Inspect coarse depth/age/attempt/lease metrics and a dry-run `job_inspect` plan. Disable the affected consumer if lease ownership is unclear. For replay, require actor, `JOB_RECOVERY`, idempotency, audit, an enabled analysis switch, current fencing token, and immutable history. Never bulk replay without bounded selection.

### Compromised actor

Disable affected switches, expire server sessions/assignments through the auth owner, preserve audit receipts, verify the audit chain, and rotate credentials through the credential owner. Do not log tokens. Break-glass requires a fixed reason, short expiry, and append-only receipt.

### Cross-case incident

Disable customer processing, export, and delivery. Quarantine affected outputs by opaque reference, preserve exact hashes and audit metadata, and notify privacy/security owners. Do not include customer identities or content in metrics, logs, chat, or the incident title.

### Object corruption or quarantine

Disable consumers of the object class. Run a dry-run `object_quarantine` plan, verify immutable metadata/hash, and retain the object as non-visible. Never overwrite. Reconcile staged/orphan state through the storage owner and restore only after an independently verified manifest.

### Chargeback-release race

Disable export and delivery. Require current immutable payment evidence and report approval hashes in one atomic transaction. Place the case on hold, invalidate stale approval/export eligibility, and retain audit/outbox evidence. This lane provides only the default-off controls and dry-run plan.

### Key rotation

Disable operations depending on the key, identify versions without logging key material or signed URLs, rotate through the credential/storage owner, and re-verify grants and backup readability. Wrong or unavailable key versions must fail closed. Dynamic key-version restoration remains blocked with the isolated target.

### Privacy request

Use an opaque request reference and `PRIVACY_REQUEST`. Hold automated deletion, verify retention/legal hold through the owning service, create a dry-run plan, require authorization and idempotency, and audit the final decision. Never put request prose or personal data in operational telemetry.

### Backup restore

Declare the incident, disable processing/export/delivery, verify manifest and exact bytes, restore only into a new empty disposable target, run schema/FK/hash/audit/job/RLS/readability checks, then obtain owner approval before traffic. A local fixture verification is not authorization for a database or Production restore.

## Blocker receipt

```text
item_id=P7_DYNAMIC_DATABASE_BACKUP_RESTORE
status=SKIPPED_BLOCKED
blocker_code=ISOLATED_DATABASE_BACKUP_RESTORE_TARGET_UNAVAILABLE
attempted_action=consume frozen execution-contract capability preflight
evidence=disposable_local_database_proven=false; docker=unavailable; supabase_cli=unavailable; postgresql_cli=unavailable
safe_fallback_completed=true (manifests, local adapters, verifier, corruption matrix, dry-run restore plan)
affected_acceptance_ids=V07-P7-BACKUP
direct_downstream_impact=no dynamic DB/schema/row/FK/RLS backup/restore or production RPO/RTO claim
next_human_or_environment_action=provide an explicitly disposable isolated local database target
```

Prohibited action counters for this lane are all zero: customer reads, Production/Preview connections, deployments, remote migrations, external Supabase, live payment, OpenAI, customer Shadow, delivery, and invented legal values/rules.
