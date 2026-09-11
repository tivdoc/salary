# Product upload and source-review SQL boundary review

This is an AI-assisted technical source review of migrations 160–166 on 2026-09-11. It is not professional approval, legal authority, or proof of deployed database ACLs. The reviewed chain contains 166 migrations and 351 literal SECURITY DEFINER declarations, up from 319. The 32 additions include redeclarations; they are not 32 new distinct functions. All 351 declarations pin an empty search_path. CI retains the former 28 tail entries and appends the seven migrations below, rather than replacing historical coverage.

| # | Migration | Literal definer declarations | Purpose |
| --- | --- | ---: | --- |
| 160 | 20260911164033_identified_cell_reading_v2.sql | 2 | Identified decisions for one exact source cell |
| 161 | 20260911164425_private_document_review_artifacts.sql | 2 | Owned, DEV-only private draft artifacts |
| 162 | 20260911165540_legacy_paid_review_upload_flow.sql | 22 | Paid source scope, upload binding and assessment |
| 163 | 20260911171000_document_review_source_revisions.sql | 3 | Immutable source-review revision admission and reading |
| 164 | 20260911171700_private_review_canonical_case_binding.sql | 2 | Redeclaration of draft reads with canonical case binding |
| 165 | 20260911173000_legacy_scope_period_variable.sql | 0 | Guarded local-variable correction in an existing function |
| 166 | 20260911173500_scoped_financial_source_completion.sql | 1 | Scoped financial-source satisfaction and obsolete reminder suppression |

## Explicit execution surfaces

Every literal definer revokes default execution from PUBLIC, anon and authenticated. The test records the complete explicit EXECUTE grant signatures and role groups, including invoker helpers. The table below groups names for readability; signatures and exact grants are pinned in `src/server/platform/persistence/postgres/security-definer-search-path.test.ts`. “Internal” means no direct runtime EXECUTE grant in the reviewed migration; it does not claim the owner cannot execute the function.

| Migration | Execution group | Exact function names |
| --- | --- | --- |
| 160 | Internal trigger | private.guard_document_cell_decision |
| 160 | Web + service_role | public.case_request_field_reading_targets |
| 160 | Web + service_role, invoker | private.document_field_answer_v2_valid |
| 160 | Worker, invoker | private.document_field_question_fields_v3 |
| 161, 164 | Web only | public.case_report_private_review_list; public.case_report_private_review_artifact |
| 162 | Internal | private.legacy_paid_scopes_internal; private.document_review_upload_pin_current; private.document_review_upload_journal; private.document_review_paid_scope_current; private.document_review_scope_insert_guard; private.document_review_upload_state |
| 162 | Worker | private.legacy_paid_scopes; private.document_field_request_open; private.document_review_upload_assess; private.document_review_upload_assessment_inputs |
| 162 | Operations | private.legacy_paid_scope_register; private.legacy_paid_period_register; private.legacy_paid_scope_revoke |
| 162 | Web + service_role | private.document_review_upload_validate; private.document_review_upload_bind; private.document_review_upload_commit_guard; private.document_review_upload_received; private.document_review_upload_batch_scope; private.document_review_upload_snapshot; private.document_review_upload_capture; public.case_order_legacy_receipts; public.case_request_review_upload_states |
| 163 | Internal | private.document_review_source_refs |
| 163 | Worker | private.document_review_source_admit; private.document_review_source_read |
| 166 | Worker | private.document_review_information_satisfied_for_sweep |

The invoker helpers `private.legacy_scope_covers_month`, `private.document_review_pinned_public_law`, `private.document_review_source_is_law`, `private.document_review_gap_sources_bound` and `private.document_review_financial_inventory_covered` do not receive runtime EXECUTE grants. They are not additional definer declarations.

## Boundary decisions checked in source

- **Identified reading:** the v2 answer guard binds the existing owned request and exact current source cell. Confirm, correct, unknown and unreadable remain distinct. A cell decision does not approve sibling cells, a whole document, or a legal rule. The original source and answer history remain preserved.
- **Private artifacts:** both final definitions in 164 require the existing disposable DEV boundary, actual web principal, linked identity and QA case gates. They resolve canonical case IDs for source and draft bindings. Returning a private draft is separate from ordinary report publication.
- **Paid scope and uploads:** 162 separates operations admission of source-backed legacy payment scope from web upload and worker assessment. Private source/payment/binding/receipt/assessment tables are RLS-enabled with direct access revoked. Uploaded bytes alone do not satisfy a question: the current case, source, order, month, target and saved assessment must agree.
- **Source revisions:** 163 stores append-only source versions and current heads. Admission and reading use the actual worker boundary, current job and paid period, source version/hash pins, input hash and exact revision. A curated source review is not inserted as an OCR checkpoint or provider result. Source changes invalidate old inputs; identified answers preserve the source reference they amend. A pinned public-law source is an input exception, not legal activation.
- **Scoped completeness:** 166 introduces only the exact `payslip.financial_source` marker. Historical `payslip.full` semantics remain unchanged. The partial document marker is not whole-document verification. Product admission separately requires four individually accepted current-period cells and original physical source proof; the SQL assessor still binds evidence, source revision, paid scope and dependent checks.
- **Reminder suppression:** the new worker-only helper returns a currentness/satisfaction boolean, not private target contents. Its actual principal and current request predicates remain in the function. Pending obsolete reminders are suppressed; old deliveries, source observations and answer receipts are not rewritten, and no new send is created by a late event.

