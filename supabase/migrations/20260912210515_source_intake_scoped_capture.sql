-- The public upload finalizer is an invoker. Keep capture_case_input private:
-- extend the existing receipt-bound capture boundary to the new receipt kind.
-- No runtime grant or direct journal-write capability is added.
create or replace function private.document_review_upload_capture(target_case uuid,target_batch uuid) returns void
language plpgsql security definer set search_path='' as $$
declare intake boolean;
begin
 if session_user not in ('tivdoc_web_runtime','service_role') then raise exception 'UPLOAD_FORBIDDEN';end if;
 select exists(select 1 from public.document_upload_batches b
  join private.legacy_source_upload_receipts r on r.batch_id=b.id and r.case_id=b.case_id
  join private.legacy_source_upload_bindings s on s.batch_id=r.batch_id and s.case_id=r.case_id and s.request_id=r.request_id
  join private.document_upload_actors a on a.batch_id=b.id and a.case_id=b.case_id
  join public.case_identity_cases i on i.case_id=b.case_id and i.identity_id=a.identity_id
  where b.id=target_batch and b.case_id=target_case and b.completed_at is not null and b.cancelled_at is null
   and b.manifest?'sourceIntake' and r.receipt->>'target_sha256'=s.scope#>>'{target,target_sha256}') into intake;
 if not intake and not exists(select 1 from public.document_upload_batches b
  join private.document_review_upload_receipts r on r.batch_id=b.id and r.case_id=b.case_id
  where b.id=target_batch and b.case_id=target_case and b.completed_at is not null and b.cancelled_at is null) then raise exception 'UPLOAD_FORBIDDEN';end if;
 perform private.capture_case_input(target_case,case when intake then 'legacy_source_upload_received' else 'document_review_upload_received' end);
end;$$;

do $scoped_capture$
declare definition text;needle text;
begin
 definition:=pg_get_functiondef('public.case_documents_commit(uuid,uuid,jsonb)'::regprocedure);
 needle:='if b.manifest?''sourceIntake'' then perform private.capture_case_input(target_case,''legacy_source_upload_received'');end if;';
 if position(needle in definition)=0 then raise exception 'SOURCE_INTAKE_CAPTURE_BASE_REQUIRED';end if;
 execute replace(definition,needle,'if b.manifest?''sourceIntake'' then perform private.document_review_upload_capture(target_case,target_batch);end if;');
end;$scoped_capture$;
