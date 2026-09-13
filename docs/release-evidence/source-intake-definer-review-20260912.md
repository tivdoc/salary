# Source intake: privileged SQL and actual-role proof boundary

AI code review, 12 September 2026. This review covers migration `20260912194800_legacy_source_period_intake.sql` (191), its upload integration, and the additive scheduling predicate in `20260912200100_managed_legacy_source_intake_admission.sql` (192). It is a software review, not a source reading, entitlement assessment, human attestation, or activation receipt.

The reviewed 191 artifact has SHA-256 `db98533addd9eeae545a729221cb05f5a0f4ac770411efde659c1c543afe4f5a`. The release operator reported its DEV application after 169 rollback assertions and static checks. The reviewer did not execute the database proof or application. The rollback proof includes actual PostgreSQL/TypeScript canonical receipt and assessment parity; synthetic fixtures were inserted by the owner role. Those assertions do not establish a successful web or worker principal journey.

## Privilege inventory

There are 22 literal `SECURITY DEFINER` declarations in 191. This includes replacements of existing functions, not 22 newly exposed endpoints. Each declaration fixes `search_path` to the empty string. The inventory is:

| Intended direct caller | Exact functions and argument types |
| --- | --- |
| Internal/owner only (5) | `private.document_physical_page_receipt_guard()`; `private.guard_extraction_source_period_evidence()`; `private.legacy_scope_covers_month(jsonb,date)`; `private.document_field_current(uuid,jsonb)`; `private.legacy_source_upload_information_satisfied(uuid,uuid)` |
| Verified worker only (6) | `private.legacy_source_document_request_open(uuid,integer,text,jsonb,text)`; `private.legacy_source_intake_context(uuid,bigint,text)`; `private.source_physical_pages_pending(uuid,bigint,text)`; `private.document_field_request_open(uuid,integer,text,jsonb,text)`; `private.legacy_source_upload_assessment_context(uuid,bigint,text)`; `private.legacy_source_upload_assessment_record(uuid,bigint,text,jsonb)` |
| Web, worker, service (1) | `private.document_physical_pages_record(uuid,uuid,uuid,text,bigint,text,integer)` |
| Web and service (10) | `public.case_request_source_intake_context(uuid,uuid,uuid)`; `private.legacy_source_upload_validate(uuid,uuid,jsonb)`; `private.legacy_source_upload_bind(uuid,uuid)`; `private.legacy_source_upload_scope(uuid,uuid)`; `private.legacy_source_upload_commit_guard(uuid,uuid)`; `private.upload_physical_pages_record(uuid,uuid,jsonb)`; `private.legacy_source_upload_received(uuid,uuid)`; `private.legacy_source_upload_snapshot(uuid,jsonb)`; `public.case_request_source_intake_upload_context(uuid,uuid)`; `private.document_field_request_answer_valid(uuid,uuid,text)` |

New functions revoke `PUBLIC`, `anon`, and `authenticated` execution; explicit grants select server roles. Existing replacements retain their earlier ACLs. Worker entry points additionally require the actual `session_user` and `runtime_verified_tenant() = 'saved-case:' || case_id`. The shared physical recorder also validates the current case/document/version/hash/size/MIME tuple and immutable page receipt. Its worker branch requires the verified tenant.

Five new private tables have RLS and no direct runtime read/write grants: `document_physical_page_receipts`, `legacy_source_document_targets`, `legacy_source_upload_bindings`, `legacy_source_upload_receipts`, and `legacy_source_upload_assessments`. Their immutability triggers protect retained evidence. Table restrictions alone do not authenticate a caller of a definer function; each callable boundary must be assessed separately.

The cloned prior `legacy_scope_covers_month`, `document_field_current`, and `document_field_request_open` functions remain internal. The cloned `case_documents_snapshot_before_intake_v1(uuid)` retains web/service use and is an invoker function. The new canonicalization, current-target, answer-validation, internal-context, source-period-evidence, and pure assessment-replay helpers are invoker functions without direct runtime execution grants. Dynamic patches retain the allocator, finalizer, answer, operations, sweep, and reminder functions' existing security declarations and ACLs.

## Authentication and trusted server boundary

The browser uses the existing sign/complete routes and signed case cookie. `prepareUpload` additionally resolves the identified session for source intake, then invokes the four-argument `case_documents_reserve` overload. That overload checks the linked case identity and verified contact, locks the case, and records the batch actor before delegating to the existing allocator. The actor's deferred foreign key makes successful transaction completion an essential positive test.

Some private web helpers, such as scope and snapshot lookup, do not independently authenticate an end-user identity. This is the existing trusted-server-role boundary. They must not be turned into arbitrary client-callable RPCs. The application database adapter allows named `public.case_*` functions; it does not expose arbitrary private functions. A direct authenticated DEV web connection proves that role's behavior only. It does not prove a PostgREST authenticator/service-role deployment or browser cookie handling.

