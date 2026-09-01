import { createHash } from "node:crypto";

import { Pool } from "pg";

import type { PinnedPostgresBinaries } from "./pinned-binaries.mts";
import type { DynamicPostgresPaths } from "./paths.mts";
import {
  buildPostgresChildEnvironment,
  type CommandRunner,
  runSafeCommand,
} from "./process.mts";
import { assertSafeTargetIdentity, type ApprovedPostgresTarget } from "./safety.mts";

export const EXPECTED_CANONICAL_TABLES = Object.freeze([
  "private.controlled_import_artifacts",
  "private.controlled_import_audit_events",
  "private.controlled_import_requests",
  "private.governance_aggregate_snapshots",
  "private.governance_audit_events",
  "private.governance_golden_case_sets",
  "private.governance_gt_active_locks",
  "private.governance_gt_eligibility_versions",
  "private.governance_gt_lock_supersessions",
  "private.governance_gt_locks",
  "private.governance_gt_manifest_versions",
  "private.governance_human_decisions",
  "private.governance_idempotency",
  "private.governance_key_challenge_consumptions",
  "private.governance_key_challenges",
  "private.governance_key_revocations",
  "private.governance_key_rotations",
  "private.governance_legal_observation_decisions",
  "private.governance_legal_observation_versions",
  "private.governance_parameter_attestations",
  "private.governance_parameter_versions",
  "private.governance_reviewer_keys",
  "private.governance_reviewer_organizations",
  "private.governance_reviewer_policies",
  "private.governance_reviewers",
  "private.governance_rulespec_approvals",
  "private.governance_rulespec_versions",
  "private.governance_work_items",
  "public.analysis_findings",
  "public.analysis_hypotheses",
  "public.analysis_jobs",
  "public.analysis_runs",
  "public.case_confirmations",
  "public.case_conversations",
  "public.case_messages",
  "public.cases",
  "public.controlled_import_publication_markers",
  "public.document_extractions",
  "public.documents",
  "public.employment_snapshots",
  "public.engine_analysis_stage_versions",
  "public.engine_calculation_trace_versions",
  "public.engine_canonical_fact_versions",
  "public.engine_case_identity",
  "public.engine_case_lifecycle_revisions",
  "public.engine_case_state",
  "public.engine_durable_jobs",
  "public.engine_global_dependency_invalidations",
  "public.engine_global_dependency_state",
  "public.engine_idempotency_records",
  "public.engine_job_history",
  "public.engine_legal_version_pins",
  "public.engine_logical_effect_receipts",
  "public.engine_object_write_sagas",
  "public.engine_outbox_events",
  "public.engine_payment_evidence_refs",
  "public.engine_platform_audit_events",
  "public.engine_report_versions",
  "public.engine_review_task_versions",
  "public.engine_rule_input_versions",
  "public.engine_schema_metadata",
  "public.engine_topic_result_versions",
  "public.funnel_events",
  "public.funnel_sessions",
  "public.payments",
  "public.product_case_owners",
  "public.product_identity_sessions",
  "public.product_privacy_request_versions",
  "public.product_private_report_objects",
  "public.questionnaire_responses",
  "storage.buckets",
] as const);

export const EXPECTED_CANONICAL_RLS_TABLES = Object.freeze([
  "public.analysis_findings",
  "public.analysis_hypotheses",
  "public.analysis_jobs",
  "public.analysis_runs",
  "public.case_confirmations",
  "public.case_conversations",
  "public.case_messages",
  "public.cases",
  "public.controlled_import_publication_markers",
  "public.document_extractions",
  "public.documents",
  "public.employment_snapshots",
  "public.engine_analysis_stage_versions",
  "public.engine_calculation_trace_versions",
  "public.engine_canonical_fact_versions",
  "public.engine_case_identity",
  "public.engine_case_lifecycle_revisions",
  "public.engine_case_state",
  "public.engine_durable_jobs",
  "public.engine_global_dependency_invalidations",
  "public.engine_global_dependency_state",
  "public.engine_idempotency_records",
  "public.engine_job_history",
  "public.engine_legal_version_pins",
  "public.engine_logical_effect_receipts",
  "public.engine_object_write_sagas",
  "public.engine_outbox_events",
  "public.engine_payment_evidence_refs",
  "public.engine_platform_audit_events",
  "public.engine_report_versions",
  "public.engine_review_task_versions",
  "public.engine_rule_input_versions",
  "public.engine_topic_result_versions",
  "public.funnel_events",
  "public.funnel_sessions",
  "public.payments",
  "public.product_case_owners",
  "public.product_identity_sessions",
  "public.product_privacy_request_versions",
  "public.product_private_report_objects",
  "public.questionnaire_responses",
] as const);

export const EXPECTED_TENANT_POLICY_TABLES = Object.freeze([
  "public.analysis_findings",
  "public.analysis_hypotheses",
  "public.analysis_runs",
  "public.case_confirmations",
  "public.case_conversations",
  "public.case_messages",
  "public.document_extractions",
  "public.documents",
  "public.engine_analysis_stage_versions",
  "public.engine_calculation_trace_versions",
  "public.engine_canonical_fact_versions",
  "public.engine_case_identity",
  "public.engine_case_lifecycle_revisions",
  "public.engine_case_state",
  "public.engine_durable_jobs",
  "public.engine_global_dependency_invalidations",
  "public.engine_global_dependency_state",
  "public.engine_idempotency_records",
  "public.engine_job_history",
  "public.engine_legal_version_pins",
  "public.engine_logical_effect_receipts",
  "public.engine_object_write_sagas",
  "public.engine_outbox_events",
  "public.engine_payment_evidence_refs",
  "public.engine_platform_audit_events",
  "public.engine_report_versions",
  "public.engine_review_task_versions",
  "public.engine_rule_input_versions",
  "public.engine_topic_result_versions",
  "public.product_case_owners",
  "public.product_identity_sessions",
  "public.product_privacy_request_versions",
  "public.product_private_report_objects",
] as const);

