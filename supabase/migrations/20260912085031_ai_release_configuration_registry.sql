alter table private.case_analysis_dispatch add column processing_profile text check(processing_profile is null or processing_profile='qualified_ai_v1');
-- Versioned AI configuration is a product/source review, never a human signature.
-- DEV enrollment, machine execution and provider spending are separate grants.
create table private.ai_release_configurations(
 configuration_id uuid not null,revision integer not null check(revision>0),
 payload_sha256 text not null unique check(payload_sha256~'^[a-f0-9]{64}$'),payload jsonb not null,
 recorded_at timestamptz not null default clock_timestamp(),primary key(configuration_id,revision),
 check(coalesce(payload->>'schema_version'='tivdoc-ai-release-configuration-v1'
  and payload->>'configuration_id'=configuration_id::text and (payload->>'revision')::integer=revision
  and payload->>'sha256'=payload_sha256
  and payload_sha256=encode(sha256(convert_to(private.governance_jsonb_compact_text(payload-'sha256'),'UTF8')),'hex'),false)));
create table private.ai_release_enrollment_events(
 event_id uuid primary key,case_id uuid not null references public.cases(id),sequence integer not null check(sequence>0),
 predecessor_id uuid references private.ai_release_enrollment_events(event_id),
 configuration_sha256 text not null references private.ai_release_configurations(payload_sha256),
 kind text not null check(kind in ('granted','revoked')),idempotency_key text not null check(char_length(idempotency_key) between 8 and 200),
 issued_at timestamptz not null,expires_at timestamptz not null,reason text not null check(char_length(reason) between 10 and 1000),
 recorded_at timestamptz not null default clock_timestamp(),
 unique(case_id,sequence),unique(case_id,idempotency_key),
 check(expires_at>issued_at and expires_at<=issued_at+interval '24 hours'),check((sequence=1)=(predecessor_id is null)));
alter table private.ai_release_configurations enable row level security;
alter table private.ai_release_configurations force row level security;
alter table private.ai_release_enrollment_events enable row level security;
alter table private.ai_release_enrollment_events force row level security;
-- Match the existing forced-RLS migration owner policy; runtime roles receive
-- neither table grants nor membership. RPC identity/tenant checks are separate.
create policy tivdoc_owner_access on private.ai_release_configurations for all to tivdoc_dev_migrator using(true) with check(true);
create policy tivdoc_owner_access on private.ai_release_enrollment_events for all to tivdoc_dev_migrator using(true) with check(true);
revoke all on private.ai_release_configurations,private.ai_release_enrollment_events
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

create function private.ai_release_immutable() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'AI_RELEASE_APPEND_ONLY';end;$$;
create trigger ai_release_config_immutable before update or delete on private.ai_release_configurations for each row execute function private.ai_release_immutable();
create trigger ai_release_enrollment_immutable before update or delete on private.ai_release_enrollment_events for each row execute function private.ai_release_immutable();

