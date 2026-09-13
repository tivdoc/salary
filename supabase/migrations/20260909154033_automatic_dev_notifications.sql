-- PostgreSQL repetition bounds stop at255; use an explicit length guard.
-- Preserve applied125 exactly; its first real worker smoke failed before work.
create or replace function private.managed_dev_worker_capability(target_capability text) returns text
 language plpgsql security definer set search_path='' as $$
declare digest text;
begin
 if current_database()<>'tivdoc_release_replay_20260907' or session_user<>'tivdoc_worker_runtime'
  or target_capability is null or length(target_capability) not between 32 and 256 or target_capability!~'^[A-Za-z0-9._-]+$' then raise exception 'MANAGED_DEV_CAPABILITY_FORBIDDEN';end if;
 digest:=encode(sha256(convert_to(target_capability,'UTF8')),'hex');
 if not exists(select 1 from private.managed_dev_worker_capabilities c where c.capability_sha256=digest and c.enabled and c.expires_at>clock_timestamp()) then raise exception 'MANAGED_DEV_CAPABILITY_FORBIDDEN';end if;
 return digest;
end;$$;

alter table private.managed_dev_worker_capabilities add column notification_recipients text[] not null default '{}';
alter table private.managed_dev_worker_capabilities add constraint managed_notification_recipient_limit check(cardinality(notification_recipients)<=4);
create table private.managed_dev_notification_events(event_key text primary key,case_id uuid not null references public.cases(id) on delete cascade,delivery_id text not null references private.case_notification_outbox(delivery_id),created_at timestamptz not null default clock_timestamp());
create table private.managed_dev_notification_attempts(delivery_id text not null,fence integer not null,capability_sha256 text not null references private.managed_dev_worker_capabilities(capability_sha256),attempted_at timestamptz not null default clock_timestamp(),primary key(delivery_id,fence));
alter table private.managed_dev_notification_events enable row level security;
alter table private.managed_dev_notification_attempts enable row level security;
revoke all on private.managed_dev_notification_events,private.managed_dev_notification_attempts from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

create function public.case_notification_managed_pending(target_capability text) returns table(event_key text,event_kind text,case_id uuid,public_id text,identity_id uuid,contact text,request_id uuid,report_id uuid)
 language plpgsql security definer set search_path='' as $$
declare digest text:=private.managed_dev_worker_capability(target_capability);
begin
 return query
 with eligible as (
  select m.case_id,c.public_id,m.identity_id,i.contact_normalized contact from private.managed_dev_worker_cases m
   join private.managed_dev_worker_capabilities b on b.capability_sha256=m.capability_sha256
   join public.cases c on c.id=m.case_id join public.case_identities i on i.id=m.identity_id
   join public.case_identity_cases ic on ic.case_id=c.id and ic.identity_id=i.id
  where m.enabled and c.is_qa and c.contact_verified_at is not null and m.capability_sha256=digest
   and i.channel='email' and i.contact_hash=any(b.notification_recipients)
 ), events as (
  select 'request:'||q.id::text key,'request_required' kind,e.*,q.id request_id,null::uuid report_id
  from eligible e join public.case_requests q on q.case_id=e.case_id
  where q.answered_at is null and q.expires_at>clock_timestamp() and (
   exists(select 1 from private.document_field_targets t where t.request_id=q.id and private.document_field_current(e.case_id,t.target))
   or exists(select 1 from private.dev_financial_request_targets t where t.request_id=q.id and private.dev_financial_source_current(e.case_id,t.order_id,t.version_id,t.source_sha256)))
  union all
  select 'engineering:'||f.id::text,'engineering_report_ready',e.*,null::uuid,f.id
  from eligible e join private.case_input_heads h on h.case_id=e.case_id
   join private.dev_financial_runs f on f.case_id=e.case_id and f.input_revision=h.revision and f.input_sha256=h.input_sha256
  where f.payload#>>'{calculation,state}'='calculated' and private.dev_financial_source_current(e.case_id,f.order_id,(f.payload#>>'{source,version_id}')::uuid,f.payload#>>'{source,source_sha256}')
  union all
  select 'report:'||d.report_id::text,'report_ready',e.*,null::uuid,d.report_id
  from eligible e join private.case_report_delivery d on d.case_id=e.case_id
   join public.case_report_projections p on p.id=d.report_id join public.case_report_qa qa on qa.id=d.qa_id and qa.case_id=d.case_id and qa.projection_id=d.report_id and qa.state='published' and qa.published_at is not null join private.case_input_heads h on h.case_id=e.case_id and h.revision=p.input_revision
  where d.delivery_id is null
 )
 select x.key,x.kind,x.case_id,x.public_id,x.identity_id,x.contact,x.request_id,x.report_id from events x
 where not exists(select 1 from private.managed_dev_notification_events n where n.event_key=x.key)
 order by x.key limit 10;
