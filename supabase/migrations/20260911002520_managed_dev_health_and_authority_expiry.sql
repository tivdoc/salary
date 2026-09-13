-- Capability-scoped metadata only, through the existing QA authorization.
create function private.managed_dev_worker_health(target_capability text)
returns table(checked_at timestamptz,last_activity_at timestamptz,capability_expires_at timestamptz,
 daily_claims bigint,total_claims bigint,daily_limit integer,total_limit integer,cases jsonb)
language plpgsql security definer set search_path='' as $$
declare digest text:=private.managed_dev_worker_capability(target_capability);
begin
 return query select statement_timestamp(),
  (select max(m.last_checked_at) from private.managed_dev_worker_cases m where m.capability_sha256=digest),
  cap.expires_at,
  (select count(*) from private.managed_dev_worker_claims x where x.capability_sha256=digest and x.claimed_at >= (date_trunc('day',statement_timestamp() at time zone 'UTC') at time zone 'UTC')),
  (select count(*) from private.managed_dev_worker_claims x where x.capability_sha256=digest),cap.daily_limit,cap.total_limit,
  coalesce((select jsonb_agg(item order by case_id) from (
   select m.case_id,jsonb_build_object('case_id',m.case_id,
    'pending_requests',(select count(*) from public.case_requests q where q.case_id=m.case_id and q.answered_at is null and q.expires_at>statement_timestamp() and private.managed_dev_notification_event_current(m.case_id,'request:'||q.id::text)),
    'authority_state',case when a.id is null then 'missing' when a.revoked_at is not null then 'revoked'
     when (a.payload#>>'{payload,expires_at}')::timestamptz<=statement_timestamp() then 'expired'
     when a.input_sha256 is distinct from h.input_sha256 then 'invalidated' else 'record_present' end,
    'authority_expires_at',a.payload#>>'{payload,expires_at}') item
   from private.managed_dev_worker_cases m join public.cases c on c.id=m.case_id and c.is_qa
   left join private.case_input_heads h on h.case_id=c.id
   left join lateral(select x.* from private.june2026_regular_assessments x where x.case_id=c.id
    and x.input_revision=h.revision order by x.created_at desc,x.id limit 1) a on true
   where m.capability_sha256=digest order by m.case_id limit 20
  ) scoped),'[]'::jsonb)
 from private.managed_dev_worker_capabilities cap where cap.capability_sha256=digest;
end;$$;
revoke all on function private.managed_dev_worker_health(text) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_operations_runtime;
grant execute on function private.managed_dev_worker_health(text) to tivdoc_worker_runtime;

-- Expiry blocks status as well as existing publication and delivery gates.
-- It does not authorize any repeat provider invocation.
do $migration$
declare body text;original text;needle text;
begin
 select pg_get_functiondef('private.managed_dev_worker_status(text)'::regprocedure) into original;
 needle:='when j.state in (''leased'',''running'')';
 if position(needle in original)=0 then raise exception 'MANAGED_HEALTH_STATUS_BASE';end if;
 body:=replace(original,needle,
  'when exists(select 1 from private.june2026_regular_assessments a where a.case_id=r.case_id and a.input_revision=h.revision and (a.payload#>>''{payload,expires_at}'')::timestamptz<=statement_timestamp()) then ''failed'' '||needle);
 needle:='when not r.enabled then ''worker_paused''';
 if position(needle in body)=0 then raise exception 'MANAGED_HEALTH_ERROR_BASE';end if;
 body:=replace(body,needle,
  'when exists(select 1 from private.june2026_regular_assessments a where a.case_id=r.case_id and a.input_revision=h.revision and (a.payload#>>''{payload,expires_at}'')::timestamptz<=statement_timestamp()) then ''authority_expired'' '||needle);
 execute body;
end;$migration$;
