-- Created with Supabase CLI on2026-09-13, ordered after206.
-- DEV-reviewed finite provider request boundary; no provider or budget authority seeded.
-- Depends on207 tables/policy and205 machine provenance. No policy/ledger seed,
-- approvals, customer data, provider call or refund/reset/replenishment function.
-- Existing12-request/USD4.272/two-unknown DEV ledger is completely untouched.
-- One actual provider response cannot settle two requests, including concurrent
-- receipts or different policy ledgers. Count receipts have no response ID.
create unique index real_service_provider_response_once on private.real_service_provider_request_receipts((payload->>'provider_response_id'))
 where payload->>'provider_response_id' is not null;
-- Strong finite numeric pricing checks at runtime supplement207 registration.
-- This is a short-lived tariff guard, not an authorization artifact or balance.
create function private.real_service_provider_policy(p_policy text) returns jsonb language plpgsql security invoker set search_path='' as $$
declare p jsonb;r jsonb;begin
 p:=private.real_service_budget_policy(p_policy);r:=p->'request_limits';
 if not coalesce(p->>'extraction_mode'='budgeted_provider' and p->'provider_calls_allowed'='true'::jsonb
  and r->>'model'='gpt-5.6-sol' and jsonb_typeof(r->'input_token_ceiling')='number' and (r->>'input_token_ceiling')::numeric=trunc((r->>'input_token_ceiling')::numeric)
  and (r->>'input_token_ceiling')::bigint between 1 and 64000 and r->'output_token_ceiling'='10000'::jsonb
  and jsonb_typeof(r->'count_reserved_micro_usd')='number' and (r->>'count_reserved_micro_usd')::numeric=trunc((r->>'count_reserved_micro_usd')::numeric)
  and jsonb_typeof(r->'generation_reserved_micro_usd')='number' and (r->>'generation_reserved_micro_usd')::numeric=trunc((r->>'generation_reserved_micro_usd')::numeric)
  and (r->>'count_reserved_micro_usd')::bigint>=(r->>'input_token_ceiling')::bigint*4
  and (r->>'generation_reserved_micro_usd')::bigint>=(r->>'input_token_ceiling')::bigint*4+200000,false)
  then raise exception 'REAL_SERVICE_PROVIDER_PRICING_BOUND';end if;
 if clock_timestamp()>='2026-09-17T00:00:00Z'::timestamptz then raise exception 'REAL_SERVICE_PROVIDER_PRICING_EXPIRED';end if;
 return p;
end;$$;

