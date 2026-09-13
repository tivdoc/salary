-- Created by Supabase CLI on 2026-09-13; ordered after the existing future-dated chain.
-- Additive DEV-reviewed service boundary; no grants, credentials or sessions seeded.
-- Authentication: session_user=tivdoc_identity_runtime AND a separately
-- provisioned issuer capability bound to the actual activation plan/issuer.
-- Tenant and actor are derived inside this wrapper; the worker cannot mint one.
-- Existing product_identity_session_register/rotate/revoke remain the only
-- durable session writers used here. No changes to applied migration 204.
-- Interface: machine_manage(capability,case,identity,plan,enrollment,request_id,
--   action read|issue|rotate|revoke,expected_sid NULL,expected_rotation NULL).
-- read has no mutation. Every mutation request_id is immutable/idempotent.
-- Events and returned SID/JTI are PRIVATE credentials, never health/log output.
create table private.real_service_machine_issuer_grants(
 capability_sha256 text primary key check(capability_sha256~'^[a-f0-9]{64}$'),
 plan_sha256 text not null references private.real_service_activation_plans(payload_sha256),
 issuer_sha256 text not null references private.real_ai_service_evidence_artifacts(sha256),
 authorization_evidence_sha256 text not null references private.real_ai_service_evidence_artifacts(sha256),
 predecessor_capability_sha256 text unique references private.real_service_machine_issuer_grants(capability_sha256),
 actor_id uuid not null,maximum_session_seconds integer not null check(maximum_session_seconds between 60 and 3600),
 issued_at timestamptz not null default clock_timestamp(),expires_at timestamptz not null,
 recorded_by name not null default session_user,check(issued_at<expires_at)
);
create table private.real_service_machine_issuer_revocations(
 capability_sha256 text primary key references private.real_service_machine_issuer_grants(capability_sha256),
 effective_at timestamptz not null default clock_timestamp(),recorded_by name not null default session_user
);
create table private.real_service_machine_events(
 event_id uuid primary key,case_id uuid not null references public.cases(id),identity_id uuid not null references public.case_identities(id),
 plan_sha256 text not null references private.real_service_activation_plans(payload_sha256),
 enrollment_id uuid not null references private.real_ai_service_enrollment_events(event_id),
 capability_sha256 text not null references private.real_service_machine_issuer_grants(capability_sha256),
 issuer_sha256 text not null,sequence integer not null check(sequence>0),
 predecessor_event_id uuid unique references private.real_service_machine_events(event_id),
 request_id uuid not null,request_sha256 text not null,action text not null check(action in ('issue','rotate','revoke')),
 session_sid text not null,session_jti text not null,rotation_counter bigint not null check(rotation_counter>=0),
 session_sha256 text not null,valid_after timestamptz not null,expires_at timestamptz not null,
 actor_id uuid not null,provenance_sha256 text not null unique,recorded_at timestamptz not null default clock_timestamp(),
 unique(case_id,sequence),unique(capability_sha256,request_id),check((sequence=1)=(predecessor_event_id is null))
);
do $acl$ declare t text;begin
 foreach t in array array['real_service_machine_issuer_grants','real_service_machine_issuer_revocations','real_service_machine_events'] loop
  execute format('alter table private.%I enable row level security',t);execute format('alter table private.%I force row level security',t);
  execute format('create policy tivdoc_owner_access on private.%I for all to tivdoc_dev_migrator using(true) with check(true)',t);
  execute format('revoke all on private.%I from public,anon,authenticated,service_role,tivdoc_identity_runtime,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime',t);
  execute format('create trigger %I before update or delete on private.%I for each row execute function private.ai_release_immutable()',t||'_immutable',t);
 end loop;
end;$acl$;

