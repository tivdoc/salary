-- One owner-support queue; support messages do not mutate findings, approvals,
-- entitlement or case/payment state. Existing correction requests keep their IDs.
create table private.case_support_threads(
 id uuid primary key,case_id uuid not null references public.cases(id) on delete cascade,
 identity_id uuid not null references public.case_identities(id),
 report_id uuid references public.case_report_projections(id) on delete cascade,finding_id uuid,
 origin text not null check(origin in ('case','finding')),state text not null default 'open' check(state in ('open','waiting_customer','resolved')),
 priority text not null default 'normal' check(priority in ('normal','urgent')),revision integer not null default 1,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 check((origin='finding')=(report_id is not null and finding_id is not null)),check((report_id is null)=(finding_id is null))
);
create table private.case_support_messages(
 id uuid primary key,sequence bigint generated always as identity unique,thread_id uuid not null references private.case_support_threads(id) on delete cascade,
 author_kind text not null check(author_kind in ('customer','owner')),actor text not null,
 message text not null check(length(message) between 4 and 2000),result_state text,result_priority text,
 created_at timestamptz not null default now()
);
create index case_support_queue on private.case_support_threads(state,priority,created_at);
revoke all on private.case_support_threads,private.case_support_messages from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create function public.case_request_support_open(target_id uuid,target_case uuid,target_identity uuid,target_message text) returns uuid
language plpgsql security definer set search_path='' as $$
declare prior private.case_support_threads;
begin
 perform 1 from public.cases where id=target_case for update;
 if not exists(select 1 from public.case_identity_cases where case_id=target_case and identity_id=target_identity) then raise exception 'SUPPORT_FORBIDDEN';end if;
 select * into prior from private.case_support_threads where id=target_id;
 if found then
  if prior.case_id<>target_case or prior.identity_id<>target_identity or prior.origin<>'case' or not exists(select 1 from private.case_support_messages where id=target_id and thread_id=target_id and message=trim(target_message) and author_kind='customer') then raise exception 'SUPPORT_RETRY_CONFLICT';end if;
  return target_id;
 end if;
 if (select count(*) from private.case_support_threads where identity_id=target_identity and created_at>now()-interval '1 hour')>=20 then raise exception 'SUPPORT_RATE_LIMIT';end if;
 insert into private.case_support_threads(id,case_id,identity_id,origin) values(target_id,target_case,target_identity,'case');
 insert into private.case_support_messages(id,thread_id,author_kind,actor,message) values(target_id,target_id,'customer',target_identity::text,trim(target_message));
 return target_id;
end;$$;
create function private.case_correction_support_thread() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_table_schema<>'private' or tg_table_name<>'case_report_corrections' or tg_op<>'INSERT' then raise exception 'SUPPORT_TRIGGER_INVALID';end if;
 insert into private.case_support_threads(id,case_id,identity_id,report_id,finding_id,origin,created_at,updated_at) values(new.id,new.case_id,new.identity_id,new.report_id,new.finding_id,'finding',new.created_at,new.created_at);
 insert into private.case_support_messages(id,thread_id,author_kind,actor,message,created_at) values(new.id,new.id,'customer',new.identity_id::text,new.message,new.created_at);
 return null;
end;$$;
revoke all on function private.case_correction_support_thread() from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create trigger case_correction_support_thread after insert on private.case_report_corrections for each row execute function private.case_correction_support_thread();
insert into private.case_support_threads(id,case_id,identity_id,report_id,finding_id,origin,created_at,updated_at)
 select id,case_id,identity_id,report_id,finding_id,'finding',created_at,created_at from private.case_report_corrections;
insert into private.case_support_messages(id,thread_id,author_kind,actor,message,created_at)
 select id,id,'customer',identity_id::text,message,created_at from private.case_report_corrections;
