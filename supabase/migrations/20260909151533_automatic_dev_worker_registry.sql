-- One existing durable queue, with explicit isolated-DEV QA authorization.
-- No production host, customer enrollment or runtime session minting.
create table private.managed_dev_worker_capabilities (
 capability_sha256 text primary key check(capability_sha256 ~ '^[a-f0-9]{64}$'),
 enabled boolean not null default true, expires_at timestamptz not null,
 daily_limit integer not null default 20 check(daily_limit between 1 and 20),
 total_limit integer not null default 80 check(total_limit between 1 and 80),
 created_at timestamptz not null default clock_timestamp(),
 check(expires_at>created_at and expires_at<=created_at+interval '7 days')
);
create table private.managed_dev_worker_cases (
 case_id uuid primary key references public.cases(id) on delete cascade,
 identity_id uuid not null references public.case_identities(id),
 session_sid text not null references public.product_identity_sessions(sid),
 capability_sha256 text not null references private.managed_dev_worker_capabilities(capability_sha256),
 enabled boolean not null default true, created_at timestamptz not null default clock_timestamp(),
 stopped_at timestamptz, last_checked_at timestamptz, last_error_code text,
 last_job_id text,last_fence bigint,
 check(last_error_code is null or last_error_code ~ '^[a-z][a-z0-9_]{2,95}$')
);
create table private.managed_dev_worker_claims (
 job_id text not null, fence bigint not null, case_id uuid not null,
 capability_sha256 text not null references private.managed_dev_worker_capabilities(capability_sha256),
 claimed_at timestamptz not null default clock_timestamp(),primary key(job_id,fence)
);
create table private.managed_dev_worker_retries (
 job_id text not null, expected_revision bigint not null, accepted_revision bigint not null,
 case_id uuid not null references public.cases(id) on delete cascade,
 requested_at timestamptz not null default clock_timestamp(),primary key(job_id,expected_revision)
);
alter table private.managed_dev_worker_capabilities enable row level security;
alter table private.managed_dev_worker_cases enable row level security;
alter table private.managed_dev_worker_claims enable row level security;
alter table private.managed_dev_worker_retries enable row level security;
revoke all on private.managed_dev_worker_capabilities,private.managed_dev_worker_cases,private.managed_dev_worker_claims,private.managed_dev_worker_retries from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

create function private.managed_dev_worker_enrollment_guard() returns trigger
 language plpgsql security definer set search_path='' as $$
begin
 if current_database()<>'tivdoc_release_replay_20260907' or session_user<>'tivdoc_dev_migrator' then raise exception 'MANAGED_DEV_ENROLLMENT_FORBIDDEN';end if;
 if not exists(select 1 from public.cases c join public.case_identity_cases i on i.case_id=c.id
  join public.product_identity_sessions s on s.sid=new.session_sid
  where c.id=new.case_id and c.is_qa and c.check_period_month='2026-06-01' and c.contact_verified_at is not null
   and i.identity_id=new.identity_id and s.tenant_id='saved-case:'||c.id::text and s.reviewer_org_id is null
   and s.revoked_at is null and s.valid_after<=clock_timestamp() and s.expires_at>clock_timestamp()
   and exists(select 1 from private.product_orders o join private.order_entitlements e on e.order_id=o.id
    where o.case_id=c.id and o.kind='initial' and o.state='paid' and o.refund_state<>'refunded' and e.state='active'
     and o.period_from='2026-06-01' and o.period_to='2026-06-01' and o.topics=array['minimum_wage']::text[])) then raise exception 'MANAGED_DEV_ENROLLMENT_SCOPE';end if;
 return new;
end;$$;
create trigger managed_dev_enrollment_guard before insert or update of case_id,identity_id,session_sid,capability_sha256 on private.managed_dev_worker_cases for each row execute function private.managed_dev_worker_enrollment_guard();

create function private.managed_dev_worker_capability(target_capability text) returns text
 language plpgsql security definer set search_path='' as $$
