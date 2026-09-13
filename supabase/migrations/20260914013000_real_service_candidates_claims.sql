-- Created with Supabase CLI on2026-09-13, ordered after206.
-- DEV-reviewed controller/claim boundary; no authority or budget policy seeded.
-- No credentials, policies, budget balances, grants or customer enrollments are
-- seeded. Root must validate actual roles/SQL and approve policy evidence first.
-- This is a ledger attached to existing engine_durable_jobs, NOT another queue.
-- A policy artifact is actual stored bytes. No runtime JSON manufactures budget.

create table private.real_service_budget_ledgers(
 policy_sha256 text primary key references private.real_ai_service_evidence_artifacts(sha256),
 opened_at timestamptz not null default clock_timestamp(),opened_by name not null default session_user
);
create table private.real_service_claim_reservations(
 reservation_id uuid primary key default gen_random_uuid(),
 policy_sha256 text not null references private.real_service_budget_ledgers(policy_sha256),
 case_id uuid not null references public.cases(id),identity_id uuid not null references public.case_identities(id),
 plan_sha256 text not null references private.real_service_activation_plans(payload_sha256),
 enrollment_id uuid not null references private.real_ai_service_enrollment_events(event_id),
 job_id text not null,fencing_token bigint not null check(fencing_token>0),worker_id text not null,
 source_revision integer not null,source_sha256 text not null,authority_dependency_sha256 text not null,
 candidate_sha256 text not null,extraction_mode text not null check(extraction_mode in('saved_receipts_only','budgeted_provider')),
 reserved_micro_usd bigint not null check(reserved_micro_usd>=0),maximum_calls integer not null check(maximum_calls>=0),
 issued_at timestamptz not null default clock_timestamp(),expires_at timestamptz not null,
 unique(job_id,fencing_token),check(issued_at<expires_at),
 check((extraction_mode='saved_receipts_only' and reserved_micro_usd=0 and maximum_calls=0)
  or(extraction_mode='budgeted_provider' and reserved_micro_usd>0 and maximum_calls>0))
);
create table private.real_service_provider_requests(
 request_id uuid primary key default gen_random_uuid(),
 reservation_id uuid not null references private.real_service_claim_reservations(reservation_id),
 policy_sha256 text not null references private.real_service_budget_ledgers(policy_sha256),
 version_id uuid not null,source_sha256 text not null,request_sha256 text not null,
 request_kind text not null check(request_kind in('input_tokens','generation')),
 reserved_micro_usd bigint not null check(reserved_micro_usd>0),
 recorded_at timestamptz not null default clock_timestamp(),
 unique(policy_sha256,version_id,source_sha256,request_sha256,request_kind)
);
-- Append-only receipt, separate from reservation: missing receipt is UNKNOWN,
-- not failed/no-charge. Neither expiry nor lease change refunds a reservation.
create table private.real_service_provider_request_receipts(
 request_id uuid primary key references private.real_service_provider_requests(request_id),
 payload jsonb not null,payload_sha256 text not null,input_tokens bigint,
 recorded_at timestamptz not null default clock_timestamp(),
 check(input_tokens is null or input_tokens>=0),
 check(payload_sha256=private.real_ai_service_json_sha(payload))
);
do $acl$ declare t text;begin
 foreach t in array array['real_service_budget_ledgers','real_service_claim_reservations','real_service_provider_requests','real_service_provider_request_receipts'] loop
  execute format('alter table private.%I enable row level security',t);execute format('alter table private.%I force row level security',t);
  execute format('create policy tivdoc_owner_access on private.%I for all to tivdoc_dev_migrator using(true) with check(true)',t);
  execute format('revoke all on private.%I from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime',t);
  execute format('create trigger %I before update or delete on private.%I for each row execute function private.ai_release_immutable()',t||'_immutable',t);
 end loop;
end;$acl$;

