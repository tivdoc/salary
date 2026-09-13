# Automatic DEV worker

This worker connects the existing saved-source queue to an explicitly enrolled
QA case scope: June 2026, minimum wage, one current payslip and a paid scope
accepted by the exact current SQL/TypeScript admission contract. Initial-order
engineering runs and the later full-AI canonical QA path retain their separate
admission gates. The worker does not grant legal authority. A terminal job is not
proof that outstanding case questions or customer activation are complete.

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

Live entry configuration uses genuine SDK transport. Sol requires the bounded
package wrapper described below; the older pinned mini profile uses
`createLiveExtractionRuntime`. Missing/invalid provider configuration blocks before discovery or
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
- `OPENAI_EXTRACTION_MODEL=gpt-5.6-sol` uses explicit medium reasoning and requires
  `TIVDOC_MANAGED_SOL_PACKAGE_FILE`; the omitted-model default has the same gate.
  A missing package cannot fall back to an unbudgeted Sol runtime.

The entry injects its build SHA. Direct status/retry module calls also require
`TIVDOC_MANAGED_DEV_BUILD_SHA`, or the exact Preview commit environment.
Production deployments and other branches/DBs/roles/hosts are refused.

A Windows Task Scheduler task can invoke this one-tick executable periodically,
with the repository as working directory, `IgnoreNew` overlap policy, a bounded
execution time and a private environment file. A supervisor restart or next tick
uses durable queue state. The root task owns registration, credentials, expiry,
the executable pin and its actual verification. Existing task registration and
the current package's activation are reported separately below. Vercel Cron targets the Production deployment, so it
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

## 2026-09-11 bounded scheduler package

Read-only Task Scheduler inspection found `Tivdoc-AutomaticDev-Proof-20260909`
already installed and **disabled**. It has a one-minute repetition, IgnoreNew,
ten-minute execution limit, InteractiveToken logon, no wake-to-run and no
start-when-available. Its previous action invokes the private
`../release-work/run-retained-managed-worker.ps1`. Its previous exit code was
zero; that does not establish that this package ran. Prior actual scheduled
source-completion and mail evidence is in
[`source-completions-final-handoff-2026-09-10-he.md`](source-completions-final-handoff-2026-09-10-he.md).

`scripts/product-workers/managed-dev-supervisor.mjs` is the new bounded host for
the ordinary `worker.cjs`. One scheduler invocation starts one separate child,
without a per-case command. It checks exact manifest, bundle and clean Git SHA;
loads an allowlisted private JSON environment; and inherits only basic Windows
system paths. It never inherits another database URL, `NODE_OPTIONS`, proxy
settings, or sending/provider credentials from the launching shell. It does not
register or enable a task itself.

Owner activation steps for this package:

1. Build from the intended clean commit and retain `manifest.json` plus the
   bundle SHA. Complete the isolated DEV migration/ACL proof first; the new
   health RPC is `private.managed_dev_worker_health(capability)`.
2. Provision the exact QA enrollment, machine session and expiring capability;
   use the same owner-only recipient hash for notification enrollment. The
   worker cannot provision them.
3. Store a supervisor control JSON under `../release-work`, with exact keys
   `schema_version: managed-dev-supervisor-v1`, UUID `control_id`, `enabled`,
   `expires_at`, `expected_git_sha`, `expected_bundle_sha256`,
   `expected_manifest_sha256`, `working_directory`, `bundle_path`,
   `manifest_path`, `environment_path`, `output_directory`, `max_ticks`, and
   `child_timeout_ms`. Paths are absolute: build/output paths stay under this
   checkout's `output/release-completion`; private environment/control paths stay
   under the sibling `release-work`. TTL is at most four hours, ticks at most
   240, child timeout at most eight minutes. This package ends by
   **2026-09-11 04:19:48 UTC**.
4. Point the disabled Windows task at a hidden launcher executing
   `node scripts/product-workers/managed-dev-supervisor.mjs --control <private-control-path>`
   with the release checkout as its working directory. Preserve IgnoreNew and
   the finite execution/expiry settings. Enable only for the authorized window.
5. Retain the task's actual start/result plus `latest.json` and each immutable
   supervisor receipt. A later independent tick must observe durable state and
   no duplicate effect. Stop scheduling and disable the package/capability at
   handoff. This document does not assert these activation steps were executed.

The package file is fixed to
`../release-work/sol-scheduled-package-20260911.private.json`; it pins the build,
case IDs, actual source byte hashes and sizes, expiry, new ledger and artifact
paths. Its separate ledger is
`output/release-completion/sol-scheduled-20260911/package-budget-ledger.json`.
At most 12 content requests and USD 5 in reserved upper bounds are authorized;
count requests are included. The wrapper admits at most two generations per
tick and checks expiry both before counting and again before generation. An
estimate or reserved bound is not an invoiced cost. Earlier package ledgers and
unknown reservations are preserved.

The supervisor watches its control file during a child run. Disablement,
expiry, unexpected control changes or timeout stop only that owned child; a
one-second grace precedes forced termination of its process tree. An in-flight
provider result can therefore remain unknown. Neither restart nor a dead PID
authorizes another call for that reservation. Normal worker interruption keeps
acknowledged effects, stops before another unit, and relies on existing durable
leases and current-source fences.

`node worker.cjs --status` reads status and operational health under the exact
worker capability, without OCR or email. The local operations page uses its
existing owner/session guard; Preview and Production refusal remain intact.
Health includes queue work timestamps, pending current questions, claim limits,
capability expiry and authority metadata. `record_present` is explicitly not a
signature/approval/readiness claim. Authority expiry and budget exhaustion are
operational holds. No recent work is normal for an idle queue; a recent
supervisor receipt is the separate host-liveness evidence.

### Explicit stale budget-lock recovery

Each provider ledger lock records PID, nonce, creation time, expiry, build and
ledger-path hash. A normal close removes only its own nonce. An unexpected
supervisor crash lock is retained for owner inspection with scheduling disabled;
it never causes automatic deletion of the separate provider ledger lock.

For provider-lock recovery, first disable the task, ensure its child has stopped,
set the private package's `enabled` to `false`, and retain the observed SHA-256 of
both the lock and ledger. Invoke the same clean worker bundle with only the
necessary local recovery environment: `NODE_ENV=development`,
`TIVDOC_MANAGED_DEV_WORKER_ENABLED=false`,
`TIVDOC_MANAGED_DEV_OWNER_RECOVERY=true`, and the exact
`TIVDOC_MANAGED_SOL_PACKAGE_FILE`. Then run:

```text
node worker.cjs --recover-budget-lock <observed-lock-sha256> <observed-ledger-sha256>
```

The command requires the recorded PID to be dead, rechecks the disabled package
and unchanged bytes, and uses a recovery gate to serialize owner operations.
Any `reserved_unknown` outcome refuses recovery and requires provider-side
reconciliation by the owner. The helper never resets or rewrites the ledger,
creates an extraction attempt, or re-enables scheduling. A successful recovery
retains a hashed receipt beside the lock. Do not delete an unknown reservation
to make this command pass.

Local validation for these additions: five focused suites passed 48 tests;
the lock and actual separate-child supervisor suites passed 16 tests; changed
files passed lint. The first lock-suite load failed because its test omitted the
`server-only` mock; that fixture boundary was corrected. Supervisor tests use
explicit synthetic subprocess output and no database/provider. The earlier
configuration/host/notification run passed 50 tests and overlaps this set;
these counts must not be summed. Actual new-schema, live scheduler, OCR,
notification delivery and hosted-flow results require the parent integration
receipt; no new package activation or deployment is claimed here.
