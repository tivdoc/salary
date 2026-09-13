-- DEV profile eligibility is separate from machine identity and expenditure.
-- The existing scheduler/leases/budgets remain authoritative. This predicate
-- never changes a purchase or issues a source/calculation approval.
create function private.ai_release_managed_case_ready(target_case uuid) returns boolean
language plpgsql stable security invoker set search_path='' as $$
declare e private.ai_release_enrollment_events; configuration jsonb; paid jsonb; item jsonb; p jsonb; supported boolean:=false; n integer:=0;months date[]:=array[]::date[];
begin
 if current_database()<>'tivdoc_release_replay_20260907' or not exists(select 1 from public.cases where id=target_case and is_qa and contact_verified_at is not null) then return false;end if;
 select * into e from private.ai_release_enrollment_events where case_id=target_case order by sequence desc limit 1;
 if not found or e.kind<>'granted' or e.issued_at>statement_timestamp() or e.expires_at<=statement_timestamp() then return false;end if;
 select payload into configuration from private.ai_release_configurations where payload_sha256=e.configuration_sha256;
 if not coalesce((configuration#>>'{policy,issued_at}')::timestamptz<=statement_timestamp()
  and (configuration#>>'{registry,issued_at}')::timestamptz<=statement_timestamp()
  and (configuration#>>'{policy,expires_at}')::timestamptz>statement_timestamp()
  and (configuration#>>'{registry,expires_at}')::timestamptz>statement_timestamp(),false) then return false;end if;
 if not exists(select 1 from private.case_input_heads h join private.case_analysis_dispatch d on d.case_id=h.case_id and d.revision=h.revision and d.mode='draft'
  where h.case_id=target_case and d.processing_profile='qualified_ai_v1' and d.authority_dependency_sha256=private.ai_release_dependency(target_case)) then return false;end if;
 if (select count(*) from public.documents where case_id=target_case)>24 then return false;end if;
 for item in select jsonb_build_object('from',o.period_from,'to',o.period_to,'kind',o.kind,'offer',o.offer)
  from private.product_orders o join private.order_entitlements x on x.order_id=o.id
  where o.case_id=target_case and o.state='paid' and o.refund_state<>'refunded' and x.state='active' loop
  n:=n+1;
  if item->>'kind'='full' and not coalesce(item#>>'{offer,version}'='tivdoc-order-offer-v2'
   and item#>>'{offer,service_kind}'='ai_assisted' and item#>'{offer,human_review_required}'='false'::jsonb,false) then return false;end if;
  if (item->>'to')::date>=(item->>'from')::date+interval '12 months' then return false;end if;
  select array_agg(distinct x) into months from unnest(months||array(select g::date from generate_series((item->>'from')::date,(item->>'to')::date,interval '1 month') g)) x;
  if cardinality(months)>12 then return false;end if;
  supported:=supported or ((item->>'from')::date<='2026-07-01' and (item->>'to')::date>='2026-05-01');
 end loop;
 paid:=private.legacy_paid_scopes_internal(target_case);
 for item in select * from jsonb_array_elements(paid) loop
  n:=n+1;
  for p in select * from jsonb_array_elements(item->'periods') loop
   if (p#>>'{period,to}')::date>=(p#>>'{period,from}')::date+interval '12 months' then return false;end if;
   select array_agg(distinct x) into months from unnest(months||array(select g::date from generate_series((p#>>'{period,from}')::date,(p#>>'{period,to}')::date,interval '1 month') g)) x;
   if cardinality(months)>12 then return false;end if;
   supported:=supported or ((p#>>'{period,from}')::date<='2026-07-01' and (p#>>'{period,to}')::date>='2026-05-01');
  end loop;
 end loop;
 return n between 1 and 12 and supported;
end;$$;
revoke all on function private.ai_release_managed_case_ready(uuid) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

-- Preserve the old branch byte-for-byte inside an explicit non-AI branch.
-- A revoked AI enrollment cannot fall back to the historical June authority.
do $migration$
declare original text;body text;first_anchor text;last_anchor text;start_at integer;end_at integer;old_scope text;
begin
 select pg_get_functiondef('private.managed_dev_worker_enrollment_guard()'::regprocedure) into original;
 first_anchor:='c.check_period_month=''2026-06-01'' and c.contact_verified_at is not null';
 body:=replace(original,first_anchor,'c.contact_verified_at is not null');
 first_anchor:='and exists(select 1 from private.product_orders o';last_anchor:=') then raise exception ''MANAGED_DEV_ENROLLMENT_SCOPE''';
 start_at:=position(first_anchor in body);end_at:=position(last_anchor in body);
 if start_at=0 or end_at<=start_at or body=original then raise exception 'AI_MANAGED_ENROLL_ANCHOR';end if;
 old_scope:=substring(body from start_at+4 for end_at-start_at-4);
 body:=substring(body from 1 for start_at-1)||'and ((not exists(select 1 from private.ai_release_enrollment_events where case_id=c.id) and c.check_period_month=''2026-06-01'' and '||old_scope||')
  or (private.ai_release_managed_case_ready(c.id) and exists(select 1 from private.managed_dev_worker_capabilities cap join public.case_identities owner on owner.id=new.identity_id
   where cap.capability_sha256=new.capability_sha256 and cap.expires_at>statement_timestamp() and owner.channel=''email'' and owner.contact_hash=any(cap.notification_recipients))))'||substring(body from end_at);
 execute body;

 select pg_get_functiondef('private.managed_dev_worker_candidates(text,integer)'::regprocedure) into original;
 body:=replace(original,'and c.check_period_month=''2026-06-01''','');
 first_anchor:='and exists(select 1 from private.product_orders o';last_anchor:='and exists(select 1 from private.managed_dev_worker_capabilities b';
 start_at:=position(first_anchor in body);end_at:=position(last_anchor in body);
 if start_at=0 or end_at<=start_at or body=original then raise exception 'AI_MANAGED_CANDIDATE_ANCHOR';end if;
 old_scope:=substring(body from start_at+4 for end_at-start_at-4);
 body:=substring(body from 1 for start_at-1)||'and ((not exists(select 1 from private.ai_release_enrollment_events where case_id=r.case_id) and c.check_period_month=''2026-06-01'' and '||old_scope||')
  or (private.ai_release_managed_case_ready(r.case_id) and private.managed_ai_release_scope(digest,r.case_id))) '||substring(body from end_at);
 execute body;

 select pg_get_functiondef('private.managed_dev_worker_retry(text,uuid,text,bigint)'::regprocedure) into original;
 first_anchor:='and exists(select 1 from private.product_orders o';last_anchor:=') then raise exception ''MANAGED_DEV_RETRY_FORBIDDEN''';
 start_at:=position(first_anchor in original);end_at:=position(last_anchor in original);
 if start_at=0 or end_at<=start_at then raise exception 'AI_MANAGED_RETRY_ANCHOR';end if;
 old_scope:=substring(original from start_at+4 for end_at-start_at-4);
 body:=substring(original from 1 for start_at-1)||'and ((not exists(select 1 from private.ai_release_enrollment_events where case_id=target_case) and '||old_scope||')
  or (private.ai_release_managed_case_ready(target_case) and private.managed_ai_release_scope(digest,target_case)))'||substring(original from end_at);
 body:=replace(body,'if j.revision<>expected_revision',
  'if not exists(select 1 from private.case_analysis_dispatch d join private.case_input_heads h on h.case_id=d.case_id and h.revision=d.revision where d.case_id=target_case and d.mode=''draft'' and d.job_id=j.job_id and d.processing_profile is not distinct from j.payload->>''processing_profile'' and d.authority_dependency_sha256 is not distinct from j.payload->>''authority_dependency_sha256'') then raise exception ''MANAGED_DEV_RETRY_STALE'';end if; if j.revision<>expected_revision');
 execute body;

 select pg_get_functiondef('private.managed_dev_worker_status(text)'::regprocedure) into original;
 body:=replace(original,'case when (select count(*) from public.documents doc','case when d.processing_profile=''qualified_ai_v1'' and not private.ai_release_managed_case_ready(r.case_id) then ''failed'' when d.processing_profile is distinct from ''qualified_ai_v1'' and (select count(*) from public.documents doc');
 -- The two CASE expressions return different diagnostics for the same gate.
 body:=replace(body,'case when d.processing_profile=''qualified_ai_v1'' and not private.ai_release_managed_case_ready(r.case_id) then ''failed'' when d.processing_profile is distinct from ''qualified_ai_v1'' and (select count(*) from public.documents doc where doc.case_id=r.case_id and doc.document_type=''payslip'')>1 then ''scope_unsupported''',
  'case when d.processing_profile=''qualified_ai_v1'' and not private.ai_release_managed_case_ready(r.case_id) then ''ai_release_scope_or_authority_unavailable'' when d.processing_profile is distinct from ''qualified_ai_v1'' and (select count(*) from public.documents doc where doc.case_id=r.case_id and doc.document_type=''payslip'')>1 then ''scope_unsupported''');
 body:=replace(body,'when (select count(*) from private.product_orders o','when d.processing_profile is distinct from ''qualified_ai_v1'' and (select count(*) from private.product_orders o');
 body:=replace(body,'when exists(select 1 from private.june2026_regular_assessments a','when d.processing_profile is distinct from ''qualified_ai_v1'' and exists(select 1 from private.june2026_regular_assessments a');
 body:=replace(body,'when exists(select 1 from public.case_requests q',
  'when d.processing_profile=''qualified_ai_v1'' and exists(select 1 from public.case_requests q where q.case_id=r.case_id and q.answered_at is null and q.expired_at is null and q.expires_at>statement_timestamp() and private.managed_dev_notification_event_current(r.case_id,''request:''||q.id::text)) then ''awaiting_input'' when exists(select 1 from public.case_requests q');
 body:=replace(body,'when j.state=''succeeded'' and (f.payload', 'when j.state=''succeeded'' and ai.report_id is not null then ''complete'' when d.processing_profile is distinct from ''qualified_ai_v1'' and j.state=''succeeded'' and (f.payload');
 body:=replace(body,'when j.state=''succeeded'' and f.id is null and regular.projection_id is null','when j.state=''succeeded'' and f.id is null and regular.projection_id is null and ai.report_id is null');
 body:=replace(body,'coalesce(regular.analysis_run_id,f.id)','coalesce(ai.run_id,regular.analysis_run_id,f.id)');
 body:=replace(body,'regular on true where r.capability_sha256=digest',
  'regular on true left join lateral(select p.report_id,ar.id run_id from private.ai_release_report_publications p join public.analysis_runs ar on ar.canonical_analysis_run_id=p.analysis_run_id and ar.canonical_case_id=p.case_id::text and ar.tenant_id=''saved-case:''||p.case_id::text join public.engine_outbox_events eff on eff.outbox_id=''saved-draft:''||j.job_id and eff.logical_effect_id=j.job_id and eff.tenant_id=j.tenant_id and eff.canonical_case_id=j.canonical_case_id and eff.payload_sha256=j.terminal_effect_sha256
   where p.case_id=r.case_id and d.processing_profile=''qualified_ai_v1'' and private.ai_release_report_current(p.case_id,p.report_id)
   and eff.effect_kind=''saved_analysis_draft_ready_v1'' and eff.payload->''source''=j.payload and eff.payload->>''publication''=''draft''
   and j.payload->>''authority_dependency_sha256''=d.authority_dependency_sha256 and jsonb_array_length(eff.payload->''months'')>0
   and exists(select 1 from jsonb_array_elements(eff.payload->''months'') x where x->>''analysis_run_id''=p.analysis_run_id)
   and not exists(select 1 from jsonb_array_elements(eff.payload->''months'') x left join public.analysis_runs rr
    on rr.canonical_analysis_run_id=x->>''analysis_run_id'' and rr.canonical_case_id=j.canonical_case_id and rr.tenant_id=j.tenant_id
    where rr.id is null or rr.status<>''completed'' or rr.completion_payload#>>''{bundle,result_sha256}'' is distinct from x->>''result_sha256''
     or rr.completion_payload#>>''{report,report_sha256}'' is distinct from x->>''report_sha256''
     or not private.ai_release_report_current(r.case_id,(rr.completion_payload#>>''{report,report_id}'')::uuid)) order by p.published_at desc limit 1) ai on true where r.capability_sha256=digest');
 if body=original or position('ai on true' in body)=0 then raise exception 'AI_MANAGED_STATUS_ANCHOR';end if;execute body;

 select pg_get_functiondef('private.managed_dev_worker_health(text)'::regprocedure) into original;
 body:=replace(original,'''authority_state'',case when a.id is null',
  '''authority_state'',case when ai.event_id is not null then case when ai.kind=''revoked'' then ''revoked'' when ai.expires_at<=statement_timestamp() or least((cfg.payload#>>''{policy,expires_at}'')::timestamptz,(cfg.payload#>>''{registry,expires_at}'')::timestamptz)<=statement_timestamp() then ''expired'' when not private.ai_release_managed_case_ready(m.case_id) then ''invalidated'' else ''record_present'' end when a.id is null');
 body:=replace(body,'''authority_expires_at'',a.payload#>>''{payload,expires_at}''',
  '''authority_expires_at'',case when ai.event_id is not null then least(ai.expires_at,(cfg.payload#>>''{policy,expires_at}'')::timestamptz,(cfg.payload#>>''{registry,expires_at}'')::timestamptz)::text else a.payload#>>''{payload,expires_at}'' end');
 body:=replace(body,'a on true',
  'a on true left join lateral(select ev.* from private.ai_release_enrollment_events ev where ev.case_id=m.case_id order by ev.sequence desc limit 1) ai on true left join private.ai_release_configurations cfg on cfg.payload_sha256=ai.configuration_sha256');
 if body=original or position('ai on true' in body)=0 then raise exception 'AI_MANAGED_HEALTH_ANCHOR';end if;execute body;
end;$migration$;

-- Status uses the currently compiled application identity, like report dispatch.
-- Old callers retain legacy status; they cannot claim AI readiness without it.
alter function private.managed_dev_worker_status(text) rename to managed_dev_worker_status_before_ai_build_v1;
revoke all on function private.managed_dev_worker_status_before_ai_build_v1(text) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create function private.managed_dev_worker_status(target_capability text,expected_ai_build_sha256 text)
returns table(case_id uuid,state text,input_revision bigint,job_id text,job_revision bigint,attempt_count integer,max_attempts integer,next_attempt_at timestamptz,last_error text,current_run_id uuid,updated_at timestamptz)
language plpgsql security definer set search_path='' as $$
declare item record;configured_sha text;
begin
 for item in select * from private.managed_dev_worker_status_before_ai_build_v1(target_capability) loop
  if exists(select 1 from private.ai_release_enrollment_events e where e.case_id=item.case_id) then
   select cfg.payload->>'build_manifest_sha256' into configured_sha from private.ai_release_configurations cfg
    join lateral(select e.configuration_sha256 from private.ai_release_enrollment_events e where e.case_id=item.case_id order by e.sequence desc limit 1) e on e.configuration_sha256=cfg.payload_sha256;
   if expected_ai_build_sha256 is null or expected_ai_build_sha256!~'^[a-f0-9]{64}$' or configured_sha is distinct from expected_ai_build_sha256 then
    item.state:='failed';item.last_error:='ai_release_build_review_required';item.current_run_id:=null;
   end if;
  end if;
  return query select item.case_id,item.state,item.input_revision,item.job_id,item.job_revision,item.attempt_count,item.max_attempts,item.next_attempt_at,item.last_error,item.current_run_id,item.updated_at;
 end loop;
end;$$;
create function private.managed_dev_worker_status(target_capability text)
returns table(case_id uuid,state text,input_revision bigint,job_id text,job_revision bigint,attempt_count integer,max_attempts integer,next_attempt_at timestamptz,last_error text,current_run_id uuid,updated_at timestamptz)
language sql security definer set search_path='' as $$ select * from private.managed_dev_worker_status(target_capability,null);$$;
revoke all on function private.managed_dev_worker_status(text,text),private.managed_dev_worker_status(text) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function private.managed_dev_worker_status(text,text),private.managed_dev_worker_status(text) to tivdoc_worker_runtime;