const EXPECTED_FORCED_RLS_TABLES = new Set<string>([
  "public.engine_global_dependency_invalidations",
  "public.engine_global_dependency_state",
]);

export const EXPECTED_PRIVATE_GOVERNANCE_POLICY_TABLES = Object.freeze([
  "private.governance_aggregate_snapshots",
  "private.governance_audit_events",
  "private.governance_golden_case_sets",
  "private.governance_gt_active_locks",
  "private.governance_gt_eligibility_versions",
  "private.governance_gt_lock_supersessions",
  "private.governance_gt_locks",
  "private.governance_gt_manifest_versions",
  "private.governance_human_decisions",
  "private.governance_idempotency",
  "private.governance_key_challenge_consumptions",
  "private.governance_key_challenges",
  "private.governance_key_revocations",
  "private.governance_key_rotations",
  "private.governance_legal_observation_decisions",
  "private.governance_legal_observation_versions",
  "private.governance_parameter_attestations",
  "private.governance_parameter_versions",
  "private.governance_reviewer_keys",
  "private.governance_reviewer_organizations",
  "private.governance_reviewer_policies",
  "private.governance_reviewers",
  "private.governance_rulespec_approvals",
  "private.governance_rulespec_versions",
  "private.governance_work_items",
] as const);

export const EXPECTED_RUNTIME_OWNER_POLICY_TABLES = Object.freeze([
  "public.engine_durable_jobs",
  "public.engine_global_dependency_invalidations",
  "public.engine_global_dependency_state",
  "public.engine_logical_effect_receipts",
  "public.engine_outbox_events",
  "public.engine_report_versions",
  "public.engine_review_task_versions",
  "public.product_case_owners",
  "public.product_privacy_request_versions",
  "public.product_private_report_objects",
] as const);

export const EXPECTED_PORTAL_WEB_READ_POLICY_TABLES = Object.freeze([
  "public.analysis_runs",
  "public.case_conversations",
  "public.documents",
  "public.engine_case_identity",
  "public.product_privacy_request_versions",
  "public.product_private_report_objects",
] as const);

export const EXPECTED_PORTAL_WEB_MUTATION_POLICY_TABLES = Object.freeze([
  "public.case_confirmations",
  "public.case_messages",
  "public.engine_case_lifecycle_revisions",
  "public.engine_case_state",
  "public.engine_idempotency_records",
  "public.engine_platform_audit_events",
] as const);

const EXPECTED_CANONICAL_FUNCTIONS = Object.freeze([
  "private.append_controlled_import_audit",
  "private.canonical_text_uuid",
  "private.claim_controlled_import_recovery",
  "private.claim_engine_platform_jobs",
  "private.claim_engine_platform_outbox",
  "private.controlled_import_forbid_mutation",
  "private.controlled_import_publish",
  "private.controlled_import_reject",
  "private.controlled_import_reserve",
  "private.controlled_import_stage_exact_bytes",
  "private.enforce_analysis_job_history",
  "private.enforce_case_confirmation_history",
  "private.enforce_case_conversation_history",
  "private.enforce_document_extraction_history",
  "private.enforce_engine_analysis_run_history",
  "private.enforce_engine_case_scope",
  "private.finish_engine_platform_job",
  "private.global_dependency_actor_assert",
  "private.global_dependency_state_initialize",
  "private.governance_aggregate_read",
  "private.governance_append_audit",
  "private.governance_claim_assert",
  "private.governance_complete_claim",
  "private.governance_decision_assert",
  "private.governance_finish_mutation",
  "private.governance_forbid_mutation",
  "private.governance_golden_case_set_import",
  "private.governance_gt_eligibility_append",
  "private.governance_gt_manifest_append",
  "private.governance_human_decision_admit",
  "private.governance_idempotency_lookup",
  "private.governance_jsonb_canonical_text",
  "private.governance_jsonb_compact_text",
  "private.governance_jsonb_sha256",
  "private.governance_key_challenge_append",
  "private.governance_legal_observation_decide",
  "private.governance_legal_observation_import",
  "private.governance_parameter_attestation_append",
  "private.governance_parameter_import",
  "private.governance_reviewer_append",
  "private.governance_reviewer_key_register",
  "private.governance_reviewer_key_revoke",
  "private.governance_reviewer_verification_material_read",
  "private.governance_rulespec_approval_append",
  "private.governance_rulespec_import",
  "private.governance_store_idempotency",
  "private.governance_trust_organization_append",
  "private.governance_trust_policy_append",
  "private.governance_work_claim",
  "private.governance_work_enqueue",
  "private.governance_work_release",
  "private.heartbeat_engine_platform_job",
  "private.open_controlled_import_published_bytes",
  "private.product_case_owner_bind",
  "private.product_forbid_delete",
  "private.product_forbid_privacy_mutation",
  "private.product_identity_session_read",
  "private.product_identity_session_register",
  "private.product_owner_lookup",
  "private.product_owner_revoke",
  "private.product_privacy_append",
  "private.product_private_report_object_bind",
  "private.product_report_object_approve",
  "private.product_report_object_approved_read",
  "private.product_report_object_revoke",
  "private.product_session_revoke",
  "private.product_session_rotate",
  "private.reject_engine_append_only_mutation",
  "private.resolve_engine_case_id",
  "private.runtime_assert_actor",
  "private.runtime_assert_reviewer_role",
  "private.runtime_context_install",
  "private.runtime_verified_actor",
  "private.runtime_verified_tenant",
  "private.runtime_web_case_state_commit_guard",
  "private.runtime_web_case_state_guard",
  "private.runtime_web_noop_update_guard",
  "private.runtime_web_owns_case",
  "private.runtime_web_owns_internal_case",
  "private.runtime_web_verified_actor",
  "public.claim_salary_ga4_purchase",
  "public.claim_salary_meta_purchase",
  "public.claim_salary_payment_completed",
  "public.complete_salary_ga4_purchase",
  "public.complete_salary_meta_purchase",
  "public.release_salary_ga4_purchase",
  "public.release_salary_meta_purchase",
  "public.touch_updated_at",
  "public.verify_salary_payment",
] as const);

