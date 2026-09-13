-- Created by Supabase CLI on 2026-09-13; ordered after the existing future-dated chain.
-- Additive DEV-reviewed service boundary; no grants, credentials or sessions seeded.
-- Requires 204 and 205. Existing 204 functions keep their ordinary interfaces.
-- This is an explicit deployment reapproval, not automatic plan/build adoption.
-- Existing case grants must still be live; this transition NEVER extends their
-- expiry, changes paid scope, revives revoked history or grants contact consent.
create table private.real_service_deployment_successors(
 sha256 text primary key,payload jsonb not null,
 predecessor_plan_sha256 text not null unique references private.real_service_activation_plans(payload_sha256),
 successor_plan_sha256 text not null unique references private.real_service_activation_plans(payload_sha256),
 authorization_evidence_sha256 text not null references private.real_ai_service_evidence_artifacts(sha256),
 issued_at timestamptz not null,expires_at timestamptz not null,
 recorded_by name not null default session_user,check(issued_at<expires_at)
);
create table private.real_service_deployment_successor_revocations(
 sha256 text primary key references private.real_service_deployment_successors(sha256),
 effective_at timestamptz not null default clock_timestamp(),recorded_by name not null default session_user
);
create table private.real_service_deployment_successor_bindings(
 event_id uuid primary key references private.real_service_activation_enrollments(event_id),
 authorization_sha256 text not null references private.real_service_deployment_successors(sha256)
);
do $acl$ declare t text;begin
 foreach t in array array['real_service_deployment_successors','real_service_deployment_successor_revocations','real_service_deployment_successor_bindings'] loop
  execute format('alter table private.%I enable row level security',t);execute format('alter table private.%I force row level security',t);
  execute format('create policy tivdoc_owner_access on private.%I for all to tivdoc_dev_migrator using(true) with check(true)',t);
  execute format('revoke all on private.%I from public,anon,authenticated,service_role,tivdoc_identity_runtime,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime',t);
  execute format('create trigger %I before update or delete on private.%I for each row execute function private.ai_release_immutable()',t||'_immutable',t);
 end loop;
end;$acl$;
create function private.real_service_deployment_successor_register(p jsonb) returns text
language plpgsql security invoker set search_path='' as $$
declare previous private.real_service_activation_plans;next private.real_service_activation_plans;existing private.real_service_deployment_successors;begin
 if session_user<>'tivdoc_dev_migrator' then raise exception 'REAL_SERVICE_OPERATOR_REQUIRED';end if;
 if not coalesce(p->>'schema_version'='real-service-deployment-successor-v1' and p->>'sha256'=private.real_ai_service_json_sha(p-'sha256')
  and (select count(*) from jsonb_object_keys(p))=7 and p->>'authorization_evidence_sha256'~'^[a-f0-9]{64}$'
  and (p->>'issued_at')::timestamptz<=clock_timestamp() and (p->>'expires_at')::timestamptz>clock_timestamp(),false)
  then raise exception 'REAL_DEPLOYMENT_APPROVAL_INVALID';end if;
 select * into previous from private.real_service_activation_plans where payload_sha256=p->>'predecessor_plan_sha256';
 select * into next from private.real_service_activation_plans where payload_sha256=p->>'successor_plan_sha256';
 if previous.plan_id is null or next.plan_id is null or previous.plan_id<>next.plan_id then raise exception 'REAL_DEPLOYMENT_PLAN_CHAIN';end if;
 perform pg_advisory_xact_lock(hashtextextended('real-service-plan:'||next.plan_id::text,0));
 if next.predecessor_sha256 is distinct from previous.payload_sha256 or next.revision<>previous.revision+1
  or next.revision<>(select max(revision) from private.real_service_activation_plans where plan_id=next.plan_id)
  or previous.payload->>'state'<>'active' or next.payload->>'state'<>'active'
  or previous.payload->>'database_name'<>current_database() or next.payload->>'database_name'<>current_database()
  or (previous.payload->>'expires_at')::timestamptz<=clock_timestamp()
  or (next.payload->>'issued_at')::timestamptz>(p->>'issued_at')::timestamptz
  or (p->>'expires_at')::timestamptz>least((previous.payload->>'expires_at')::timestamptz,(next.payload->>'expires_at')::timestamptz)
  then raise exception 'REAL_DEPLOYMENT_PLAN_CHAIN';end if;
 -- Same service population/purchase permissions. Build/config/decision/issuer/
 -- budget may change only through separately registered new-plan evidence.
 if exists(select 1 from unnest(array['purpose','namespace','environment','database_name','target_id','population','period','topics','purchase']) k
  where previous.payload->k is distinct from next.payload->k) then raise exception 'REAL_DEPLOYMENT_SERVICE_SCOPE_CHANGED';end if;
 select * into existing from private.real_service_deployment_successors where sha256=p->>'sha256';
 if found then if existing.payload<>p then raise exception 'REAL_DEPLOYMENT_APPROVAL_RETRY';end if;return existing.sha256;end if;
 insert into private.real_service_deployment_successors(sha256,payload,predecessor_plan_sha256,successor_plan_sha256,authorization_evidence_sha256,issued_at,expires_at)
 values(p->>'sha256',p,p->>'predecessor_plan_sha256',p->>'successor_plan_sha256',p->>'authorization_evidence_sha256',(p->>'issued_at')::timestamptz,(p->>'expires_at')::timestamptz);
 return p->>'sha256';
