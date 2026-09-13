-- One completion email per fully committed analysis round.
-- Existing outbox remains the sole provider queue. No historical mail is resent.
create table private.managed_dev_completion_rounds (
 round_id text primary key check(round_id~'^[a-f0-9]{64}$'),
 case_id uuid not null references public.cases(id) on delete cascade,
 job_id text not null unique,analysis_run_id uuid not null,input_revision bigint not null,
 input_sha256 text not null check(input_sha256~'^[a-f0-9]{64}$'),
 terminal_sha256 text not null check(terminal_sha256~'^[a-f0-9]{64}$'),
 request_ids uuid[] not null check(cardinality(request_ids) between 1 and 40),
 questions jsonb not null check(jsonb_typeof(questions)='array'),
 request_set_sha256 text not null check(request_set_sha256~'^[a-f0-9]{64}$'),
 delivery_id text references private.case_notification_outbox(delivery_id),
 dispatch_started_at timestamptz,created_at timestamptz not null default clock_timestamp(),
 check(dispatch_started_at is null or delivery_id is not null)
);
alter table private.managed_dev_completion_rounds enable row level security;
revoke all on private.managed_dev_completion_rounds from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create index managed_completion_case_history on private.managed_dev_completion_rounds(case_id,created_at);

create function private.managed_completion_scope(target_digest text,target_case uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select current_database()='tivdoc_release_replay_20260907' and exists(
  select 1 from private.managed_dev_worker_cases m
  join private.managed_dev_worker_capabilities cap on cap.capability_sha256=m.capability_sha256
  join public.cases c on c.id=m.case_id and c.is_qa and c.check_period_month='2026-06-01'
  join public.case_identity_cases ic on ic.case_id=c.id and ic.identity_id=m.identity_id
  join public.case_identities i on i.id=ic.identity_id and i.channel='email'
  join public.product_identity_sessions s on s.sid=m.session_sid and s.tenant_id='saved-case:'||c.id::text
  where m.case_id=target_case and m.capability_sha256=target_digest and m.enabled
   and cap.enabled and cap.expires_at>statement_timestamp() and i.contact_hash=any(cap.notification_recipients)
   and c.contact_verified_at is not null and s.revoked_at is null and s.valid_after<=statement_timestamp()
   and s.expires_at>statement_timestamp() and s.reviewer_org_id is null
 );
$$;

create function private.managed_completion_ready(target_case uuid)
returns table(round_id text,job_id text,analysis_run_id uuid,input_revision bigint,input_sha256 text,terminal_sha256 text,
 request_ids uuid[],request_set_sha256 text,questions jsonb)
language sql stable security definer set search_path='' as $$
 with ready as (
  select j.job_id,h.revision,h.input_sha256,j.terminal_effect_sha256,e.payload,
   ar.canonical_analysis_run_id
  from public.cases c join private.case_input_heads h on h.case_id=c.id
  join private.case_analysis_dispatch d on d.case_id=h.case_id and d.revision=h.revision and d.mode='draft'
  join public.engine_durable_jobs j on j.job_id=d.job_id and j.canonical_case_id=c.id::text and j.tenant_id='saved-case:'||c.id::text
  join public.engine_outbox_events e on e.outbox_id='saved-draft:'||j.job_id and e.logical_effect_id=j.job_id
   and e.tenant_id=j.tenant_id and e.canonical_case_id=j.canonical_case_id
   and e.effect_kind='saved_analysis_draft_ready_v1' and e.payload_sha256=j.terminal_effect_sha256
  join public.analysis_runs ar on ar.canonical_analysis_run_id=e.payload#>>'{months,0,analysis_run_id}'
   and ar.tenant_id=j.tenant_id and ar.canonical_case_id=j.canonical_case_id and ar.status='completed'
   and ar.completion_payload#>>'{bundle,result_sha256}'=e.payload#>>'{months,0,result_sha256}'
   and ar.completion_payload#>>'{report,report_sha256}'=e.payload#>>'{months,0,report_sha256}'
   and ar.command_payload->>'document_snapshot_id'='saved-documents:2026-06:'||h.input_sha256
   and ar.command_payload#>>'{period,start_date}'='2026-06-01' and ar.command_payload#>>'{period,end_date}'='2026-06-30'
   and ar.command_payload->'requested_topics'='["minimum_wage"]'::jsonb
  where c.id=target_case and c.is_qa and c.check_period_month='2026-06-01'
   and j.state='succeeded' and not j.cancellation_requested and j.payload->>'mode'='draft'
   and e.payload->>'schema_version'='saved_analysis_draft_ready_v1' and e.payload->>'publication'='draft'
   and e.payload->>'job_id'=j.job_id and e.payload->'source'=j.payload
   and (j.payload->>'revision')::bigint=h.revision and j.payload->>'input_sha256'=h.input_sha256
   and j.payload->>'authority_dependency_sha256' is not distinct from d.authority_dependency_sha256
   and jsonb_array_length(e.payload->'months')=1 and e.payload#>>'{months,0,month}'='2026-06'
   and ar.canonical_analysis_run_id~'^[a-f0-9-]{36}$'
   and exists(select 1 from private.product_orders o join private.order_entitlements ent on ent.order_id=o.id
    where o.id::text=e.payload#>>'{months,0,order_id}' and o.case_id=c.id and o.offer_sha256=e.payload#>>'{months,0,offer_sha256}'
     and o.state='paid' and o.refund_state<>'refunded' and ent.state='active'
     and o.period_from='2026-06-01' and o.period_to='2026-06-01' and o.topics=array['minimum_wage']::text[]
     and (o.kind='initial' or o.kind='full' and o.offer->>'version'='tivdoc-order-offer-v2'
      and o.offer->>'service_kind'='ai_assisted' and o.offer->'human_review_required'='false'::jsonb))
   and (select count(*) from private.product_orders o join private.order_entitlements ent on ent.order_id=o.id
    where o.case_id=c.id and o.state='paid' and o.refund_state<>'refunded' and ent.state='active')=1
 ), current_questions as (
  select array_agg(q.id order by q.id) ids,
   jsonb_agg(jsonb_build_object('request_id',q.id,'question',q.question) order by q.id) body
  from public.case_requests q where q.case_id=target_case and q.answered_at is null and q.expired_at is null
   and q.expires_at>statement_timestamp() and private.managed_dev_notification_event_current(target_case,'request:'||q.id::text)
 )
 select encode(sha256(convert_to('managed-completion-v1|'||r.job_id||'|'||r.terminal_effect_sha256,'UTF8')),'hex'),
  r.job_id,r.canonical_analysis_run_id::uuid,r.revision,r.input_sha256,r.terminal_effect_sha256,q.ids,
  encode(sha256(convert_to(q.body::text,'UTF8')),'hex'),q.body
 from ready r cross join current_questions q where cardinality(q.ids) between 1 and 40;
$$;

create function private.managed_completion_has_new(target_case uuid,target_ids uuid[]) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from unnest(target_ids) id
  where not exists(select 1 from private.managed_dev_completion_rounds r
   where r.case_id=target_case and r.dispatch_started_at is not null and id=any(r.request_ids))
   and not exists(select 1 from private.managed_dev_notification_events e
    join private.case_notification_outbox o on o.delivery_id=e.delivery_id
    where e.case_id=target_case and e.event_key='request:'||id::text
     and (o.attempts>0 or o.provider_message_id is not null or o.state in ('sent','delivered'))));