const EXPECTED_CANONICAL_INDEXES = Object.freeze([
  "private.controlled_import_audit_operation_sequence_idx",
  "private.controlled_import_requests_recovery_idx",
  "private.governance_audit_chain_idx",
  "private.governance_gt_document_history_idx",
  "private.governance_legal_observation_current_idx",
  "private.governance_parameter_current_idx",
  "private.governance_rulespec_current_idx",
  "private.governance_snapshot_current_idx",
  "private.governance_work_claim_idx",
  "private.governance_work_claimant_idx",
  "public.analysis_findings_run_status_idx",
  "public.analysis_hypotheses_run_status_idx",
  "public.analysis_jobs_claim_idx",
  "public.analysis_jobs_document_idx",
  "public.analysis_jobs_run_stage_idx",
  "public.analysis_runs_canonical_id_uq",
  "public.analysis_runs_canonical_owner_case_idx",
  "public.analysis_runs_case_created_idx",
  "public.analysis_runs_parent_idx",
  "public.analysis_runs_status_created_idx",
  "public.case_confirmations_case_created_idx",
  "public.case_confirmations_run_idx",
  "public.case_conversations_case_created_idx",
  "public.case_conversations_run_idx",
  "public.case_messages_conversation_created_idx",
  "public.case_messages_run_idx",
  "public.cases_attribution_idx",
  "public.cases_real_payment_reporting_idx",
  "public.cases_status_created_at_idx",
  "public.confirmations_canonical_id_uq",
  "public.conversations_canonical_id_uq",
  "public.document_extractions_document_created_idx",
  "public.document_extractions_run_idx",
  "public.documents_canonical_case_idx",
  "public.documents_canonical_id_uq",
  "public.documents_case_created_id_idx",
  "public.documents_case_id_idx",
  "public.documents_content_sha256_idx",
  "public.documents_supersedes_idx",
  "public.engine_analysis_stage_case_idx",
  "public.engine_audit_canonical_chain_uq",
  "public.engine_audit_case_sequence_idx",
  "public.engine_case_state_tenant_idx",
  "public.engine_facts_case_revision_idx",
  "public.engine_global_dependency_history_case_idx",
  "public.engine_idempotency_case_scope_idx",
  "public.engine_jobs_canonical_claim_idx",
  "public.engine_jobs_claim_idx",
  "public.engine_object_saga_reconcile_idx",
  "public.engine_one_active_report_approval_uq",
  "public.engine_outbox_canonical_claim_idx",
  "public.engine_outbox_claim_idx",
  "public.engine_outbox_superseded_case_idx",
  "public.engine_reports_case_revision_idx",
  "public.engine_reviews_case_kind_idx",
  "public.engine_rule_inputs_run_topic_idx",
  "public.extractions_canonical_id_uq",
  "public.funnel_events_case_created_idx",
  "public.funnel_events_session_created_idx",
  "public.funnel_sessions_case_id_idx",
  "public.funnel_sessions_first_touch_idx",
  "public.hypotheses_canonical_id_uq",
  "public.messages_canonical_id_uq",
  "public.payments_case_id_created_at_idx",
  "public.payments_ga4_delivery_pending_idx",
  "public.payments_ga4_purchase_event_id_unique_idx",
  "public.payments_meta_checkout_event_id_unique_idx",
  "public.payments_meta_purchase_event_id_unique_idx",
  "public.payments_provider_clearing_log_id_unique_idx",
  "public.payments_provider_payment_id_unique_idx",
  "public.payments_provider_reference_unique_idx",
  "public.payments_return_token_hash_unique_idx",
  "public.product_case_owners_subject_idx",
  "public.product_identity_sessions_active_idx",
  "public.product_privacy_request_case_idx",
  "public.product_private_report_object_read_idx",
] as const);

const EXPECTED_CANONICAL_TRIGGERS = Object.freeze([
  "analysis_jobs_case_scope_guard",
  "analysis_jobs_history_guard",
  "analysis_runs_history_guard",
  "case_confirmations_case_scope_guard",
  "case_confirmations_history_guard",
  "case_conversations_case_scope_guard",
  "case_conversations_history_guard",
  "case_messages_case_scope_guard",
  "controlled_import_audit_append_only",
  "controlled_import_publication_append_only",
  "governance_aggregate_snapshots_immutable",
  "governance_audit_events_immutable",
  "governance_golden_case_sets_immutable",
  "governance_gt_eligibility_versions_immutable",
  "governance_gt_lock_supersessions_immutable",
  "governance_gt_locks_immutable",
  "governance_gt_manifest_versions_immutable",
  "governance_human_decisions_immutable",
  "governance_idempotency_immutable",
  "governance_key_challenge_consumptions_immutable",
  "governance_key_challenges_immutable",
  "governance_key_revocations_immutable",
  "governance_key_rotations_immutable",
  "governance_legal_observation_decisions_immutable",
  "governance_legal_observation_versions_immutable",
  "governance_parameter_attestations_immutable",
  "governance_parameter_versions_immutable",
  "governance_reviewer_keys_immutable",
  "governance_reviewer_organizations_immutable",
  "governance_reviewer_policies_immutable",
  "governance_reviewers_immutable",
  "governance_rulespec_approvals_immutable",
  "governance_rulespec_versions_immutable",
  "cases_touch_updated_at",
  "document_extractions_case_scope_guard",
  "document_extractions_history_guard",
  "engine_analysis_stages_append_only",
  "engine_audit_append_only",
  "engine_effects_append_only",
  "engine_facts_append_only",
  "engine_global_dependency_history_append_only",
  "engine_global_dependency_state_initialize",
  "engine_global_dependency_state_no_delete",
  "engine_job_history_append_only",
  "engine_legal_pins_append_only",
  "engine_lifecycle_append_only",
  "engine_payment_refs_append_only",
  "engine_reports_append_only",
  "engine_reviews_append_only",
  "engine_rule_inputs_append_only",
  "engine_topic_results_append_only",
  "engine_traces_append_only",
  "portal_web_case_state_commit",
  "portal_web_case_state_update",
  "portal_web_message_noop_update",
  "product_case_owner_no_delete",
  "product_identity_session_no_delete",
  "product_privacy_append_only",
  "product_private_report_no_delete",
] as const);

