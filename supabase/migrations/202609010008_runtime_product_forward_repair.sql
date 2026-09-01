-- V0.10.2 forward-only repair for the least-privilege runtime product path.
-- It restores the operations resolver ACL removed by 006 and exposes only the
-- exact owner-scoped report identity columns needed by the canonical portal.

grant execute on function private.resolve_engine_case_id(text,text)
  to tivdoc_operations_runtime;

drop policy if exists tivdoc_portal_web_owned_case on public.engine_report_versions;
create policy tivdoc_portal_web_owned_case on public.engine_report_versions
  as restrictive for select to tivdoc_web_runtime
  using (private.runtime_web_owns_case(tenant_id, canonical_case_id));

drop policy if exists tivdoc_portal_web_owned_case on public.engine_review_task_versions;
create policy tivdoc_portal_web_owned_case on public.engine_review_task_versions
  as restrictive for select to tivdoc_web_runtime
  using (private.runtime_web_owns_case(tenant_id, canonical_case_id));

drop policy if exists tivdoc_portal_web_owned_case on public.product_case_owners;
create policy tivdoc_portal_web_owned_case on public.product_case_owners
  as restrictive for select to tivdoc_web_runtime
  using (private.runtime_web_owns_case(tenant_id, canonical_case_id));

grant select (
  tenant_id, canonical_case_id, case_id, analysis_run_id,
  canonical_analysis_run_id, report_id, revision,
  analysis_result_sha256, json_sha256, html_sha256, manifest_sha256,
  report_sha256, pdf_sha256, review_eligible
) on public.engine_report_versions to tivdoc_web_runtime;

grant select (
  tenant_id, case_id, canonical_case_id, task_id, revision,
  decision_sha256, report_id, report_revision, report_sha256,
  task_kind, release_state, invalidated_at, decision_payload
) on public.engine_review_task_versions to tivdoc_web_runtime;

grant select (
  tenant_id, canonical_case_id, status, revoked_at, revision, binding_sha256
) on public.product_case_owners to tivdoc_web_runtime;

grant select (status, case_revision, completion_payload)
  on public.analysis_runs to tivdoc_web_runtime;

insert into public.engine_schema_metadata (component, schema_version, migration_id)
values (
  'runtime_product_forward_repair',
  'tivdoc-runtime-product-forward-repair-v0.10.2',
  '202609010008_runtime_product_forward_repair'
)
on conflict (component) do update
set schema_version = excluded.schema_version,
    migration_id = excluded.migration_id;

comment on policy tivdoc_portal_web_owned_case on public.engine_report_versions is
  'Restricts canonical report identity reads to the active durable owner session.';
comment on policy tivdoc_portal_web_owned_case on public.engine_review_task_versions is
  'Restricts exact approval identity reads to the active durable owner session.';
comment on policy tivdoc_portal_web_owned_case on public.product_case_owners is
  'Restricts owner-binding identity reads to the actor proven by the durable session.';