create function private.real_service_machine_issuer_register(p_capability_sha text,p_plan_sha text,p_issuer_sha text,p_evidence_sha text,p_actor uuid,p_seconds integer,p_expires timestamptz,p_predecessor_capability_sha text default null) returns void
language plpgsql security invoker set search_path='' as $$
declare p private.real_service_activation_plans;old private.real_service_machine_issuer_grants;begin
 if session_user<>'tivdoc_dev_migrator' then raise exception 'REAL_SERVICE_OPERATOR_REQUIRED';end if;
 select * into p from private.real_service_activation_plans where payload_sha256=p_plan_sha;
 if p.payload_sha256 is null or p.payload->>'state'<>'active' or p.payload->>'database_name'<>current_database()
  or p.payload->>'machine_issuer_sha256' is distinct from p_issuer_sha or p.revision<>(select max(revision) from private.real_service_activation_plans where plan_id=p.plan_id)
  or p_expires is null or p_expires<=clock_timestamp() or p_expires>(p.payload->>'expires_at')::timestamptz then raise exception 'REAL_MACHINE_ISSUER_PLAN';end if;
 select * into old from private.real_service_machine_issuer_grants where capability_sha256=p_capability_sha;
 if found then
  if old.plan_sha256<>p_plan_sha or old.issuer_sha256<>p_issuer_sha or old.authorization_evidence_sha256<>p_evidence_sha
   or old.actor_id<>p_actor or old.maximum_session_seconds<>p_seconds or old.expires_at<>p_expires
   or old.predecessor_capability_sha256 is distinct from p_predecessor_capability_sha then raise exception 'REAL_MACHINE_ISSUER_RETRY';end if;return;
 end if;
 if p_predecessor_capability_sha is not null then
  perform 1 from private.real_service_machine_issuer_grants where capability_sha256=p_predecessor_capability_sha for update;
  if not found or exists(select 1 from private.real_service_machine_issuer_revocations where capability_sha256=p_predecessor_capability_sha)
   then raise exception 'REAL_MACHINE_ISSUER_SUCCESSOR_REVOKED';end if;
 end if;
 insert into private.real_service_machine_issuer_grants(capability_sha256,plan_sha256,issuer_sha256,authorization_evidence_sha256,predecessor_capability_sha256,actor_id,maximum_session_seconds,expires_at)
 values(p_capability_sha,p_plan_sha,p_issuer_sha,p_evidence_sha,p_predecessor_capability_sha,p_actor,p_seconds,p_expires);
end;$$;

-- Only an explicit administrator-recorded successor chain authorizes issuer
-- credential/build replacement. No traversal through a revoked issuer grant.
create function private.real_service_machine_issuer_successor(p_new text,p_old text) returns boolean language sql stable security invoker set search_path='' as $$
 with recursive lineage as (
  select g.capability_sha256,g.predecessor_capability_sha256,0 depth from private.real_service_machine_issuer_grants g where g.capability_sha256=p_new
  union all select g.capability_sha256,g.predecessor_capability_sha256,l.depth+1 from lineage l join private.real_service_machine_issuer_grants g on g.capability_sha256=l.predecessor_capability_sha256
   where l.depth<16 and not exists(select 1 from private.real_service_machine_issuer_revocations r where r.capability_sha256=l.capability_sha256)
 ) select exists(select 1 from lineage l where l.capability_sha256=p_old and l.depth>0
  and not exists(select 1 from private.real_service_machine_issuer_revocations r where r.capability_sha256=l.capability_sha256))
$$;
create function private.real_service_machine_issuer_revoke(p_capability_sha text) returns void language plpgsql security invoker set search_path='' as $$
begin if session_user<>'tivdoc_dev_migrator' then raise exception 'REAL_SERVICE_OPERATOR_REQUIRED';end if;
 perform 1 from private.real_service_machine_issuer_grants where capability_sha256=p_capability_sha for update;
 insert into private.real_service_machine_issuer_revocations(capability_sha256) values(p_capability_sha) on conflict do nothing;
end;$$;