export const POSTGRES_INVENTORY_SQL = String.raw`
select jsonb_build_object(
  'server', jsonb_build_object(
    'version', current_setting('server_version'),
    'encoding', current_setting('server_encoding'),
    'timezone', current_setting('TimeZone'),
    'standard_conforming_strings', current_setting('standard_conforming_strings'),
    'default_transaction_isolation', current_setting('default_transaction_isolation')
  ),
  'extensions', coalesce((
    select jsonb_agg(extname order by extname) from pg_catalog.pg_extension
  ), '[]'::jsonb),
  'roles', coalesce((
    select jsonb_agg(jsonb_build_object(
      'name', rolname,
      'login', rolcanlogin,
      'superuser', rolsuper,
      'bypass_rls', rolbypassrls
    ) order by rolname)
    from pg_catalog.pg_roles
    where rolname in (
      'anon', 'authenticated', 'service_role', 'tivdoc_governance_owner',
      'tivdoc_identity_runtime', 'tivdoc_operations_runtime', 'tivdoc_web_runtime', 'tivdoc_worker_runtime'
    )
  ), '[]'::jsonb),
  'schemas', coalesce((
    select jsonb_agg(nspname order by nspname)
    from pg_catalog.pg_namespace
    where nspname in ('public', 'private', 'storage')
  ), '[]'::jsonb),
  'tables', coalesce((
    select jsonb_agg(format('%I.%I', n.nspname, c.relname) order by n.nspname, c.relname)
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p') and n.nspname in ('public', 'private', 'storage')
  ), '[]'::jsonb),
  'rls', coalesce((
    select jsonb_agg(jsonb_build_object(
      'table', format('%I.%I', n.nspname, c.relname),
      'enabled', c.relrowsecurity,
      'forced', c.relforcerowsecurity
    ) order by n.nspname, c.relname)
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p') and n.nspname = 'public'
  ), '[]'::jsonb),
  'private_governance_rls', coalesce((
    select jsonb_agg(jsonb_build_object(
      'table', format('%I.%I', n.nspname, c.relname),
      'enabled', c.relrowsecurity,
      'forced', c.relforcerowsecurity
    ) order by c.relname)
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p')
      and n.nspname = 'private'
      and c.relname like 'governance\_%' escape '\'
  ), '[]'::jsonb),
  'policies', coalesce((
    select jsonb_agg(jsonb_build_object(
      'schema', schemaname,
      'table', tablename,
      'name', policyname,
      'roles', roles,
      'command', cmd,
      'permissive', permissive
    ) order by schemaname, tablename, policyname)
    from pg_catalog.pg_policies
    where schemaname in ('public', 'private', 'storage')
  ), '[]'::jsonb),
  'portal_runtime_acl', jsonb_build_object(
    'web_surface_table_privileges', (
      select count(*)::integer
      from information_schema.table_privileges
      where grantee in ('tivdoc_web_runtime', 'PUBLIC')
        and table_schema = 'public'
        and table_name in (
          'engine_case_identity', 'engine_case_state', 'engine_case_lifecycle_revisions',
          'documents', 'case_conversations', 'case_messages', 'case_confirmations',
          'analysis_runs', 'engine_idempotency_records', 'engine_platform_audit_events',
          'engine_report_versions', 'engine_review_task_versions', 'product_case_owners',
          'product_privacy_request_versions', 'product_private_report_objects'
        )
    ),
    'web_column_select', (
      select count(*)::integer from information_schema.column_privileges
      where grantee = 'tivdoc_web_runtime' and table_schema = 'public'
        and privilege_type = 'SELECT'
        and table_name in (
          'engine_case_identity', 'engine_case_state', 'engine_case_lifecycle_revisions',
          'documents', 'case_conversations', 'case_messages', 'case_confirmations',
          'analysis_runs', 'engine_idempotency_records', 'engine_platform_audit_events',
          'product_privacy_request_versions', 'product_private_report_objects'
        )
    ),
    'web_column_insert', (
      select count(*)::integer from information_schema.column_privileges
      where grantee = 'tivdoc_web_runtime' and table_schema = 'public'
        and privilege_type = 'INSERT'
        and table_name in (
          'case_messages', 'case_confirmations', 'engine_case_lifecycle_revisions',
          'engine_idempotency_records', 'engine_platform_audit_events'
        )
    ),
    'web_column_update', (
      select count(*)::integer from information_schema.column_privileges
      where grantee = 'tivdoc_web_runtime' and table_schema = 'public'
        and privilege_type = 'UPDATE'
        and table_name in (
          'case_messages', 'engine_case_state', 'engine_idempotency_records',
          'engine_platform_audit_events'
        )
    ),
    'public_surface_column_privileges', (
      select count(*)::integer from information_schema.column_privileges
      where grantee = 'PUBLIC' and table_schema = 'public'
        and table_name in (
          'engine_case_identity', 'engine_case_state', 'engine_case_lifecycle_revisions',
          'documents', 'case_conversations', 'case_messages', 'case_confirmations',
          'analysis_runs', 'engine_idempotency_records', 'engine_platform_audit_events',
          'engine_report_versions', 'engine_review_task_versions', 'product_case_owners',
          'product_privacy_request_versions', 'product_private_report_objects'
        )
    ),
    'web_sequence_usage', pg_catalog.has_sequence_privilege(
      'tivdoc_web_runtime', 'public.engine_platform_audit_events_sequence_seq', 'USAGE'
    ),
    'web_sequence_select', pg_catalog.has_sequence_privilege(
      'tivdoc_web_runtime', 'public.engine_platform_audit_events_sequence_seq', 'SELECT'
    ),
    'operations_bind_execute', pg_catalog.has_function_privilege(
      'tivdoc_operations_runtime',
      'private.product_private_report_object_bind(text,text,text,bigint,text,text,text,bigint,text,timestamptz)',
      'EXECUTE'
    ),
    'worker_bind_execute', pg_catalog.has_function_privilege(
      'tivdoc_worker_runtime',
      'private.product_private_report_object_bind(text,text,text,bigint,text,text,text,bigint,text,timestamptz)',
      'EXECUTE'
    ),
    'web_bind_execute', pg_catalog.has_function_privilege(
      'tivdoc_web_runtime',
      'private.product_private_report_object_bind(text,text,text,bigint,text,text,text,bigint,text,timestamptz)',
      'EXECUTE'
    ),
    'service_bind_execute', pg_catalog.has_function_privilege(
      'service_role',
      'private.product_private_report_object_bind(text,text,text,bigint,text,text,text,bigint,text,timestamptz)',
      'EXECUTE'
    )
  ),
  'functions', coalesce((
    select jsonb_agg(format('%I.%I(%s)', n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)) order by n.nspname, p.proname, p.oid)
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and not exists (
        select 1
        from pg_catalog.pg_depend d
        where d.classid = 'pg_catalog.pg_proc'::regclass
          and d.objid = p.oid
          and d.refclassid = 'pg_catalog.pg_extension'::regclass
          and d.deptype = 'e'
      )
  ), '[]'::jsonb),
  'indexes', coalesce((
    select jsonb_agg(format('%I.%I', index_namespace.nspname, index_class.relname)
                     order by index_namespace.nspname, index_class.relname)
    from pg_catalog.pg_index index_entry
    join pg_catalog.pg_class index_class on index_class.oid = index_entry.indexrelid
    join pg_catalog.pg_namespace index_namespace on index_namespace.oid = index_class.relnamespace
    where index_namespace.nspname in ('public', 'private', 'storage')
      and not exists (
        select 1 from pg_catalog.pg_constraint constraint_entry
        where constraint_entry.conindid = index_entry.indexrelid
      )
  ), '[]'::jsonb),
  'triggers', coalesce((
    select jsonb_agg(jsonb_build_object(
      'table', format('%I.%I', n.nspname, c.relname),
      'name', t.tgname
    ) order by n.nspname, c.relname, t.tgname)
    from pg_catalog.pg_trigger t
    join pg_catalog.pg_class c on c.oid = t.tgrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where not t.tgisinternal and n.nspname in ('public', 'private', 'storage')
  ), '[]'::jsonb),
  'canonical_metadata', coalesce((
    select jsonb_agg(jsonb_build_object(
      'component', component,
      'schema_version', schema_version,
      'migration_id', migration_id
    ) order by component)
    from public.engine_schema_metadata
  ), '[]'::jsonb),
  'storage_buckets', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', id,
      'name', name,
      'public', public,
      'file_size_limit', file_size_limit,
      'allowed_mime_types', allowed_mime_types
    ) order by id)
    from storage.buckets
  ), '[]'::jsonb))::text;
`;

