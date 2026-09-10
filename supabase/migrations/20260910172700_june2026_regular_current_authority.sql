-- Do not rewrite completed bytes. Fence current presentation/delivery against
-- the exact authority already cryptographically admitted by the worker.
create function private.june2026_regular_publication_current(target_projection uuid) returns boolean
 language plpgsql security definer set search_path='' as $$
declare a private.june2026_regular_assessments; r private.june2026_authority_registries;
 result private.june2026_regular_results; stage jsonb; e jsonb; events jsonb; selected text;
 at_time timestamptz:=statement_timestamp();
begin
 select * into result from private.june2026_regular_results where projection_id=target_projection;
 if not found then return false;end if;
 select * into a from private.june2026_regular_assessments where id=result.assessment_id;
 if not found or a.revoked_at is not null or a.case_id<>result.case_id or a.input_revision<>result.input_revision
  or a.input_sha256<>result.input_sha256 then return false;end if;
 select * into r from private.june2026_authority_registries where registry_key=a.registry_key order by revision desc limit 1;
 select v.payload into stage from public.engine_analysis_stage_versions v where v.analysis_run_id=result.analysis_run_id and v.stage='review_pending';
 if r.payload_sha256 is null or stage is null or r.namespace<>result.namespace
  or r.payload_sha256 is distinct from stage#>>'{diagnostics,registry_sha256}'
  or a.payload_sha256 is distinct from stage#>>'{diagnostics,assessment_sha256}'
  or a.payload_sha256<>encode(sha256(convert_to(private.governance_jsonb_compact_text(a.payload),'UTF8')),'hex')
  or r.payload_sha256<>encode(sha256(convert_to(private.governance_jsonb_compact_text(r.payload),'UTF8')),'hex')
  or not coalesce((a.payload#>>'{payload,issued_at}')::timestamptz<=at_time and (a.payload#>>'{payload,expires_at}')::timestamptz>at_time,false)
  then return false;end if;
 if not exists(select 1 from private.case_input_heads h where h.case_id=result.case_id and h.revision=result.input_revision and h.input_sha256=result.input_sha256)
  or not exists(select 1 from private.product_orders o join private.order_entitlements t on t.order_id=o.id
   where o.id=a.order_id and o.case_id=result.case_id and o.state='paid' and o.refund_state<>'refunded' and t.state='active') then return false;end if;
 events:=r.payload#>'{trust_journal,events}';
 for e in select a.payload->'envelope' union all
  select decision->'envelope' from jsonb_array_elements(r.payload#>'{legal,artifacts}') artifact
  cross join lateral jsonb_array_elements(artifact->'events') decision where decision->'envelope'<>'null'::jsonb loop
  if not coalesce((e->>'issued_at')::timestamptz<=at_time and (e->>'expires_at')::timestamptz>at_time,false) then return false;end if;
  -- Envelope expiry was bounded by key/reviewer/policy/organization validity
  -- during cryptographic admission. Also handle future transitions already
  -- present in that same immutable journal, without a new registry revision.
  select item#>>'{candidate,organization_version}' into selected from jsonb_array_elements(events) with ordinality x(item,n)
   where item->>'kind'='organization' and item#>>'{candidate,organization_id}'=e->>'organization_id'
    and (item#>>'{candidate,valid_from}')::timestamptz<=at_time
    and ((item#>>'{candidate,expires_at}') is null or (item#>>'{candidate,expires_at}')::timestamptz>at_time) order by n desc limit 1;
  if selected is distinct from e->>'organization_version' then return false;end if;
  select item#>>'{candidate,policy_version}' into selected from jsonb_array_elements(events) with ordinality x(item,n)
   where item->>'kind'='policy' and item#>>'{candidate,organization_id}'=e->>'organization_id'
    and item#>>'{candidate,organization_version}'=e->>'organization_version'
    and (item#>>'{candidate,effective_from}')::timestamptz<=at_time
    and ((item#>>'{candidate,expires_at}') is null or (item#>>'{candidate,expires_at}')::timestamptz>at_time) order by n desc limit 1;
  if selected is distinct from e->>'policy_version' then return false;end if;
  select item#>>'{candidate,reviewer_identity_version}' into selected from jsonb_array_elements(events) with ordinality x(item,n)
   where item->>'kind'='reviewer' and item#>>'{candidate,reviewer_id}'=e->>'reviewer_id'
    and (item#>>'{candidate,valid_from}')::timestamptz<=at_time and (item#>>'{candidate,expires_at}')::timestamptz>at_time order by n desc limit 1;
  if selected is distinct from e->>'reviewer_identity_version' then return false;end if;
  if exists(select 1 from jsonb_array_elements(events) item where
   item->>'kind'='revoke' and item->>'key_id'=e->>'key_id' and (item->>'effective_at')::timestamptz<=at_time
   or item->>'kind'='key' and item#>>'{challenge,replaces_key_id}'=e->>'key_id' and (item#>>'{challenge,valid_from}')::timestamptz<=at_time) then return false;end if;
 end loop;
 return true;
end;$$;
revoke all on function private.june2026_regular_publication_current(uuid) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

-- Snapshot remains SECURITY INVOKER. Its narrow wrapper cannot probe a
-- projection in another case or return registry/assessment material.
create function private.june2026_regular_publication_owned_current(target_projection uuid,target_case uuid,target_identity uuid) returns boolean
 language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.case_identity_cases where case_id=target_case and identity_id=target_identity)
  or not exists(select 1 from public.case_report_projections where id=target_projection and case_id=target_case) then raise exception 'REGULAR_REPORT_FORBIDDEN';end if;
 return private.june2026_regular_publication_current(target_projection);
end;$$;
revoke all on function private.june2026_regular_publication_owned_current(uuid,uuid,uuid) from public,anon,authenticated,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function private.june2026_regular_publication_owned_current(uuid,uuid,uuid) to tivdoc_web_runtime,service_role;

-- Existing functions keep their ownership, role checks and source isolation.
do $migration$
declare body text; original text;
begin
 select pg_get_functiondef('public.june2026_regular_report_artifact(uuid,uuid,uuid)'::regprocedure) into original;
 body:=replace(original,'''current'',h.revision=r.input_revision and h.input_sha256=r.input_sha256,',
  '''current'',h.revision=r.input_revision and h.input_sha256=r.input_sha256,''authority_current'',private.june2026_regular_publication_current(p.id),');
 if body=original then raise exception 'REGULAR_ARTIFACT_CURRENT_ANCHOR';end if;execute body;
 select pg_get_functiondef('public.case_report_customer_snapshot(uuid,uuid)'::regprocedure) into original;
 body:=replace(original,'''state'',case when p.superseded_at is not null then ''superseded'' else q.state end',
  '''state'',case when p.report_document ? ''execution_authority'' and not private.june2026_regular_publication_owned_current(p.id,target_case,target_identity) then ''authority_unavailable'' when p.superseded_at is not null then ''superseded'' else q.state end');
 if body=original then raise exception 'REGULAR_SNAPSHOT_CURRENT_ANCHOR';end if;execute body;
 select pg_get_functiondef('public.case_notification_managed_pending(text)'::regprocedure) into original;
 body:=replace(original,'where d.delivery_id is null','where d.delivery_id is null and (not coalesce(p.report_document ? ''execution_authority'',false) or private.june2026_regular_publication_current(p.id))');
 if body=original then raise exception 'REGULAR_NOTIFICATION_PENDING_ANCHOR';end if;execute body;
 select pg_get_functiondef('private.managed_dev_notification_event_current(uuid,text)'::regprocedure) into original;
 body:=replace(original,'''report:''||p.id::text=target_event','''report:''||p.id::text=target_event and (not coalesce(p.report_document ? ''execution_authority'',false) or private.june2026_regular_publication_current(p.id))');
 if body=original then raise exception 'REGULAR_NOTIFICATION_CURRENT_ANCHOR';end if;execute body;
 select pg_get_functiondef('public.case_report_notification_pending()'::regprocedure) into original;
 body:=replace(original,'where d.delivery_id is null','where d.delivery_id is null and not exists(select 1 from public.case_report_projections p where p.id=d.report_id and p.report_document ? ''execution_authority'' and not private.june2026_regular_publication_current(p.id))');
 if body=original then raise exception 'REGULAR_DIRECT_PENDING_ANCHOR';end if;execute body;
 select pg_get_functiondef('public.case_report_notification_queue(uuid,text,uuid,text,jsonb,timestamptz)'::regprocedure) into original;
 body:=replace(original,'perform public.case_notification_outbox_enqueue',
  'if exists(select 1 from public.case_report_projections p where p.id=target_report and p.report_document ? ''execution_authority'' and not private.june2026_regular_publication_current(p.id)) then raise exception ''REGULAR_NOTIFICATION_AUTHORITY_REQUIRED'';end if; perform public.case_notification_outbox_enqueue');
 if body=original then raise exception 'REGULAR_DIRECT_QUEUE_ANCHOR';end if;execute body;
end $migration$;