$$;

create function public.case_notification_completion_pending(target_capability text)
returns table(round_id text,job_id text,analysis_run_id uuid,case_id uuid,public_id text,identity_id uuid,
 contact text,request_set_sha256 text,questions jsonb)
language plpgsql security definer set search_path='' as $$
declare digest text:=private.managed_dev_worker_capability(target_capability);
begin
 return query select r.round_id,r.job_id,r.analysis_run_id,c.id,c.public_id,m.identity_id,i.contact_normalized,r.request_set_sha256,r.questions
 from private.managed_dev_worker_cases m join public.cases c on c.id=m.case_id
 join public.case_identities i on i.id=m.identity_id
 cross join lateral private.managed_completion_ready(c.id) r
 where m.capability_sha256=digest and private.managed_completion_scope(digest,c.id)
  and private.managed_completion_has_new(c.id,r.request_ids)
  and not exists(select 1 from private.managed_dev_completion_rounds prior where prior.round_id=r.round_id and prior.dispatch_started_at is not null)
 order by c.id,r.round_id limit 10;
end;$$;

create function public.case_notification_completion_enqueue(target_capability text,target_round text,target_delivery text,target_payload jsonb,
 target_expires timestamptz,expected_case uuid,expected_identity uuid,expected_recipient text,expected_request_set_sha256 text,expected_request_ids uuid[])