export type PostgresInventoryReceipt = Readonly<{
  schema_version: "tivdoc-real-postgres-inventory-v0.9.1";
  target_id: string;
  database: string;
  inventory: Readonly<Record<string, unknown>>;
  inventory_sha256: string;
  credentials_emitted: 0;
}>;

export async function collectPostgresInventory(input: Readonly<{
  target: ApprovedPostgresTarget;
  paths: DynamicPostgresPaths;
  binaries: PinnedPostgresBinaries;
  runner?: CommandRunner;
}>): Promise<PostgresInventoryReceipt> {
  assertSafeTargetIdentity(input.target.descriptor);
  let stdout: string;
  if (input.binaries.source_kind === "edb_authenticode_signed_windows_installer") {
    const pool = new Pool({
      host: input.target.descriptor.host,
      port: input.target.descriptor.port,
      database: input.target.descriptor.database,
      user: input.target.username.reveal(),
      password: input.target.password.reveal(),
      ssl: false,
      max: 1,
      allowExitOnIdle: true,
      application_name: "tivdoc-v091-node-inventory",
      connectionTimeoutMillis: 5_000,
    });
    try {
      const result = await pool.query<Record<string, unknown>>(POSTGRES_INVENTORY_SQL);
      const values = Object.values(result.rows[0] ?? {});
      if (result.rows.length !== 1 || values.length !== 1 || typeof values[0] !== "string") {
        throw new Error("POSTGRES_INVENTORY_OUTPUT_INVALID");
      }
      stdout = values[0];
    } finally {
      await pool.end();
    }
  } else {
    const runner = input.runner ?? runSafeCommand;
    const result = await runner({
      executable: input.binaries.executable_paths.psql,
      args: Object.freeze([
        "--no-psqlrc",
        "--no-password",
        "--no-align",
        "--tuples-only",
        "--set=ON_ERROR_STOP=1",
        "--command", POSTGRES_INVENTORY_SQL,
      ]),
      cwd: input.paths.repository_root,
      env: buildPostgresChildEnvironment(input.target),
      redactions: Object.freeze([
        input.target.username,
        input.target.password,
        ...(input.target.ownership_token ? [input.target.ownership_token] : []),
      ]),
      timeout_ms: 30_000,
    });
    stdout = result.stdout;
  }
  const inventory = parseInventory(stdout);
  const canonical = canonicalJson(inventory);
  return Object.freeze({
    schema_version: "tivdoc-real-postgres-inventory-v0.9.1",
    target_id: input.target.descriptor.target_id,
    database: input.target.descriptor.database,
    inventory,
    inventory_sha256: createHash("sha256").update(canonical).digest("hex"),
    credentials_emitted: 0,
  });
}

