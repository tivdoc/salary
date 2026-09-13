-- DEV-reviewed211: physical page discovery for current paid contract
-- transcription. No OCR, page defaults, source-period edits or new receipts.
create function private.contract_transcription_physical_pages_pending(
 target_case uuid,expected_revision integer,expected_sha text,target_job text,target_worker text,target_fence bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare journal jsonb;items jsonb;paid boolean;
begin
 if session_user<>'tivdoc_worker_runtime'
  or private.runtime_verified_tenant() is distinct from 'saved-case:'||target_case::text
  or private.runtime_verified_actor()::text is distinct from target_worker
 then raise exception 'SOURCE_INTAKE_FORBIDDEN';end if;
 select v.input into journal from private.case_input_heads h join private.case_input_versions v
  on v.case_id=h.case_id and v.revision=h.revision and v.input_sha256=h.input_sha256
  where h.case_id=target_case and h.revision=expected_revision and h.input_sha256=expected_sha
   and encode(sha256(convert_to(v.input::text,'UTF8')),'hex')=expected_sha;
 if journal is null then raise exception 'REQUEST_FIELD_SOURCE_CHANGED';end if;
 if not exists(select 1 from public.engine_durable_jobs j where j.job_id=target_job
  and j.canonical_case_id=target_case::text and j.tenant_id='saved-case:'||target_case::text
  and j.payload->>'case_id'=target_case::text and j.payload->>'revision'=expected_revision::text
  and j.payload->>'input_sha256'=expected_sha and j.payload->>'processing_profile'='qualified_ai_v1'
  and j.state='running' and j.lease_owner=target_worker and j.fencing_token=target_fence
  and j.lease_expires_at>clock_timestamp() and not j.cancellation_requested)
 then raise exception 'SAVED_JOB_FENCE';end if;
 -- A physically inspected contract must serve at least one still-paid scope
 -- in this exact captured journal. The current paid-scope helper independently
 -- checks modern entitlements or historical receipt evidence and month coverage.
 select exists(
  select 1 from jsonb_array_elements(coalesce(journal->'orders','[]'::jsonb)) o
   where coalesce(o->'topics' ?| array['contract','bonuses'],false)
    and private.document_review_paid_scope_current(target_case,(o->>'id')::uuid,'saved_order',o->>'offer_sha256',o->'topics',(o->>'from')::date)
  union all
  select 1 from jsonb_array_elements(coalesce(journal->'legacy_orders','[]'::jsonb)) o
   cross join lateral jsonb_array_elements(coalesce(o->'periods','[]'::jsonb)) p
   where coalesce(o->'topics' ?| array['contract','bonuses'],false)
    and private.document_review_paid_scope_current(target_case,(o->>'id')::uuid,'legacy_paid_receipt',o->>'receipt_sha256',o->'topics',(p#>>'{period,from}')::date)
 ) into paid;
 if not paid then return '[]'::jsonb;end if;
 select coalesce(jsonb_agg(jsonb_build_object('document_id',d.id,'version_id',d.version_id,'source_sha256',d.content_sha256,
  'byte_size',d.size,'mime_type',d.mime_type,'storage_path',d.storage_path) order by d.id),'[]'::jsonb) into items
 from jsonb_array_elements(journal->'documents') pin join public.documents d
  on d.case_id=target_case and d.id::text=pin->>'id' and d.version_id::text=pin->>'version_id'
   and d.content_sha256=pin->>'sha256' and d.document_type::text=pin->>'type'
 where d.document_type::text='contract' and not exists(
  select 1 from private.document_physical_page_receipts p where p.case_id=d.case_id and p.document_id=d.id
   and p.version_id=d.version_id and p.source_sha256=d.content_sha256 and p.byte_size=d.size
   and p.mime_type=d.mime_type and p.method='physical-pages-v1');
 if jsonb_array_length(items)>24 then raise exception 'SOURCE_INTAKE_PHYSICAL_BOUND';end if;
 return items;
end;$$;
revoke all on function private.contract_transcription_physical_pages_pending(uuid,integer,text,text,text,bigint)
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;
grant execute on function private.contract_transcription_physical_pages_pending(uuid,integer,text,text,text,bigint) to tivdoc_worker_runtime;
-- Existing document_physical_pages_record has no legacy-period gate. Keep it
-- unchanged: it rechecks current document identity/hash/size/MIME and preserves
-- immutable/idempotent physical receipt equality. The TS caller independently
-- re-admits the source and exact lease after storage I/O before invoking it.