returns text language plpgsql security definer set search_path='' as $$
declare digest text:=private.managed_dev_worker_capability(target_capability); ready record; prior private.managed_dev_completion_rounds;
 delivery private.case_notification_outbox; identity_row public.case_identities; sorted_ids uuid[];
begin
 if expected_case is null or expected_identity is null or expected_recipient is null or expected_recipient!~'^[a-f0-9]{64}$'
  or expected_request_set_sha256 is null or expected_request_set_sha256!~'^[a-f0-9]{64}$'
  or target_round is null or target_round!~'^[a-f0-9]{64}$' or target_delivery is null or target_delivery!~'^[a-f0-9]{64}$'
  or expected_request_ids is null or cardinality(expected_request_ids) not between 1 and 40
  or array_position(expected_request_ids,null) is not null then raise exception 'COMPLETION_NOTIFICATION_SNAPSHOT_INVALID';end if;
 select array_agg(id order by id) into sorted_ids from (select distinct unnest(expected_request_ids) id) x;
 if cardinality(sorted_ids)<>cardinality(expected_request_ids) then raise exception 'COMPLETION_NOTIFICATION_SNAPSHOT_INVALID';end if;
 perform 1 from public.cases where id=expected_case and is_qa for update;
 if not found or not private.managed_completion_scope(digest,expected_case) then return null;end if;
 select * into identity_row from public.case_identities where id=expected_identity for share;
 if not found or identity_row.contact_hash is distinct from expected_recipient
  or encode(sha256(convert_to('email|'||lower(btrim(identity_row.contact_normalized)),'UTF8')),'hex') is distinct from expected_recipient
  or not exists(select 1 from private.managed_dev_worker_cases m where m.case_id=expected_case and m.identity_id=expected_identity and m.capability_sha256=digest and m.enabled) then return null;end if;
 select * into prior from private.managed_dev_completion_rounds where round_id=target_round for update;
 if found and prior.dispatch_started_at is not null then
  if prior.case_id is distinct from expected_case or prior.request_ids is distinct from sorted_ids or prior.request_set_sha256 is distinct from expected_request_set_sha256 then return null;end if;
  if not exists(select 1 from private.case_notification_outbox o where o.delivery_id=prior.delivery_id and o.case_id=expected_case
   and o.identity_id=expected_identity and o.recipient_sha256=expected_recipient) then return null;end if;
  perform private.managed_notification_product_mirror(digest,expected_case,prior.delivery_id);return prior.delivery_id;
 end if;
 select * into ready from private.managed_completion_ready(expected_case) where round_id=target_round;
 if not found or ready.request_set_sha256 is distinct from expected_request_set_sha256 or ready.request_ids is distinct from sorted_ids
  or not private.managed_completion_has_new(expected_case,ready.request_ids) then return null;end if;
 if prior.round_id is not null and prior.case_id is distinct from expected_case then return null;end if;
 if prior.delivery_id is not null then
  select * into delivery from private.case_notification_outbox where delivery_id=prior.delivery_id for update;
  if delivery.provider_message_id is not null or delivery.state in ('sent','delivered') then return prior.delivery_id;end if;
  if prior.request_set_sha256=ready.request_set_sha256 and delivery.state in ('queued','leased') and delivery.expires_at>statement_timestamp() then
   perform private.managed_notification_product_mirror(digest,expected_case,prior.delivery_id);return prior.delivery_id;
  end if;
  update private.case_notification_outbox set state='dead_letter',encrypted_payload=null,last_error='completion_snapshot_superseded',lease_owner=null,lease_expires_at=null
   where delivery_id=prior.delivery_id and state in ('queued','leased') and provider_message_id is null;
 end if;
 -- A deterministic same-body key whose five-hour envelope expired is held;
 -- renewing the provider idempotency window needs explicit reconciliation.
 if exists(select 1 from private.case_notification_outbox where delivery_id=target_delivery) then return null;end if;
 perform public.case_notification_outbox_enqueue(target_delivery,expected_case,expected_identity,expected_recipient,'document_request',target_payload,target_expires);
 insert into private.managed_dev_completion_rounds(round_id,case_id,job_id,analysis_run_id,input_revision,input_sha256,terminal_sha256,
  request_ids,questions,request_set_sha256,delivery_id)
 values(target_round,expected_case,ready.job_id,ready.analysis_run_id,ready.input_revision,ready.input_sha256,ready.terminal_sha256,
  ready.request_ids,ready.questions,ready.request_set_sha256,target_delivery)
 on conflict(round_id) do update set request_ids=excluded.request_ids,questions=excluded.questions,request_set_sha256=excluded.request_set_sha256,delivery_id=excluded.delivery_id
  where private.managed_dev_completion_rounds.dispatch_started_at is null;
 insert into private.managed_dev_notification_events(event_key,case_id,delivery_id)
 values('completion:'||target_round||':'||target_delivery,expected_case,target_delivery);
 perform private.managed_notification_product_mirror(digest,expected_case,target_delivery);return target_delivery;