export function assertPlainPostgresFoundationInventory(receipt: PostgresInventoryReceipt): void {
  const inventory = receipt.inventory;
  const server = record(inventory.server, "server");
  expectValue(server.version, "17.11", "POSTGRES_INVENTORY_SERVER_VERSION_INVALID");
  expectValue(server.encoding, "UTF8", "POSTGRES_INVENTORY_SERVER_ENCODING_INVALID");
  expectValue(server.timezone, "UTC", "POSTGRES_INVENTORY_SERVER_TIMEZONE_INVALID");
  expectValue(server.standard_conforming_strings, "on", "POSTGRES_INVENTORY_STANDARD_STRINGS_INVALID");
  expectValue(server.default_transaction_isolation, "read committed", "POSTGRES_INVENTORY_ISOLATION_INVALID");

  const extensions = stringArray(inventory.extensions, "extensions");
  const schemas = stringArray(inventory.schemas, "schemas");
  const tables = stringArray(inventory.tables, "tables");
  assertExactStrings(extensions, ["pgcrypto", "plpgsql"], "POSTGRES_INVENTORY_EXTENSIONS_INVALID");
  assertExactStrings(schemas, ["private", "public", "storage"], "POSTGRES_INVENTORY_SCHEMAS_INVALID");
  assertExactStrings(tables, EXPECTED_CANONICAL_TABLES, "POSTGRES_INVENTORY_TABLES_INVALID");

  const roles = recordArray(inventory.roles, "roles");
  if (roles.length !== 8) throw new Error("POSTGRES_INVENTORY_ROLES_INVALID");
  for (const roleName of ["anon", "authenticated", "service_role"] as const) {
    const role = roles.find((candidate) => candidate.name === roleName);
    if (!role || role.login !== true || role.superuser !== false
      || role.bypass_rls !== (roleName === "service_role")) {
      throw new Error(`POSTGRES_INVENTORY_ROLE_INVALID:${roleName}`);
    }
  }

  const rls = recordArray(inventory.rls, "rls");
  const expectedPublicTables = EXPECTED_CANONICAL_TABLES.filter((table) => table.startsWith("public."));
  assertExactStrings(rls.map((entry) => stringField(entry, "table", "rls")), expectedPublicTables,
    "POSTGRES_INVENTORY_RLS_DENOMINATOR_INVALID");
  const expectedRls = new Set<string>(EXPECTED_CANONICAL_RLS_TABLES);
  for (const entry of rls) {
    const table = stringField(entry, "table", "rls");
    if (entry.enabled !== expectedRls.has(table)
      || entry.forced !== EXPECTED_FORCED_RLS_TABLES.has(table)) {
      throw new Error(`POSTGRES_INVENTORY_RLS_STATE_INVALID:${table}`);
    }
  }
  for (const roleName of [
    "tivdoc_identity_runtime",
    "tivdoc_operations_runtime",
    "tivdoc_web_runtime",
    "tivdoc_worker_runtime",
  ] as const) {
    const role = roles.find((candidate) => candidate.name === roleName);
    if (!role || role.login !== true || role.superuser !== false || role.bypass_rls !== false) {
      throw new Error(`POSTGRES_INVENTORY_ROLE_INVALID:${roleName}`);
    }
  }
  const governanceOwner = roles.find((candidate) => candidate.name === "tivdoc_governance_owner");
  if (!governanceOwner || governanceOwner.login !== false || governanceOwner.superuser !== false
    || governanceOwner.bypass_rls !== false) {
    throw new Error("POSTGRES_INVENTORY_ROLE_INVALID:tivdoc_governance_owner");
  }

  const privateGovernanceRls = recordArray(inventory.private_governance_rls, "private_governance_rls");
  assertExactStrings(
    privateGovernanceRls.map((entry) => stringField(entry, "table", "private_governance_rls")),
    EXPECTED_PRIVATE_GOVERNANCE_POLICY_TABLES,
    "POSTGRES_INVENTORY_PRIVATE_GOVERNANCE_RLS_DENOMINATOR_INVALID",
  );
  for (const entry of privateGovernanceRls) {
    if (entry.enabled !== true || entry.forced !== true) {
      throw new Error(
        `POSTGRES_INVENTORY_PRIVATE_GOVERNANCE_RLS_STATE_INVALID:${stringField(entry, "table", "private_governance_rls")}`,
      );
    }
  }

  const policies = recordArray(inventory.policies, "policies");
  if (policies.length !== EXPECTED_TENANT_POLICY_TABLES.length * 2
    + EXPECTED_PRIVATE_GOVERNANCE_POLICY_TABLES.length
    + EXPECTED_RUNTIME_OWNER_POLICY_TABLES.length
    + EXPECTED_PORTAL_WEB_READ_POLICY_TABLES.length
    + EXPECTED_PORTAL_WEB_MUTATION_POLICY_TABLES.length + 1) {
    throw new Error("POSTGRES_INVENTORY_POLICY_COUNT_INVALID");
  }
  const publicPolicyTables: string[] = [];
  const runtimePolicyTables: string[] = [];
  const runtimeOwnerPolicyTables: string[] = [];
  const contextLookupPolicyTables: string[] = [];
  const privateGovernancePolicyTables: string[] = [];
  const portalWebReadPolicyTables: string[] = [];
  const portalWebMutationPolicyTables: string[] = [];
  for (const entry of policies) {
    const schema = stringField(entry, "schema", "policies");
    const table = stringField(entry, "table", "policies");
    const rolesValue = stringArray(entry.roles, "policy.roles");
    const qualifiedTable = `${schema}.${table}`;
    const permissiveness = stringField(entry, "permissive", "policies");
    const publicShapeValid = permissiveness === "PERMISSIVE" && entry.command === "ALL"
      && rolesValue.length === 1 && rolesValue[0] === "service_role";
    const runtimeShapeValid = permissiveness === "PERMISSIVE" && entry.command === "ALL"
      && rolesValue.join(",") === "tivdoc_operations_runtime,tivdoc_web_runtime,tivdoc_worker_runtime";
    const runtimeOwnerShapeValid = permissiveness === "PERMISSIVE" && entry.command === "ALL"
      && rolesValue.length === 1 && rolesValue[0] === "tivdoc_governance_owner";
    const governanceShapeValid = permissiveness === "PERMISSIVE" && entry.command === "ALL"
      && rolesValue.length === 1 && rolesValue[0] === "tivdoc_governance_owner";
    if (schema === "public" && entry.name === "tivdoc_service_tenant_scope" && publicShapeValid) {
      publicPolicyTables.push(qualifiedTable);
      continue;
    }
    if (schema === "public" && entry.name === "tivdoc_runtime_verified_tenant" && runtimeShapeValid) {
      runtimePolicyTables.push(qualifiedTable);
      continue;
    }
    if (schema === "public" && entry.name === "tivdoc_owner_verified_tenant" && runtimeOwnerShapeValid
      && EXPECTED_RUNTIME_OWNER_POLICY_TABLES.includes(
        qualifiedTable as (typeof EXPECTED_RUNTIME_OWNER_POLICY_TABLES)[number],
      )) {
      runtimeOwnerPolicyTables.push(qualifiedTable);
      continue;
    }
    if (schema === "public" && entry.name === "tivdoc_runtime_context_session_lookup"
      && runtimeOwnerShapeValid && qualifiedTable === "public.product_identity_sessions") {
      contextLookupPolicyTables.push(qualifiedTable);
      continue;
    }
    if (schema === "private" && entry.name === `${table}_verified_tenant` && governanceShapeValid
      && EXPECTED_PRIVATE_GOVERNANCE_POLICY_TABLES.includes(
        qualifiedTable as (typeof EXPECTED_PRIVATE_GOVERNANCE_POLICY_TABLES)[number],
      )) {
      privateGovernancePolicyTables.push(qualifiedTable);
      continue;
    }
    if (schema === "public" && entry.name === "tivdoc_portal_web_owned_case"
      && permissiveness === "RESTRICTIVE"
      && rolesValue.length === 1 && rolesValue[0] === "tivdoc_web_runtime"
      && entry.command === "SELECT"
      && EXPECTED_PORTAL_WEB_READ_POLICY_TABLES.includes(
        qualifiedTable as (typeof EXPECTED_PORTAL_WEB_READ_POLICY_TABLES)[number],
      )) {
      portalWebReadPolicyTables.push(qualifiedTable);
      continue;
    }
    if (schema === "public" && entry.name === "tivdoc_portal_web_owned_case"
      && permissiveness === "RESTRICTIVE"
      && rolesValue.length === 1 && rolesValue[0] === "tivdoc_web_runtime"
      && entry.command === "ALL"
      && EXPECTED_PORTAL_WEB_MUTATION_POLICY_TABLES.includes(
        qualifiedTable as (typeof EXPECTED_PORTAL_WEB_MUTATION_POLICY_TABLES)[number],
      )) {
      portalWebMutationPolicyTables.push(qualifiedTable);
      continue;
    }
    {
      throw new Error(`POSTGRES_INVENTORY_POLICY_INVALID:${schema}.${table}`);
    }
  }
  assertExactStrings(publicPolicyTables, EXPECTED_TENANT_POLICY_TABLES,
    "POSTGRES_INVENTORY_POLICY_TABLES_INVALID");
  assertExactStrings(runtimePolicyTables, EXPECTED_TENANT_POLICY_TABLES,
    "POSTGRES_INVENTORY_RUNTIME_POLICY_TABLES_INVALID");
  assertExactStrings(runtimeOwnerPolicyTables, EXPECTED_RUNTIME_OWNER_POLICY_TABLES,
    "POSTGRES_INVENTORY_RUNTIME_OWNER_POLICY_TABLES_INVALID");
  assertExactStrings(contextLookupPolicyTables, ["public.product_identity_sessions"],
    "POSTGRES_INVENTORY_CONTEXT_LOOKUP_POLICY_TABLE_INVALID");
  assertExactStrings(privateGovernancePolicyTables, EXPECTED_PRIVATE_GOVERNANCE_POLICY_TABLES,
    "POSTGRES_INVENTORY_PRIVATE_GOVERNANCE_POLICY_TABLES_INVALID");
  assertExactStrings(portalWebReadPolicyTables, EXPECTED_PORTAL_WEB_READ_POLICY_TABLES,
    "POSTGRES_INVENTORY_PORTAL_WEB_READ_POLICY_TABLES_INVALID");
  assertExactStrings(portalWebMutationPolicyTables, EXPECTED_PORTAL_WEB_MUTATION_POLICY_TABLES,
    "POSTGRES_INVENTORY_PORTAL_WEB_MUTATION_POLICY_TABLES_INVALID");

  const portalAcl = record(inventory.portal_runtime_acl, "portal_runtime_acl");
  expectValue(portalAcl.web_surface_table_privileges, 0,
    "POSTGRES_INVENTORY_PORTAL_WEB_TABLE_ACL_INVALID");
  expectValue(portalAcl.web_column_select, 115,
    "POSTGRES_INVENTORY_PORTAL_WEB_SELECT_ACL_INVALID");
  expectValue(portalAcl.web_column_insert, 68,
    "POSTGRES_INVENTORY_PORTAL_WEB_INSERT_ACL_INVALID");
  expectValue(portalAcl.web_column_update, 10,
    "POSTGRES_INVENTORY_PORTAL_WEB_UPDATE_ACL_INVALID");
  expectValue(portalAcl.public_surface_column_privileges, 0,
    "POSTGRES_INVENTORY_PORTAL_PUBLIC_COLUMN_ACL_INVALID");
  expectValue(portalAcl.web_sequence_usage, true,
    "POSTGRES_INVENTORY_PORTAL_WEB_SEQUENCE_USAGE_INVALID");
  expectValue(portalAcl.web_sequence_select, false,
    "POSTGRES_INVENTORY_PORTAL_WEB_SEQUENCE_SELECT_INVALID");
  expectValue(portalAcl.operations_bind_execute, true,
    "POSTGRES_INVENTORY_PORTAL_OPERATIONS_BIND_INVALID");
  expectValue(portalAcl.worker_bind_execute, true,
    "POSTGRES_INVENTORY_PORTAL_WORKER_BIND_INVALID");
  expectValue(portalAcl.web_bind_execute, false,
    "POSTGRES_INVENTORY_PORTAL_WEB_BIND_INVALID");
  expectValue(portalAcl.service_bind_execute, false,
    "POSTGRES_INVENTORY_PORTAL_SERVICE_BIND_INVALID");

  const functions = stringArray(inventory.functions, "functions");
  const functionNames = functions.map((signature) => signature.slice(0, signature.indexOf("(")));
  if (functionNames.some((name) => !name)) throw new Error("POSTGRES_INVENTORY_FUNCTION_SIGNATURE_INVALID");
  assertExactStrings(functionNames, EXPECTED_CANONICAL_FUNCTIONS, "POSTGRES_INVENTORY_FUNCTIONS_INVALID");
  assertExactStrings(stringArray(inventory.indexes, "indexes"), EXPECTED_CANONICAL_INDEXES,
    "POSTGRES_INVENTORY_INDEXES_INVALID");

  const triggers = recordArray(inventory.triggers, "triggers");
  assertExactStrings(triggers.map((entry) => stringField(entry, "name", "triggers")), EXPECTED_CANONICAL_TRIGGERS,
    "POSTGRES_INVENTORY_TRIGGERS_INVALID");

  const metadata = recordArray(inventory.canonical_metadata, "canonical_metadata");
  const expectedMetadata = Object.freeze([
    Object.freeze({
      component: "canonical_postgresql_composition",
      schema_version: "tivdoc-canonical-postgresql-v0.9.0",
      migration_id: "202608310002_canonical_postgresql_composition",
    }),
    Object.freeze({
      component: "controlled_import_ledger",
      schema_version: "tivdoc-controlled-import-ledger-v0.10.0",
      migration_id: "202609010001_controlled_import_ledger",
    }),
    Object.freeze({
      component: "durable_human_legal_governance",
      schema_version: "tivdoc-durable-governance-v0.10.1",
      migration_id: "202609010004_durable_governance_workflows",
    }),
    Object.freeze({
      component: "durable_portal_runtime_security",
      schema_version: "tivdoc-durable-portal-runtime-security-v0.10.2",
      migration_id: "202609010006_durable_portal_runtime_security",
    }),
    Object.freeze({
      component: "durable_product_boundaries",
      schema_version: "tivdoc-durable-product-postgresql-v0.10.1",
      migration_id: "202609010003_durable_product_integrity_hardening",
    }),
    Object.freeze({
      component: "global_dependency_invalidation",
      schema_version: "tivdoc-global-dependency-invalidation-v0.10.2",
      migration_id: "202609010007_global_dependency_invalidation",
    }),
    Object.freeze({
      component: "governance_runtime_security",
      schema_version: "tivdoc-governance-runtime-security-v0.10.2",
      migration_id: "202609010005_governance_runtime_security",
    }),
  ]);
  if (canonicalJson(metadata) !== canonicalJson(expectedMetadata)) {
    throw new Error("POSTGRES_INVENTORY_CANONICAL_METADATA_INVALID");
  }

  const buckets = recordArray(inventory.storage_buckets, "storage_buckets");
  const bucket = buckets[0];
  if (buckets.length !== 1 || !bucket || bucket.id !== "salary-documents" || bucket.name !== "salary-documents"
    || bucket.public !== false || bucket.file_size_limit !== 10_485_760) {
    throw new Error("POSTGRES_INVENTORY_STORAGE_BUCKET_INVALID");
  }
  assertExactStrings(stringArray(bucket.allowed_mime_types, "storage_bucket.allowed_mime_types"),
    ["application/pdf", "image/jpeg", "image/png"], "POSTGRES_INVENTORY_STORAGE_MIME_TYPES_INVALID");
}

