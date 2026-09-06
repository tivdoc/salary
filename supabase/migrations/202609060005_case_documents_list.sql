-- S2.3 / S3.4: the documents on a case, for the case screen. Read-only; uploading
-- goes through the same signed-URL path the funnel uses.
create or replace function public.case_documents_list(target_case uuid)
returns table (
  id uuid, document_type text, slot text, original_filename text,
  mime_type text, size bigint, period_month date, created_at timestamptz
)
language sql security invoker set search_path = '' as $$
  select d.id, d.document_type, d.slot, d.original_filename, d.mime_type, d.size, d.period_month, d.created_at
  from public.documents d
  where d.case_id = target_case
  order by d.slot;
$$;

grant execute on function public.case_documents_list(uuid) to tivdoc_web_runtime, tivdoc_operations_runtime, tivdoc_worker_runtime;