-- Proposed exact POLICY ARTIFACT grammar. These are limits from independently
-- authorized source evidence, not invented prices. Registration is operator-only
-- and opens one finite ledger per artifact hash; new plans reuse that ledger.
-- No renewal, rollover, replenishment or balance-reset function is provided.
create function private.real_service_budget_policy(p_sha text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare p jsonb;bytes bytea;begin
 select content into bytes from private.real_ai_service_evidence_artifacts where sha256=p_sha;
 if bytes is null or encode(sha256(bytes),'hex') is distinct from p_sha then raise exception 'REAL_SERVICE_BUDGET_EVIDENCE_REQUIRED';end if;
 p:=convert_from(bytes,'UTF8')::jsonb;
 if not coalesce(p->>'schema_version'='real-service-provider-budget-policy-v1' and p->>'namespace'='real'
  and p->>'purpose'='real_customer_service' and p->>'database_name'=current_database()
  and length(p->>'target_id') between 1 and 200 and p->>'extraction_mode' in('saved_receipts_only','budgeted_provider')
  and jsonb_typeof(p->'maximum_claims')='number' and (p->>'maximum_claims')::bigint between 1 and 1000000
  and jsonb_typeof(p->'maximum_active_claims')='number' and (p->>'maximum_active_claims')::integer between 1 and 2
  and jsonb_typeof(p->'maximum_total_micro_usd')='number' and (p->>'maximum_total_micro_usd')::bigint>=0
  and jsonb_typeof(p->'maximum_claim_micro_usd')='number' and (p->>'maximum_claim_micro_usd')::bigint>=0
  and (p->>'maximum_claim_micro_usd')::bigint<=(p->>'maximum_total_micro_usd')::bigint
  and jsonb_typeof(p->'maximum_calls_per_claim')='number' and (p->>'maximum_calls_per_claim')::integer between 0 and 64
  and (p->>'issued_at')::timestamptz<(p->>'expires_at')::timestamptz,false)
  or (select count(*) from jsonb_object_keys(p))<>15 then raise exception 'REAL_SERVICE_BUDGET_POLICY_INVALID';end if;
 if p->>'extraction_mode'='saved_receipts_only' then
  if p->'provider_calls_allowed' is distinct from 'false'::jsonb or (p->>'maximum_total_micro_usd')::bigint<>0
   or (p->>'maximum_claim_micro_usd')::bigint<>0 or (p->>'maximum_calls_per_claim')::integer<>0
   or p->'request_limits' is distinct from 'null'::jsonb then raise exception 'REAL_SERVICE_NO_SPEND_POLICY_REQUIRED';end if;
 else
  if not coalesce(p->'provider_calls_allowed'='true'::jsonb and (p->>'maximum_claim_micro_usd')::bigint>0
   and (p->>'maximum_calls_per_claim')::integer>=2 and length(p#>>'{request_limits,model}') between 1 and 100
   and jsonb_typeof(p->'request_limits')='object' and (select count(*) from jsonb_object_keys(p->'request_limits'))=5
   and (p#>>'{request_limits,input_token_ceiling}')::bigint>0 and (p#>>'{request_limits,output_token_ceiling}')::bigint>0
   and (p#>>'{request_limits,count_reserved_micro_usd}')::bigint>0 and (p#>>'{request_limits,generation_reserved_micro_usd}')::bigint>0
   and (p#>>'{request_limits,count_reserved_micro_usd}')::bigint+(p#>>'{request_limits,generation_reserved_micro_usd}')::bigint<=(p->>'maximum_claim_micro_usd')::bigint,false)
   then raise exception 'REAL_SERVICE_FINITE_PROVIDER_POLICY_REQUIRED';end if;
 end if;
 return p;
end;$$;
create function private.real_service_budget_open(p_sha text) returns void
language plpgsql security invoker set search_path='' as $$ begin
 if session_user<>'tivdoc_dev_migrator' then raise exception 'REAL_SERVICE_OPERATOR_REQUIRED';end if;
 perform private.real_service_budget_policy(p_sha);
 insert into private.real_service_budget_ledgers(policy_sha256) values(p_sha) on conflict do nothing;
end;$$;

-- Controller capability permits bounded discovery, not a machine SID/JTI or
-- a claim. Return at most2 current, already-enrolled non-QA cases. No caller case
-- list and no customer document/contact data are returned. Plan/controller locks
-- precede any per-case lock; actual claims remain the existing durable-job API.
create function private.real_service_candidates(p_capability text,p_plan text,p_build text,p_target jsonb,p_limit integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare control private.real_service_activation_controllers;plan private.real_service_activation_plans;p jsonb;
 at_time timestamptz:=clock_timestamp();until_time timestamptz;items jsonb;begin
 if session_user<>'tivdoc_worker_runtime' or p_limit not between 1 and 2 or p_capability is null
  or p_capability!~'^[A-Za-z0-9._-]{32,256}$' then raise exception 'REAL_ACTIVATION_CONTROLLER_FORBIDDEN';end if;
 select * into control from private.real_service_activation_controllers where capability_sha256=encode(sha256(convert_to(p_capability,'UTF8')),'hex') for share;
 if control.plan_sha256 is distinct from p_plan or control.expires_at<=at_time or exists(select 1 from private.real_service_activation_controller_revocations r
  where r.capability_sha256=control.capability_sha256 and r.effective_at<=at_time) then raise exception 'REAL_ACTIVATION_CONTROLLER_FORBIDDEN';end if;
 select * into plan from private.real_service_activation_plans where payload_sha256=p_plan;p:=plan.payload;
 if p is null then raise exception 'REAL_ACTIVATION_PLAN_INVALID';end if;
 perform pg_advisory_xact_lock_shared(hashtextextended('real-service-plan:'||plan.plan_id::text,0));
 if p->>'state'<>'active' or plan.revision<>(select max(x.revision) from private.real_service_activation_plans x where x.plan_id=plan.plan_id)
  or p->>'database_name'<>current_database() or p->>'deployment_sha256'<>control.deployment_sha256
  or p->>'build_manifest_sha256'<>p_build then raise exception 'REAL_ACTIVATION_DEPLOYMENT_CHANGED';end if;
 if jsonb_typeof(p_target) is distinct from 'object' or (select count(*) from jsonb_object_keys(p_target))<>6
  or p_target->>'database_name' is distinct from current_database() or p_target->>'database_name' is distinct from p->>'database_name'
  or p_target->>'target_id' is distinct from p->>'target_id' or p_target->>'environment' is distinct from p->>'environment'
  or p_target->>'deployment_sha256' is distinct from p->>'deployment_sha256'
  or p_target->>'machine_issuer_sha256' is distinct from p->>'machine_issuer_sha256'
  or p_target->>'provider_budget_policy_sha256' is distinct from p->>'provider_budget_policy_sha256' then raise exception 'REAL_ACTIVATION_DEPLOYMENT_CHANGED';end if;
 until_time:=least(control.expires_at,(p->>'expires_at')::timestamptz);at_time:=clock_timestamp();
 if (p->>'issued_at')::timestamptz>at_time or until_time<=at_time then raise exception 'REAL_SERVICE_RUN_EXPIRED';end if;
 select coalesce(jsonb_agg(candidate order by case_id),'[]'::jsonb) into items from(
  select c.id case_id,jsonb_build_object('case_id',c.id,'identity_id',e.identity_id,'enrollment_id',e.event_id,'source_revision',h.revision,'source_sha256',h.input_sha256,
   'authority_dependency_sha256',d.authority_dependency_sha256,'plan_sha256',p_plan,
   'expires_at',least(until_time,e.expires_at,private.real_service_activation_parent_until(c.id))) candidate
  from public.cases c join private.case_input_heads h on h.case_id=c.id
  join private.case_input_versions v on v.case_id=h.case_id and v.revision=h.revision and v.input_sha256=h.input_sha256
  join private.case_analysis_dispatch d on d.case_id=c.id and d.revision=h.revision and d.mode='draft'
  join lateral(select * from private.real_service_activation_enrollments x where x.case_id=c.id order by sequence desc limit 1)b on b.plan_sha256=p_plan
  join lateral(select * from private.real_ai_service_enrollment_events x where x.case_id=c.id order by sequence desc limit 1)e on e.event_id=b.event_id and e.kind='granted'
  where c.is_qa is false and d.processing_profile='qualified_ai_v1' and d.authority_dependency_sha256=private.real_ai_service_dependency(c.id)
   and encode(sha256(convert_to(v.input::text,'UTF8')),'hex')=h.input_sha256 and e.expires_at>at_time
   and private.real_service_activation_parent_current(c.id) and private.real_service_activation_parent_until(c.id)>at_time
   and e.purchased_scope=private.real_ai_service_paid_scope(c.id,h.revision,h.input_sha256)
   and exists(select 1 from public.case_identity_cases ic where ic.case_id=c.id and ic.identity_id=e.identity_id)
   and not exists(select 1 from private.ai_release_enrollment_events x where x.case_id=c.id)
   and (d.job_id is null or exists(select 1 from public.engine_durable_jobs j where j.job_id=d.job_id and j.tenant_id='saved-case:'||c.id::text
    and j.canonical_case_id=c.id and not j.cancellation_requested and j.attempt_count<j.max_attempts
    and ((j.state in('queued','retry_wait') and j.available_at<=at_time) or(j.state in('leased','running') and j.lease_expires_at<=at_time)))
    or exists(select 1 from private.case_notification_outbox n join private.real_ai_service_notification_bindings nb on nb.delivery_id=n.delivery_id
     where n.case_id=c.id and nb.case_id=c.id and nb.identity_id=e.identity_id and nb.expires_at>at_time
      and (n.state='queued' or n.state='leased' and n.lease_expires_at<=at_time)
      and n.available_at<=at_time and n.expires_at>at_time and n.attempts<6))
  order by coalesce(d.dispatched_at,'-infinity'::timestamptz),c.id limit p_limit
 )selected;
 return jsonb_build_object('evaluated_at',at_time,'expires_at',until_time,'candidates',items);
end;$$;

-- Bounded maintenance under the EXISTING issuer grant, never authority renewal.
-- A selector may have no/expired machine; execution is still impossible until
-- this operation authenticates the live plan/enrollment and returns 205 proof.
-- Rotation cannot extend session expiry. Natural expiry uses existing issue,
-- which revokes the predecessor and retains an append-only provenance event.
create function private.real_service_machine_maintain(p_capability text,p_case uuid,p_identity uuid,p_plan text,p_enrollment uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare material jsonb;prior private.real_service_machine_events;result jsonb;request_hex text;request_uuid uuid;begin
 material:=private.real_service_machine_issuer_material(p_capability,p_case,p_identity,p_plan,p_enrollment,false);
 if material->>'state' is distinct from 'authorized' then return material;end if;
 -- issuer_material locks this exact case. Concurrent maintenance sees the
 -- committed successor instead of creating two new sessions for one expiry.
 select * into prior from private.real_service_machine_events where case_id=p_case order by sequence desc limit 1;
 request_hex:=private.real_ai_service_json_sha(jsonb_build_array('real-service-machine-maintenance-v1',material->>'capability_sha256',
  p_case,p_identity,p_plan,p_enrollment,prior.event_id,'issue'));
 request_uuid:=(substr(request_hex,1,8)||'-'||substr(request_hex,9,4)||'-4'||substr(request_hex,14,3)||'-8'||substr(request_hex,18,3)||'-'||substr(request_hex,21,12))::uuid;
 result:=private.real_service_machine_manage(p_capability,p_case,p_identity,p_plan,p_enrollment,request_uuid,'read');
 if result->>'state'='active' then return result;end if;
 if result->>'state' is distinct from 'unavailable' then return result;end if;
 if result->>'reason'='scope_changed' then
  -- Only an explicitly registered successor capability or a new live enrollment
  -- may cross this boundary; the original issue guards recheck both cases.
  if prior.identity_id is distinct from p_identity or prior.action='revoke'
   or not ((prior.capability_sha256 is distinct from material->>'capability_sha256'
      and private.real_service_machine_issuer_successor(material->>'capability_sha256',prior.capability_sha256))
     or (prior.plan_sha256=p_plan and prior.capability_sha256=material->>'capability_sha256' and prior.enrollment_id<>p_enrollment)) then return result;end if;
 elsif result->>'reason' not in('not_issued','expired') then return result;
 end if;
 -- Existing manage refuses revoked actual sessions, provenance/grant revocation,
 -- stale scope and unknown supersession. This wrapper does not suppress errors.
 return private.real_service_machine_manage(p_capability,p_case,p_identity,p_plan,p_enrollment,request_uuid,'issue');
end;$$;

-- Called AFTER claimSavedDraftJob in the SAME transaction. Failure rolls back
-- that claim. Every successful claim consumes finite policy escrow permanently;
-- spent/unknown amounts are never returned to capacity through worker expiry.
create function private.real_service_claim_admit(p_candidate jsonb,p_job_id text,p_fence bigint,p_worker text,p_policy text,p_mode text,p_build text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare ctx jsonb;policy jsonb;c uuid:=(p_candidate->>'case_id')::uuid;j public.engine_durable_jobs;
 r private.real_service_claim_reservations;old private.real_service_claim_reservations;at_time timestamptz;until_time timestamptz;spent numeric;claims bigint;active_claims bigint;begin
 ctx:=private.real_service_activation_worker_context(c,p_candidate->>'plan_sha256',p_build);
 if ctx->>'state' is distinct from 'authorized' or ctx->>'identity_id' is distinct from p_candidate->>'identity_id'
  or ctx->>'enrollment_id' is distinct from p_candidate->>'enrollment_id'
  or p_worker is distinct from private.runtime_verified_actor()
  or ctx->>'authority_dependency_sha256' is distinct from p_candidate->>'authority_dependency_sha256'
  or not private.real_service_machine_current(c,p_candidate->>'plan_sha256',(ctx->>'enrollment_id')::uuid)
  then raise exception 'REAL_SERVICE_RUN_CLAIM_ADMISSION';end if;
 if ctx#>>'{plan,provider_budget_policy_sha256}' is distinct from p_policy then raise exception 'REAL_SERVICE_BUDGET_EVIDENCE_REQUIRED';end if;
 select * into j from public.engine_durable_jobs where job_id=p_job_id and tenant_id='saved-case:'||c::text and canonical_case_id=c for update;
 at_time:=clock_timestamp();
 if j.job_id is null or j.state<>'running' or j.fencing_token<>p_fence or j.lease_owner<>p_worker or j.lease_expires_at<=at_time or j.cancellation_requested
  or j.job_kind<>'saved_case_analysis_v1' or j.payload->>'schema_version' is distinct from 'saved-case-work-v1'
  or j.payload->>'mode' is distinct from 'draft' or j.payload->>'processing_profile' is distinct from 'qualified_ai_v1'
  or j.payload->>'case_id'<>c::text or j.payload->>'input_sha256' is distinct from p_candidate->>'source_sha256'
  or j.payload->>'revision' is distinct from p_candidate->>'source_revision'
  or j.payload->>'authority_dependency_sha256' is distinct from p_candidate->>'authority_dependency_sha256'
  or not exists(select 1 from private.case_input_heads h where h.case_id=c and h.revision=(j.payload->>'revision')::integer and h.input_sha256=j.payload->>'input_sha256')
  then raise exception 'REAL_SERVICE_RUN_SCOPE';end if;
 -- Serialize EVERY plan/case sharing the same budget artifact. No LIMIT1 budget
 -- lookup and no per-process file ledger can spend the same authorization twice.
 perform 1 from private.real_service_budget_ledgers where policy_sha256=p_policy for update;
 if not found then raise exception 'REAL_SERVICE_BUDGET_EVIDENCE_REQUIRED';end if;
 policy:=private.real_service_budget_policy(p_policy);
 if policy->>'extraction_mode' is distinct from p_mode or policy->>'target_id' is distinct from ctx#>>'{plan,target_id}' then raise exception 'REAL_SERVICE_BUDGET_MODE';end if;
 at_time:=clock_timestamp();until_time:=least((ctx->>'expires_at')::timestamptz,(p_candidate->>'expires_at')::timestamptz,(policy->>'expires_at')::timestamptz,j.lease_expires_at);
 if (policy->>'issued_at')::timestamptz>at_time or until_time<=at_time then raise exception 'REAL_SERVICE_BUDGET_EXPIRED';end if;
 select * into old from private.real_service_claim_reservations where job_id=p_job_id and fencing_token=p_fence;
 if found then
  if old.case_id<>c or old.policy_sha256<>p_policy or old.plan_sha256<>p_candidate->>'plan_sha256' or old.worker_id<>p_worker
   or old.extraction_mode<>p_mode or old.candidate_sha256<>private.real_ai_service_json_sha(p_candidate) then raise exception 'REAL_SERVICE_CLAIM_RETRY_CHANGED';end if;
  r:=old;
 else
  select count(*),coalesce(sum(reserved_micro_usd),0) into claims,spent from private.real_service_claim_reservations where policy_sha256=p_policy;
  select count(*) into active_claims from private.real_service_claim_reservations x join public.engine_durable_jobs q on q.job_id=x.job_id and q.fencing_token=x.fencing_token
   where x.policy_sha256=p_policy and x.expires_at>at_time and q.state='running' and not q.cancellation_requested and q.lease_expires_at>at_time;
  if claims>=(policy->>'maximum_claims')::bigint or active_claims>=(policy->>'maximum_active_claims')::integer
   or spent+(policy->>'maximum_claim_micro_usd')::bigint>(policy->>'maximum_total_micro_usd')::bigint then raise exception 'REAL_SERVICE_BUDGET_EXHAUSTED';end if;
  insert into private.real_service_claim_reservations(policy_sha256,case_id,identity_id,plan_sha256,enrollment_id,job_id,fencing_token,worker_id,
   source_revision,source_sha256,authority_dependency_sha256,candidate_sha256,extraction_mode,reserved_micro_usd,maximum_calls,expires_at)
  values(p_policy,c,(ctx->>'identity_id')::uuid,p_candidate->>'plan_sha256',(ctx->>'enrollment_id')::uuid,p_job_id,p_fence,p_worker,
   (p_candidate->>'source_revision')::integer,p_candidate->>'source_sha256',p_candidate->>'authority_dependency_sha256',private.real_ai_service_json_sha(p_candidate),p_mode,
   (policy->>'maximum_claim_micro_usd')::bigint,(policy->>'maximum_calls_per_claim')::integer,until_time) returning * into r;
 end if;
 if r.expires_at<=at_time then raise exception 'REAL_SERVICE_BUDGET_EXPIRED';end if;
 return jsonb_build_object('state','admitted','reservation_id',r.reservation_id,'case_id',r.case_id,'job_id',r.job_id,'fencing_token',r.fencing_token,
  'source_sha256',r.source_sha256,'authority_dependency_sha256',r.authority_dependency_sha256,'plan_sha256',r.plan_sha256,
  'provider_budget_policy_sha256',r.policy_sha256,'extraction_mode',r.extraction_mode,'expires_at',r.expires_at);
end;$$;

-- Per-request reservations and receipt validation follow in208. Every runtime
-- mode remains bound to an independently registered policy. Revoke all default
-- helper access before granting the narrow worker and issuer RPC boundaries.
do $acl$ declare r record;begin
 for r in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='private' and p.proname in('real_service_budget_policy','real_service_budget_open','real_service_candidates','real_service_claim_admit','real_service_machine_maintain') loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role,tivdoc_identity_runtime,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime',r.signature);
 end loop;
end;$acl$;

grant execute on function private.real_service_candidates(text,text,text,jsonb,integer),
 private.real_service_claim_admit(jsonb,text,bigint,text,text,text,text) to tivdoc_worker_runtime;
grant execute on function private.real_service_machine_maintain(text,uuid,uuid,text,uuid) to tivdoc_identity_runtime;