end;$$;

create function private.managed_completion_event_current(target_case uuid,target_event text) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from private.managed_dev_completion_rounds r
  cross join lateral private.managed_completion_ready(target_case) current_round
  where target_event='completion:'||r.round_id||':'||r.delivery_id and r.case_id=target_case
   and r.round_id=current_round.round_id and r.request_set_sha256=current_round.request_set_sha256
   and r.request_ids=current_round.request_ids);
$$;

create function public.case_notification_managed_dispatch(target_capability text,target_delivery text,target_worker uuid,target_fence integer)
returns table(state text) language plpgsql security definer set search_path='' as $$
declare digest text:=private.managed_dev_worker_capability(target_capability); delivery private.case_notification_outbox;
 round_row private.managed_dev_completion_rounds; target_case uuid; valid boolean;
begin
 if target_delivery is null or target_delivery!~'^[a-f0-9]{64}$' or target_worker is null or target_fence is null or target_fence<1 then raise exception 'MANAGED_NOTIFICATION_DISPATCH_INVALID';end if;
 select o.case_id into target_case from private.case_notification_outbox o where o.delivery_id=target_delivery;
 if target_case is not null then perform 1 from public.cases where id=target_case for update;end if;
 select * into round_row from private.managed_dev_completion_rounds where delivery_id=target_delivery for update;
 select * into delivery from private.case_notification_outbox where delivery_id=target_delivery for update;
 if not found or delivery.state<>'leased' or delivery.lease_owner is distinct from target_worker
  or delivery.fencing_token is distinct from target_fence or delivery.lease_expires_at<=clock_timestamp() then raise exception 'NOTIFICATION_LEASE_LOST';end if;
 valid:=delivery.expires_at>clock_timestamp() and exists(select 1 from private.managed_dev_worker_capabilities c
  join public.case_identities i on i.id=delivery.identity_id and i.channel='email' and i.contact_hash=delivery.recipient_sha256
  where c.capability_sha256=digest and c.enabled and c.expires_at>clock_timestamp() and i.contact_hash=any(c.notification_recipients))
  and not exists(select 1 from private.case_notification_suppression s where s.recipient_sha256=delivery.recipient_sha256);
 if target_case is null then
  valid:=valid and delivery.template='access_code';
 else
  valid:=valid and private.managed_completion_scope(digest,target_case)
   and exists(select 1 from private.managed_dev_worker_cases m where m.case_id=target_case and m.capability_sha256=digest and m.identity_id=delivery.identity_id)
   and not exists(select 1 from private.managed_dev_notification_events e where e.delivery_id=target_delivery
    and not private.managed_dev_notification_event_current(e.case_id,e.event_key));
 end if;
 if round_row.round_id is not null and round_row.dispatch_started_at is not null then return query select 'held'::text;return;end if;
 -- Old queued per-question managed events must not drain after the upgrade.
 if delivery.template='document_request' and round_row.round_id is null and exists(
  select 1 from private.managed_dev_notification_events e where e.delivery_id=target_delivery and e.event_key like 'request:%') then valid:=false;end if;
 if not coalesce(valid,false) then
  update private.case_notification_outbox set state='dead_letter',encrypted_payload=null,last_error='completion_or_notification_superseded',lease_owner=null,lease_expires_at=null where delivery_id=target_delivery;
  return query select 'cancelled'::text;return;
 end if;
 if round_row.round_id is not null then
  if not private.managed_completion_event_current(target_case,'completion:'||round_row.round_id||':'||target_delivery) then
   update private.case_notification_outbox set state='dead_letter',encrypted_payload=null,last_error='completion_snapshot_superseded',lease_owner=null,lease_expires_at=null where delivery_id=target_delivery;
   return query select 'cancelled'::text;return;
  end if;
  update private.managed_dev_completion_rounds set dispatch_started_at=clock_timestamp() where round_id=round_row.round_id and dispatch_started_at is null;
  if not found then return query select 'held'::text;return;end if;
 end if;
 return query select 'ready'::text;