end;$$;
create function private.real_service_deployment_successor_revoke(p_sha text) returns void
language plpgsql security invoker set search_path='' as $$
declare c uuid;begin
 if session_user<>'tivdoc_dev_migrator' then raise exception 'REAL_SERVICE_OPERATOR_REQUIRED';end if;
 perform 1 from private.real_service_deployment_successors where sha256=p_sha for update;
 insert into private.real_service_deployment_successor_revocations(sha256) values(p_sha) on conflict do nothing;
 for c in select distinct e.case_id from private.real_service_deployment_successor_bindings b join private.real_service_activation_enrollments e on e.event_id=b.event_id
  where b.authorization_sha256=p_sha loop perform private.real_ai_service_refresh_dispatch(c);end loop;
end;$$;
-- Approval history remains attached through later paid extensions/deployments.
-- Revocation therefore invalidates processing, publication, web reads and sends.
create function private.real_service_deployment_history_current(p_case uuid) returns boolean language sql volatile security invoker set search_path='' as $$
 select not exists(select 1 from private.real_service_deployment_successor_bindings b
  join private.real_service_activation_enrollments e on e.event_id=b.event_id
  join private.real_service_deployment_successors g on g.sha256=b.authorization_sha256 where e.case_id=p_case
  and (g.issued_at>clock_timestamp() or g.expires_at<=clock_timestamp()
   or exists(select 1 from private.real_service_deployment_successor_revocations r where r.sha256=g.sha256 and r.effective_at<=clock_timestamp())
   or exists(select 1 from private.real_ai_service_revocations r where r.case_id=p_case and r.target_sha256 in(g.sha256,g.authorization_evidence_sha256) and r.effective_at<=clock_timestamp())))
$$;
create function private.real_service_deployment_history_until(p_case uuid) returns timestamptz language sql stable security invoker set search_path='' as $$
 select min(least(g.expires_at,(select min(r.effective_at) from private.real_service_deployment_successor_revocations r where r.sha256=g.sha256),
  (select min(r.effective_at) from private.real_ai_service_revocations r where r.case_id=p_case and r.target_sha256 in(g.sha256,g.authorization_evidence_sha256))))
 from private.real_service_deployment_successor_bindings b join private.real_service_activation_enrollments e on e.event_id=b.event_id
 join private.real_service_deployment_successors g on g.sha256=b.authorization_sha256 where e.case_id=p_case