Worker credentials must be installed using the existing authoritative `private.runtime_context_install(sid,jti,correlation)` path. Setting tenant GUCs or assuming a role is not an equivalent proof. Operations identities with a reviewer organization are not ordinary worker identities. No identity issuance or renewal is part of this review.

## Reservation, finalization and information state

The allocator and finalizer retain case-then-batch locking, capacity checks, immutable reserved paths, and exact replacement-version checks. Source-intake opt-in permits a missing period; it does not write a purchase month or weaken the paid-case month lock. The selected request, target, paid receipt, actor, and scope are checked again at commit. A completed-batch retry returns the current snapshot without writing a second receipt.

Physical verification occurs after document inserts/replacements inside the same database transaction. A missing or invalid physical count must roll back the archive, replacement/new document, receipt, batch completion and source-head capture together. A test that merely observes an exception is insufficient: it must compare all those persisted effects before and after rollback. The application separately downloads and inspects actual bytes before supplying hashes/page counts; a direct SQL protocol proof cannot replace that storage/parser test.

Duplicate evidence is checked against reservation-time hashes, duplicate hashes within the batch, and other current documents at receipt creation. The final check addresses two batches reserved before either finishes. Two-connection contention remains a distinct proof obligation from sequential synthetic receipt fixtures.

An upload is `received_pending_reading`, with `information_satisfied = false`. Only current, identified, exact-source period readings can satisfy source intake. This is never financial completion. Unknown/unreadable, replaced source, duplicate content, partial periods and conflicting readings remain explicit. Context links are restricted to the selected receipt's files and latest eligible requests; a request with no receipt gets no incidental reading links. Current satisfaction is replayed from the current source head, so a changed answer can remove it. Operations and reminder exclusions use that current source result; financial-report delivery guards are not widened.

## Actual-role acceptance plan

For a durable synthetic journey, use a dedicated, clearly synthetic QA case with a committed original legacy paid receipt and linked identity. A smaller SQL-role proof can use an existing authorized QA copy: commit only its genuine missing-source request, then keep every synthetic upload effect inside one web transaction that is rolled back. Do not persist a synthetic payroll document in a retained private customer copy. Provisioning belongs to the operator and is separate from the proof runner.

1. Through the actual worker connection and a current authoritative worker session for that QA case, load the exact current head, replay the source-intake context, and open the generated request twice. Verify one request identity. Reject foreign/stale target and wrong source hash. Roll back this worker transaction, or explicitly retain a separately authorized request for the next role.
2. With a committed request, use the actual web connection and four-argument reserve RPC. Verify reserve retry returns the same files, paths and scope, while a different manifest with the same batch identifier fails. Force deferred constraints before ending the transaction. Reject a foreign identity and scope.
3. Attempt finalization with an invalid physical count, verify the expected failure and unchanged snapshot, then finalize the identical reservation with the verified synthetic file's real digest and page count. Check exact canonical receipt, unchanged purchase month, pending-reading status and completed retry. Roll back the entire proof and compare documents, archived versions, actors, batches, receipts and source head to their initial state.
4. Separately, use two actual web connections to reserve overlapping capacity/replacement targets and duplicate content before either commit. Assert serialization, stale replacement rejection and duplicate classification, with no lost original source.
5. For a durable cross-role test, explicitly retain only the synthetic QA fixture/request/upload; then the worker opens the generated period target, the identified web path records a source reading, and the worker records the pure replay assessment. Verify pending → satisfied → correction/unknown removes satisfaction, and that all nine financial topics remain unevaluated. Never claim that two independent rolled-back transactions form this durable journey.

No provider execution, customer notification, payment, financial analysis or running worker-epoch change is needed for steps 1–3. Storage PUT/download/parser and authenticated browser tests are separate, necessary evidence for the complete product upload journey.

## Scheduling-only addition in 192

192 changes only the final result of `ai_release_managed_case_ready`: a bounded missing-period legacy intake branch is added after the existing DEV/QA/contact, current grant/configuration times, source/dispatch dependency and inventory limits. Its helper requires 1–12 current paid legacy scopes, exact pinned equality, every purchase period explicitly missing, and no active modern paid entitlement. It has no direct runtime grants. Existing capability, compiled-build, expiry, budget and scheduler gates remain in the calling path.

The helper reads purchase-period state. A later source reading does not rewrite that purchase. Therefore scheduling eligibility can remain true even if a reading identifies a month outside May–July 2026. That boolean is permission to continue bounded intake, not proof of an executable supported month. The ordinary monthly selector must still reject unsupported dates. The reported 17 rollback assertions for 192 prove patch preservation and separation from configuration authority; they do not prove a successful scheduler claim. Include current/expired authority, mixed known/missing scopes, altered pinned scope, and a source reading outside the supported period in the final operational acceptance evidence.
