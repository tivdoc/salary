# Automatic DEV worker

This worker connects the existing saved-source queue to one explicitly enrolled
QA case scope: June 2026, one paid initial order, minimum wage, one current
payslip. It does not activate legal rules or authorize a real customer analysis.
`complete` means that the current DEV engineering run finished; provider and
canonical activation evidence must still be reported independently.

## Execution and authority

`managed-worker.entry.mts` is a one-tick Node entry point. It discovers at most
two eligible enrolled cases and processes them sequentially through the existing
`saved_case_analysis_v1` queue. Uploads and saved answers already append a new
current input/dispatch revision; a scheduled tick discovers that revision without
per-case command-line intervention. The registry is authorization and operation
metadata, not a second queue.

The scheduler uses an opaque capability plus the actual `tivdoc_worker_runtime`
database login. SQL limits discovery to owner-enrolled, verified synthetic QA
cases and existing machine sessions. Each case transaction reinstalls that
case's SID/JTI and verifies its tenant. No worker function mints a session, grants
payment, selects an arbitrary customer, or trusts a client-supplied tenant.

The claim, enrollment recheck and shared daily/total attempt budget reserve are
one transaction. Work uses the existing fencing token, three-attempt policy,
database lease clock and 30/60/120-second backoff. A normal heartbeat renews a
180-second lease. Expired work can be reclaimed after process restart. A late or
reclaimed worker cannot complete another worker's lease or overwrite its result.

The optional `onMonth` runner callback runs after the exact canonical parent and
before the lease check in the same transaction. `runAutomaticDevMonth` owns the
financial composition. Callback refusal rolls back that month's parent/effect
and prevents terminal success. Previously succeeded queue jobs are read-only;
enroll a fresh current source for the new automatic path.

Live entry configuration uses `createLiveExtractionRuntime` with no injected
transport. Missing/invalid provider configuration blocks before discovery or
claim. The extraction receipt protocol separately prevents automatic replay of
an unknown provider outcome. An explicitly injected test process can prove
scheduling/recovery; it cannot prove live OCR.

## Build and scheduler setup

From the clean intended checkout:

```powershell
node src/server/product/processing/managed-worker-build.mjs
node --env-file=<private-managed-dev.env> output/release-completion/managed-worker/worker.cjs
```

The build records the exact commit, dirty state, dependency lock, font and source
hashes. Enabled execution refuses a dirty build. Keep private environment files,
worker credentials, scheduler capability, Storage key and provider key outside
Git and do not place their values in scheduler command text or logs.

Required environment names:

- `TIVDOC_MANAGED_DEV_WORKER_ENABLED=true`.
- `TIVDOC_MANAGED_DEV_WORKER_CAPABILITY`: the opaque capability enrolled in DEV.
- `TIVDOC_WORKER_POSTGRES_URL`: the exact session-pool worker endpoint for
  `tivdoc_release_replay_20260907`, project `cpzrbidxftzqcfeqqusu`, port 5432.
- `NEXT_PUBLIC_SUPABASE_URL=https://cpzrbidxftzqcfeqqusu.supabase.co`.
- `SUPABASE_SERVICE_ROLE_KEY` for the isolated Storage project.
- `TIVDOC_SAVED_EXTRACTION_PROVIDER_ENABLED=true` and `OPENAI_API_KEY`.
- Model remains the pinned default; provider timeout is independently bounded.

The entry injects its build SHA. Direct status/retry module calls also require
`TIVDOC_MANAGED_DEV_BUILD_SHA`, or the exact Preview commit environment.
Production deployments and other branches/DBs/roles/hosts are refused.

A Windows Task Scheduler task can invoke this one-tick executable periodically,
with the repository as working directory, `IgnoreNew` overlap policy, a bounded
execution time and a private environment file. A supervisor restart or next tick
uses durable queue state. The root task owns registration, credentials, expiry,
the executable pin and its actual verification. No scheduler registration is
claimed by this document. Vercel Cron targets the Production deployment, so it
is not suitable for this Preview-only scope. [Vercel documentation](https://vercel.com/docs/cron-jobs)

This local scheduler depends on the computer, user/session permissions, network
and task availability. It is not a continuously available cloud service. Retain
the task's LastRunResult, bounded safe worker output and exact bundle hash as
operational evidence; an installed task alone does not prove successful work.

The opt-in scheduler proof uses a separate executable:

```powershell
node src/server/product/processing/managed-worker-build.mjs --synthetic-proof
```

It requires `NODE_ENV=test`, `TIVDOC_MANAGED_SYNTHETIC_PROCESS=1`, and
`TIVDOC_MANAGED_DEV_PROOF_MANIFEST` pointing to the exact private
`../release-work/managed-worker-proof-control.json` path. The test harness owns
that atomic manifest, enrolls only its two new synthetic identities/cases, and
disables its capability during cleanup. Each external one-tick process verifies
the build and source SHA oracle before its injected adapter can return fixture
readings. This executable has no live provider transport.

Run the opt-in `managed-worker.postgres.test.ts` with
`TIVDOC_MANAGED_DEV_DB_PROOF=1` only after the root task has registered the
external scheduler. It uploads actual private Storage bytes, answers the exact
source confirmation questions through identified web-role calls, and polls
saved state. It never calls extraction, calculation, claim or worker functions.
The proof includes three pre-save transaction failures, a bounded authorized
retry, independent process restarts, source replacement, a missing-hours answer,
history and HTML/PDF parity. `TIVDOC_MANAGED_DEV_PREVIEW_PROOF=1` additionally
uses the hosted answer form and customer report/source routes before exact QA
cleanup; its synthetic session cookies do not prove OTP login. A missing
scheduler or Preview is a failed or unverified proof, not an automatic fallback
to a direct calculation invocation.

## Operations and recovery

`/operations/dev-worker` and `/api/operations/dev-worker` preserve the existing
operations capability, verified session, configured support-owner and write-CSRF
guards. The existing stable operations surface refuses Preview/Production; this
change does not remove that guard. Local operation setup must already supply the
durable operations session boundary. The Node status/retry functions remain
available independently under the scheduler's DEV capability.

The screen reads DB-derived waiting, processing, awaiting-input, failed or
DEV-complete state, current source/job revision, attempt count and safe last error.
It never treats a host-supplied string as completion and never includes machine
credentials, raw OCR text or source paths. Refresh is explicit and double-clicks
are serialized.

An authorized manual retry names the exact current job/revision. SQL appends one
bounded attempt allowance without resetting attempt count, fencing, input,
receipts or history. Repeated acknowledgement cannot grant another allowance.
Unknown provider outcomes require reconciliation; retry cannot authorize another
provider dispatch for that immutable input. Pausing/revoking enrollment and the
machine session prevents subsequent admission. A forced process exit leaves an
expiring lease; an active known response may still be durably recorded, while
current-source and lease checks prevent stale publication.

## Verification status

First focused local run: 58 tests passed across configuration, scoped case
composition, operations HTTP and the existing runner. They prove recording/mock
contracts, scope refusal, atomic rollback behavior at adapter boundaries,
no provider work on budget refusal, safe error handling, CSRF/owner requirements,
and unchanged historical replay behavior. Later changes require their own run.

These unit tests do not prove applied SQL, actual SID/JTI privileges, task
registration, restart recovery in another process, live OCR, hosted operations
UI, or an automatically generated customer report. Root delivery must append
the exact actual-DB/scheduler/Preview receipts and distinguish implemented,
verified, ready-to-run and deployed states. No Production change is authorized.
