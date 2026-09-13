-- Migration 204; CLI-created file sequenced after the existing future-dated chain.
-- Reusable explicit REAL plan enrollment; no customer activation or credentials seeded.
create table private.real_service_activation_plans(
 payload_sha256 text primary key,payload jsonb not null,plan_id uuid not null,revision integer not null,
 predecessor_sha256 text references private.real_service_activation_plans(payload_sha256),
 configuration_sha256 text not null references private.ai_release_configurations(payload_sha256),
 decision_sha256 text not null references private.real_ai_service_decisions(payload_sha256),
 recorded_at timestamptz not null default clock_timestamp(),recorded_by name not null default session_user,
 unique(plan_id,revision),check(revision>0),check((revision=1)=(predecessor_sha256 is null))
);
create table private.real_service_activation_controllers(
 capability_sha256 text primary key check(capability_sha256~'^[a-f0-9]{64}$'),
 plan_sha256 text not null references private.real_service_activation_plans(payload_sha256),
 deployment_sha256 text not null,authorization_evidence_sha256 text not null references private.real_ai_service_evidence_artifacts(sha256),
 expires_at timestamptz not null,recorded_at timestamptz not null default clock_timestamp(),recorded_by name not null default session_user
);
create table private.real_service_activation_controller_revocations(
 capability_sha256 text primary key references private.real_service_activation_controllers(capability_sha256),
 effective_at timestamptz not null default clock_timestamp(),recorded_by name not null default session_user
);
create table private.real_service_activation_enrollments(
 event_id uuid primary key references private.real_ai_service_enrollment_events(event_id),
 case_id uuid not null references public.cases(id),plan_sha256 text not null references private.real_service_activation_plans(payload_sha256),
 sequence integer not null check(sequence>0),predecessor_event_id uuid unique references private.real_service_activation_enrollments(event_id),
 source_revision integer not null check(source_revision>0),source_sha256 text not null check(source_sha256~'^[a-f0-9]{64}$'),
 capability_sha256 text not null references private.real_service_activation_controllers(capability_sha256),
 context_sha256 text not null,purchased_scope_sha256 text not null,recorded_at timestamptz not null default clock_timestamp(),
 unique(case_id,sequence),check((sequence=1)=(predecessor_event_id is null))
);
do $acl$ declare t text;begin
 foreach t in array array['real_service_activation_plans','real_service_activation_controllers','real_service_activation_controller_revocations','real_service_activation_enrollments'] loop
  execute format('alter table private.%I enable row level security',t);execute format('alter table private.%I force row level security',t);
  execute format('create policy tivdoc_owner_access on private.%I for all to tivdoc_dev_migrator using(true) with check(true)',t);
  execute format('revoke all on private.%I from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime',t);
  execute format('create trigger %I before update or delete on private.%I for each row execute function private.ai_release_immutable()',t||'_immutable',t);
 end loop;
end;$acl$;

