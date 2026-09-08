-- Forward repair: bytes may stay identical while document-month metadata moves.
-- An older checkpoint alone must not authorize confirmation for the old month.
create or replace function private.document_field_current(target_case uuid, target jsonb) returns boolean
 language sql security definer set search_path='' as $$
 select exists(select 1 from public.documents d join public.cases pc on pc.id=d.case_id
  join private.case_extraction_checkpoints c on c.case_id=d.case_id and c.version_id=d.version_id
  cross join lateral jsonb_array_elements(c.result#>'{run,result,final_extraction,fields}') f
  where d.case_id=target_case and d.id::text=target->>'product_document_id' and d.version_id::text=target->>'version_id'
   and to_char(coalesce(d.period_month,pc.check_period_month),'YYYY-MM')=target->>'month'
   and d.content_sha256=target->>'source_sha256' and c.input_sha256=d.content_sha256
   and c.policy_version=target->>'policy_version' and c.result_sha256=target->>'extraction_result_sha256'
   and c.result->>'expected_month'=target->>'month' and c.result->>'period_mismatch'='false'
   and c.result->>'case_id'=target_case::text and c.result->>'product_document_id'=d.id::text
   and c.result->>'version_id'=d.version_id::text and c.result->>'input_sha256'=d.content_sha256
   and f=target->'candidate' and f#>>'{source,document_id}'=d.version_id::text);
$$;
revoke all on function private.document_field_current(uuid,jsonb) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
