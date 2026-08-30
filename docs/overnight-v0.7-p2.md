# Overnight V0.7 P2 — Security, private storage and audit runbook

## Capability truth

This lane implements deny-by-default server claim derivation, RBAC decisions, a complete static RLS policy contract, a canonical `ObjectStoragePort` local adapter, SSRF/CSRF/input/privacy guards, a parser-sandbox capability gate, and hash-chained local audit receipts. Tests and the verifier use synthetic identities, bytes and generated temporary roots only.

The frozen preflight proves no disposable database and no Docker runtime. Therefore RLS is `STATIC_CONTRACT_ONLY`; no PostgreSQL session, join or RPC enforcement is dynamically claimed. Parser OS isolation is specified but not run. Storage is a local adapter, not managed storage. Audit anchoring is a local receipt, not off-host/WORM custody.

## Verified-claims and RBAC procedure

1. Accept identity only from the trusted server adapter after its signature verification. Never construct a `VerifiedActor` from request body, query, cookie role, tenant, owner, case or paid fields.
2. Bind exact issuer, audience, issued/expiry times and server runtime. Reject test identities in Production.
3. Apply tenant and case assignment before role permission. API authorization supplements RLS and never replaces it.
4. Legal-review role alone never permits document-body access. Operations never activate legal artifacts. Auditors read metadata/audit only.
5. Parameter attestors must differ. Report approvers must differ from the last facts/legal/report content actor.
6. Break-glass needs a fixed reason code, expiry within 15 minutes and an append-only audit event. Revoke immediately after use.
7. Return only stable denial codes. Do not disclose whether another tenant/case/object exists.

## RLS deployment and verification

The static contract covers cases, payment evidence, documents, extractions, canonical facts, RuleInputs, analysis runs, reports, reviews, jobs, object metadata and audit projections. Each table requires forced RLS, trusted-claim tenant/case predicates, guarded joins/RPCs and immutable ownership columns.

When an explicitly disposable local PostgreSQL/Supabase target becomes available:

1. Verify it is local, empty/disposable and not linked to Preview/Production before connection.
2. Apply the orchestrator-owned migration from a clean baseline.
3. Test independent sessions for anonymous, two synthetic owners/tenants, assigned and unassigned staff, legal reviewer, approver, auditor, worker and break-glass.
4. Cover direct table access, child joins, RPC/functions and attempted owner/role mutation.
5. Retain raw session evidence and schema hash. Until all pass, preserve `ISOLATED_SUPABASE_MIGRATION_RLS_VERIFICATION_REQUIRED`.

## Private object lifecycle

1. Use a generated temporary root or the future authorized managed adapter. Never pass a customer or repository path.
2. Reserve with trusted actor, reason, idempotency, expected length/hash, allowed MIME and retention class.
3. Stream bounded bytes. Exact length/hash and magic/content validation must pass while the object remains quarantined.
4. Finalize once with an immutable content-addressed internal path. Never overwrite or expose internal paths.
5. Issue a short-lived scope-bound private grant only after current authorization. Never log or persist the returned bearer token in receipts.
6. Quarantine on corruption or policy change. Grant and reads fail with the same non-enumerating denial.
7. Legal hold blocks deletion. Authorized retention completion tombstones immutably and appends audit.
8. Reconciliation considers old staging reservations only; it cannot expose or delete finalized/referenced objects.

The PDF gate rejects malformed/encrypted/active-action/external-reference/embedded-file/resource-bomb structures. It is a pre-screen, not a replacement for OS sandboxing.

## Request and privacy controls

- CSRF-protected cookie mutations require HTTPS same-origin, JSON content type and equal bounded cookie/header tokens.
- Outbound retrieval is HTTPS-only, rejects credentials/fragments/nonstandard ports/local/internal/IP hostnames, validates every redirect, rejects private/link-local/metadata/multicast DNS results and returns pinned public addresses for the transport owner.
- Bound JSON rejects oversized and prototype-manipulation payloads. Untrusted OCR/legal/report text is rendered inertly.
- Operational records permit only opaque IDs, coarse status/codes, timestamps, sequence and hashes. Canaries cover email, phone, ID number, salary/amount terms, OCR/payslip text, JWT, signed URL and object path.
- Server startup rejects client-exposed service/private/token/key configuration and weak missing Production secret values.