-- No public wrapper: only authenticated issuer manage calls this materializer.
-- All actions preserve capability scope. Revoke remains available after expiry
-- or service/payment revocation, because it can only remove an existing session.
create function private.real_service_machine_issuer_material(p_capability text,p_case uuid,p_identity uuid,p_plan_sha text,p_enrollment uuid,p_revoke boolean default false) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare g private.real_service_machine_issuer_grants;b private.real_service_activation_enrollments;e private.real_ai_service_enrollment_events;
 p jsonb;h private.case_input_heads;at_time timestamptz;until_time timestamptz;begin
 if session_user<>'tivdoc_identity_runtime' or p_capability is null or p_capability!~'^[A-Za-z0-9._-]{32,256}$' then raise exception 'REAL_MACHINE_ISSUER_FORBIDDEN';end if;
 select * into g from private.real_service_machine_issuer_grants where capability_sha256=encode(sha256(convert_to(p_capability,'UTF8')),'hex') for share;
 if g.capability_sha256 is null or g.plan_sha256 is distinct from p_plan_sha then raise exception 'REAL_MACHINE_ISSUER_FORBIDDEN';end if;
 perform 1 from public.cases where id=p_case and is_qa is false for update;
 if not found then return jsonb_build_object('state','unavailable','reason','not_enrolled');end if;
 at_time:=clock_timestamp();select payload into p from private.real_service_activation_plans where payload_sha256=p_plan_sha;
 if p->>'database_name' is distinct from current_database() or p->>'machine_issuer_sha256' is distinct from g.issuer_sha256 then raise exception 'REAL_MACHINE_ISSUER_PLAN';end if;
 if p_revoke then
  if not exists(select 1 from private.real_service_machine_events where case_id=p_case and identity_id=p_identity and enrollment_id=p_enrollment
   and plan_sha256=p_plan_sha and capability_sha256=g.capability_sha256) then return jsonb_build_object('state','unavailable','reason','not_issued');end if;
  return jsonb_build_object('state','authorized','capability_sha256',g.capability_sha256,'issuer_sha256',g.issuer_sha256,'plan',p,'actor_id',g.actor_id,'evaluated_at',at_time);
 end if;
 if g.issued_at>at_time or g.expires_at<=at_time then return jsonb_build_object('state','unavailable','reason','expired');end if;
 if exists(select 1 from private.real_service_machine_issuer_revocations where capability_sha256=g.capability_sha256 and effective_at<=at_time)
  or not private.real_service_activation_parent_current(p_case) then return jsonb_build_object('state','unavailable','reason','revoked');end if;
 select * into b from private.real_service_activation_enrollments where case_id=p_case order by sequence desc limit 1;
 select * into e from private.real_ai_service_enrollment_events where case_id=p_case order by sequence desc limit 1;
 if b.event_id is null or e.event_id is null then return jsonb_build_object('state','unavailable','reason','not_enrolled');end if;
 if b.event_id is distinct from p_enrollment or e.event_id is distinct from p_enrollment or b.plan_sha256 is distinct from p_plan_sha
  or e.identity_id is distinct from p_identity then return jsonb_build_object('state','unavailable','reason','scope_changed');end if;
 if e.kind<>'granted' then return jsonb_build_object('state','unavailable','reason','revoked');end if;
 if e.issued_at>at_time or e.expires_at<=at_time then return jsonb_build_object('state','unavailable','reason','expired');end if;
 if not exists(select 1 from public.case_identity_cases ic join public.cases ca on ca.id=ic.case_id
  where ic.case_id=p_case and ic.identity_id=p_identity and ca.contact_verified_at is not null) then return jsonb_build_object('state','unavailable','reason','scope_changed');end if;
 select * into h from private.case_input_heads where case_id=p_case;
 if e.purchased_scope is distinct from private.real_ai_service_paid_scope(p_case,h.revision,h.input_sha256)
  then return jsonb_build_object('state','unavailable','reason','scope_changed');end if;
 select least(g.expires_at,e.expires_at,private.real_service_activation_parent_until(p_case),at_time+g.maximum_session_seconds*interval '1 second',min(r.effective_at))
  into until_time from private.real_ai_service_revocations r where r.case_id=p_case and r.target_sha256 in(g.issuer_sha256,g.authorization_evidence_sha256);
 if until_time<=at_time then return jsonb_build_object('state','unavailable','reason','revoked');end if;
 return jsonb_build_object('state','authorized','capability_sha256',g.capability_sha256,'issuer_sha256',g.issuer_sha256,'plan',p,
  'actor_id',g.actor_id,'evaluated_at',at_time,'expires_at',until_time);