declare digest text;
begin
 if current_database()<>'tivdoc_release_replay_20260907' or session_user<>'tivdoc_worker_runtime'
  or target_capability is null or target_capability!~'^[A-Za-z0-9._-]{32,256}$' then raise exception 'MANAGED_DEV_CAPABILITY_FORBIDDEN';end if;
 digest:=encode(sha256(convert_to(target_capability,'UTF8')),'hex');
 if not exists(select 1 from private.managed_dev_worker_capabilities c where c.capability_sha256=digest and c.enabled and c.expires_at>clock_timestamp()) then raise exception 'MANAGED_DEV_CAPABILITY_FORBIDDEN';end if;
 return digest;
end;$$;

create function private.managed_dev_worker_candidates(target_capability text,target_limit integer) returns table(case_id uuid,identity jsonb)
 language plpgsql security definer set search_path='' as $$
declare digest text:=private.managed_dev_worker_capability(target_capability);
begin
 if target_limit is null or target_limit not between 1 and 2 then raise exception 'MANAGED_DEV_LIMIT_INVALID';end if;
 return query select r.case_id,jsonb_build_object('session_id',s.sid,'token_id',s.current_jti,'tenant_id',s.tenant_id,'actor_id',s.subject,'reviewer_organization_id',null,'rotation_counter',s.rotation_counter)
 from private.managed_dev_worker_cases r join public.cases c on c.id=r.case_id
 join public.product_identity_sessions s on s.sid=r.session_sid
 join private.case_input_heads h on h.case_id=r.case_id
 left join private.case_analysis_dispatch d on d.case_id=r.case_id and d.revision=h.revision and d.mode='draft'
 left join public.engine_durable_jobs j on j.job_id=d.job_id and j.canonical_case_id=r.case_id::text
 where r.capability_sha256=digest and r.enabled and c.is_qa and c.check_period_month='2026-06-01'
  and s.tenant_id='saved-case:'||r.case_id::text and s.revoked_at is null and s.valid_after<=clock_timestamp() and s.expires_at>clock_timestamp()
  and exists(select 1 from public.case_identity_cases i where i.case_id=r.case_id and i.identity_id=r.identity_id)
  and exists(select 1 from private.product_orders o join private.order_entitlements e on e.order_id=o.id
   where o.case_id=r.case_id and o.kind='initial' and o.state='paid' and o.refund_state<>'refunded' and e.state='active'
    and o.period_from='2026-06-01' and o.period_to='2026-06-01' and o.topics=array['minimum_wage']::text[])
  and (select count(*) from private.product_orders o join private.order_entitlements e on e.order_id=o.id where o.case_id=r.case_id and o.state='paid' and o.refund_state<>'refunded' and e.state='active')=1
  and (select count(*) from public.documents doc where doc.case_id=r.case_id and doc.document_type='payslip')=1
  and exists(select 1 from public.documents doc where doc.case_id=r.case_id and doc.document_type='payslip' and doc.period_month='2026-06-01')
  and exists(select 1 from private.managed_dev_worker_capabilities b where b.capability_sha256=digest
   and (select count(*) from private.managed_dev_worker_claims x where x.capability_sha256=digest)<b.total_limit
   and (select count(*) from private.managed_dev_worker_claims x where x.capability_sha256=digest and x.claimed_at>=(date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC'))<b.daily_limit)
  and (j.job_id is null or (not j.cancellation_requested and ((j.state in ('queued','retry_wait') and j.available_at<=clock_timestamp())
   or (j.state in ('leased','running') and j.lease_expires_at<=clock_timestamp()))))
 order by coalesce(j.available_at,r.created_at),r.case_id limit target_limit;
end;$$;

create function private.managed_dev_worker_admit_claim(target_case uuid,target_job text,target_fence bigint) returns void
 language plpgsql security definer set search_path='' as $$
declare r private.managed_dev_worker_cases; c private.managed_dev_worker_capabilities;
begin
 if current_database()<>'tivdoc_release_replay_20260907' or session_user<>'tivdoc_worker_runtime'
  or private.runtime_verified_tenant() is distinct from 'saved-case:'||target_case::text then raise exception 'MANAGED_DEV_CLAIM_FORBIDDEN';end if;
 perform 1 from public.cases where id=target_case and is_qa for update;
 if not found then raise exception 'MANAGED_DEV_CLAIM_FORBIDDEN';end if;
 select * into r from private.managed_dev_worker_cases where case_id=target_case and enabled
  and session_sid=current_setting('tivdoc.identity_sid',true);
 if not found then raise exception 'MANAGED_DEV_CLAIM_FORBIDDEN';end if;
 perform 1 from public.engine_durable_jobs j join private.case_input_heads h on h.case_id=target_case
  where j.job_id=target_job and j.tenant_id='saved-case:'||target_case::text and j.canonical_case_id=target_case::text
   and j.job_kind='saved_case_analysis_v1' and j.payload->>'input_sha256'=h.input_sha256 and (j.payload->>'revision')::integer=h.revision
   and j.state='running' and j.fencing_token=target_fence and j.lease_expires_at>clock_timestamp()
   and j.lease_owner=private.runtime_verified_actor() for update of j;
 if not found then raise exception 'MANAGED_DEV_CLAIM_FENCE';end if;
 select * into c from private.managed_dev_worker_capabilities where capability_sha256=r.capability_sha256 for update;
 if not c.enabled or c.expires_at<=clock_timestamp() then raise exception 'MANAGED_DEV_CAPABILITY_FORBIDDEN';end if;
 if exists(select 1 from private.managed_dev_worker_claims where job_id=target_job and fence=target_fence and case_id=target_case) then return;end if;
 if (select count(*) from private.managed_dev_worker_claims x where x.capability_sha256=c.capability_sha256)>=c.total_limit
  or (select count(*) from private.managed_dev_worker_claims x where x.capability_sha256=c.capability_sha256 and x.claimed_at>=date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC')>=c.daily_limit then raise exception 'MANAGED_DEV_BUDGET_EXHAUSTED';end if;
 insert into private.managed_dev_worker_claims(job_id,fence,case_id,capability_sha256) values(target_job,target_fence,target_case,c.capability_sha256);
 update private.managed_dev_worker_cases set last_checked_at=clock_timestamp(),last_job_id=target_job,last_fence=target_fence,last_error_code=null where case_id=target_case;
end;$$;

create function private.managed_dev_worker_note(target_case uuid,target_job text,target_fence bigint,target_error text) returns void
 language plpgsql security definer set search_path='' as $$
begin
 if current_database()<>'tivdoc_release_replay_20260907' or session_user<>'tivdoc_worker_runtime'
  or private.runtime_verified_tenant() is distinct from 'saved-case:'||target_case::text then raise exception 'MANAGED_DEV_NOTE_FORBIDDEN';end if;
 if target_error is not null and target_error not in ('provider_outcome_unknown','provider_disabled','provider_unconfigured','period_confirmation_required','purchased_document_missing','entitlement_unavailable','payment_unavailable','source_superseded','worker_interrupted','worker_lease_lost','worker_scope_forbidden','scope_unsupported','scenario_unsupported','canonical_confirmation_required','processing_failed','canonical_activation_blocked') then raise exception 'MANAGED_DEV_NOTE_INVALID';end if;
 perform 1 from public.cases where id=target_case for update;
 if not exists(select 1 from public.engine_durable_jobs j join private.case_input_heads h on h.case_id=target_case
  where j.job_id=target_job and j.canonical_case_id=target_case::text and j.fencing_token=target_fence
   and j.payload->>'input_sha256'=h.input_sha256 and (target_error is null or j.state<>'succeeded')) then return;end if;
 update private.managed_dev_worker_cases set last_checked_at=clock_timestamp(),last_error_code=target_error
  where case_id=target_case and enabled and session_sid=current_setting('tivdoc.identity_sid',true) and last_job_id=target_job and last_fence=target_fence;
end;$$;

create function private.managed_dev_worker_status(target_capability text) returns table(case_id uuid,state text,input_revision bigint,job_id text,job_revision bigint,attempt_count integer,max_attempts integer,next_attempt_at timestamptz,last_error text,current_run_id uuid,updated_at timestamptz)
 language plpgsql security definer set search_path='' as $$
declare digest text:=private.managed_dev_worker_capability(target_capability);
begin
 return query select r.case_id,
  case when (select count(*) from public.documents doc where doc.case_id=r.case_id and doc.document_type='payslip')>1 then 'failed'
   when (select count(*) from private.product_orders o join private.order_entitlements e on e.order_id=o.id where o.case_id=r.case_id and o.state='paid' and o.refund_state<>'refunded' and e.state='active')<>1 then 'failed'
   when (select count(*) from private.managed_dev_worker_claims x where x.capability_sha256=digest)>=b.total_limit
    or (select count(*) from private.managed_dev_worker_claims x where x.capability_sha256=digest and x.claimed_at>=(date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC'))>=b.daily_limit then 'failed'
   when not r.enabled or s.revoked_at is not null or s.expires_at<=clock_timestamp() then 'failed'
   when j.state in ('leased','running') and j.lease_expires_at>clock_timestamp() then 'processing'
   when j.state in ('dead_letter','cancelled') then 'failed'
   when exists(select 1 from public.case_requests q where q.case_id=r.case_id and q.answered_at is null and q.expires_at>clock_timestamp() and (
    exists(select 1 from private.document_field_targets t where t.request_id=q.id and t.case_id=r.case_id and private.document_field_current(r.case_id,t.target))
    or exists(select 1 from private.dev_financial_request_targets t where t.request_id=q.id and t.case_id=r.case_id and private.dev_financial_source_current(r.case_id,t.order_id,t.version_id,t.source_sha256)))) then 'awaiting_input'
   when j.state='succeeded' and f.payload#>>'{calculation,state}'='calculated' then 'complete' else 'waiting' end,
  h.revision::bigint,j.job_id,j.revision::bigint,coalesce(j.attempt_count,0),coalesce(j.max_attempts,3),
  case when j.state in ('queued','retry_wait') then j.available_at else null end,
  case when (select count(*) from public.documents doc where doc.case_id=r.case_id and doc.document_type='payslip')>1 then 'scope_unsupported'
   when (select count(*) from private.product_orders o join private.order_entitlements e on e.order_id=o.id where o.case_id=r.case_id and o.state='paid' and o.refund_state<>'refunded' and e.state='active')<>1 then 'entitlement_unavailable'
   when (select count(*) from private.managed_dev_worker_claims x where x.capability_sha256=digest)>=b.total_limit
    or (select count(*) from private.managed_dev_worker_claims x where x.capability_sha256=digest and x.claimed_at>=(date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC'))>=b.daily_limit then 'worker_budget_exhausted'
   when not r.enabled then 'worker_paused' when s.revoked_at is not null or s.expires_at<=clock_timestamp() then 'worker_session_expired'
   when j.state='succeeded' and f.id is null then 'canonical_activation_blocked' else r.last_error_code end,
  f.id,coalesce(r.last_checked_at,r.created_at)
 from private.managed_dev_worker_cases r join public.product_identity_sessions s on s.sid=r.session_sid
 join private.managed_dev_worker_capabilities b on b.capability_sha256=r.capability_sha256
 left join private.case_input_heads h on h.case_id=r.case_id
 left join private.case_analysis_dispatch d on d.case_id=r.case_id and d.revision=h.revision and d.mode='draft'
 left join public.engine_durable_jobs j on j.job_id=d.job_id
 left join lateral(select f0.* from private.dev_financial_runs f0 join private.product_orders o on o.id=f0.order_id where f0.case_id=r.case_id and f0.input_revision=h.revision and f0.input_sha256=h.input_sha256 and o.state='paid' and o.refund_state<>'refunded' order by f0.created_at desc,f0.id limit 1) f on true
 where r.capability_sha256=digest order by r.created_at,r.case_id limit 20;
end;$$;

create function private.managed_dev_worker_retry(target_capability text,target_case uuid,expected_job text,expected_revision bigint) returns table(job_id text,job_revision bigint,replayed boolean)
 language plpgsql security definer set search_path='' as $$
declare digest text:=private.managed_dev_worker_capability(target_capability);j public.engine_durable_jobs;r private.managed_dev_worker_retries;
begin
 perform 1 from public.cases c join private.managed_dev_worker_cases m on m.case_id=c.id
  where c.id=target_case and c.is_qa and m.enabled and m.capability_sha256=digest for update of c;
 if not found then raise exception 'MANAGED_DEV_RETRY_FORBIDDEN';end if;
 select * into j from public.engine_durable_jobs x where x.job_id=expected_job and x.canonical_case_id=target_case::text for update;
 if not found or j.job_kind<>'saved_case_analysis_v1' or not exists(select 1 from private.case_input_heads h where h.case_id=target_case and h.input_sha256=j.payload->>'input_sha256' and h.revision=(j.payload->>'revision')::integer) then raise exception 'MANAGED_DEV_RETRY_STALE';end if;
 select * into r from private.managed_dev_worker_retries x where x.job_id=expected_job and x.expected_revision=managed_dev_worker_retry.expected_revision;
 if found then return query select r.job_id,r.accepted_revision,true;return;end if;
 if not exists(select 1 from private.managed_dev_worker_cases m join public.product_identity_sessions sess on sess.sid=m.session_sid
  join public.case_identity_cases i on i.case_id=m.case_id and i.identity_id=m.identity_id
  where m.case_id=target_case and sess.revoked_at is null and sess.expires_at>clock_timestamp()
   and exists(select 1 from private.product_orders o join private.order_entitlements e on e.order_id=o.id where o.case_id=target_case and o.state='paid' and o.refund_state<>'refunded' and e.state='active' and o.period_from='2026-06-01' and o.period_to='2026-06-01' and o.topics=array['minimum_wage']::text[])) then raise exception 'MANAGED_DEV_RETRY_FORBIDDEN';end if;
 if j.revision<>expected_revision or j.state<>'dead_letter' or j.max_attempts>=5 or j.cancellation_requested then raise exception 'MANAGED_DEV_RETRY_STATE';end if;
 if exists(select 1 from private.case_extraction_invocations x join public.documents d on d.case_id=x.case_id and d.version_id=x.version_id and d.content_sha256=x.input_sha256 where x.case_id=target_case and x.policy_version='saved-payslip-v21-p95-v1' and x.result is null) then raise exception 'SAVED_EXTRACTION_OUTCOME_PENDING';end if;
 update public.engine_durable_jobs set state='queued',revision=revision+1,max_attempts=max_attempts+1,available_at=clock_timestamp(),updated_at=clock_timestamp() where engine_durable_jobs.job_id=expected_job;
 insert into private.managed_dev_worker_retries values(expected_job,expected_revision,j.revision+1,target_case,clock_timestamp());
 return query select expected_job,j.revision+1,false;
end;$$;

revoke all on function private.managed_dev_worker_enrollment_guard(),private.managed_dev_worker_capability(text),private.managed_dev_worker_candidates(text,integer),private.managed_dev_worker_admit_claim(uuid,text,bigint),private.managed_dev_worker_note(uuid,text,bigint,text),private.managed_dev_worker_status(text),private.managed_dev_worker_retry(text,uuid,text,bigint) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function private.managed_dev_worker_candidates(text,integer),private.managed_dev_worker_admit_claim(uuid,text,bigint),private.managed_dev_worker_note(uuid,text,bigint,text),private.managed_dev_worker_status(text),private.managed_dev_worker_retry(text,uuid,text,bigint) to tivdoc_worker_runtime;

-- The canonical result can be staged in the existing product report contract.
-- This deliberately does not change report_ai_publish or allow empty reports.
create table private.automatic_dev_canonical_reports (
 projection_id uuid primary key references public.case_report_projections(id) on delete cascade,
 case_id uuid not null references public.cases(id) on delete cascade,order_id uuid not null,
 input_revision integer not null,input_sha256 text not null,parent_run_id text not null,parent_result_sha256 text not null,
 unique(case_id,order_id,input_revision)
);
alter table private.automatic_dev_canonical_reports enable row level security;
revoke all on private.automatic_dev_canonical_reports from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create policy automatic_dev_projection_writer on public.case_report_projections for insert to CURRENT_USER
 with check(current_database()='tivdoc_release_replay_20260907' and session_user='tivdoc_worker_runtime' and private.runtime_verified_tenant()='saved-case:'||case_id::text
  and report_document->>'schema_version'='tivdoc-report-document-v3' and report_document#>>'{publication,state}'='draft');
create function private.automatic_dev_canonical_draft_save(body jsonb,target_parent text,target_result_sha text) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare source jsonb;parent public.analysis_runs;prior private.automatic_dev_canonical_reports;projection jsonb:=body->'projection';expected_topics jsonb;
begin
 source:=private.dev_financial_admit((body->>'case_id')::uuid,(body->>'order_id')::uuid,(body->>'revision')::integer,body->>'input_sha256');
 select * into parent from public.analysis_runs a where a.tenant_id='saved-case:'||(body->>'case_id') and a.canonical_analysis_run_id=target_parent and a.status='completed';
 if not found or parent.completion_payload#>>'{bundle,result_sha256}' is distinct from target_result_sha
  or parent.command_payload->>'document_snapshot_id' is distinct from 'saved-documents:2026-06:'||(body->>'input_sha256')
  or parent.command_payload#>>'{period,start_date}' is distinct from '2026-06-01'
  or parent.command_payload#>>'{period,end_date}' is distinct from '2026-06-30'
  or parent.command_payload->'requested_topics' is distinct from '["minimum_wage"]'::jsonb
  or exists(select 1 from jsonb_array_elements(parent.completion_payload#>'{bundle,topic_results}') t where t->>'status' in ('calculated','not_applicable') or t->'amount'<>'null'::jsonb or t->'trace'<>'null'::jsonb)
  then raise exception 'AUTOMATIC_DEV_CANONICAL_PARENT_REQUIRED';end if;
 select jsonb_agg(jsonb_build_object('topic',topic,'branches_examined','[]'::jsonb,'parameter_grades','{}'::jsonb,'gate','awaiting_verification','activation','awaiting_verification','status','not_checked','customer_text','ממתין לאימות בסיום הפיתוח','blocked_by_grades','["draft"]'::jsonb) order by ord)
 into expected_topics from unnest(array['minimum_wage','working_time','pension','travel','convalescence','vacation','sick_leave']) with ordinality as t(topic,ord);
 if body->>'schema_version' is distinct from 'tivdoc-report-document-v3' or body->>'service_kind' is distinct from 'ai_assisted'
  or body->>'publication_policy' is distinct from 'tivdoc-ai-publication-v1'
  or body->'publication' is distinct from '{"state":"draft","approval_actor_kind":"automation","approved_input_sha256":null,"published_at":null}'::jsonb
  or body->'findings' is distinct from '[]'::jsonb or body->'evidence' is distinct from '[]'::jsonb
  or body->'purchased_period' is distinct from '{"from":"2026-06","to":"2026-06"}'::jsonb
  or body->>'order_offer_sha256' is distinct from (select offer_sha256 from private.product_orders where id=(body->>'order_id')::uuid)
  or projection is distinct from jsonb_build_object('schema_version','tivdoc-case-report-projection-v1','case_public_id',source->>'public_id',
   'check_period_month','2026-06','months_covered','["2026-06"]'::jsonb,'report_kind','initial','legal_basis','opinion_3ddad7e8 + errata_1_owner_closed','generated_at',projection->>'generated_at','topics',expected_topics)
  or (projection->>'generated_at')::timestamptz is distinct from (parent.command_payload->>'as_of')::date::timestamp at time zone 'UTC'
  then raise exception 'AUTOMATIC_DEV_CANONICAL_DRAFT_ONLY';end if;
 select * into prior from private.automatic_dev_canonical_reports where case_id=(body->>'case_id')::uuid and order_id=(body->>'order_id')::uuid and input_revision=(body->>'revision')::integer;
 if found then
  if prior.projection_id<>(body->>'id')::uuid or prior.parent_run_id<>target_parent or prior.parent_result_sha256<>target_result_sha
   or not exists(select 1 from public.case_report_projections p where p.id=prior.projection_id and p.report_document=body) then raise exception 'AUTOMATIC_DEV_DRAFT_REPLAY_CONFLICT';end if;
  return jsonb_build_object('projection_id',prior.projection_id,'publication','draft','replayed',true);
 end if;
 insert into public.case_report_projections(id,case_id,schema_version,report_kind,check_period_month,projection,projection_sha256,legal_basis,generated_at,input_revision,report_document)
 values((body->>'id')::uuid,(body->>'case_id')::uuid,'tivdoc-case-report-projection-v1','initial','2026-06-01',projection,body->>'projection_sha256','opinion_3ddad7e8 + errata_1_owner_closed',(projection->>'generated_at')::timestamptz,(body->>'revision')::integer,body);
 insert into private.automatic_dev_canonical_reports values((body->>'id')::uuid,(body->>'case_id')::uuid,(body->>'order_id')::uuid,(body->>'revision')::integer,body->>'input_sha256',target_parent,target_result_sha);
 return jsonb_build_object('projection_id',body->>'id','publication','draft','replayed',false);
end;$$;
revoke all on function private.automatic_dev_canonical_draft_save(jsonb,text,text) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_operations_runtime;
grant execute on function private.automatic_dev_canonical_draft_save(jsonb,text,text) to tivdoc_worker_runtime;

-- New provider claims are checked against the actual saved checkpoint; old
-- immutable runs remain readable without retroactively inventing receipts.
do $migration$
declare definition text;needle text;
begin
 definition:=pg_get_functiondef('private.dev_financial_save(jsonb,text,text,text)'::regprocedure);
 needle:=' select * into parent from public.analysis_runs';
 if position(needle in definition)=0 then raise exception 'AUTOMATIC_DEV_PROVENANCE_PATCH_BASE';end if;
 definition:=replace(definition,needle,$guard$
 if body ? 'extraction_provenance' then
  if body#>'{extraction_provenance,receipts}' is distinct from coalesce(source#>'{checkpoint,run,provider_receipts}','[]'::jsonb)
   or body#>>'{extraction_provenance,checkpointResultSha256}' is distinct from source#>>'{checkpoint,result_sha256}'
   or body->>'extraction_provider' is distinct from coalesce(source#>>'{checkpoint,run,provider_receipts,0,origin}','unproven_legacy') then raise exception 'DEV_FINANCIAL_PROVIDER_BINDING';end if;
 elsif source#>'{checkpoint,run,provider_receipts}' is not null then raise exception 'DEV_FINANCIAL_PROVIDER_PROVENANCE_REQUIRED';end if;
 select * into parent from public.analysis_runs$guard$);
 execute definition;
end;$migration$;
-- A capability-authorized retry must observe unknown extraction outcomes even
-- across questionnaire revisions. The private invocation table uses FORCE RLS.
create policy managed_dev_invocation_owner_read on private.case_extraction_invocations for select to CURRENT_USER
 using(current_database()='tivdoc_release_replay_20260907' and exists(select 1 from private.managed_dev_worker_cases m where m.case_id=case_extraction_invocations.case_id and m.enabled));