create function private.real_service_activation_plan_register(p jsonb,p_predecessor text) returns text
language plpgsql security invoker set search_path='' as $$
declare prior private.real_service_activation_plans;existing private.real_service_activation_plans;c jsonb;d jsonb;at_time timestamptz:=clock_timestamp();begin
 if session_user<>'tivdoc_dev_migrator' then raise exception 'REAL_SERVICE_OPERATOR_REQUIRED';end if;
 -- Dedicated advisory namespace serializes concurrent first registration too.
 perform pg_advisory_xact_lock(hashtextextended('real-service-plan:'||(p->>'plan_id'),0));
 if not coalesce(p->>'schema_version'='tivdoc-real-service-activation-plan-v1' and p->>'purpose'='real_customer_service' and p->>'namespace'='real'
  and p->>'state' in ('active','revoked') and p->>'sha256'=private.real_ai_service_json_sha(p-'sha256')
  and p->>'environment' in ('development','preview','production','test') and p->>'database_name'=current_database()
  and p#>>'{period,from}'~'^2026-(05|06|07)$' and p#>>'{period,to}'~'^2026-(05|06|07)$' and p#>>'{period,from}'<=p#>>'{period,to}'
  and p#>>'{purchase,offer_version}'='tivdoc-order-offer-v3' and p#>>'{purchase,purchase_topics_version}'='tivdoc-purchase-topics-v2'
  and jsonb_typeof(p->'topics')='array' and jsonb_array_length(p->'topics') between 1 and 9
  and jsonb_typeof(p#>'{purchase,terms_versions}')='array' and jsonb_array_length(p#>'{purchase,terms_versions}') between 1 and 8
  and (p->>'issued_at')::timestamptz<(p->>'expires_at')::timestamptz,false) then raise exception 'REAL_ACTIVATION_PLAN_INVALID';end if;
 if (select count(*) from jsonb_object_keys(p))<>23 or coalesce(length(p->>'target_id'),0) not between 1 and 200 or exists(select 1 from jsonb_array_elements_text(p->'topics') t
  where t not in ('minimum_wage','working_time','pension','travel','convalescence','vacation','rest_day','bonuses','contract'))
  or (select count(distinct t) from jsonb_array_elements_text(p->'topics') t)<>jsonb_array_length(p->'topics')
  or exists(select 1 from jsonb_array_elements_text(p#>'{purchase,terms_versions}') t where length(t) not between 4 and 40)
  or (select count(distinct t) from jsonb_array_elements_text(p#>'{purchase,terms_versions}') t)<>jsonb_array_length(p#>'{purchase,terms_versions}')
  then raise exception 'REAL_ACTIVATION_PLAN_SCOPE';end if;
 select * into existing from private.real_service_activation_plans where payload_sha256=p->>'sha256';
 if found then if existing.payload<>p or existing.predecessor_sha256 is distinct from p_predecessor then raise exception 'REAL_ACTIVATION_PLAN_RETRY';end if;return existing.payload_sha256;end if;
 select * into prior from private.real_service_activation_plans where plan_id=(p->>'plan_id')::uuid order by revision desc limit 1;
 if prior.payload_sha256 is distinct from p_predecessor or (p->>'revision')::integer<>coalesce(prior.revision,0)+1 then raise exception 'REAL_ACTIVATION_PLAN_SUPERSEDED';end if;
 -- A revoked plan ID is terminal. New explicit activation requires a new plan
 -- and cannot revive any revoked/expired case enrollment history.
 if prior.payload->>'state'='revoked' then raise exception 'REAL_ACTIVATION_PLAN_NO_RESURRECTION';end if;
 select x.payload,y.payload into c,d from private.ai_release_configurations x join private.real_ai_service_decisions y on y.configuration_sha256=x.payload_sha256
  where x.payload_sha256=p->>'configuration_sha256' and y.payload_sha256=p->>'service_decision_sha256';
 if c is null or d is null or c->>'population' is distinct from p->>'population' or c->>'build_manifest_sha256' is distinct from p->>'build_manifest_sha256'
  or c#>>'{policy,namespace}' is distinct from 'real' or c#>>'{registry,namespace}' is distinct from 'real'
  or d->>'namespace' is distinct from 'real' or d->>'purpose' is distinct from 'real_customer_service'
  or not coalesce(c#>'{policy,allowed_environments}' ? (p->>'environment'),false) then raise exception 'REAL_ACTIVATION_CONFIGURATION';end if;
 if exists(select 1 from unnest(array['machine_issuer_sha256','provider_budget_policy_sha256','activation_evidence_sha256']) key
  where coalesce(p->>key,'')!~'^[a-f0-9]{64}$' or not exists(select 1 from private.real_ai_service_evidence_artifacts a where a.sha256=p->>key))
  or coalesce(p->>'deployment_sha256','')!~'^[a-f0-9]{64}$' then raise exception 'REAL_ACTIVATION_EVIDENCE_REQUIRED';end if;
 if p->>'state'='active' then
  if d->>'status' is distinct from 'active' or (p->>'issued_at')::timestamptz>at_time or (p->>'expires_at')::timestamptz<=at_time
   or (p->>'issued_at')::timestamptz<greatest((c#>>'{policy,issued_at}')::timestamptz,(c#>>'{registry,issued_at}')::timestamptz,(d->>'issued_at')::timestamptz)
   or (p->>'expires_at')::timestamptz>least((c#>>'{policy,expires_at}')::timestamptz,(c#>>'{registry,expires_at}')::timestamptz,(d->>'expires_at')::timestamptz)
   then raise exception 'REAL_ACTIVATION_PLAN_WINDOW';end if;
 else
  if prior.payload->>'state' is distinct from 'active' or prior.payload-'sha256'-'revision'-'state'<>p-'sha256'-'revision'-'state'
   then raise exception 'REAL_ACTIVATION_PLAN_REVOKE_SCOPE';end if;
 end if;
 insert into private.real_service_activation_plans(payload_sha256,payload,plan_id,revision,predecessor_sha256,configuration_sha256,decision_sha256)
 values(p->>'sha256',p,(p->>'plan_id')::uuid,(p->>'revision')::integer,p_predecessor,p->>'configuration_sha256',p->>'service_decision_sha256');
 return p->>'sha256';
end;$$;

-- Admin registration of a separately issued controller secret HASH only.
-- Plan scope explicitly authorizes future eligible v3 cases; no payment or
-- customer-specific permission is inferred from possession of a worker LOGIN.
create function private.real_service_activation_controller_register(p_capability_sha text,p_plan_sha text,p_deployment_sha text,p_evidence_sha text,p_expires timestamptz) returns void
language plpgsql security invoker set search_path='' as $$
declare p jsonb;old private.real_service_activation_controllers;begin
 if session_user<>'tivdoc_dev_migrator' then raise exception 'REAL_SERVICE_OPERATOR_REQUIRED';end if;
 select payload into p from private.real_service_activation_plans where payload_sha256=p_plan_sha;
 if p is null or p->>'state'<>'active' or p->>'deployment_sha256' is distinct from p_deployment_sha or p_expires is null
  or p_expires<=clock_timestamp() or p_expires>(p->>'expires_at')::timestamptz then raise exception 'REAL_ACTIVATION_CONTROLLER_SCOPE';end if;
 select * into old from private.real_service_activation_controllers where capability_sha256=p_capability_sha;
 if found then
  if old.plan_sha256<>p_plan_sha or old.deployment_sha256<>p_deployment_sha or old.authorization_evidence_sha256<>p_evidence_sha or old.expires_at<>p_expires
   then raise exception 'REAL_ACTIVATION_CONTROLLER_RETRY';end if;return;
 end if;
 insert into private.real_service_activation_controllers(capability_sha256,plan_sha256,deployment_sha256,authorization_evidence_sha256,expires_at)
 values(p_capability_sha,p_plan_sha,p_deployment_sha,p_evidence_sha,p_expires);
end;$$;
create function private.real_service_activation_controller_revoke(p_capability_sha text) returns void language plpgsql security invoker set search_path='' as $$
begin if session_user<>'tivdoc_dev_migrator' then raise exception 'REAL_SERVICE_OPERATOR_REQUIRED';end if;
 insert into private.real_service_activation_controller_revocations(capability_sha256) values(p_capability_sha) on conflict do nothing;
end;$$;

-- Dependency helper has no clock in the token; expiry remains a live guard.
create function private.real_service_activation_parent_current(p_case uuid) returns boolean language sql volatile security invoker set search_path='' as $$
 select not exists(select 1 from private.real_service_activation_enrollments b where b.case_id=p_case
  and b.sequence=(select max(n.sequence) from private.real_service_activation_enrollments n where n.case_id=p_case) and not exists(
  select 1 from private.real_service_activation_plans p where p.payload_sha256=b.plan_sha256
   and p.payload->>'state'='active' and (p.payload->>'issued_at')::timestamptz<=clock_timestamp() and (p.payload->>'expires_at')::timestamptz>clock_timestamp()
   and p.revision=(select max(n.revision) from private.real_service_activation_plans n where n.plan_id=p.plan_id)
   and not exists(select 1 from private.real_ai_service_revocations r where r.case_id=p_case and r.effective_at<=clock_timestamp()
    and r.target_sha256 in (p.payload_sha256,p.payload->>'machine_issuer_sha256',p.payload->>'provider_budget_policy_sha256',p.payload->>'activation_evidence_sha256'))))
$$;
create function private.real_service_activation_parent_until(p_case uuid) returns timestamptz language sql stable security invoker set search_path='' as $$
 select least((p.payload->>'expires_at')::timestamptz,(select min(r.effective_at) from private.real_ai_service_revocations r where r.case_id=p_case
  and r.target_sha256 in(p.payload_sha256,p.payload->>'machine_issuer_sha256',p.payload->>'provider_budget_policy_sha256',p.payload->>'activation_evidence_sha256')))
 from private.real_service_activation_enrollments b join private.real_service_activation_plans p on p.payload_sha256=b.plan_sha256 where b.case_id=p_case order by b.sequence desc limit 1
$$;

create function private.real_service_activation_material(p_capability text,p_case uuid,p_identity uuid,p_revision integer,p_input_sha text,p_plan_sha text,p_build text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare control private.real_service_activation_controllers;plan private.real_service_activation_plans;p jsonb;c jsonb;d jsonb;e private.real_ai_service_enrollment_events;
 binding private.real_service_activation_enrollments;scope jsonb;scope_sha text;token text;selector jsonb;transition text:='initial_enrollment';until_time timestamptz;at_time timestamptz:=clock_timestamp();begin
 if session_user<>'tivdoc_worker_runtime' or p_capability is null or p_capability!~'^[A-Za-z0-9._-]{32,256}$' then raise exception 'REAL_ACTIVATION_CONTROLLER_FORBIDDEN';end if;
 select * into control from private.real_service_activation_controllers where capability_sha256=encode(sha256(convert_to(p_capability,'UTF8')),'hex') for share;
 if control.capability_sha256 is null or control.plan_sha256 is distinct from p_plan_sha or control.expires_at<=at_time
  or exists(select 1 from private.real_service_activation_controller_revocations where capability_sha256=control.capability_sha256 and effective_at<=at_time)
  then raise exception 'REAL_ACTIVATION_CONTROLLER_FORBIDDEN';end if;
 select * into plan from private.real_service_activation_plans where payload_sha256=p_plan_sha;p:=plan.payload;
 if p is null then return jsonb_build_object('state','unavailable','reason','not_registered');end if;
 perform pg_advisory_xact_lock_shared(hashtextextended('real-service-plan:'||plan.plan_id::text,0));
 at_time:=clock_timestamp();
 if p->>'state'<>'active' or plan.revision<>(select max(revision) from private.real_service_activation_plans where plan_id=plan.plan_id)
  then return jsonb_build_object('state','unavailable','reason','revoked');end if;
 if p->>'database_name'<>current_database() or p->>'deployment_sha256'<>control.deployment_sha256 or p->>'build_manifest_sha256'<>p_build
  then raise exception 'REAL_ACTIVATION_DEPLOYMENT_CHANGED';end if;
 if (p->>'issued_at')::timestamptz>at_time or (p->>'expires_at')::timestamptz<=at_time then return jsonb_build_object('state','unavailable','reason','expired');end if;
 perform 1 from public.cases where id=p_case and is_qa is false for update;
 if not found then return jsonb_build_object('state','unavailable','reason','not_eligible');end if;
 at_time:=clock_timestamp();
 if control.expires_at<=at_time or (p->>'expires_at')::timestamptz<=at_time then return jsonb_build_object('state','unavailable','reason','expired');end if;
 if exists(select 1 from private.ai_release_enrollment_events where case_id=p_case) then return jsonb_build_object('state','unavailable','reason','not_eligible');end if;
 if not exists(select 1 from public.case_identity_cases ic join public.case_identities i on i.id=ic.identity_id join public.cases ca on ca.id=ic.case_id
  where ic.case_id=p_case and i.id=p_identity and ca.contact_verified_at is not null)
  then return jsonb_build_object('state','unavailable','reason','identity_unverified');end if;
 if not exists(select 1 from private.case_input_heads where case_id=p_case and revision=p_revision and input_sha256=p_input_sha)
  then return jsonb_build_object('state','unavailable','reason','source_changed');end if;
 select x.payload,y.payload into c,d from private.ai_release_configurations x join private.real_ai_service_decisions y on y.configuration_sha256=x.payload_sha256
  where x.payload_sha256=plan.configuration_sha256 and y.payload_sha256=plan.decision_sha256;
 if d->>'status' is distinct from 'active' or c->>'population' is distinct from p->>'population' or c->>'build_manifest_sha256' is distinct from p_build
  then return jsonb_build_object('state','unavailable','reason','not_eligible');end if;
 if exists(select 1 from unnest(array['A01','A03','A05','A06','A07','A11']) required(action)
  where not exists(select 1 from jsonb_array_elements(d->'action_reviews') r where r->>'action'=required.action)) then return jsonb_build_object('state','unavailable','reason','not_eligible');end if;
 if exists(select 1 from private.real_ai_service_evidence_refs(d) ref where not exists(select 1 from private.real_ai_service_evidence_artifacts a where a.sha256=ref.sha256))
  then return jsonb_build_object('state','unavailable','reason','not_eligible');end if;
 if exists(select 1 from private.real_ai_service_revocations r where r.case_id=p_case and r.effective_at<=at_time and (r.target_sha256 in(p_plan_sha,p->>'machine_issuer_sha256',p->>'provider_budget_policy_sha256',p->>'activation_evidence_sha256')
  or r.target_sha256 in(select sha256 from private.real_ai_service_dependency_targets(c,d)))) then return jsonb_build_object('state','unavailable','reason','revoked');end if;
 begin scope:=private.real_ai_service_paid_scope(p_case,p_revision,p_input_sha);
 exception when others then
  if sqlerrm in ('REAL_SERVICE_PAID_SCOPE_REQUIRED','REAL_SERVICE_VERIFIED_PAYMENT_REQUIRED','REAL_SERVICE_LEGACY_ADAPTER_REQUIRED') then return jsonb_build_object('state','unavailable','reason','not_eligible');
  elsif sqlerrm in ('REAL_SERVICE_PURCHASE_TERMS_INCOMPATIBLE','REAL_SERVICE_PURCHASE_SCOPE_UNSUPPORTED') then return jsonb_build_object('state','unavailable','reason','terms_incompatible');else raise;end if;
 end;
 if exists(select 1 from jsonb_array_elements(scope) s join private.product_orders o on o.id::text=s->>'id' where
  o.offer->>'version' is distinct from 'tivdoc-order-offer-v3' or o.offer->>'purchase_topics_version' is distinct from 'tivdoc-purchase-topics-v2'
  or not(p#>'{purchase,terms_versions}' ? o.terms_version) or o.terms_accepted_at is null
  or to_char(o.period_from,'YYYY-MM')<p#>>'{period,from}' or to_char(o.period_to,'YYYY-MM')>p#>>'{period,to}'
  or not (to_jsonb(o.topics)<@(p->'topics')) or o.refund_state<>'none') then return jsonb_build_object('state','unavailable','reason','terms_incompatible');end if;
 scope_sha:=private.real_ai_service_json_sha(scope);
 select * into e from private.real_ai_service_enrollment_events where case_id=p_case order by sequence desc limit 1;
 select * into binding from private.real_service_activation_enrollments where case_id=p_case order by sequence desc limit 1;
 if e.event_id is not null then
  if e.kind<>'granted' then return jsonb_build_object('state','unavailable','reason','revoked');end if;
  if e.expires_at<=at_time then return jsonb_build_object('state','unavailable','reason','expired');end if;
  if binding.event_id is distinct from e.event_id or binding.plan_sha256 is distinct from p_plan_sha or e.identity_id<>p_identity
   or e.configuration_sha256 is distinct from p->>'configuration_sha256' or e.service_decision_sha256 is distinct from p->>'service_decision_sha256'
   then return jsonb_build_object('state','unavailable','reason','scope_changed');end if;
  transition:='replay';
  if e.purchased_scope_sha256<>scope_sha then
   -- Add only new verified full purchases. Every old receipt stays exactly
   -- present; removed, refunded, replaced or edited scope cannot be adopted.
   if jsonb_array_length(scope)<=jsonb_array_length(e.purchased_scope)
    or exists(select 1 from jsonb_array_elements(e.purchased_scope) previous_scope where not exists(select 1 from jsonb_array_elements(scope) next_scope where next_scope=previous_scope))
    or exists(select 1 from jsonb_array_elements(scope) next_scope join private.product_orders o on o.id::text=next_scope->>'id'
     where not exists(select 1 from jsonb_array_elements(e.purchased_scope) previous_scope where previous_scope->>'id'=next_scope->>'id')
      and (o.kind<>'full' or o.verified_at<=e.issued_at))
    then return jsonb_build_object('state','unavailable','reason','scope_changed');end if;
   transition:='paid_scope_extension';
  end if;
 end if;
 select least((p->>'expires_at')::timestamptz,(c#>>'{policy,expires_at}')::timestamptz,(c#>>'{registry,expires_at}')::timestamptz,(d->>'expires_at')::timestamptz,
  min(r.effective_at)) into until_time from private.real_ai_service_revocations r where r.case_id=p_case and (r.target_sha256 in(p_plan_sha,p->>'machine_issuer_sha256',p->>'provider_budget_policy_sha256',p->>'activation_evidence_sha256') or r.target_sha256 in(select sha256 from private.real_ai_service_dependency_targets(c,d)));
 if e.event_id is not null then until_time:=least(until_time,e.expires_at);end if;
 if until_time<=at_time then return jsonb_build_object('state','unavailable','reason','expired');end if;
 selector:=jsonb_build_object('case_id',p_case,'identity_id',p_identity,'source_revision',p_revision,'source_sha256',p_input_sha,'plan_sha256',p_plan_sha);
 token:=private.real_ai_service_json_sha(jsonb_build_object('schema_version','real-service-activation-context-v1','selector',selector,'plan',p_plan_sha,'scope',scope_sha,
  'capability',control.capability_sha256,'expires_at',until_time,'prior_event_id',e.event_id,'transition',transition));
 return jsonb_build_object('state','eligible','transition',transition,'selector',selector,'plan',p,'context_sha256',token,'evaluated_at',at_time,'expires_at',until_time,
  'purchased_scope_sha256',scope_sha,'configuration_sha256',plan.configuration_sha256,'service_decision_sha256',plan.decision_sha256,'population',p->>'population',
  'environment',p->>'environment','database_name',p->>'database_name','target_id',p->>'target_id','deployment_sha256',p->>'deployment_sha256',
  'machine_issuer_sha256',p->>'machine_issuer_sha256','provider_budget_policy_sha256',p->>'provider_budget_policy_sha256',
  'prior_enrollment',case when e.event_id is null then null else jsonb_build_object('event_id',e.event_id,'state',e.kind,'plan_sha256',binding.plan_sha256,'purchased_scope_sha256',e.purchased_scope_sha256) end);
end;$$;
create function private.real_service_activation_context(p_capability text,p_case uuid,p_identity uuid,p_revision integer,p_input_sha text,p_plan_sha text,p_build text) returns jsonb
language sql security definer set search_path='' as $$ select private.real_service_activation_material(p_capability,p_case,p_identity,p_revision,p_input_sha,p_plan_sha,p_build) $$;
create function private.real_service_activation_enroll(p_capability text,p_case uuid,p_identity uuid,p_revision integer,p_input_sha text,p_plan_sha text,p_build text,p_expected_context text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m jsonb;p jsonb;scope jsonb;event uuid;prior_event uuid;event_predecessor uuid;next_sequence integer;replayed boolean;begin
 m:=private.real_service_activation_material(p_capability,p_case,p_identity,p_revision,p_input_sha,p_plan_sha,p_build);
 if m->>'state'<>'eligible' then return m;end if;
 prior_event:=(m#>>'{prior_enrollment,event_id}')::uuid;replayed:=m->>'transition'='replay';
 if m->>'context_sha256' is distinct from p_expected_context then
  -- Lost-response retry of the same original CAS may return only the current
  -- exact event. It cannot authorize another extension or revive old history.
  if not replayed or not exists(select 1 from private.real_service_activation_enrollments b where b.event_id=prior_event
   and b.case_id=p_case and b.plan_sha256=p_plan_sha and b.context_sha256=p_expected_context and b.purchased_scope_sha256=m->>'purchased_scope_sha256'
   and b.source_revision=p_revision and b.source_sha256=p_input_sha)
   then raise exception 'REAL_ACTIVATION_CONTEXT_SUPERSEDED';end if;
 end if;p:=m->'plan';event:=prior_event;
 if not replayed then
  scope:=private.real_ai_service_paid_scope(p_case,p_revision,p_input_sha);event:=gen_random_uuid();event_predecessor:=prior_event;
  select coalesce(max(sequence),0)+1 into next_sequence from private.real_service_activation_enrollments where case_id=p_case;
  insert into private.real_ai_service_enrollment_events(event_id,case_id,identity_id,sequence,predecessor_id,configuration_sha256,service_decision_sha256,
   purpose,namespace,environment,kind,purchased_scope,purchased_scope_sha256,idempotency_key,issued_at,expires_at,reason)
  values(event,p_case,p_identity,next_sequence,prior_event,p->>'configuration_sha256',p->>'service_decision_sha256','real_customer_service','real',p->>'environment','granted',scope,m->>'purchased_scope_sha256',
   'activation:'||private.real_ai_service_json_sha(jsonb_build_array(p_plan_sha,p_case,p_identity,m->>'purchased_scope_sha256')),clock_timestamp(),(m->>'expires_at')::timestamptz,'Derived from authenticated immutable REAL activation plan');
  insert into private.real_service_activation_enrollments(event_id,case_id,plan_sha256,sequence,predecessor_event_id,source_revision,source_sha256,capability_sha256,context_sha256,purchased_scope_sha256)
  values(event,p_case,p_plan_sha,next_sequence,prior_event,p_revision,p_input_sha,encode(sha256(convert_to(p_capability,'UTF8')),'hex'),p_expected_context,m->>'purchased_scope_sha256');
  perform private.real_ai_service_refresh_dispatch(p_case);
 else select predecessor_event_id into event_predecessor from private.real_service_activation_enrollments where event_id=event;end if;
 return jsonb_build_object('state','enrolled','selector',m->'selector','event_id',event,'predecessor_event_id',event_predecessor,'replayed',replayed,'context_sha256',p_expected_context,
  'purchased_scope_sha256',m->>'purchased_scope_sha256','authority_dependency_sha256',private.real_ai_service_dependency(p_case),'expires_at',m->>'expires_at');
end;$$;

-- Downstream integration below is part of this proposal, not an optional hook.
-- Manual token bytes remain unchanged; parent transitions refresh derived jobs.
create function private.real_service_activation_plan_changed() returns trigger language plpgsql security invoker set search_path='' as $$
declare c uuid;begin
 for c in select distinct b.case_id from private.real_service_activation_enrollments b join private.real_service_activation_plans p on p.payload_sha256=b.plan_sha256
  where p.plan_id=new.plan_id order by b.case_id loop perform private.real_ai_service_refresh_dispatch(c);end loop;
 return new;
end;$$;
create trigger real_service_activation_plan_changed after insert on private.real_service_activation_plans for each row execute function private.real_service_activation_plan_changed();

create function private.real_service_activation_manual_dependency(p_case uuid) returns text
language sql stable security definer set search_path='' as $$
 select encode(sha256(convert_to(private.governance_jsonb_compact_text(jsonb_build_object(
  'schema_version','real-ai-service-enrollment-dependency-v1','event_id',e.event_id,'case_id',e.case_id,'identity_id',e.identity_id,
  'sequence',e.sequence,'configuration_sha256',e.configuration_sha256,'service_decision_sha256',e.service_decision_sha256,
  'purpose',e.purpose,'namespace',e.namespace,'environment',e.environment,'database_name',e.database_name,'kind',e.kind,
  'purchased_scope_sha256',e.purchased_scope_sha256,
  'issued_at',to_char(e.issued_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'expires_at',to_char(e.expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'revocations',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'target_sha256',r.target_sha256,
   'effective_at',to_char(r.effective_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) order by r.id)
   from private.real_ai_service_revocations r where r.case_id=e.case_id),'[]'::jsonb))),'UTF8')),'hex')
 from private.real_ai_service_enrollment_events e where e.case_id=p_case order by e.sequence desc limit 1
$$;

-- Exact additive wrapper: preserve all historical manual dependency bytes.
create or replace function private.real_ai_service_dependency(p_case uuid) returns text language sql stable security definer set search_path='' as $$
 select case when b.event_id is null then private.real_service_activation_manual_dependency(p_case)
 else private.real_ai_service_json_sha(jsonb_build_object('schema_version','real-service-activation-dependency-v1',
  'enrollment_dependency_sha256',private.real_service_activation_manual_dependency(p_case),'plan_sha256',b.plan_sha256,
  'parent_head_sha256',(select n.payload_sha256 from private.real_service_activation_plans n where n.plan_id=p.plan_id order by n.revision desc limit 1))) end
 from (select 1) seed left join lateral(select * from private.real_service_activation_enrollments x where x.case_id=p_case order by x.sequence desc limit 1) b on true
 left join private.real_service_activation_plans p on p.payload_sha256=b.plan_sha256
$$;

-- Guard both execution and exact already-published artifact reads. These
-- catalog replacements fail loudly if the reviewed integration anchors change.
-- Parent loss is never absence and therefore cannot fall through to owner/DEV.
do $hooks$ declare b text;needle text;replacement text;begin
 b:=pg_get_functiondef('private.real_ai_service_processing_context(uuid,integer,text)'::regprocedure);
 needle:='token:=private.real_ai_service_dependency(p_case);';
 if position(needle in b)=0 then raise exception 'REAL_ACTIVATION_PROCESSING_HOOK_MISSING';end if;
 replacement:=needle||E'\n if not private.real_service_activation_parent_current(p_case) then return jsonb_build_object(''state'',''unavailable'',''reason'',''revoked'',''dependency_sha256'',token);end if;';
 b:=replace(b,needle,replacement);
 needle:='select least(e.expires_at,min((r->>''effective_at'')::timestamptz)) into until_time from jsonb_array_elements(revocations) r;';
 if position(needle in b)=0 then raise exception 'REAL_ACTIVATION_PROCESSING_EXPIRY_HOOK_MISSING';end if;
 execute replace(b,needle,needle||E'\n until_time:=least(until_time,private.real_service_activation_parent_until(p_case));');
 b:=pg_get_functiondef('private.real_ai_service_delivery_material(uuid,uuid,uuid,boolean)'::regprocedure);
 -- Insert before the enrollment's existing granted/live guard, preserving
-- SQL 202's notification-parent changes (this patches only delivery material).
 needle:='if e.kind';
 if position(needle in b)=0 then raise exception 'REAL_ACTIVATION_DELIVERY_HOOK_MISSING';end if;
 replacement:=E'if not private.real_service_activation_parent_current(p_case) then return jsonb_build_object(''state'',''unavailable'',''reason'',''revoked'');end if;\n if e.kind';
 b:=replace(b,needle,replacement);
 needle:='select least(until_time,min((r->>''effective_at'')::timestamptz)) into until_time from jsonb_array_elements(revocations) r;';
 if position(needle in b)=0 then raise exception 'REAL_ACTIVATION_DELIVERY_EXPIRY_HOOK_MISSING';end if;
 execute replace(b,needle,needle||E'\n until_time:=least(until_time,private.real_service_activation_parent_until(p_case));');
end;$hooks$;

create function private.real_service_activation_worker_context(p_case uuid,p_plan_sha text,p_build text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare b private.real_service_activation_enrollments;e private.real_ai_service_enrollment_events;p jsonb;h private.case_input_heads;at_time timestamptz:=clock_timestamp();begin
 perform private.real_ai_service_assert_worker(p_case);
 perform 1 from public.cases where id=p_case and is_qa is false for update;
 if not found then return jsonb_build_object('state','unavailable','reason','not_enrolled');end if;
 at_time:=clock_timestamp();
 select * into b from private.real_service_activation_enrollments where case_id=p_case order by sequence desc limit 1;
 if b.event_id is null then return jsonb_build_object('state','unavailable','reason','not_enrolled');end if;
 if b.plan_sha256<>p_plan_sha or not private.real_service_activation_parent_current(p_case) then return jsonb_build_object('state','unavailable','reason','revoked');end if;
 select payload into p from private.real_service_activation_plans where payload_sha256=b.plan_sha256;
 select * into e from private.real_ai_service_enrollment_events where case_id=p_case order by sequence desc limit 1;
 if e.event_id is distinct from b.event_id or e.kind<>'granted' then return jsonb_build_object('state','unavailable','reason','revoked');end if;
 if e.expires_at<=at_time then return jsonb_build_object('state','unavailable','reason','expired');end if;
 if p->>'build_manifest_sha256' is distinct from p_build or p->>'database_name' is distinct from current_database()
  or e.environment is distinct from p->>'environment' or e.configuration_sha256 is distinct from p->>'configuration_sha256'
  or e.service_decision_sha256 is distinct from p->>'service_decision_sha256'
  then return jsonb_build_object('state','unavailable','reason','scope_changed');end if;
 select * into h from private.case_input_heads where case_id=p_case;
 if e.purchased_scope is distinct from private.real_ai_service_paid_scope(p_case,h.revision,h.input_sha256)
  or not exists(select 1 from public.case_identity_cases where case_id=p_case and identity_id=e.identity_id)
  then return jsonb_build_object('state','unavailable','reason','scope_changed');end if;
 -- SQL confirms an actual current machine SID/JTI through assert_worker.
 -- Issuer/deployment identity is independently verified by the REAL host.
 return jsonb_build_object('state','authorized','plan',p,'case_id',p_case,'identity_id',e.identity_id,'enrollment_id',e.event_id,
  'evaluated_at',at_time,'expires_at',least(e.expires_at,private.real_service_activation_parent_until(p_case)),'authority_dependency_sha256',private.real_ai_service_dependency(p_case));
end;$$;
do $acl$ declare r record;begin
 for r in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname like 'real_service_activation_%' loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime',r.signature);
 end loop;
end;$acl$;
grant execute on function private.real_service_activation_worker_context(uuid,text,text),private.real_service_activation_context(text,uuid,uuid,integer,text,text,text),private.real_service_activation_enroll(text,uuid,uuid,integer,text,text,text,text) to tivdoc_worker_runtime;
