# Tivdoc engine persistence foundation

## Scope and boundary

This foundation adds a review-only migration and a server-only data-access layer. It does not connect the engine to the current application, add routes, alter customer UI, call an LLM, implement legal rules, or change the questionnaire, payment, attribution, GA4, Meta, or funnel state machines. The migration has not been applied to any database.

`src/engine` remains the pure source of truth for domain contracts. `src/server/engine` is the only intended Supabase boundary for future orchestration. It imports `server-only`, validates input before mapping, uses the existing service-role client, and returns validated domain objects where practical. Agent contracts continue to declare `database_access: "none"`.

The engine lifecycle remains independent from `cases.status`. Engine work must never write OCR, interview, or analysis stages into the customer funnel state.

## Minimal relational model

The migration creates nine query-critical tables rather than normalizing every salary field:

| Table | Purpose | Mutability |
| --- | --- | --- |
| `analysis_runs` | Versioned executions, parent lineage, exact input manifest/hash, versions, safe failure metadata | Lifecycle updates only; identity and inputs are guarded; terminal rows are immutable |
| `employment_snapshots` | One validated canonical fact snapshot per run | Insert-only through the service role |
| `analysis_hypotheses` | Structured investigation output with reason, evidence needs, and rule proposals in payload | Insert-only through the service role |
| `case_conversations` | Case/run-scoped interview container | Status/close lifecycle updates |
| `case_messages` | Append-only question, answer, content, and model/prompt provenance | Insert-only through the service role |
| `analysis_findings` | Queryable status/period/money/rule fields plus full trace and evidence | Insert-only through the service role |
| `document_extractions` | Versioned extraction attempts with immutable source hash and optional private artifact path | Active-attempt lifecycle updates; terminal attempts are immutable |
| `case_confirmations` | Customer correction/confirmation and source-message link | Pending-to-answered lifecycle updates |
| `analysis_jobs` | Durable, retryable stage records without introducing a queue vendor | Job lifecycle updates |

Facts are intentionally not stored as individual relational rows in V1. A canonical employment snapshot stores the strict `EmploymentSnapshot` JSON payload, which contains canonical facts and their provenance. Extraction payloads are also schema-validated JSON. Hypotheses keep their full domain payload. Findings are relational only where filtering or monetary safety benefits from it; their calculation trace and evidence references stay structured JSON.

This keeps the audit chain representable without creating a table for every ontology member:

```text
finding
  -> calculation_payload + rule_id/rule_version
  -> fact_references
  -> employment snapshot facts/provenance
  -> document extraction or conversation message
  -> immutable document/private artifact or customer answer
```

## Historical analysis runs

Every interpretation is a new `analysis_runs` row. `parent_run_id` records lineage when later evidence causes re-analysis. `input_snapshot` is a reference-only manifest of document, extraction, conversation-message, questionnaire-response, and parent-snapshot IDs; the repository hashes its canonical JSON. It does not copy OCR or chat content into the run row.

Database guards enforce same-case parent lineage, immutable run identity/input/version fields, the domain state machine, and terminal immutability. The service role has no direct delete grant on engine tables; deletion is owned by the case aggregate. Insert-only grants prevent snapshots, hypotheses, messages, and findings from being silently rewritten.

Customer corrections are new confirmation/message evidence. A correction does not edit an earlier fact or finding; orchestration will create a child analysis run with a new snapshot.

## Document compatibility and migration stages

The current Production contract remains `unique(case_id, document_type)`, a restricted legacy `document_type`, deterministic paths such as `cases/{case_id}/payslip-01.pdf`, and an upsert on `(case_id, document_type)`. Phase A preserves all of those assumptions.

Phase A — additive foundation (this migration):

- Add nullable classification/hash/period/supersession metadata and defaulted `processing_status`/`storage_layout` fields to `documents`.
- Existing rows become `legacy_slot` without backfill or path changes.
- Add the engine tables and repositories, but do not call them from the application.
- Keep the legacy unique constraint and current upload code unchanged.
- The engine document repository is read-only in this phase, making an accidental new write through this foundation impossible.

Phase B — engine upload API (future, separate approval):

- Add a trusted server endpoint that allocates a document UUID before upload, hashes bytes, and writes `cases/{case_id}/documents/{document_id}/original.ext` to the private bucket.
- Relax the legacy `document_type` restriction in a reviewed migration so pension, termination, and unknown types are representable.
- Write `immutable_v1` rows and never overwrite an object or document identity.

Phase C — customer upload migration (future):

- Move the customer upload UI and completion route to the engine API.
- Prove resume, replacement, cleanup, payment prerequisites, and attribution behavior in Preview.
- Treat a replacement as a new document linked with `supersedes_document_id`.

Phase D — legacy constraint removal (future):