end;$$;

revoke all on function private.managed_completion_scope(text,uuid),private.managed_completion_ready(uuid),private.managed_completion_has_new(uuid,uuid[]),private.managed_completion_event_current(uuid,text)
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
revoke all on function public.case_notification_completion_pending(text),public.case_notification_completion_enqueue(text,text,text,jsonb,timestamptz,uuid,uuid,text,text,uuid[]),public.case_notification_managed_dispatch(text,text,uuid,integer)
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_operations_runtime;
grant execute on function public.case_notification_completion_pending(text),public.case_notification_completion_enqueue(text,text,text,jsonb,timestamptz,uuid,uuid,text,text,uuid[]),public.case_notification_managed_dispatch(text,text,uuid,integer) to tivdoc_worker_runtime;

-- Preserve every previous namespace and each historical function ACL. These
-- exact anchors fail the upgrade if the reviewed definition has changed.
do $proposal$
declare definition text;needle text;
begin
 definition:=pg_get_functiondef('private.managed_dev_notification_event_current(uuid,text)'::regprocedure);
 needle:=' select case';
 if length(definition)-length(replace(definition,needle,''))<>length(needle) then raise exception 'COMPLETION_EVENT_BASE';end if;
 definition:=replace(definition,needle,needle||E'\n when target_event like ''completion:%'' then private.managed_completion_event_current(target_case,target_event)');execute definition;
 definition:=pg_get_functiondef('private.managed_notification_product_mirror(text,uuid,text)'::regprocedure);
 needle:='delivery.template=''document_request'' and n.event_key like ''request:%''';
 if length(definition)-length(replace(definition,needle,''))<>length(needle) then raise exception 'COMPLETION_MIRROR_BASE';end if;
 definition:=replace(definition,needle,'delivery.template=''document_request'' and (n.event_key like ''request:%'' or n.event_key like ''completion:%'')');execute definition;
 definition:=pg_get_functiondef('public.case_notification_managed_pending(text)'::regprocedure);
 needle:='where not exists(select 1 from private.managed_dev_notification_events n where n.event_key=x.key)';
 if length(definition)-length(replace(definition,needle,''))<>length(needle) then raise exception 'COMPLETION_PENDING_BASE';end if;
 definition:=replace(definition,needle,'where x.kind<>''request_required'' and not exists(select 1 from private.managed_dev_notification_events n where n.event_key=x.key)');execute definition;
 definition:=pg_get_functiondef('public.case_notification_managed_enqueue(text,text,text,jsonb,timestamptz,uuid,uuid,text)'::regprocedure);
 needle:=' select * into row from public.case_notification_managed_pending(target_capability) where event_key=target_event;';
 if length(definition)-length(replace(definition,needle,''))<>2*length(needle) then raise exception 'COMPLETION_LEGACY_ENQUEUE_BASE';end if;
 definition:=replace(definition,needle,' if target_event like ''request:%'' then return null;end if;'||needle);execute definition;
 definition:=pg_get_functiondef('public.case_notification_managed_claim(text,uuid)'::regprocedure);
 needle:='where o.recipient_sha256=any(recipients) and (';
 if length(definition)-length(replace(definition,needle,''))<>2*length(needle) then raise exception 'COMPLETION_MANAGED_CLAIM_BASE';end if;
 definition:=replace(definition,needle,'where o.recipient_sha256=any(recipients) and not exists(select 1 from private.managed_dev_completion_rounds cr where cr.delivery_id=o.delivery_id and cr.dispatch_started_at is not null) and (');execute definition;
 definition:=pg_get_functiondef('public.case_notification_outbox_claim(uuid)'::regprocedure);
 needle:='from private.case_notification_outbox o where (';
 if length(definition)-length(replace(definition,needle,''))<>length(needle) then raise exception 'COMPLETION_GENERIC_CLAIM_BASE';end if;
 definition:=replace(definition,needle,'from private.case_notification_outbox o where not exists(select 1 from private.managed_dev_notification_events ce where ce.delivery_id=o.delivery_id and ce.event_key like ''completion:%'') and (');execute definition;
end;$proposal$;