create function private.ai_release_enrollment_guard() returns trigger language plpgsql security invoker set search_path='' as $$
declare previous private.ai_release_enrollment_events;configuration jsonb;begin
 if current_database()<>'tivdoc_release_replay_20260907' then raise exception 'AI_RELEASE_DEV_ONLY';end if;
 perform 1 from public.cases where id=new.case_id and is_qa for update nowait;
 if not found then raise exception 'AI_RELEASE_QA_ENROLLMENT_REQUIRED';end if;
 select * into previous from private.ai_release_enrollment_events where case_id=new.case_id order by sequence desc limit 1;
 if new.sequence<>coalesce(previous.sequence,0)+1 or new.predecessor_id is distinct from previous.event_id then raise exception 'AI_RELEASE_ENROLLMENT_SEQUENCE';end if;
 if new.kind='revoked' and (previous.kind is distinct from 'granted' or previous.configuration_sha256<>new.configuration_sha256) then raise exception 'AI_RELEASE_REVOKE_SCOPE';end if;
 select payload into configuration from private.ai_release_configurations where payload_sha256=new.configuration_sha256;
 if new.kind='granted' and (new.issued_at>clock_timestamp()+interval '1 minute' or new.expires_at<=clock_timestamp()
  or new.issued_at<(configuration#>>'{policy,issued_at}')::timestamptz or new.issued_at<(configuration#>>'{registry,issued_at}')::timestamptz
  or new.expires_at>least((configuration#>>'{policy,expires_at}')::timestamptz,(configuration#>>'{registry,expires_at}')::timestamptz)) then raise exception 'AI_RELEASE_ENROLLMENT_VALIDITY';end if;
 return new;
end;$$;
create trigger ai_release_enrollment_guard before insert on private.ai_release_enrollment_events for each row execute function private.ai_release_enrollment_guard();

-- Stable dependency includes immutable grant/revoke history, never wall time.
create function private.ai_release_dependency(target_case uuid) returns text language sql stable security definer set search_path='' as $$
 select encode(sha256(convert_to(private.governance_jsonb_compact_text(jsonb_build_object('schema_version','ai-release-enrollment-dependency-v1',
  'event_id',e.event_id,'case_id',e.case_id,'sequence',e.sequence,'configuration_sha256',e.configuration_sha256,'kind',e.kind,
  'issued_at',to_char(e.issued_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'expires_at',to_char(e.expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))),'UTF8')),'hex')
 from private.ai_release_enrollment_events e where e.case_id=target_case order by e.sequence desc limit 1;
$$;
-- An enrolled case remains on this profile after revocation. Legacy June
-- authority refreshes cannot silently replace its authority generation.
create function private.ai_release_dispatch_profile_guard() returns trigger language plpgsql security definer set search_path='' as $$
declare token text;begin
 token:=private.ai_release_dependency(new.case_id);
 if token is not null and new.mode='draft' then
  new.authority_dependency_sha256:=token;new.processing_profile:='qualified_ai_v1';
 elsif new.processing_profile is not null then raise exception 'AI_RELEASE_ENROLLMENT_REQUIRED';end if;
 return new;
end;$$;
create trigger ai_release_dispatch_profile_guard before insert or update of authority_dependency_sha256,processing_profile on private.case_analysis_dispatch
 for each row execute function private.ai_release_dispatch_profile_guard();
revoke all on function private.ai_release_dispatch_profile_guard() from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

create function private.ai_release_refresh_dispatch() returns trigger language plpgsql security definer set search_path='' as $$
declare target_case uuid;token text;begin
 target_case:=new.case_id;
 if tg_table_name='ai_release_enrollment_events' then perform 1 from public.cases where id=target_case for update nowait;end if;
 token:=private.ai_release_dependency(target_case);if token is null then return new;end if;
 update private.case_analysis_dispatch d set authority_dependency_sha256=token,processing_profile='qualified_ai_v1',job_id=null,dispatched_at=null
 from private.case_input_heads h where d.case_id=target_case and h.case_id=d.case_id and h.revision=d.revision
  and d.mode='draft' and (d.authority_dependency_sha256 is distinct from token or d.processing_profile is distinct from 'qualified_ai_v1');
 return new;
end;$$;
create trigger ai_release_enrollment_dispatch after insert on private.ai_release_enrollment_events for each row execute function private.ai_release_refresh_dispatch();
create trigger ai_release_source_dispatch after insert on private.case_analysis_dispatch for each row execute function private.ai_release_refresh_dispatch();

create function private.ai_release_context_read(target_case uuid,expected_revision integer,expected_input_sha256 text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e private.ai_release_enrollment_events;c private.ai_release_configurations;token text;at_time timestamptz:=clock_timestamp();begin
 if session_user<>'tivdoc_worker_runtime' or private.runtime_verified_tenant() is distinct from 'saved-case:'||target_case::text then raise exception 'AI_RELEASE_SCOPE_FORBIDDEN';end if;
 if current_database()<>'tivdoc_release_replay_20260907' then raise exception 'AI_RELEASE_DEV_ONLY';end if;
 perform 1 from public.cases where id=target_case and is_qa for update;
 if not found then raise exception 'AI_RELEASE_QA_ENROLLMENT_REQUIRED';end if;
 if not exists(select 1 from private.case_input_heads where case_id=target_case and revision=expected_revision and input_sha256=expected_input_sha256) then raise exception 'ANALYSIS_INPUT_SUPERSEDED';end if;
 select * into e from private.ai_release_enrollment_events where case_id=target_case order by sequence desc limit 1;
 if not found then return jsonb_build_object('state','absent');end if;
 token:=private.ai_release_dependency(target_case);
 if e.kind='revoked' or e.expires_at<=at_time or e.issued_at>at_time then return jsonb_build_object('state','unavailable','reason',case when e.kind='revoked' then 'revoked' else 'expired' end,'dependency_sha256',token);end if;
 select * into c from private.ai_release_configurations where payload_sha256=e.configuration_sha256;
 if not exists(select 1 from private.case_analysis_dispatch d where d.case_id=target_case and d.revision=expected_revision and d.mode='draft' and d.authority_dependency_sha256=token) then raise exception 'ANALYSIS_AUTHORITY_SUPERSEDED';end if;
 return jsonb_build_object('state','configured','configuration',c.payload,'configuration_sha256',c.payload_sha256,'enrollment_id',e.event_id,
  'dependency_sha256',token,'evaluated_at',at_time,'source_created_at',(select v.created_at from private.case_input_versions v where v.case_id=target_case and v.revision=expected_revision),'expires_at',e.expires_at,'is_qa',true,'environment','development');
end;$$;
revoke all on function private.ai_release_immutable(),private.ai_release_enrollment_guard(),private.ai_release_dependency(uuid),private.ai_release_refresh_dispatch(),private.ai_release_context_read(uuid,integer,text)
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function private.ai_release_context_read(uuid,integer,text) to tivdoc_worker_runtime;