- Only after no caller uses the old upsert, remove `unique(case_id, document_type)` and legacy path assumptions.
- Backfill or explicitly retain old rows as `legacy_slot`; do not pretend an overwritten legacy object has immutable provenance.

The Phase A immutable-path check applies only when `storage_layout = 'immutable_v1'`. Legacy rows and writes remain valid.

## Extraction, conversations, and confirmations

Each extraction attempt has its own UUID and idempotency key. `source_content_sha256` is immutable even before a payload exists, so a queued attempt is bound to exact bytes. An improved extractor creates a new attempt rather than overwriting a terminal one. Structured extraction content remains in the protected table; large raw artifacts, if retained, use a relative path in the private `salary-documents` bucket. Raw OCR must never be emitted to logs.

Messages preserve role, agent, question ID/version, selected option IDs, free text, rendered content, model identifier, prompt version, run, conversation, case, and timestamp. Cross-case database triggers reject joins between a run, document, extraction, conversation, message, confirmation, or job belonging to different cases.

Answered confirmations require an answer, source message, and timestamp. The source run remains historical; the confirmation becomes input evidence for a future run.

## Idempotency and partial failure

Stable SHA-256 keys are defined for:

- analysis run: case, mode, trigger, input snapshot hash, engine version, and contract version;
- extraction: immutable document ID/content hash and extractor/model versions;
- job: run, stage, optional document/extraction, and input payload hash;
- assistant question: conversation, run, question ID, and question version;
- finding: run, category, period, rule version, and sorted fact references (never the generated finding UUID).

Repositories insert first. On PostgreSQL unique violation `23505`, they fetch the row by its scoped idempotency key and return it only when its identity-critical values agree. They never use an upsert to rewrite historical artifacts. A duplicate monetary finding therefore resolves to the existing record.

`analysis_jobs` is sufficient for this foundation: each document/stage can fail or retry independently, active jobs require a remaining attempt, and errors use stable codes. No Redis, queue provider, worker, scheduler, or orchestration loop is introduced.

## Security and logging

Every new engine table has RLS enabled, no anon/authenticated policy, explicit revocation from browser roles, and least-mutation grants to `service_role`. Browser Supabase code must never import the repository layer or select engine tables. The private Storage bucket remains private and unchanged.

`SafeEngineLog` is strict and permits only operational IDs, stage/event, duration, retry count, timestamp, and a safe error code. Unknown fields are rejected, including names, contact details, OCR text, salary contents, or chat content. `EnginePersistenceError` exposes only a stable code and operation; database messages and persisted values are not copied into it.

## Deletion and retention

The relational ownership graph is:

```text
case
  -> documents -> document_extractions
  -> conversations -> messages
  -> confirmations
  -> analysis_runs
       -> employment_snapshots
       -> hypotheses
       -> findings
       -> jobs
```

Foreign-key cascades remove database records when the owning case is deleted. Cross-case guards prevent an unrelated case from retaining a reference. PostgreSQL cannot transactionally delete private Storage objects, so future case-deletion orchestration must inventory the exact case-owned paths, delete the database case in a transaction, and perform/retry private-object cleanup with a durable audit record. Automatic retention and that cleanup worker are intentionally not implemented here.

Transactional case evidence must not be repurposed as an evaluation corpus. A future de-identified evaluation dataset needs separate consent, irreversible de-identification, access controls, and retention approval; it is outside this task.

## Verification and current limits

Before persistence work, Vitest discovered 96 tests once across 13 files: 43 engine-foundation tests plus 53 non-engine tests. The older 41-test baseline predates twelve net non-engine additions (payment-return, GA4 server-core, funnel-report, and attribution coverage; a validation test was replaced rather than duplicated). The include patterns `src/**/*.test.ts` and `scripts/**/*.test.mjs` do not overlap, and `vitest list` showed no duplicate test IDs.

The persistence unit suite covers contracts, mappings, run lineage, extraction immutability, safe money, legacy document compatibility, stable keys, safe logs, repository duplicate handling, RLS/grants, cascade declarations, and static protection of the existing upload assumptions.

Not yet implemented or verified:

- no migration has been applied to local, Preview, or Production Supabase;
- no PostgreSQL/Supabase integration test has executed the DDL, triggers, grants, or cascades;
- no private Storage deletion workflow or retention automation exists;
- no engine upload API, worker, queue consumer, agent, LLM provider, legal rule, deterministic salary formula, report, or customer chat UI exists;
- no current app route imports these repositories.

Before Preview deployment, review the DDL against a current schema dump, apply it to an isolated database, exercise legacy upload/upsert and resume flows, test every trigger/state transition and case deletion, verify grants with anon/authenticated/service-role sessions, and confirm private-object cleanup ownership. Production application remains a separate explicit approval.
