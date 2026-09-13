# REAL service runtime

The REAL entry runs one bounded tick on the existing saved-job queue and notification outbox. The database must already contain a current activation plan, controller capability, issuer grant, and an explicitly authorized policy ledger matching the configured extraction mode. With the separate enrollment flag enabled, the controller derives first enrollment or a newly verified full-purchase extension through the existing activation helper. It creates no plan, grant or budget. The receipts-only mode requires an explicit zero-spend policy; provider mode requires authenticated claim and per-request reservations.

Build from a clean checkout after updating/checking the ordinary release manifest:

```powershell
node src/server/product/processing/managed-worker-build.mjs --real
```

This produces `output/release-completion/real-service-worker/worker.cjs` and its `manifest.json`. Dirty builds are recorded and refuse enabled execution. The separate REAL entry does not import the DEV launcher. Each tick considers at most two purchase-enrollment selectors, then processes at most two cases sequentially and at most two notification attempts per processing case, with an eight-minute cancellation deadline.

The private `TIVDOC_REAL_SERVICE_RUNTIME_CONFIG` environment value is JSON with these exact fields:

| Field | Value |
| --- | --- |
| `schema_version` | `real-service-runtime-v1` |
| `build_sha` | Compiled 40-character Git SHA |
| `plan_sha256` | Current stored activation-plan hash |
| `extraction_mode` | `saved_receipts_only`, or explicitly configured `budgeted_provider` |
| `storage_origin` | Configured private Storage HTTPS origin |
| `notifications` | `null`, or `{ "origin": "https://configured-report-origin", "from": "configured sender" }` |
| `target` | Exact `real-service-worker-target-v1` object: `target_id`, `host`, `port`, `database`, `login`, `environment`, `deployment_sha256`, `machine_issuer_sha256`, `provider_budget_policy_sha256` |

Private environment also supplies `TIVDOC_REAL_SERVICE_DATABASE_URL` (worker LOGIN), `TIVDOC_REAL_SERVICE_ISSUER_DATABASE_URL` (identity LOGIN), `TIVDOC_REAL_SERVICE_DATABASE_CA`, `TIVDOC_REAL_SERVICE_CONTROLLER_CAPABILITY`, `TIVDOC_REAL_SERVICE_STORAGE_KEY`, and `TIVDOC_REAL_AI_MACHINE_ISSUER_CAPABILITY`. Enabled execution requires `TIVDOC_REAL_AI_SERVICE_ENABLED=1` and `TIVDOC_REAL_AI_MACHINE_ISSUER_ENABLED=1`. Notifications additionally require `TIVDOC_REAL_AI_NOTIFICATIONS_ENABLED=1`, `RESEND_API_KEY`, and the existing `TIVDOC_NOTIFICATION_ENCRYPTION_KEY`; recipient authorization remains independently checked. No OpenAI key is accepted by the receipts-only supervisor profile.

Provider mode additionally requires `TIVDOC_REAL_AI_PROVIDER_ENABLED=1`, an explicitly supplied `OPENAI_API_KEY`, and an absolute private `TIVDOC_REAL_SERVICE_PROVIDER_ARTIFACT_DIRECTORY`. The supervisor never inherits a provider key from its parent shell. The runtime binds the genuine extractor to each authenticated case host; the database validates the selected mode, current policy, source and job fence in the claim transaction. Every input-token count and generation request reserves credit before dispatch. Unknown outcomes retain reservations and do not trigger an automatic repeat. The mode and environment switch grant no spend by themselves. Set `TIVDOC_REAL_AI_PROVIDER_ENABLED=0` to stop further provider requests; existing notification authorization remains separate.

Automatic purchase enrollment additionally requires `TIVDOC_REAL_AI_ENROLLMENT_ENABLED=1` and the private `TIVDOC_REAL_AI_ENROLLMENT_CAPABILITY`. The bounded controller consumes the existing payment/source capture records before job discovery. Initial enrollment requires one unambiguous authenticated case identity; extensions preserve the existing identity. Source-only uploads or answers retain the same enrollment and expiry. Enrollment failures are recorded separately and do not block already enrolled work.

An already configured shell can run one tick directly:

```powershell
node output/release-completion/real-service-worker/worker.cjs
```

For scheduled execution, reuse the existing supervisor:

```powershell
node scripts/product-workers/managed-dev-supervisor.mjs --control "<absolute private REAL control path>"
```

The control uses `schema_version: real-service-supervisor-v1` with the existing fields `control_id`, `enabled`, `expires_at`, `expected_git_sha`, `expected_bundle_sha256`, `expected_manifest_sha256`, `working_directory`, `bundle_path`, `manifest_path`, `environment_path`, `output_directory`, `max_ticks`, and `child_timeout_ms`. Bind the exact bundle/manifest hashes. Environment/control files stay under the private sibling `release-work` directory; output paths stay under `output/release-completion`. The REAL control allows at most 31 days/44,640 invocations and a 480,000 ms child timeout. These local scheduling ceilings grant no database authority; every tick rechecks the shorter actual authorization windows.

Use the existing hidden Windows launcher and Task Scheduler `IgnoreNew` overlap policy when registering the task. Registration is an operator action; none of these commands registers or enables a task. Each invocation reuses the supervisor's process lock, immutable build checks, bounded child shutdown and sanitized receipts. Raw stdout/stderr and machine SID/JTI values are excluded from receipts.

Set the control's `enabled` field to `false` to stop new ticks and signal an active child through the existing supervisor watcher. Set `TIVDOC_REAL_AI_SERVICE_ENABLED=0` in the private environment to disable subsequent direct invocations. Disabling notifications uses their separate flag. Database revocations remain authoritative on every transaction.

Machine maintenance reads first. An expired or missing session can be replaced only through the existing live issuer grant; terminal revocation and unknown supersession are refused. The replacement keeps append-only provenance and does not renew calculation authority, notification permission or spend. Execution expiry is narrowed to the actual machine expiry before candidate hashing.

The source graph retains authenticated historical June test-authority branches in the shared saved-analysis service, but no fixture modules or DEV worker entry. The REAL catalog wrapper preserves the original REAL selection hashes while the historical mixed wrapper retains its synthetic behavior.