end;$$;

create function private.real_service_machine_response(e private.real_service_machine_events,p jsonb,p_replayed boolean) returns jsonb language sql volatile security invoker set search_path='' as $$
 select jsonb_build_object('state',case when e.action='revoke' then 'revoked' else 'active' end,'case_id',e.case_id,'identity_id',e.identity_id,
  'plan_sha256',e.plan_sha256,'enrollment_id',e.enrollment_id,'issuer_sha256',e.issuer_sha256,'request_id',e.request_id,'provenance_sha256',e.provenance_sha256,
  'replayed',p_replayed,'evaluated_at',clock_timestamp(),'valid_after',e.valid_after,'expires_at',least(e.expires_at,private.real_service_activation_parent_until(e.case_id),
   (select g.expires_at from private.real_service_machine_issuer_grants g where g.capability_sha256=e.capability_sha256),
   (select min(r.effective_at) from private.real_ai_service_revocations r join private.real_service_machine_issuer_grants g on g.capability_sha256=e.capability_sha256
    where r.case_id=e.case_id and r.target_sha256 in(g.issuer_sha256,g.authorization_evidence_sha256,e.provenance_sha256))),
  'target_id',p->>'target_id','database_name',p->>'database_name',
  'environment',p->>'environment','deployment_sha256',p->>'deployment_sha256',
  'identity',jsonb_build_object('session_id',e.session_sid,'token_id',e.session_jti,'tenant_id','saved-case:'||e.case_id::text,
   'actor_id',e.actor_id,'reviewer_organization_id',null,'rotation_counter',e.rotation_counter))
$$;

