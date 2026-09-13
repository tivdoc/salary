-- Migration 202; CLI-created file sequenced after the existing future-dated chain.
-- Reusable explicit report-notice authorization; no activation, seeds or sends.
-- Existing per-report payloads and their hashes remain unchanged.
create table private.real_ai_service_notification_authorizations (
 authorization_id uuid primary key,payload_sha256 text not null unique,payload jsonb not null,
 case_id uuid not null references public.cases(id),identity_id uuid not null references public.case_identities(id),
 sequence integer not null check(sequence>0),
 predecessor_sha256 text references private.real_ai_service_notification_authorizations(payload_sha256),
 evidence_sha256 text not null references private.real_ai_service_evidence_artifacts(sha256),
 recorded_at timestamptz not null default clock_timestamp(),recorded_by name not null default session_user,
 unique(case_id,identity_id,sequence),check((sequence=1)=(predecessor_sha256 is null))
);
alter table private.real_ai_service_notification_authorizations enable row level security;
alter table private.real_ai_service_notification_authorizations force row level security;
create policy tivdoc_owner_access on private.real_ai_service_notification_authorizations for all to tivdoc_dev_migrator using(true) with check(true);
revoke all on private.real_ai_service_notification_authorizations from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create trigger real_ai_service_notification_authorizations_immutable before update or delete on private.real_ai_service_notification_authorizations
 for each row execute function private.ai_release_immutable();
-- Existing v1 payloads and their hashes remain byte-for-byte unchanged.
alter table private.real_ai_service_notification_grants add column parent_authorization_sha256 text
 references private.real_ai_service_notification_authorizations(payload_sha256);