end;$$;

create function public.case_notification_managed_enqueue(target_capability text,target_event text,target_delivery text,target_payload jsonb,target_expires timestamptz) returns text
 language plpgsql security definer set search_path='' as $$
declare row record;prior text;
begin
 perform private.managed_dev_worker_capability(target_capability);
 select n.delivery_id into prior from private.managed_dev_notification_events n join private.managed_dev_worker_cases m on m.case_id=n.case_id where n.event_key=target_event and m.enabled and m.capability_sha256=private.managed_dev_worker_capability(target_capability);
 if found then return prior;end if;
 select * into row from public.case_notification_managed_pending(target_capability) where event_key=target_event;
 if not found then return null;end if;
 perform 1 from public.cases where id=row.case_id for update;
 -- Refresh after the case lock so an answer/replacement cannot enqueue a stale event.
 select * into row from public.case_notification_managed_pending(target_capability) where event_key=target_event;
 if not found then return null;end if;
 perform public.case_notification_outbox_enqueue(target_delivery,row.case_id,row.identity_id,
  (select contact_hash from public.case_identities where id=row.identity_id),case when row.event_kind='request_required' then 'document_request' else 'report_ready' end,target_payload,target_expires);
 insert into private.managed_dev_notification_events(event_key,case_id,delivery_id) values(target_event,row.case_id,target_delivery) on conflict(event_key) do nothing;
 if row.event_kind='report_ready' then update private.case_report_delivery set delivery_id=target_delivery where report_id=row.report_id and delivery_id is null;end if;
 return target_delivery;
end;$$;

create function public.case_notification_managed_claim(target_capability text,target_worker uuid) returns table(delivery_id text,encrypted_payload jsonb,fencing_token integer)
 language plpgsql security definer set search_path='' as $$
