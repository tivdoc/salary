-- Preserve source metadata for a provider receipt completed after replacement.
-- Retained versions have no content hash/type: both are taken exclusively from
-- the immutable source revision that authorized this invocation.
create function private.document_evidence_receipt_source(target_invocation uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare i private.case_extraction_invocations;pin jsonb;result jsonb;
begin
 if session_user<>'tivdoc_worker_runtime' then raise exception 'SAVED_WORKER_SCOPE_FORBIDDEN';end if;
 select * into i from private.case_extraction_invocations where invocation_id=target_invocation and policy_version='saved-document-evidence-v1';
 if not found or private.runtime_verified_tenant() is distinct from 'saved-case:'||i.case_id::text then raise exception 'SAVED_WORKER_SCOPE_FORBIDDEN';end if;
 select (jsonb_agg(p))->0 into pin from private.case_input_versions v cross join lateral jsonb_array_elements(v.input->'documents') p
  where v.case_id=i.case_id and v.revision=i.source_revision and p->>'version_id'=i.version_id::text
   and p->>'sha256'=i.input_sha256 and p->>'type' in ('attendance','contract') having count(*)=1;
 if pin is null then return null;end if;
 -- The logical document is not an authority for its former content; it supplies
 -- only its stable identity/creation metadata. Version-specific bytes and path
 -- come from the exact retained version, with hash/type from the dispatch pin.
 select jsonb_build_object('id',d.id,'case_id',d.case_id,'version_id',d.version_id,'document_type',pin->>'type',
  'storage_path',d.storage_path,'original_filename',d.original_filename,'mime_type',d.mime_type,'size',d.size,
  'content_sha256',pin->>'sha256','period_month',d.period_month,'created_at',d.created_at) into result
 from public.documents d where d.case_id=i.case_id and d.id::text=pin->>'id' and d.version_id=i.version_id
  and d.content_sha256=i.input_sha256 and d.document_type::text=pin->>'type';
 if result is not null then return result;end if;
 select jsonb_build_object('id',v.document_id,'case_id',v.case_id,'version_id',v.version_id,'document_type',pin->>'type',
  'storage_path',v.storage_path,'original_filename',v.original_filename,'mime_type',v.mime_type,'size',v.size,
  'content_sha256',pin->>'sha256','period_month',v.period_month,'created_at',d.created_at) into result
 from public.document_versions v join public.documents d on d.id=v.document_id and d.case_id=v.case_id
 where v.case_id=i.case_id and v.document_id::text=pin->>'id' and v.version_id=i.version_id;
 return result;
end;$$;
revoke all on function private.document_evidence_receipt_source(uuid) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function private.document_evidence_receipt_source(uuid) to tivdoc_worker_runtime;
-- This function never mutates a checkpoint or source journal. Current-source
-- and job-lease checks are deliberately retained at checkpoint finalization.