$$;
create function private.real_service_deployment_successor_authorization(p_case uuid,p_prior uuid,p_previous text,p_next text,p_identity uuid,p_scope text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare g private.real_service_deployment_successors;old private.real_service_activation_plans;e private.real_ai_service_enrollment_events;until_time timestamptz;begin
 select * into g from private.real_service_deployment_successors where predecessor_plan_sha256=p_previous and successor_plan_sha256=p_next for share;
 if g.sha256 is null or g.issued_at>clock_timestamp() or g.expires_at<=clock_timestamp()
  or exists(select 1 from private.real_service_deployment_successor_revocations where sha256=g.sha256)
  or not private.real_service_deployment_history_current(p_case) then return null;end if;
 select * into old from private.real_service_activation_plans where payload_sha256=p_previous;
 select * into e from private.real_ai_service_enrollment_events where event_id=p_prior and case_id=p_case;
 if e.event_id is null or e.kind<>'granted' or e.identity_id<>p_identity or e.purchased_scope_sha256<>p_scope or e.expires_at<=clock_timestamp()
  or old.payload->>'state'<>'active' or (old.payload->>'expires_at')::timestamptz<=clock_timestamp()
  or not exists(select 1 from private.real_service_activation_plans n where n.payload_sha256=p_next and n.predecessor_sha256=p_previous
   and n.payload->>'state'='active' and n.revision=(select max(revision) from private.real_service_activation_plans where plan_id=n.plan_id))
  or exists(select 1 from private.real_service_activation_controller_revocations r join private.real_service_activation_enrollments b on b.capability_sha256=r.capability_sha256
   where b.event_id=p_prior and r.effective_at<=clock_timestamp()) then return null;end if;
 -- Preserve old customer's revocation history, including old config/decision.
 if exists(select 1 from private.real_ai_service_revocations r where r.case_id=p_case and r.effective_at<=clock_timestamp()
  and (r.target_sha256 in(g.sha256,g.authorization_evidence_sha256,p_previous,old.payload->>'machine_issuer_sha256',old.payload->>'provider_budget_policy_sha256',old.payload->>'activation_evidence_sha256')
   or r.target_sha256 in(select ref.sha256 from private.ai_release_configurations c join private.real_ai_service_decisions d on d.configuration_sha256=c.payload_sha256,
    lateral private.real_ai_service_dependency_targets(c.payload,d.payload) ref where c.payload_sha256=e.configuration_sha256 and d.payload_sha256=e.service_decision_sha256))) then return null;end if;
 select least(g.expires_at,e.expires_at,private.real_service_deployment_history_until(p_case),min(r.effective_at)) into until_time
  from private.real_ai_service_revocations r where r.case_id=p_case and r.target_sha256 in(g.sha256,g.authorization_evidence_sha256);
 return jsonb_build_object('approval',g.payload,'until',until_time);
end;$$;

-- Derive the explicit successor path from the ACTUAL installed enrollment
-- functions, preserving paid-scope, source, terms, role, config, CAS and all
-- existing journal/dispatch writes. No replacement calculator/queue/runtime.
do $derive$ declare body text;needle text;replacement text;begin
 body:=pg_get_functiondef('private.real_service_activation_material(text,uuid,uuid,integer,text,text,text)'::regprocedure);
 body:=replace(body,'FUNCTION private.real_service_activation_material(','FUNCTION private.real_service_deployment_successor_material(');
 body:=replace(body,'transition text:=''initial_enrollment'';','transition text:=''initial_enrollment'';deployment jsonb;');
 needle:=$old$  if binding.event_id is distinct from e.event_id or binding.plan_sha256 is distinct from p_plan_sha or e.identity_id<>p_identity
   or e.configuration_sha256 is distinct from p->>'configuration_sha256' or e.service_decision_sha256 is distinct from p->>'service_decision_sha256'
   then return jsonb_build_object('state','unavailable','reason','scope_changed');end if;
  transition:='replay';$old$;
 replacement:=$new$  if binding.event_id is distinct from e.event_id or e.identity_id<>p_identity then return jsonb_build_object('state','unavailable','reason','scope_changed');end if;
  if binding.plan_sha256 is distinct from p_plan_sha then
   deployment:=private.real_service_deployment_successor_authorization(p_case,e.event_id,binding.plan_sha256,p_plan_sha,p_identity,scope_sha);
   if deployment is null then return jsonb_build_object('state','unavailable','reason','scope_changed');end if;
   transition:='deployment_successor';
  else
   if e.configuration_sha256 is distinct from p->>'configuration_sha256' or e.service_decision_sha256 is distinct from p->>'service_decision_sha256'
    then return jsonb_build_object('state','unavailable','reason','scope_changed');end if;
   transition:='replay';
  end if;$new$;
 if position(needle in body)=0 then raise exception 'REAL_DEPLOYMENT_MATERIAL_BRANCH_MISSING';end if;body:=replace(body,needle,replacement);
 needle:='if until_time<=at_time then';
 if position(needle in body)=0 then raise exception 'REAL_DEPLOYMENT_MATERIAL_EXPIRY_MISSING';end if;
 body:=replace(body,needle,'until_time:=least(until_time,(deployment->>''until'')::timestamptz,private.real_service_deployment_history_until(p_case));'||E'\n '||needle);
 needle:='''prior_event_id'',e.event_id,''transition'',transition));';
 if position(needle in body)=0 then raise exception 'REAL_DEPLOYMENT_MATERIAL_TOKEN_MISSING';end if;
 body:=replace(body,needle,'''prior_event_id'',e.event_id,''transition'',transition,''deployment_authorization'',deployment#>>''{approval,sha256}''));');
 needle:='scope_sha:=private.real_ai_service_json_sha(scope);';
 body:=replace(body,needle,needle||E'\n if not private.real_service_deployment_history_current(p_case) then return jsonb_build_object(''state'',''unavailable'',''reason'',''revoked'');end if;');
 -- Only successor/replay are allowed by this explicit API, including direct SQL.
 needle:='selector:=jsonb_build_object(';
 body:=replace(body,needle,'if transition not in (''deployment_successor'',''replay'') then return jsonb_build_object(''state'',''unavailable'',''reason'',''scope_changed'');end if;'||E'\n '||needle);
 execute body;
 body:=pg_get_functiondef('private.real_service_activation_enroll(text,uuid,uuid,integer,text,text,text,text)'::regprocedure);
 body:=replace(body,'FUNCTION private.real_service_activation_enroll(','FUNCTION private.real_service_deployment_successor_enroll(');
 body:=replace(body,'private.real_service_activation_material(','private.real_service_deployment_successor_material(');
 needle:='perform private.real_ai_service_refresh_dispatch(p_case);';
 if position(needle in body)=0 then raise exception 'REAL_DEPLOYMENT_ENROLL_BINDING_MISSING';end if;
 body:=replace(body,needle,$bind$insert into private.real_service_deployment_successor_bindings(event_id,authorization_sha256)
   select event,g.sha256 from private.real_service_deployment_successors g where g.predecessor_plan_sha256=m#>>'{prior_enrollment,plan_sha256}' and g.successor_plan_sha256=p_plan_sha;
  if not found then raise exception 'REAL_DEPLOYMENT_APPROVAL_CHANGED';end if;
  $bind$||needle);
 execute body;
end;$derive$;
create function private.real_service_deployment_successor_context(p_capability text,p_case uuid,p_identity uuid,p_revision integer,p_input_sha text,p_plan_sha text,p_build text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m jsonb;g jsonb;begin
 m:=private.real_service_deployment_successor_material(p_capability,p_case,p_identity,p_revision,p_input_sha,p_plan_sha,p_build);
 if m->>'transition'='deployment_successor' then
  select payload into g from private.real_service_deployment_successors where predecessor_plan_sha256=m#>>'{prior_enrollment,plan_sha256}' and successor_plan_sha256=p_plan_sha;
  m:=m||jsonb_build_object('deployment_authorization',g);
 end if;return m;
end;$$;
-- Currentness hooks apply to all downstream paths already using 204 parents.
-- Catalog edits fail closed if root's installed function no longer matches.
do $hooks$ declare body text;needle text;begin
 body:=pg_get_functiondef('private.real_service_activation_parent_current(uuid)'::regprocedure);
 needle:='select not exists(';if position(needle in body)=0 then raise exception 'REAL_DEPLOYMENT_PARENT_HOOK_MISSING';end if;
 execute replace(body,needle,'select private.real_service_deployment_history_current(p_case) and not exists(');
 body:=pg_get_functiondef('private.real_service_activation_parent_until(uuid)'::regprocedure);
 needle:='select least(';if position(needle in body)=0 then raise exception 'REAL_DEPLOYMENT_PARENT_EXPIRY_HOOK_MISSING';end if;
 execute replace(body,needle,'select least(private.real_service_deployment_history_until(p_case),');
 body:=pg_get_functiondef('private.real_service_activation_material(text,uuid,uuid,integer,text,text,text)'::regprocedure);
 needle:='scope_sha:=private.real_ai_service_json_sha(scope);';if position(needle in body)=0 then raise exception 'REAL_DEPLOYMENT_EXISTING_MATERIAL_HOOK_MISSING';end if;
 body:=replace(body,needle,needle||E'\n if not private.real_service_deployment_history_current(p_case) then return jsonb_build_object(''state'',''unavailable'',''reason'',''revoked'');end if;');
 needle:='if until_time<=at_time then';body:=replace(body,needle,'until_time:=least(until_time,private.real_service_deployment_history_until(p_case));'||E'\n '||needle);execute body;
end;$hooks$;
do $acl$ declare r record;begin
 for r in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname like 'real_service_deployment_%' loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role,tivdoc_identity_runtime,tivdoc_worker_runtime,tivdoc_web_runtime,tivdoc_operations_runtime',r.signature);
 end loop;
end;$acl$;
grant execute on function private.real_service_deployment_successor_context(text,uuid,uuid,integer,text,text,text),
 private.real_service_deployment_successor_enroll(text,uuid,uuid,integer,text,text,text,text) to tivdoc_worker_runtime;
