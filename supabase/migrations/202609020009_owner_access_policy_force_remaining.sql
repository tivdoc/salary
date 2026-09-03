-- Pool A-0, and the sixteen tables it was holding up.
--
-- The pool had one stated dependency: an owner-access policy, so the admin and
-- fixture paths stop depending on `tivdoc_service_tenant_scope`. The run took a
-- different route first — it measured that the migrator already reaches those
-- tables through that policy by inheriting `service_role`, provided it declares
-- `tivdoc.tenant_id` — and then corrected every owner-connection writer to
-- declare it. That left sixteen tables waiting on an execution this host cannot
-- perform: the marathon harness needs a local cluster, and Windows Application
-- Control refuses `initdb.exe` (BL-6). Sixteen tables stalled on a proof of a
-- fixture rather than on anything about the tables.
--
-- This is the dependency the pool actually named. `tivdoc_dev_migrator` owns
-- all thirty-one of these tables. On the sixteen that do not force RLS it
-- bypasses every policy by ownership; on the fifteen that do, it could turn
-- FORCE off. A policy that admits it unconditionally therefore grants nothing
-- it lacks — it converts an implicit bypass into a named, auditable policy and
-- removes the fixture dependency, so FORCE can be applied everywhere and the
-- other policies bind every non-owner principal, including any that inherits
-- privileges in future. The writer corrections stay as hygiene and as the path
-- to eventually narrowing `tivdoc_service_tenant_scope`, which is its own unit.
--
-- `product_identity_sessions` keeps its restrictive UPDATE and DELETE policies:
-- a permissive owner policy ANDs with restrictive ones, so the tenant check on
-- update and the refusal of delete both still hold for the owner.

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'analysis_findings', 'analysis_hypotheses', 'analysis_runs',
    'case_confirmations', 'case_conversations', 'case_messages',
    'document_extractions', 'documents',
    'engine_analysis_stage_versions', 'engine_calculation_trace_versions',
    'engine_canonical_fact_versions', 'engine_case_identity',
    'engine_case_lifecycle_revisions', 'engine_case_state',
    'engine_durable_jobs', 'engine_idempotency_records', 'engine_job_history',
    'engine_legal_version_pins', 'engine_logical_effect_receipts',
    'engine_object_write_sagas', 'engine_outbox_events',
    'engine_payment_evidence_refs', 'engine_platform_audit_events',
    'engine_report_versions', 'engine_review_task_versions',
    'engine_rule_input_versions', 'engine_topic_result_versions',
    'product_case_owners', 'product_identity_sessions',
    'product_privacy_request_versions', 'product_private_report_objects'
  ] loop
    execute format(
      'create policy tivdoc_owner_access on public.%I for all to tivdoc_dev_migrator using (true) with check (true)',
      table_name
    );
    execute format('alter table public.%I force row level security', table_name);
  end loop;
end;
$$;

insert into public.engine_schema_metadata (component, schema_version, migration_id)
values (
  'tenant_scoped_force_rls',
  'tivdoc-owner-access-policy-force-remaining',
  '202609020009_owner_access_policy_force_remaining'
)
on conflict (component) do update
set schema_version = excluded.schema_version,
    migration_id = excluded.migration_id;