create function public.case_request_support_list(target_case uuid,target_identity uuid) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.case_identity_cases where case_id=target_case and identity_id=target_identity) then raise exception 'SUPPORT_FORBIDDEN';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'origin',t.origin,'report_id',t.report_id,'finding_id',t.finding_id,'state',t.state,'created_at',t.created_at,'revision',t.revision,'messages',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'author_kind',m.author_kind,'message',m.message,'created_at',m.created_at) order by m.sequence) from private.case_support_messages m where m.thread_id=t.id),'[]'::jsonb)) order by t.created_at desc) from private.case_support_threads t where t.case_id=target_case and t.identity_id=target_identity),'[]'::jsonb);
end;$$;
create function public.case_request_support_reply(target_id uuid,target_thread uuid,target_case uuid,target_identity uuid,target_message text) returns uuid language plpgsql security definer set search_path='' as $$
declare t private.case_support_threads;m private.case_support_messages;
begin
 if not exists(select 1 from public.case_identity_cases where case_id=target_case and identity_id=target_identity) then raise exception 'SUPPORT_FORBIDDEN';end if;
 select * into t from private.case_support_threads where id=target_thread and case_id=target_case and identity_id=target_identity for update;
 if not found then raise exception 'SUPPORT_FORBIDDEN';end if;
 select * into m from private.case_support_messages where id=target_id;
 if found then
  if m.thread_id<>target_thread or m.actor<>target_identity::text or m.author_kind<>'customer' or m.message<>trim(target_message) then raise exception 'SUPPORT_RETRY_CONFLICT';end if;return target_id;
 end if;
 if (select count(*) from private.case_support_messages where thread_id=target_thread and created_at>now()-interval '1 hour')>=40 then raise exception 'SUPPORT_RATE_LIMIT';end if;
 insert into private.case_support_messages(id,thread_id,author_kind,actor,message) values(target_id,target_thread,'customer',target_identity::text,trim(target_message));
 update private.case_support_threads set state='open',revision=revision+1,updated_at=now() where id=target_thread;
 return target_id;
end;$$;
create function public.case_request_support_queue() returns jsonb language sql security definer set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(t)||jsonb_build_object('public_id',c.public_id,'messages',coalesce((select jsonb_agg(to_jsonb(m) order by m.sequence) from private.case_support_messages m where m.thread_id=t.id),'[]'::jsonb)) order by (t.priority='urgent') desc,t.created_at),'[]'::jsonb)
 from (select * from private.case_support_threads where state<>'resolved' order by (priority='urgent') desc,created_at limit 100) t join public.cases c on c.id=t.case_id;
$$;
create function public.case_request_support_owner_reply(target_id uuid,target_thread uuid,target_revision integer,target_actor text,target_message text,target_state text,target_priority text) returns uuid language plpgsql security definer set search_path='' as $$
declare t private.case_support_threads;m private.case_support_messages;
begin
 if target_actor is null or length(target_actor)<3 or target_state not in ('waiting_customer','resolved') or target_priority not in ('normal','urgent') then raise exception 'SUPPORT_REPLY_INVALID';end if;
 select * into t from private.case_support_threads where id=target_thread for update;if not found then raise exception 'SUPPORT_FORBIDDEN';end if;
 select * into m from private.case_support_messages where id=target_id;
 if found then
  if m.thread_id<>target_thread or m.actor<>target_actor or m.author_kind<>'owner' or m.message<>trim(target_message) or m.result_state<>target_state or m.result_priority<>target_priority then raise exception 'SUPPORT_RETRY_CONFLICT';end if;return target_id;
 end if;
 if t.revision is distinct from target_revision then raise exception 'SUPPORT_REVISION_CONFLICT';end if;
 insert into private.case_support_messages(id,thread_id,author_kind,actor,message,result_state,result_priority) values(target_id,target_thread,'owner',target_actor,trim(target_message),target_state,target_priority);
 update private.case_support_threads set state=target_state,priority=target_priority,revision=revision+1,updated_at=now() where id=target_thread;
 return target_id;
end;$$;
revoke all on function public.case_request_support_open(uuid,uuid,uuid,text),public.case_request_support_list(uuid,uuid),public.case_request_support_reply(uuid,uuid,uuid,uuid,text),public.case_request_support_queue(),public.case_request_support_owner_reply(uuid,uuid,integer,text,text,text,text) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function public.case_request_support_open(uuid,uuid,uuid,text),public.case_request_support_list(uuid,uuid),public.case_request_support_reply(uuid,uuid,uuid,uuid,text) to service_role,tivdoc_web_runtime;
grant execute on function public.case_request_support_queue(),public.case_request_support_owner_reply(uuid,uuid,integer,text,text,text,text) to tivdoc_operations_runtime;