## Incident runbooks

### IDOR or cross-case incident

Disable affected routes, preserve opaque correlation/audit hashes, verify tenant/case assignments and RLS contract, and quarantine affected grants/objects. Do not put identities or content in logs or the incident title. Dynamic resolution requires independent-session RLS proof.

### Compromised actor or break-glass misuse

Expire sessions and assignments through the identity owner, revoke grants, disable the affected feature, verify the audit chain and create a local anchor receipt. Preserve actor/action/resource hashes only. Rotate credentials without logging material.

### Object corruption or MIME alert

Quarantine before any further read, deny grants uniformly, verify exact stored bytes against metadata and preserve immutable audit. Never overwrite. Restore only from an independently verified source into a new private target.

### SSRF or parser alert

Stop the fetch/parser path, preserve bounded target classification and hashes, revalidate all redirects/DNS addresses, and quarantine input. Never bypass access controls. Parser execution remains disabled until no-network/read-only/resource-limited OS isolation is dynamically proven.

### Privacy canary or secret exposure

Stop emission and delivery, restrict the artifact, rotate exposed credentials through their owner, determine scope using hashes/opaque IDs, and add the exact canary to regression tests. Do not copy the secret or personal data into tickets, chat or receipts.

### Audit-chain failure

Freeze mutations, preserve immutable local bytes, compare sequence/previous/event hashes, and escalate to security. A local anchor cannot repair a broken chain or substitute for off-host custody.

## Commands

```text
npx vitest run src/server/platform/auth src/server/platform/storage src/server/platform/security src/server/platform/audit --reporter=verbose
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/platform/security/verify.mts
npx tsc --noEmit --incremental false
npx eslint src/server/platform/auth src/server/platform/storage src/server/platform/security src/server/platform/audit scripts/platform/security/verify.mts
```

## Blocker receipts

```text
item_id=P2_DYNAMIC_RLS
status=SKIPPED_BLOCKED
blocker_code=ISOLATED_SUPABASE_MIGRATION_RLS_VERIFICATION_REQUIRED
attempted_action=consume frozen execution-contract capability preflight
evidence=disposable_local_database_proven=false
safe_fallback_completed=true (complete static table/join/RPC/owner-immutability contract)
affected_acceptance_ids=V07-P2-RLS
direct_downstream_impact=no dynamic independent-session RLS claim
next_human_or_environment_action=provide an explicitly disposable isolated local PostgreSQL/Supabase target

item_id=P2_PARSER_SANDBOX
status=SKIPPED_BLOCKED
blocker_code=PARSER_OS_SANDBOX_NOT_VERIFIED
attempted_action=consume frozen execution-contract capability preflight
evidence=docker=unavailable; supported_microvm=false
safe_fallback_completed=true (sandbox spec, quarantine and execution-denial guard)
affected_acceptance_ids=V07-P2-PARSER
direct_downstream_impact=untrusted parsing remains disabled
next_human_or_environment_action=provide a supported isolated container or microVM runtime

item_id=P2_MANAGED_STORAGE_AND_AUDIT_CUSTODY
status=SKIPPED_BLOCKED
blocker_code=MANAGED_PRIVATE_STORAGE_CONFIGURATION_PENDING;OFF_HOST_AUDIT_CUSTODY_PENDING
attempted_action=implement local fake/temp-root adapters without remote credentials
evidence=local adapters verified; remote connections zero
safe_fallback_completed=true
affected_acceptance_ids=V07-P2-STORAGE,V07-P2-AUDIT
direct_downstream_impact=no managed-storage or off-host/WORM claim
next_human_or_environment_action=configure authorized managed private storage and independent audit custody
```

All prohibited counters remain zero: customer reads, Production/Preview connections, deployments, remote migrations, external Supabase/storage, live payments, OpenAI, Shadow, delivery and invented legal content.