## Dynamic replacement inventory and ACL retention

These migrations also read existing definitions and replace narrow body fragments. They do not introduce literal CREATE declarations into the inventory. There are 20 literal `pg_get_functiondef` lookups, with repeated lookups preserved in the test, plus two targets in migration 160's loop.

| Migration | Existing signatures read for body replacement |
| --- | --- |
| 160 | public.case_request_answer(uuid,uuid,text); public.case_request_edit(uuid,uuid,uuid,text,integer,text) (loop) |
| 162 | private.capture_case_input(uuid,text); private.document_review_request_open(uuid,integer,text,text,text,text); private.document_review_request_current(uuid,uuid); public.case_documents_reserve(uuid,uuid,jsonb); public.case_documents_batch(uuid,uuid); public.case_documents_commit(uuid,uuid,jsonb); public.case_documents_snapshot(uuid); private.document_review_upload_bind(uuid,uuid); private.document_review_upload_snapshot(uuid,jsonb) (12 lookups over these nine signatures) |
| 163 | private.capture_case_input(uuid,text) |
| 165 | private.legacy_paid_scope_register(uuid,bytea,jsonb) |
| 166 | private.document_review_upload_assess(uuid,integer,text,uuid,text,text); private.managed_dev_notification_event_current(uuid,text); public.case_request_sweep(timestamptz,integer); public.case_notification_request_reminders(integer); public.case_notification_reminder_enqueue(uuid,text,text,uuid,uuid,text,jsonb,timestamptz); public.case_notification_outbox_claim(uuid) |

Each patch uses the exact existing signature and guarded base/needle checks with exceptions when the expected source is absent or changed. Migration 165 changes the local period variable within the known declaration and loop; it does not rename a SQL function or alter its signature. The tests pin the target sequences, reject DROP FUNCTION/owner changes in these migrations, and retain the exhaustive literal search-path assertion. Newly declared or explicitly redeclared functions separately revoke/grant their intended execution groups.

PostgreSQL preserves ownership and permissions when CREATE OR REPLACE replaces the same function; other properties are those supplied in the command. Reading `pg_get_functiondef` retains the existing header while these reviewed patches alter only guarded body fragments. This explains ACL retention; it does not establish that the original live ACL was correct. [PostgreSQL CREATE FUNCTION documentation](https://www.postgresql.org/docs/current/sql-createfunction.html).

## Verification and limits

The named inventory tests check every migration, exact new declaration names, complete explicit grants, default-execute revocations, dynamic target sequences and all empty search paths. No migration, deployment, provider request, production write, or customer message is executed by this source review.

The root integration lane separately captured the current isolated DEV surface at `2026-09-11T17:58:09.522Z`, schema chain 166. The inspected, copied [DB surface receipt](product-upload-db-surface-20260911.json) contains only function names, signatures, owner, configuration, role execution booleans and seven migration hashes. It records 49 current functions (37 definers and 12 invokers), all current definers with an empty search_path, and no anon/authenticated execution in that surface. These current distinct functions include dynamic targets and therefore are a different count from the 32 literal declarations added by seven migration files. Role booleans record current permissions; they do not alone prove each function's behavioral authorization gates. The receipt's `noPublicRoleExecute` field summarizes the measured anon/authenticated role columns; it is not a separate PUBLIC pseudo-role ACL query.

Focused verification passed on 2026-09-11: `npx vitest run scripts/supabase-dev-guard/chain-replay.test.mjs src/server/platform/persistence/postgres/security-definer-search-path.test.ts` — 2 files, 17/17 tests. Targeted ESLint for both files passed. No test was removed, skipped, or weakened; the exact chain tail and surface inventories were extended. The integration lane also reported 13 isolated DEV behavior tests passing; their exact scope belongs to the package's DB test receipt. This document does not claim fresh full-chain replay, every historical function's live ACL, customer readiness, or a Production change. A matching source count is not a substitute for runtime permission and behavior proofs.
