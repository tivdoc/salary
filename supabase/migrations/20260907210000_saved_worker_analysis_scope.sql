-- Saved product analysis uses a provisioned machine session whose verified
-- tenant is exactly saved-case:<product case UUID>. No session is minted here.
-- Existing canonical RLS still checks the authoritative, unexpired SID/JTI.
grant select on public.documents to tivdoc_worker_runtime;
create policy saved_worker_product_document_read on public.documents
 for select to tivdoc_worker_runtime using (
  tenant_id is null and canonical_case_id is null and canonical_document_id is null
  and storage_layout='legacy_slot'
  and private.runtime_verified_tenant()='saved-case:' || case_id::text
 );

-- The current mapping helper is SECURITY INVOKER; the worker needs only
-- SELECT/INSERT under the existing authoritative verified-tenant FORCE RLS.
grant select,insert on public.engine_case_identity to tivdoc_worker_runtime;
grant select,insert on public.engine_case_lifecycle_revisions to tivdoc_worker_runtime;
grant select on public.analysis_findings to tivdoc_worker_runtime;
grant select,insert on public.analysis_runs to tivdoc_worker_runtime;
grant update(status,completed_at,completion_payload) on public.analysis_runs to tivdoc_worker_runtime;
-- No UPDATE to document bytes/ownership, no human reviewer role, publication,
-- payment confirmation or customer access is introduced by these grants.