-- Shared short-transaction currentness guard. The pre-read is only a selector;
-- authority comes from installed205 SID/JTI and actual plan/case/job evidence.
-- Lock order:205/204 worker context(case/plan), existingjob, sharedpolicy, claim.
create function private.real_service_provider_material(p_reservation uuid,p_build text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare r private.real_service_claim_reservations;ctx jsonb;p jsonb;j public.engine_durable_jobs;at_time timestamptz;until_time timestamptz;begin
 if session_user<>'tivdoc_worker_runtime' then raise exception 'REAL_SERVICE_WORKER_FORBIDDEN';end if;
 select * into r from private.real_service_claim_reservations where reservation_id=p_reservation;
 if r.reservation_id is null or private.runtime_verified_tenant() is distinct from 'saved-case:'||r.case_id::text
  or private.runtime_verified_actor()::text is distinct from r.worker_id then raise exception 'REAL_SERVICE_PROVIDER_CLAIM_SCOPE';end if;
 ctx:=private.real_service_activation_worker_context(r.case_id,r.plan_sha256,p_build);
 if ctx->>'state' is distinct from 'authorized' or ctx->>'enrollment_id' is distinct from r.enrollment_id::text
  or ctx->>'identity_id' is distinct from r.identity_id::text or ctx->>'authority_dependency_sha256' is distinct from r.authority_dependency_sha256
  or ctx#>>'{plan,provider_budget_policy_sha256}' is distinct from r.policy_sha256 then raise exception 'REAL_SERVICE_PROVIDER_CLAIM_CHANGED';end if;
 select * into j from public.engine_durable_jobs where job_id=r.job_id and tenant_id='saved-case:'||r.case_id::text and canonical_case_id=r.case_id for update;
 at_time:=clock_timestamp();
 if j.job_id is null or j.state<>'running' or j.fencing_token<>r.fencing_token or j.lease_owner<>r.worker_id or j.lease_expires_at<=at_time or j.cancellation_requested
  or j.job_kind<>'saved_case_analysis_v1' or j.payload->>'mode' is distinct from 'draft' or j.payload->>'processing_profile' is distinct from 'qualified_ai_v1'
  or j.payload->>'input_sha256' is distinct from r.source_sha256 or j.payload->>'revision' is distinct from r.source_revision::text
  or j.payload->>'authority_dependency_sha256' is distinct from r.authority_dependency_sha256
  or not exists(select 1 from private.case_input_heads where case_id=r.case_id and revision=r.source_revision and input_sha256=r.source_sha256)
  then raise exception 'REAL_SERVICE_PROVIDER_JOB_FENCE';end if;
 perform 1 from private.real_service_budget_ledgers where policy_sha256=r.policy_sha256 for update;
 if not found then raise exception 'REAL_SERVICE_BUDGET_EVIDENCE_REQUIRED';end if;
 perform 1 from private.real_service_claim_reservations where reservation_id=r.reservation_id for update;
 p:=private.real_service_provider_policy(r.policy_sha256);
 if r.extraction_mode<>'budgeted_provider' or p->>'target_id' is distinct from ctx#>>'{plan,target_id}' then raise exception 'REAL_SERVICE_BUDGET_MODE';end if;
 at_time:=clock_timestamp();until_time:=least(r.expires_at,j.lease_expires_at,(ctx->>'expires_at')::timestamptz,(p->>'expires_at')::timestamptz);
 if r.issued_at>at_time or (p->>'issued_at')::timestamptz>at_time or until_time<=at_time then raise exception 'REAL_SERVICE_BUDGET_EXPIRED';end if;
 return jsonb_build_object('state','authorized','admission',jsonb_build_object('state','admitted','reservation_id',r.reservation_id,'case_id',r.case_id,'job_id',r.job_id,
  'fencing_token',r.fencing_token,'source_sha256',r.source_sha256,'authority_dependency_sha256',r.authority_dependency_sha256,'plan_sha256',r.plan_sha256,
  'provider_budget_policy_sha256',r.policy_sha256,'extraction_mode',r.extraction_mode,'expires_at',r.expires_at),
  'policy',p,'evaluated_at',at_time,'expires_at',until_time);
end;$$;
create function private.real_service_provider_context(p_reservation uuid,p_build text) returns jsonb
language sql security definer set search_path='' as $$select private.real_service_provider_material(p_reservation,p_build)$$;

create function private.real_service_provider_request_reserve(p_reservation uuid,p_version uuid,p_source text,p_request text,p_kind text,p_model text,p_output integer,p_build text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m jsonb;p jsonb;r private.real_service_claim_reservations;q private.real_service_provider_requests;count_request private.real_service_provider_requests;
 calls bigint;spent bigint;cost bigint;dispatch boolean:=false;begin
 m:=private.real_service_provider_material(p_reservation,p_build);p:=m->'policy';
 select * into r from private.real_service_claim_reservations where reservation_id=p_reservation;
 if not coalesce(p_kind in('input_tokens','generation') and p_source~'^[a-f0-9]{64}$' and p_request~'^[a-f0-9]{64}$'
  and p_model=p#>>'{request_limits,model}' and p_output=(p#>>'{request_limits,output_token_ceiling}')::integer,false) then raise exception 'REAL_SERVICE_PROVIDER_REQUEST_SCOPE';end if;
 -- Actual immutable upload version in the CURRENT pinned source journal. No
 -- caller case/type/Storage path/month may expand the authenticated paid source.
 if not exists(select 1 from private.case_input_versions v cross join lateral jsonb_array_elements(v.input->'documents') pin
  join public.documents d on d.id=(pin->>'id')::uuid and d.version_id=(pin->>'version_id')::uuid and d.case_id=v.case_id
  where v.case_id=r.case_id and v.revision=r.source_revision and v.input_sha256=r.source_sha256
   and d.version_id=p_version and d.content_sha256=p_source and pin->>'sha256'=p_source and pin->>'type'=d.document_type::text
   and d.document_type::text in('payslip','attendance','contract') and d.size between 1 and 10485760 and d.mime_type in('application/pdf','image/png','image/jpeg'))
  then raise exception 'REAL_SERVICE_PROVIDER_SOURCE_CHANGED';end if;
 cost:=case when p_kind='input_tokens' then (p#>>'{request_limits,count_reserved_micro_usd}')::bigint else (p#>>'{request_limits,generation_reserved_micro_usd}')::bigint end;
 select * into q from private.real_service_provider_requests where policy_sha256=r.policy_sha256 and version_id=p_version and source_sha256=p_source and request_sha256=p_request and request_kind=p_kind;
 if q.request_id is not null then
  -- An existing reservation NEVER grants another dispatch, even if its original
  -- caller missed COMMIT/response or a later job acquired a different fence.
  return jsonb_build_object('state','reserved','dispatch',false,'request_id',q.request_id,'reservation_id',r.reservation_id,'policy_sha256',r.policy_sha256,
   'case_id',r.case_id,'version_id',p_version,'source_sha256',p_source,'request_sha256',p_request,'request_kind',p_kind,'reserved_micro_usd',q.reserved_micro_usd,
   'evaluated_at',m->'evaluated_at','expires_at',m->'expires_at');
 end if;
 -- A changed prompt/hash or new claim is not a recovery authorization. Any
 -- unknown prior generation/count for this exact source blocks another call.
 if exists(select 1 from private.real_service_provider_requests x left join private.real_service_provider_request_receipts t on t.request_id=x.request_id
  where x.policy_sha256=r.policy_sha256 and x.version_id=p_version and x.source_sha256=p_source
   and (t.request_id is null or x.request_kind='generation' and (t.payload->>'provider_response_id' is null or jsonb_typeof(t.payload->'token_usage') is distinct from 'object')))
  then raise exception 'REAL_SERVICE_PROVIDER_UNKNOWN_HELD';end if;
 if p_kind='generation' then
  select * into count_request from private.real_service_provider_requests where policy_sha256=r.policy_sha256 and reservation_id=r.reservation_id
   and version_id=p_version and source_sha256=p_source and request_sha256=p_request and request_kind='input_tokens';
  if count_request.request_id is null or not exists(select 1 from private.real_service_provider_request_receipts t where t.request_id=count_request.request_id
   and t.payload->>'schema_version'='real-service-input-count-receipt-v1' and t.input_tokens between 1 and (p#>>'{request_limits,input_token_ceiling}')::bigint)
   then raise exception 'REAL_SERVICE_PROVIDER_COUNT_REQUIRED';end if;
 end if;
 select count(*),coalesce(sum(reserved_micro_usd),0) into calls,spent from private.real_service_provider_requests where reservation_id=r.reservation_id;
 if calls>=r.maximum_calls or spent+cost>r.reserved_micro_usd then raise exception 'REAL_SERVICE_BUDGET_EXHAUSTED';end if;
 insert into private.real_service_provider_requests(reservation_id,policy_sha256,version_id,source_sha256,request_sha256,request_kind,reserved_micro_usd)
 values(r.reservation_id,r.policy_sha256,p_version,p_source,p_request,p_kind,cost) returning * into q;dispatch:=true;
 return jsonb_build_object('state','reserved','dispatch',dispatch,'request_id',q.request_id,'reservation_id',r.reservation_id,'policy_sha256',r.policy_sha256,
  'case_id',r.case_id,'version_id',p_version,'source_sha256',p_source,'request_sha256',p_request,'request_kind',p_kind,'reserved_micro_usd',q.reserved_micro_usd,
  'evaluated_at',clock_timestamp(),'expires_at',m->'expires_at');
end;$$;

-- Receipt append never authorizes work, changes a checkpoint or frees escrow.
-- It is deliberately independent of current job/source/plan expiry so a late
-- actual response may be retained by an otherwise authenticated case machine.
-- A host that has itself expired still refuses; TS retains private raw/mapped
-- artifacts BEFORE this operation for later explicit reconciliation.
create function private.real_service_provider_receipt_record(p_request uuid,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare q private.real_service_provider_requests;r private.real_service_claim_reservations;old private.real_service_provider_request_receipts;policy jsonb;tokens bigint;sha text;begin
 if session_user<>'tivdoc_worker_runtime' then raise exception 'REAL_SERVICE_WORKER_FORBIDDEN';end if;
 select * into q from private.real_service_provider_requests where request_id=p_request;
 select * into r from private.real_service_claim_reservations where reservation_id=q.reservation_id;
 if r.case_id is null or private.runtime_verified_tenant() is distinct from 'saved-case:'||r.case_id::text
  or private.runtime_verified_actor()::text is distinct from r.worker_id then raise exception 'REAL_SERVICE_PROVIDER_CLAIM_SCOPE';end if;
 perform private.real_ai_service_assert_worker(r.case_id);
 perform 1 from private.real_service_provider_requests where request_id=p_request for update;
 -- Read immutable policy bytes; no live-window requirement is imposed on late evidence.
 policy:=private.real_service_budget_policy(r.policy_sha256);sha:=private.real_ai_service_json_sha(p_payload);
 if pg_column_size(p_payload)>65536 or p_payload->>'request_sha256' is distinct from q.request_sha256 then raise exception 'REAL_SERVICE_PROVIDER_RECEIPT_CHANGED';end if;
 if q.request_kind='input_tokens' then
  if not coalesce(p_payload->>'schema_version'='real-service-input-count-receipt-v1' and p_payload->>'object'='response.input_tokens'
   and (select count(*) from jsonb_object_keys(p_payload))=4 and jsonb_typeof(p_payload->'input_tokens')='number'
   and (p_payload->>'input_tokens')::numeric=trunc((p_payload->>'input_tokens')::numeric) and (p_payload->>'input_tokens')::bigint>0,false)
   then raise exception 'REAL_SERVICE_PROVIDER_COUNT_RECEIPT';end if;
  tokens:=(p_payload->>'input_tokens')::bigint;
 else
  if not coalesce(p_payload->>'schema_version'='tivdoc-openai-provider-receipt-v1' and p_payload->>'origin'='openai_live' and p_payload->'provider_attempted'='true'::jsonb
   and p_payload->>'receipt_sha256'=private.real_ai_service_json_sha(p_payload-'receipt_sha256') and p_payload->>'case_id'=r.case_id::text
   and p_payload->>'document_id'=q.version_id::text and p_payload->>'source_sha256'=q.source_sha256 and p_payload->>'requested_model'=policy#>>'{request_limits,model}'
   and p_payload->>'status' in('completed','failed') and ((p_payload->>'status'='completed')=(p_payload->'error_code'='null'::jsonb))
   and p_payload ? 'token_usage' and p_payload ? 'actual_model' and p_payload ? 'provider_response_id'
   and (p_payload->'actual_model'='null'::jsonb or p_payload->>'actual_model'=policy#>>'{request_limits,model}' or p_payload->>'actual_model'~'^gpt-5\.6-sol-[0-9]{4}-[0-9]{2}-[0-9]{2}$')
   and p_payload->>'pass_kind' in('first_pass','targeted_recovery') and (p_payload->>'created_at')::timestamptz>=q.recorded_at
   and (p_payload->>'status'<>'completed' or length(p_payload->>'provider_response_id')>0)
   and p_payload#>>'{cost,status}'='not_returned_by_provider' and p_payload#>'{cost,amount_usd}'='null'::jsonb,false)
   then raise exception 'REAL_SERVICE_PROVIDER_RECEIPT_CHANGED';end if;
  if p_payload->>'provider_response_id' is not null and exists(select 1 from private.real_service_provider_request_receipts t
   join private.real_service_provider_requests x on x.request_id=t.request_id where x.policy_sha256=r.policy_sha256 and x.request_id<>q.request_id
   and t.payload->>'provider_response_id'=p_payload->>'provider_response_id') then raise exception 'REAL_SERVICE_PROVIDER_RESPONSE_REUSED';end if;
  if p_payload->'token_usage'<>'null'::jsonb then
   if not coalesce(jsonb_typeof(p_payload#>'{token_usage,input_tokens}')='number' and jsonb_typeof(p_payload#>'{token_usage,output_tokens}')='number'
    and (p_payload#>>'{token_usage,input_tokens}')::numeric=trunc((p_payload#>>'{token_usage,input_tokens}')::numeric)
    and (p_payload#>>'{token_usage,output_tokens}')::numeric=trunc((p_payload#>>'{token_usage,output_tokens}')::numeric)
    and (p_payload#>>'{token_usage,total_tokens}')::numeric=trunc((p_payload#>>'{token_usage,total_tokens}')::numeric)
    and (p_payload#>>'{token_usage,input_tokens}')::bigint between 0 and (policy#>>'{request_limits,input_token_ceiling}')::bigint
    and (p_payload#>>'{token_usage,output_tokens}')::bigint between 0 and (policy#>>'{request_limits,output_token_ceiling}')::bigint
    and (p_payload#>>'{token_usage,total_tokens}')::bigint>=(p_payload#>>'{token_usage,input_tokens}')::bigint+(p_payload#>>'{token_usage,output_tokens}')::bigint,false)
    then raise exception 'REAL_SERVICE_PROVIDER_USAGE_BOUND';end if;
   tokens:=(p_payload#>>'{token_usage,input_tokens}')::bigint;
  end if;
 end if;
 select * into old from private.real_service_provider_request_receipts where request_id=p_request;
 if found then if old.payload_sha256<>sha or old.payload<>p_payload then raise exception 'REAL_SERVICE_PROVIDER_RECEIPT_IMMUTABLE';end if;
 else insert into private.real_service_provider_request_receipts(request_id,payload,payload_sha256,input_tokens) values(p_request,p_payload,sha,tokens);end if;
 return jsonb_build_object('state','recorded','request_id',p_request,'payload_sha256',sha);
end;$$;
do $acl$ declare r record;begin
 for r in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname like 'real_service_provider_%' loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role,tivdoc_identity_runtime,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime',r.signature);
 end loop;
end;$acl$;
grant execute on function private.real_service_provider_context(uuid,text),private.real_service_provider_request_reserve(uuid,uuid,text,text,text,text,integer,text),
 private.real_service_provider_receipt_record(uuid,jsonb) to tivdoc_worker_runtime;