declare digest text:=private.managed_dev_worker_capability(target_capability);recipients text[];target text;fence integer;
begin
 if target_worker is null then raise exception 'NOTIFICATION_WORKER_INVALID';end if;
 select notification_recipients into recipients from private.managed_dev_worker_capabilities where capability_sha256=digest for update;
 if cardinality(recipients)=0 then return;end if;
 if (select count(*) from private.managed_dev_notification_attempts a where a.capability_sha256=digest)>=120
  or (select count(*) from private.managed_dev_notification_attempts a where a.capability_sha256=digest and a.attempted_at>=(date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC'))>=30 then return;end if;
 update private.case_notification_outbox o set state='dead_letter',encrypted_payload=null,lease_owner=null,lease_expires_at=null,
  last_error=case when o.expires_at<=clock_timestamp() then 'delivery_expired' else 'input_superseded' end
 where o.recipient_sha256=any(recipients) and (o.state='queued' or (o.state='leased' and o.lease_expires_at<=clock_timestamp()))
  and exists(select 1 from private.managed_dev_worker_cases m where m.case_id=o.case_id and m.capability_sha256=digest and m.enabled)
  and (o.expires_at<=clock_timestamp() or exists(select 1 from private.managed_dev_notification_events e where e.delivery_id=o.delivery_id and not private.managed_dev_notification_event_current(e.case_id,e.event_key)));
 select o.delivery_id into target from private.case_notification_outbox o
 where o.recipient_sha256=any(recipients) and (o.state='queued' or (o.state='leased' and o.lease_expires_at<=clock_timestamp()))
  and o.available_at<=clock_timestamp() and o.expires_at>clock_timestamp() and o.attempts<6
  and (o.case_id is null and o.template='access_code' and exists(select 1 from public.case_identities i where i.id=o.identity_id and i.contact_hash=o.recipient_sha256)
   or exists(select 1 from private.managed_dev_worker_cases m join public.cases c on c.id=m.case_id
    join public.case_identity_cases ic on ic.case_id=c.id and ic.identity_id=m.identity_id
    join public.case_identities i on i.id=ic.identity_id and i.contact_hash=o.recipient_sha256
    where m.case_id=o.case_id and m.identity_id=o.identity_id and m.capability_sha256=digest and m.enabled and c.is_qa))
  and not exists(select 1 from private.managed_dev_notification_events e where e.delivery_id=o.delivery_id and not private.managed_dev_notification_event_current(e.case_id,e.event_key))
  and not exists(select 1 from private.case_notification_suppression s where s.recipient_sha256=o.recipient_sha256)
 order by case when o.template='access_code' then 0 else 1 end,o.created_at,o.delivery_id limit 1 for update skip locked;
 if target is null then return;end if;
 update private.case_notification_outbox o set state='leased',attempts=attempts+1,fencing_token=o.fencing_token+1,lease_owner=target_worker,lease_expires_at=clock_timestamp()+interval '1 minute' where o.delivery_id=target returning o.fencing_token into fence;
 insert into private.managed_dev_notification_attempts(delivery_id,fence,capability_sha256) values(target,fence,digest);
 return query select o.delivery_id,o.encrypted_payload,o.fencing_token from private.case_notification_outbox o where o.delivery_id=target;
end;$$;
revoke all on function public.case_notification_managed_pending(text),public.case_notification_managed_enqueue(text,text,text,jsonb,timestamptz),public.case_notification_managed_claim(text,uuid) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_operations_runtime;
grant execute on function public.case_notification_managed_pending(text),public.case_notification_managed_enqueue(text,text,text,jsonb,timestamptz),public.case_notification_managed_claim(text,uuid) to tivdoc_worker_runtime;

create function private.managed_dev_notification_event_current(target_case uuid,target_event text) returns boolean
 language sql stable security definer set search_path='' as $$
 select case
 when target_event like 'request:%' then exists(select 1 from public.case_requests q where q.case_id=target_case and 'request:'||q.id::text=target_event and q.answered_at is null and q.expires_at>statement_timestamp() and (
  exists(select 1 from private.document_field_targets t where t.request_id=q.id and private.document_field_current(target_case,t.target))
  or exists(select 1 from private.dev_financial_request_targets t where t.request_id=q.id and private.dev_financial_source_current(target_case,t.order_id,t.version_id,t.source_sha256))))
 when target_event like 'engineering:%' then exists(select 1 from private.dev_financial_runs f join private.case_input_heads h on h.case_id=f.case_id and h.revision=f.input_revision and h.input_sha256=f.input_sha256 where f.case_id=target_case and 'engineering:'||f.id::text=target_event and f.payload#>>'{calculation,state}'='calculated' and private.dev_financial_source_current(target_case,f.order_id,(f.payload#>>'{source,version_id}')::uuid,f.payload#>>'{source,source_sha256}'))
 when target_event like 'report:%' then exists(select 1 from public.case_report_projections p join private.case_report_delivery d on d.report_id=p.id and d.case_id=p.case_id join public.case_report_qa q on q.id=d.qa_id and q.projection_id=p.id and q.case_id=p.case_id join private.case_input_heads h on h.case_id=p.case_id and h.revision=p.input_revision where p.case_id=target_case and 'report:'||p.id::text=target_event and q.state='published' and q.published_at is not null)
 else false end;
$$;
revoke all on function private.managed_dev_notification_event_current(uuid,text) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
-- Bind the financial artifact's metadata to the exact saved uploaded version,
-- in addition to the source SHA and provider receipts already checked in125.
do $migration$
declare definition text;needle text;
begin
 definition:=pg_get_functiondef('private.dev_financial_save(jsonb,text,text,text)'::regprocedure);
 needle:=' if body ? ''extraction_provenance'' then';
 if position(needle in definition)=0 then raise exception 'AUTOMATIC_DEV_METADATA_PATCH_BASE';end if;
 definition:=replace(definition,needle,$guard$
 if body#>>'{source,document_id}' is distinct from source->>'document_id'
  or body#>>'{source,path}' is distinct from source->>'path' or body#>>'{source,mime}' is distinct from source->>'mime'
  or (body#>>'{source,size}')::bigint is distinct from (source->>'size')::bigint then raise exception 'DEV_FINANCIAL_SOURCE_METADATA_BINDING';end if;
 if body ? 'extraction_provenance' then$guard$);
 execute definition;
end;$migration$;