export function parseInventory(stdout: string): Readonly<Record<string, unknown>> {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) throw new Error("POSTGRES_INVENTORY_OUTPUT_INVALID");
  let parsed: unknown;
  try {
    parsed = JSON.parse(lines[0]!);
  } catch {
    throw new Error("POSTGRES_INVENTORY_JSON_INVALID");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("POSTGRES_INVENTORY_JSON_INVALID");
  }
  return Object.freeze(parsed as Record<string, unknown>);
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`POSTGRES_INVENTORY_FIELD_INVALID:${field}`);
  }
  return value as string[];
}

function record(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`POSTGRES_INVENTORY_FIELD_INVALID:${field}`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function recordArray(value: unknown, field: string): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value)) throw new Error(`POSTGRES_INVENTORY_FIELD_INVALID:${field}`);
  return value.map((entry) => record(entry, field));
}

function stringField(value: Readonly<Record<string, unknown>>, field: string, parent: string): string {
  const child = value[field];
  if (typeof child !== "string") throw new Error(`POSTGRES_INVENTORY_FIELD_INVALID:${parent}.${field}`);
  return child;
}

function expectValue(actual: unknown, expected: unknown, code: string): void {
  if (actual !== expected) throw new Error(code);
}

function assertExactStrings(
  actual: readonly string[],
  expected: readonly string[],
  code: string,
): void {
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  if (actualSorted.length !== expectedSorted.length
    || actualSorted.some((value, index) => value !== expectedSorted[index])) {
    throw new Error(code);
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
