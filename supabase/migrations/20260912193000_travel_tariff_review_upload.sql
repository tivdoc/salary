-- A received tariff PDF is not a verified fare or a completed information request.
-- Preserve the existing v1 receipt bytes and authorization for every legacy kind.
do $migration$
declare body text;
begin
 body:=pg_get_functiondef('private.document_review_upload_validate(uuid,uuid,jsonb)'::regprocedure);
 execute replace(body,'FUNCTION private.document_review_upload_validate(', 'FUNCTION private.document_review_upload_validate_before_tariff_v1(');
end;$migration$;
revoke all on function private.document_review_upload_validate_before_tariff_v1(uuid,uuid,jsonb) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

create or replace function private.document_review_upload_validate(target_case uuid,target_request uuid,allocated jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare r public.case_requests;t private.document_review_request_targets;m text;
begin
 if session_user not in ('tivdoc_web_runtime','service_role') then raise exception 'UPLOAD_FORBIDDEN';end if;
 select * into t from private.document_review_request_targets where request_id=target_request and case_id=target_case;
 if t.target->>'document_kind' is distinct from 'other' then
  perform private.document_review_upload_validate_before_tariff_v1(target_case,target_request,allocated);return;
 end if;
 perform 1 from public.cases where id=target_case and contact_verified_at is not null for update;
 if not found then raise exception 'UPLOAD_FORBIDDEN';end if;
 select * into r from public.case_requests where id=target_request and case_id=target_case;
 if r.id is null or r.code is distinct from 'document_review:'||t.target_sha256 or r.answer_kind is distinct from 'document'
  or r.answered_at is not null or r.expired_at is not null or r.expires_at<=clock_timestamp()
  or not private.document_review_request_current(target_case,target_request) then raise exception 'UPLOAD_REQUEST_CONFLICT';end if;
 m:=left(t.target#>>'{period,from}',7);
 if t.target->>'kind' is distinct from 'document' or t.target->>'answer_kind' is distinct from 'document'
  or t.target->>'fact_key' is distinct from 'travel.tariff_source' or t.target->>'required_evidence_kind' is distinct from 'document'
  or m is null or m!~'^2026-(05|06|07)$' or left(t.target#>>'{period,to}',7) is distinct from m
  or jsonb_typeof(allocated) is distinct from 'array' then raise exception 'UPLOAD_REQUEST_CONFLICT';end if;
 if (select count(*) from jsonb_array_elements(allocated) f where f->>'documentType'='other')<>1
  or exists(select 1 from jsonb_array_elements(allocated) f where f->>'documentType'='other' and
   (f->>'type' is distinct from 'application/pdf' or f#>>'{evidencePurpose,kind}' is distinct from 'travel_tariff'
    or f#>>'{evidencePurpose,month}' is distinct from m or f ? 'periodMonth'))
  or not private.travel_tariff_paid(target_case,to_date(m,'YYYY-MM')) then raise exception 'UPLOAD_REQUEST_CONFLICT';end if;
end;$$;
revoke all on function private.document_review_upload_validate(uuid,uuid,jsonb) from public,anon,authenticated,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function private.document_review_upload_validate(uuid,uuid,jsonb) to tivdoc_web_runtime,service_role;

do $migration$
declare body text;anchor text;replacement text;
begin
 body:=pg_get_functiondef('private.document_review_request_open(uuid,integer,text,text,text,text)'::regprocedure);
 anchor:='target->>''document_kind'' in (''payslip'',''contract'',''attendance'')';
 if position(anchor in body)=0 then raise exception 'TARIFF_REQUEST_OPEN_KIND_ANCHOR';end if;
 execute replace(body,anchor,'('||anchor||' or (target->>''document_kind''=''other'' and target->>''fact_key''=''travel.tariff_source''
  and target->>''required_evidence_kind''=''document'' and left(target#>>''{period,from}'',7)~''^2026-(05|06|07)$''
  and left(target#>>''{period,from}'',7)=left(target#>>''{period,to}'',7)))');
 body:=pg_get_functiondef('private.document_review_upload_snapshot(uuid,jsonb)'::regprocedure);
 anchor:='t.target->>''document_kind'' in (''payslip'',''contract'',''attendance'')';
 if position(anchor in body)=0 then raise exception 'TARIFF_REQUEST_SNAPSHOT_KIND_ANCHOR';end if;
 execute replace(body,anchor,'('||anchor||' or (t.target->>''document_kind''=''other'' and t.target->>''fact_key''=''travel.tariff_source''
  and t.target->>''required_evidence_kind''=''document''))');
 body:=pg_get_functiondef('public.case_documents_commit(uuid,uuid,jsonb)'::regprocedure);
 anchor:='perform private.document_tariff_upload_record(target_case,target_batch,target_checks);';
 if position(anchor in body)=0 then raise exception 'TARIFF_RECEIVED_RECORD_ANCHOR';end if;
 body:=replace(body,anchor,'');
 anchor:='if private.document_review_upload_batch_scope(target_case,target_batch) is not null then';
 if position(anchor in body)=0 then raise exception 'TARIFF_RECEIVED_ORDER_ANCHOR';end if;
 execute replace(body,anchor,'perform private.document_tariff_upload_record(target_case,target_batch,target_checks);'||E'\n  '||anchor);

 body:=pg_get_functiondef('private.document_review_upload_received(uuid,uuid,jsonb)'::regprocedure);
 anchor:='digest:=encode(sha256(convert_to(private.governance_jsonb_compact_text(body),''UTF8'')),''hex'');';
 if position(anchor in body)=0 then raise exception 'TARIFF_RECEIVED_DIGEST_ANCHOR';end if;
 replacement:=$branch$
 if kind='other' then
  if binding.scope#>>'{request,target,fact_key}' is distinct from 'travel.tariff_source'
   or binding.scope#>>'{request,target,required_evidence_kind}' is distinct from 'document'
   or jsonb_array_length(files)<>1 then raise exception 'UPLOAD_REQUEST_CONFLICT';end if;
  select jsonb_agg(f.value||jsonb_build_object('tariff_source',jsonb_build_object('document',jsonb_build_object(
   'case_id',p.case_id,'document_id',p.document_id,'version_id',p.version_id,'file_sha256',p.payload->>'file_sha256',
   'page_count',p.payload->'page_count','month',p.payload->>'month','evidence_purpose','travel_tariff','document_type','other',
   'purpose_sha256',p.payload->>'purpose_sha256'),'group',p.payload->'group')) order by f.value->>'version_id')
   into files from jsonb_array_elements(files) f(value) join private.document_source_purposes p
    on p.batch_id=target_batch and p.case_id=target_case and p.document_id::text=f.value->>'document_id'
    and p.version_id::text=f.value->>'version_id' and p.payload->>'file_sha256'=f.value->>'source_sha256'
    and p.payload->>'month'=left(binding.scope#>>'{request,target,period,from}',7)
    and p.payload->>'month'=left(binding.scope#>>'{request,target,period,to}',7);
  if files is null or jsonb_array_length(files)<>1 then raise exception 'UPLOAD_UNVERIFIED';end if;
  body:=body||jsonb_build_object('schema_version','document-review-upload-receipt-v2','fact_key','travel.tariff_source','files',files);
 end if;
 $branch$;
 execute replace(body,anchor,replacement||anchor);
end;$migration$;