create function private.real_ai_service_notification_authorization_record(p_authorization jsonb,p_predecessor_sha256 text) returns text
language plpgsql security invoker set search_path='' as $$
declare prior private.real_ai_service_notification_authorizations;existing private.real_ai_service_notification_authorizations;
 e private.real_ai_service_enrollment_events;a jsonb:=p_authorization;target_case uuid;target_identity uuid;at_time timestamptz:=clock_timestamp();begin
 if session_user<>'tivdoc_dev_migrator' then raise exception 'REAL_SERVICE_OPERATOR_REQUIRED';end if;
 if not coalesce(jsonb_typeof(a)='object' and a->>'schema_version'='tivdoc-real-ai-service-notification-authorization-v1'
  and a->>'namespace'='real' and a->>'purpose'='real_service_report_notifications' and a->>'scope'='current_real_reports'
  and a->>'state' in ('active','revoked') and a->>'template'='real-ai-report-ready-v1'
  and a->>'origin'~'^https://[A-Za-z0-9.-]+(:[0-9]+)?/?$'
  and a->>'recipient_sha256'~'^[a-f0-9]{64}$' and a->>'service_decision_sha256'~'^[a-f0-9]{64}$'
  and a->>'sha256'=private.real_ai_service_json_sha(a-'sha256')
  and a#>>'{authorization_source,kind}'='operator_case_grant'
  and (select count(*) from jsonb_object_keys(a))=16 and (select count(*) from jsonb_object_keys(a->'authorization_source'))=2
  and (a->>'issued_at')::timestamptz<(a->>'expires_at')::timestamptz,false)
  then raise exception 'REAL_SERVICE_NOTIFICATION_AUTHORIZATION_INVALID';end if;
 target_case:=(a->>'case_id')::uuid;target_identity:=(a->>'identity_id')::uuid;
 perform 1 from public.cases where id=target_case for update;
 if not exists(select 1 from private.real_ai_service_evidence_artifacts where sha256=a#>>'{authorization_source,evidence_sha256}')
  then raise exception 'REAL_SERVICE_NOTIFICATION_AUTHORIZATION_EVIDENCE';end if;
 select * into existing from private.real_ai_service_notification_authorizations where authorization_id=(a->>'authorization_id')::uuid;
 if found then
  if existing.payload<>a or existing.predecessor_sha256 is distinct from p_predecessor_sha256 then raise exception 'REAL_SERVICE_NOTIFICATION_AUTHORIZATION_RETRY';end if;
  return existing.payload_sha256;
 end if;
 select * into prior from private.real_ai_service_notification_authorizations where case_id=target_case and identity_id=target_identity order by sequence desc limit 1;
 if prior.payload_sha256 is distinct from p_predecessor_sha256 then raise exception 'REAL_SERVICE_NOTIFICATION_AUTHORIZATION_SUPERSEDED';end if;
 if a->>'state'='active' then
  select * into e from private.real_ai_service_enrollment_events where case_id=target_case order by sequence desc limit 1;
  if e.kind is distinct from 'granted' or e.identity_id is distinct from target_identity or e.service_decision_sha256 is distinct from a->>'service_decision_sha256'
   or e.database_name is distinct from current_database() or e.namespace is distinct from 'real'
   or (a->>'issued_at')::timestamptz<e.issued_at or (a->>'issued_at')::timestamptz>at_time
   or (a->>'expires_at')::timestamptz>e.expires_at or (a->>'expires_at')::timestamptz<=at_time
   then raise exception 'REAL_SERVICE_NOTIFICATION_AUTHORIZATION_WINDOW';end if;
  if not exists(select 1 from public.case_identities i join public.case_identity_cases ic on ic.identity_id=i.id join public.cases c on c.id=ic.case_id
   where c.id=target_case and c.is_qa is false and c.contact_verified_at is not null and c.reminder_opted_out_at is null and i.id=target_identity
   and i.channel='email' and i.contact_hash=a->>'recipient_sha256'
   and i.contact_hash=encode(sha256(convert_to('email|'||lower(btrim(i.contact_normalized)),'UTF8')),'hex'))
   then raise exception 'REAL_SERVICE_NOTIFICATION_AUTHORIZATION_RECIPIENT';end if;
  if exists(select 1 from private.case_notification_suppression where recipient_sha256=a->>'recipient_sha256')
   or exists(select 1 from private.real_ai_service_revocations where case_id=target_case
    and target_sha256 in (a->>'sha256',a->>'service_decision_sha256',a->>'recipient_sha256',a#>>'{authorization_source,evidence_sha256}') and effective_at<=at_time)
   then raise exception 'REAL_SERVICE_NOTIFICATION_AUTHORIZATION_REVOKED';end if;
 elsif prior.payload->>'state' is distinct from 'active' or prior.payload-'sha256'-'authorization_id'-'state'<>a-'sha256'-'authorization_id'-'state'
  then raise exception 'REAL_SERVICE_NOTIFICATION_AUTHORIZATION_REVOKE_SCOPE';end if;
 insert into private.real_ai_service_notification_authorizations(authorization_id,payload_sha256,payload,case_id,identity_id,sequence,predecessor_sha256,evidence_sha256)
 values((a->>'authorization_id')::uuid,a->>'sha256',a,target_case,target_identity,coalesce(prior.sequence,0)+1,p_predecessor_sha256,a#>>'{authorization_source,evidence_sha256}');
 return a->>'sha256';
end;$$;

-- Internal helper, never directly exposed. Delivery material separately checks
-- all enrollment, source, payment/refund/suspension and publication currentness.
create function private.real_ai_service_notification_parent_material(p_case uuid,p_identity uuid,p_decision text,p_expected text default null) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare a private.real_ai_service_notification_authorizations;i public.case_identities;c public.cases;revocations jsonb;at_time timestamptz:=clock_timestamp();begin
 select * into a from private.real_ai_service_notification_authorizations where case_id=p_case and identity_id=p_identity order by sequence desc limit 1;
 if a.authorization_id is null then return jsonb_build_object('state','not_authorized','reason','not_authorized');end if;
 if a.payload->>'state' is distinct from 'active' or (p_expected is not null and a.payload_sha256<>p_expected)
  or a.payload->>'service_decision_sha256' is distinct from p_decision then return jsonb_build_object('state','not_authorized','reason','revoked');end if;
 if (a.payload->>'issued_at')::timestamptz>at_time or (a.payload->>'expires_at')::timestamptz<=at_time then return jsonb_build_object('state','not_authorized','reason','expired');end if;
 select * into i from public.case_identities where id=p_identity;select * into c from public.cases where id=p_case;
 if i.channel is distinct from 'email' or i.contact_hash is distinct from a.payload->>'recipient_sha256'
  or i.contact_hash is distinct from encode(sha256(convert_to('email|'||lower(btrim(i.contact_normalized)),'UTF8')),'hex')
  then return jsonb_build_object('state','not_authorized','reason','contact_changed');end if;
 if c.reminder_opted_out_at is not null or exists(select 1 from private.case_notification_suppression where recipient_sha256=i.contact_hash)
  then return jsonb_build_object('state','not_authorized','reason','opted_out');end if;
 select coalesce(jsonb_agg(jsonb_build_object('target_sha256',r.target_sha256,'effective_at',r.effective_at) order by r.id),'[]'::jsonb) into revocations
 from private.real_ai_service_revocations r where r.case_id=p_case and r.target_sha256 in(a.payload_sha256,a.evidence_sha256,p_decision,i.contact_hash);
 if exists(select 1 from jsonb_array_elements(revocations) r where (r->>'effective_at')::timestamptz<=at_time)
  then return jsonb_build_object('state','not_authorized','reason','revoked');end if;
 return jsonb_build_object('state','authorized','authorization',a.payload,'revocations',revocations);
end;$$;

-- Root must replace material with the exact generated body appended below:
-- historical manual grants preserve their context v1 hash; derived grants add
-- parent currentness. All enqueue/claim/dispatch/late-event callers already use
-- this same function, so no second queue or special provider path is created.

create function private.real_ai_service_notification_prepare(p_case uuid,p_identity uuid,p_report uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d jsonb;n jsonb;p jsonb;a jsonb;g private.real_ai_service_notification_grants;body jsonb;grant_sha text;until_time timestamptz;issued timestamptz;begin
 perform private.real_ai_service_assert_worker(p_case);
 d:=private.real_ai_service_delivery_material(p_case,p_identity,p_report);
 if d->>'state' is distinct from 'configured' or d->'publication'='null'::jsonb then return jsonb_build_object('state','not_authorized','reason','not_authorized');end if;
 perform 1 from public.case_identities where id=p_identity for share;
 select * into g from private.real_ai_service_notification_grants where case_id=p_case and identity_id=p_identity and report_id=p_report order by sequence desc limit 1;
 if g.grant_id is not null then
  -- Existing history wins forever: an expired/revoked child is never renewed
  -- by a later parent, retry, callback or new source completion.
  n:=private.real_ai_service_notification_material(p_case,p_identity,p_report);
  if n->>'state'<>'authorized' then return jsonb_build_object('state','not_authorized','reason',n->>'reason');end if;
  return jsonb_build_object('state','prepared','grant_sha256',g.payload_sha256,'derived',g.parent_authorization_sha256 is not null);
 end if;
 p:=private.real_ai_service_notification_parent_material(p_case,p_identity,d#>>'{service_decision,sha256}');
 if p->>'state'<>'authorized' then return p;end if;a:=p->'authorization';
 select least((a->>'expires_at')::timestamptz,(d->>'enrollment_expires_at')::timestamptz,min((value->>'effective_at')::timestamptz))
  into until_time from jsonb_array_elements(p->'revocations');
 issued:=greatest((a->>'issued_at')::timestamptz,(d#>>'{publication,published_at}')::timestamptz);
 if until_time<=clock_timestamp() or issued>=until_time then return jsonb_build_object('state','not_authorized','reason','expired');end if;
 body:=jsonb_build_object('schema_version','tivdoc-real-ai-service-notification-grant-v1','grant_id',gen_random_uuid(),'state','active','namespace','real',
  'case_id',p_case,'identity_id',p_identity,'report_id',p_report,'service_decision_sha256',a->>'service_decision_sha256',
  'recipient_sha256',a->>'recipient_sha256','origin',a->>'origin','template','real-ai-report-ready-v1',
  'issued_at',to_char(issued at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'expires_at',to_char(until_time at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
 grant_sha:=private.real_ai_service_json_sha(body);
 insert into private.real_ai_service_notification_grants(grant_id,payload_sha256,payload,case_id,identity_id,report_id,sequence,predecessor_sha256,parent_authorization_sha256)
 values((body->>'grant_id')::uuid,grant_sha,body||jsonb_build_object('sha256',grant_sha),p_case,p_identity,p_report,1,null,a->>'sha256');
 n:=private.real_ai_service_notification_material(p_case,p_identity,p_report);
 if n->>'state' is distinct from 'authorized' then raise exception 'REAL_SERVICE_NOTIFICATION_PREPARATION_CHANGED';end if;
 return jsonb_build_object('state','prepared','grant_sha256',grant_sha,'derived',true);
end;$$;

-- No existing per-report grant may shed its recorded parent on a later write.
-- Parent revocation is the supported case-wide revocation path for derived grants.
create function private.real_ai_service_notification_parent_insert_guard() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if exists(select 1 from private.real_ai_service_notification_grants g where g.case_id=new.case_id and g.identity_id=new.identity_id
  and g.report_id=new.report_id and g.parent_authorization_sha256 is not null)
  then raise exception 'REAL_SERVICE_NOTIFICATION_DERIVED_HISTORY_IMMUTABLE';end if;
 return new;
end;$$;
create trigger real_ai_service_notification_parent_insert_guard before insert on private.real_ai_service_notification_grants
 for each row execute function private.real_ai_service_notification_parent_insert_guard();

revoke all on function private.real_ai_service_notification_authorization_record(jsonb,text),
 private.real_ai_service_notification_parent_material(uuid,uuid,text,text),private.real_ai_service_notification_prepare(uuid,uuid,uuid),
 private.real_ai_service_notification_parent_insert_guard() from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function private.real_ai_service_notification_prepare(uuid,uuid,uuid) to tivdoc_worker_runtime;

create or replace function private.real_ai_service_notification_material(p_case uuid,p_identity uuid,p_report uuid,p_lock boolean default true) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare d jsonb;parent jsonb;parent_revocations jsonb;g private.real_ai_service_notification_grants;i public.case_identities;c public.cases;revocations jsonb;context_sha text;at_time timestamptz:=clock_timestamp();begin
 d:=private.real_ai_service_delivery_material(p_case,p_identity,p_report,p_lock);
 if d->>'state' is distinct from 'configured' or d->'publication'='null'::jsonb then return jsonb_build_object('state','unavailable','reason','not_authorized');end if;
 select * into g from private.real_ai_service_notification_grants where case_id=p_case and identity_id=p_identity and report_id=p_report order by sequence desc limit 1;
 if g.grant_id is null then return jsonb_build_object('state','unavailable','reason','not_authorized');end if;
 if g.parent_authorization_sha256 is not null then
  parent:=private.real_ai_service_notification_parent_material(p_case,p_identity,d#>>'{service_decision,sha256}',g.parent_authorization_sha256);
  if parent->>'state' is distinct from 'authorized' then return jsonb_build_object('state','unavailable','reason',parent->>'reason');end if;
  if g.payload->>'recipient_sha256' is distinct from parent#>>'{authorization,recipient_sha256}'
   or g.payload->>'origin' is distinct from parent#>>'{authorization,origin}'
   or (g.payload->>'expires_at')::timestamptz>(parent#>>'{authorization,expires_at}')::timestamptz
   then return jsonb_build_object('state','unavailable','reason','revoked');end if;
 end if;
 if g.payload->>'state'<>'active' then return jsonb_build_object('state','unavailable','reason','revoked');end if;
 if (g.payload->>'issued_at')::timestamptz>at_time or (g.payload->>'expires_at')::timestamptz<=at_time then return jsonb_build_object('state','unavailable','reason','expired');end if;
 if g.payload->>'service_decision_sha256' is distinct from d#>>'{service_decision,sha256}' then return jsonb_build_object('state','unavailable','reason','revoked');end if;
 if p_lock then perform 1 from public.case_identities where id=p_identity for share;end if;
 select * into i from public.case_identities where id=p_identity;select * into c from public.cases where id=p_case;
 if i.channel is distinct from 'email' or i.contact_hash is distinct from g.payload->>'recipient_sha256'
  or encode(sha256(convert_to('email|'||lower(btrim(i.contact_normalized)),'UTF8')),'hex') is distinct from i.contact_hash then return jsonb_build_object('state','unavailable','reason','contact_changed');end if;
 if c.reminder_opted_out_at is not null or exists(select 1 from private.case_notification_suppression where recipient_sha256=i.contact_hash) then return jsonb_build_object('state','unavailable','reason','opted_out');end if;
 select coalesce(jsonb_agg(jsonb_build_object('target_sha256',r.target_sha256,'effective_at',r.effective_at) order by r.id),'[]'::jsonb) into revocations
 from private.real_ai_service_revocations r where r.case_id=p_case and r.target_sha256 in (g.payload_sha256,g.payload->>'service_decision_sha256',i.contact_hash);
 if exists(select 1 from jsonb_array_elements(revocations) r where (r->>'effective_at')::timestamptz<=at_time) then return jsonb_build_object('state','unavailable','reason','revoked');end if;
 context_sha:=private.real_ai_service_json_sha(jsonb_build_object('schema_version','real-ai-service-notification-context-v1','grant_sha256',g.payload_sha256,
  'delivery_context_sha256',d->>'context_sha256','recipient_sha256',i.contact_hash,'public_id',c.public_id,'revocations',revocations));
 if g.parent_authorization_sha256 is not null then
  -- Map parent/evidence future revocations to this child for unchanged TS v1
  -- expiry clipping; raw parent targets also remain bound into the context hash.
  select coalesce(jsonb_agg(jsonb_build_object('target_sha256',g.payload_sha256,'effective_at',r->>'effective_at')),'[]'::jsonb)
   into parent_revocations from jsonb_array_elements(parent->'revocations') r;
  revocations:=revocations||parent_revocations;
  context_sha:=private.real_ai_service_json_sha(jsonb_build_object('schema_version','real-ai-service-notification-derived-context-v1',
   'base_context_sha256',context_sha,'parent_authorization_sha256',g.parent_authorization_sha256,'parent_revocations',parent->'revocations'));
 end if;
 return jsonb_build_object('state','authorized','grant',g.payload,'grant_sha256',g.payload_sha256,'context_sha256',context_sha,
  'evaluated_at',clock_timestamp(),'contact',lower(btrim(i.contact_normalized)),'public_id',c.public_id,'revocations',revocations);
end;$$;
