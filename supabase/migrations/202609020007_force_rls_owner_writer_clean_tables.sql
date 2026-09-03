-- Pool A. FORCE row level security on the fourteen tenant-scoped tables whose
-- owner-connection writers already declare the tenant they write.
--
-- All thirty unforced tables are owned by `tivdoc_dev_migrator`, so the owner
-- connection bypasses their policies today; FORCE is what makes those policies
-- apply to it. Measured on DEV inside a rolled-back transaction: forcing blinds
-- the owner completely — SQLSTATE 42501 on insert, zero rows on select — and
-- declaring `tivdoc.tenant_id` restores it exactly. Nine of the thirty hold
-- rows to measure and all nine behaved identically.
--
-- The mechanism is not the one the pool assumed. `tivdoc_dev_migrator` inherits
-- `service_role` (`pg_auth_members.inherit_option` true) and RLS role matching
-- uses `has_privs_of_role`, so `tivdoc_service_tenant_scope` binds it. It does
-- not inherit the four runtime roles, so the verified-tenant policies never
-- admit it. The single deciding gate is therefore
-- `tenant_id = current_setting('tivdoc.tenant_id')`.
--
-- These fourteen are written only by runtime-role lanes under
-- `src/server/platform/persistence/postgres/**`, or by owner connections that
-- already declare the tenant inside their transaction — `dev-runtime/journey.mts`
-- and `legal-review-projection/invalidation-effect-matrix.mts`. The other
-- sixteen have an owner writer that does not, and are deliberately left
-- untouched until each writer declares it; forcing them first would break the
-- fixture rather than protect anything.

alter table public.analysis_hypotheses force row level security;
alter table public.case_conversations force row level security;
alter table public.case_messages force row level security;
alter table public.document_extractions force row level security;
alter table public.engine_analysis_stage_versions force row level security;
alter table public.engine_calculation_trace_versions force row level security;
alter table public.engine_idempotency_records force row level security;
alter table public.engine_legal_version_pins force row level security;
alter table public.engine_logical_effect_receipts force row level security;
alter table public.engine_object_write_sagas force row level security;
alter table public.engine_payment_evidence_refs force row level security;
alter table public.engine_platform_audit_events force row level security;
alter table public.engine_rule_input_versions force row level security;
alter table public.engine_topic_result_versions force row level security;

insert into public.engine_schema_metadata (component, schema_version, migration_id)
values (
  'tenant_scoped_force_rls',
  'tivdoc-force-rls-owner-writer-clean-tables',
  '202609020007_force_rls_owner_writer_clean_tables'
)
on conflict (component) do update
set schema_version = excluded.schema_version,
    migration_id = excluded.migration_id;