create function private.real_service_machine_manage(p_capability text,p_case uuid,p_identity uuid,p_plan_sha text,p_enrollment uuid,p_request uuid,p_action text,p_sid text default null,p_rotation bigint default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m jsonb;prior private.real_service_machine_events;old private.real_service_machine_events;written private.real_service_machine_events;
 s public.product_identity_sessions;request_sha text;sid text;jti text;at_time timestamptz;until_time timestamptz;previous_tenant text;event uuid;provenance text;begin
 if p_action is null or p_action not in ('read','issue','rotate','revoke') or p_request is null
  or (p_action in ('read','issue') and (p_sid is not null or p_rotation is not null))
  or (p_action in ('rotate','revoke') and (p_sid is null or p_rotation is null or p_rotation<0)) then raise exception 'REAL_MACHINE_INPUT';end if;
 m:=private.real_service_machine_issuer_material(p_capability,p_case,p_identity,p_plan_sha,p_enrollment,p_action='revoke');
 if m->>'state'<>'authorized' then return m;end if;
 at_time:=clock_timestamp();until_time:=(m->>'expires_at')::timestamptz;
 request_sha:=private.real_ai_service_json_sha(jsonb_build_array(p_case,p_identity,p_plan_sha,p_enrollment,p_action,p_sid,p_rotation));
 select * into prior from private.real_service_machine_events where case_id=p_case order by sequence desc limit 1;
 select * into old from private.real_service_machine_events where capability_sha256=m->>'capability_sha256' and request_id=p_request;
 if old.event_id is not null then
  if old.request_sha256<>request_sha then raise exception 'REAL_MACHINE_REQUEST_RETRY';end if;
  if old.event_id is distinct from prior.event_id then return jsonb_build_object('state','unavailable','reason','superseded');end if;
  if old.action='revoke' then return private.real_service_machine_response(old,m->'plan',true);end if;
 end if;
 if prior.event_id is not null then
  if prior.identity_id<>p_identity then return jsonb_build_object('state','unavailable','reason','scope_changed');end if;
  if prior.plan_sha256<>p_plan_sha or prior.capability_sha256<>m->>'capability_sha256' then
   if p_action<>'issue' or not private.real_service_machine_issuer_successor(m->>'capability_sha256',prior.capability_sha256)
    then return jsonb_build_object('state','unavailable','reason','scope_changed');end if;
  end if;
 end if;
 if prior.action='revoke' then return jsonb_build_object('state','unavailable','reason','revoked');end if;
 if p_action<>'revoke' and exists(select 1 from private.real_ai_service_revocations r where r.case_id=p_case
  and r.target_sha256=prior.provenance_sha256 and r.effective_at<=at_time) then return jsonb_build_object('state','unavailable','reason','revoked');end if;
 if prior.event_id is not null then
  select * into s from public.product_identity_sessions where tenant_id='saved-case:'||p_case::text and sid=prior.session_sid for update;
  if s.sid is null or s.subject is distinct from prior.actor_id::text or s.current_jti is distinct from prior.session_jti
   or s.rotation_counter<>prior.rotation_counter or s.session_sha256<>prior.session_sha256 or s.reviewer_org_id is not null then return jsonb_build_object('state','unavailable','reason','superseded');end if;
  if s.revoked_at is not null then return jsonb_build_object('state','unavailable','reason','revoked');end if;
 end if;
 if old.event_id is not null then
  if old.expires_at<=at_time then return jsonb_build_object('state','unavailable','reason','expired');end if;
  return private.real_service_machine_response(old,m->'plan',true);
 end if;
 if p_action='read' then
  if prior.event_id is null then return jsonb_build_object('state','unavailable','reason','not_issued');end if;
  if prior.enrollment_id<>p_enrollment then return jsonb_build_object('state','unavailable','reason','scope_changed');end if;
  if prior.expires_at<=at_time then return jsonb_build_object('state','unavailable','reason','expired');end if;
  return private.real_service_machine_response(prior,m->'plan',true);
 end if;
 if p_action in ('rotate','revoke') and (prior.session_sid is distinct from p_sid or prior.rotation_counter is distinct from p_rotation or prior.enrollment_id is distinct from p_enrollment)
  then raise exception 'REAL_MACHINE_PREDECESSOR_CHANGED';end if;
 if p_action='issue' and prior.event_id is not null and prior.enrollment_id=p_enrollment and prior.expires_at>at_time and prior.capability_sha256=m->>'capability_sha256'
  then return jsonb_build_object('state','unavailable','reason','already_issued');end if;
 if p_action='rotate' and prior.expires_at<=at_time then return jsonb_build_object('state','unavailable','reason','expired');end if;
 previous_tenant:=current_setting('tivdoc.tenant_id',true);
 -- The sole tenant install here is AFTER authenticated issuer+plan+paid case
 -- derivation. Never accept tenant, actor, SID/JTI or expiry from caller JSON.
 perform set_config('tivdoc.tenant_id','saved-case:'||p_case::text,true);
 begin
  if p_action='issue' then
   if prior.event_id is not null and not private.product_session_revoke(prior.session_sid,at_time) then raise exception 'REAL_MACHINE_SUPERSEDED_SESSION_REVOKE';end if;
   sid:='real-machine:'||gen_random_uuid()::text;jti:='real-token:'||gen_random_uuid()::text;
   select * into s from private.product_identity_session_register(sid,m->>'actor_id',jti,0,at_time,until_time,null,at_time);
  elsif p_action='rotate' then
   jti:='real-token:'||gen_random_uuid()::text;
   if not private.product_session_rotate(prior.session_sid,jti,p_rotation,at_time) then raise exception 'REAL_MACHINE_ROTATION_REFUSED';end if;
   select * into s from public.product_identity_sessions where tenant_id='saved-case:'||p_case::text and sid=prior.session_sid;
  else
   if not private.product_session_revoke(prior.session_sid,at_time) then raise exception 'REAL_MACHINE_REVOCATION_REFUSED';end if;
   select * into s from public.product_identity_sessions where tenant_id='saved-case:'||p_case::text and sid=prior.session_sid;
  end if;
  perform set_config('tivdoc.tenant_id',coalesce(previous_tenant,''),true);
 exception when others then perform set_config('tivdoc.tenant_id',coalesce(previous_tenant,''),true);raise;end;
 if s.sid is null or s.tenant_id is distinct from 'saved-case:'||p_case::text or s.subject is distinct from m->>'actor_id' then raise exception 'REAL_MACHINE_SESSION_ACK';end if;
 event:=gen_random_uuid();
 provenance:=private.real_ai_service_json_sha(jsonb_build_object('schema_version','real-service-machine-provenance-v1','event_id',event,'case_id',p_case,'identity_id',p_identity,
  'plan_sha256',p_plan_sha,'enrollment_id',p_enrollment,'issuer_sha256',m->>'issuer_sha256','capability_sha256',m->>'capability_sha256','action',p_action,
  'request_id',p_request,'predecessor_event_id',prior.event_id,'session_sha256',s.session_sha256));
 insert into private.real_service_machine_events(event_id,case_id,identity_id,plan_sha256,enrollment_id,capability_sha256,issuer_sha256,sequence,predecessor_event_id,
  request_id,request_sha256,action,session_sid,session_jti,rotation_counter,session_sha256,valid_after,expires_at,actor_id,provenance_sha256)
 values(event,p_case,p_identity,p_plan_sha,p_enrollment,m->>'capability_sha256',m->>'issuer_sha256',coalesce(prior.sequence,0)+1,prior.event_id,p_request,request_sha,p_action,
  s.sid,s.current_jti,s.rotation_counter,s.session_sha256,s.valid_after,s.expires_at,(m->>'actor_id')::uuid,provenance) returning * into written;
 return private.real_service_machine_response(written,m->'plan',false);
end;$$;

-- Installed runtime identity must match actual issuer provenance. Any mutation
-- of the underlying session outside this bridge invalidates the binding.
create function private.real_service_machine_current(p_case uuid,p_plan_sha text,p_enrollment uuid) returns boolean language sql volatile security invoker set search_path='' as $$
 select coalesce((select e.action<>'revoke' and e.plan_sha256=p_plan_sha and e.enrollment_id=p_enrollment
  and e.session_sid=current_setting('tivdoc.identity_sid',true) and e.session_jti=current_setting('tivdoc.identity_jti',true)
  and s.current_jti=e.session_jti and s.rotation_counter=e.rotation_counter and s.session_sha256=e.session_sha256
  and s.subject=e.actor_id::text and s.tenant_id='saved-case:'||p_case::text and s.reviewer_org_id is null
  and s.revoked_at is null and s.valid_after<=clock_timestamp() and s.expires_at>clock_timestamp()
  and g.issuer_sha256=e.issuer_sha256 and g.plan_sha256=p_plan_sha and g.actor_id=e.actor_id and g.issued_at<=clock_timestamp() and g.expires_at>clock_timestamp()
  and not exists(select 1 from private.real_service_machine_issuer_revocations r where r.capability_sha256=g.capability_sha256 and r.effective_at<=clock_timestamp())
  and not exists(select 1 from private.real_ai_service_revocations r where r.case_id=p_case and r.target_sha256 in(g.issuer_sha256,g.authorization_evidence_sha256,e.provenance_sha256)
   and r.effective_at<=clock_timestamp())
 from private.real_service_machine_events e join private.real_service_machine_issuer_grants g on g.capability_sha256=e.capability_sha256
 join public.product_identity_sessions s on s.sid=e.session_sid and s.tenant_id='saved-case:'||p_case::text
 where e.case_id=p_case order by e.sequence desc limit 1),false)
$$;
create function private.real_service_machine_until(p_case uuid) returns timestamptz language sql stable security invoker set search_path='' as $$
 select least(e.expires_at,g.expires_at,(select min(r.effective_at) from private.real_ai_service_revocations r
  where r.case_id=p_case and r.target_sha256 in(g.issuer_sha256,g.authorization_evidence_sha256,e.provenance_sha256)))
 from private.real_service_machine_events e join private.real_service_machine_issuer_grants g on g.capability_sha256=e.capability_sha256
 where e.case_id=p_case order by e.sequence desc limit 1
$$;
-- Protect every direct REAL worker RPC too. Historical manually enrolled REAL
-- cases have no activation binding and retain their original tenant guard.
-- DEV processing does not call this function and is unchanged.
create or replace function private.real_ai_service_assert_worker(p_case uuid) returns void language plpgsql security invoker set search_path='' as $$
declare b private.real_service_activation_enrollments;begin
 if session_user<>'tivdoc_worker_runtime' or private.runtime_verified_tenant() is distinct from 'saved-case:'||p_case::text then raise exception 'REAL_SERVICE_WORKER_FORBIDDEN';end if;
 select * into b from private.real_service_activation_enrollments where case_id=p_case order by sequence desc limit 1;
 if b.event_id is not null and not private.real_service_machine_current(p_case,b.plan_sha256,b.event_id) then raise exception 'REAL_MACHINE_PROVENANCE_REQUIRED';end if;
end;$$;
do $processing$ declare body text;signature text;needle text;begin
 foreach signature in array array['private.real_ai_service_processing_context(uuid,integer,text)','private.real_ai_service_processing_enrolled(uuid,integer,text)'] loop
  body:=pg_get_functiondef(signature::regprocedure);
  needle:='if session_user<>''tivdoc_worker_runtime'' or private.runtime_verified_tenant() is distinct from ''saved-case:''||p_case::text then raise exception ''REAL_SERVICE_PROCESSING_FORBIDDEN'';end if;';
  if position(needle in body)=0 then raise exception 'REAL_MACHINE_PROCESSING_HOOK_MISSING';end if;
  execute replace(body,needle,needle||E'\n perform private.real_ai_service_assert_worker(p_case);');
 end loop;
end;$processing$;
do $hook$ declare body text;needle text;begin
 body:=pg_get_functiondef('private.real_service_activation_worker_context(uuid,text,text)'::regprocedure);
 needle:='-- SQL confirms an actual current machine SID/JTI through assert_worker.';
 if position(needle in body)=0 then raise exception 'REAL_MACHINE_WORKER_HOOK_MISSING';end if;
 body:=replace(body,needle,E'if not private.real_service_machine_current(p_case,p_plan_sha,e.event_id) then return jsonb_build_object(''state'',''unavailable'',''reason'',''revoked'');end if;\n '||needle);
 needle:='least(e.expires_at,private.real_service_activation_parent_until(p_case))';
 if position(needle in body)=0 then raise exception 'REAL_MACHINE_WORKER_EXPIRY_HOOK_MISSING';end if;
 body:=replace(body,needle,'least(e.expires_at,private.real_service_activation_parent_until(p_case),private.real_service_machine_until(p_case))');
 execute body;
end;$hook$;

-- Narrow prerequisite for the private security-definer wrapper's owner;
-- no additional runtime principal receives the underlying session writers.
grant execute on function private.product_identity_session_register(text,text,text,bigint,timestamptz,timestamptz,text,timestamptz),
 private.product_session_rotate(text,text,bigint,timestamptz),private.product_session_revoke(text,timestamptz) to tivdoc_dev_migrator;
do $acl$ declare r record;begin
 for r in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname like 'real_service_machine_%' loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role,tivdoc_identity_runtime,tivdoc_worker_runtime,tivdoc_web_runtime,tivdoc_operations_runtime',r.signature);
 end loop;
end;$acl$;
grant execute on function private.real_service_machine_manage(text,uuid,uuid,text,uuid,uuid,text,text,bigint) to tivdoc_identity_runtime;
