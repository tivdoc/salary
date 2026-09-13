-- Explicit REAL service namespace, evidence and paid-source admission.
-- No service enrollment, activation, payment or human approval is seeded.
-- CLI-generated timestamp resequenced after already-recorded migration197.
create table private.real_ai_service_evidence_artifacts (
 sha256 text primary key check(sha256 ~ '^[a-f0-9]{64}$'), content bytea not null,
 recorded_at timestamptz not null default clock_timestamp(), recorded_by name not null default session_user,
 check(octet_length(content) between 1 and 3000000), check(encode(sha256(content),'hex')=sha256)
);
create table private.real_ai_service_decisions (
 payload_sha256 text primary key check(payload_sha256 ~ '^[a-f0-9]{64}$'),
 configuration_sha256 text not null references private.ai_release_configurations(payload_sha256),
 decision_id text not null, version text not null, payload jsonb not null,
 recorded_at timestamptz not null default clock_timestamp(), recorded_by name not null default session_user,
 unique(decision_id,version), check(coalesce(
  payload->>'schema_version'='tivdoc-real-ai-service-decision-v1'
  and payload->>'namespace'='real' and payload->>'purpose'='real_customer_service'
  and payload->>'status' in ('active','proposed_not_activated') and payload->'human_attestation'='null'::jsonb
  and payload->>'decision_id'=decision_id and payload->>'version'=version
  and payload->>'sha256'=payload_sha256
  and payload_sha256=encode(sha256(convert_to(private.governance_jsonb_compact_text(payload-'sha256'),'UTF8')),'hex'),false))
);
create table private.real_ai_service_enrollment_events (
 event_id uuid primary key, case_id uuid not null references public.cases(id),
 identity_id uuid not null references public.case_identities(id),
 sequence integer not null check(sequence>0), predecessor_id uuid references private.real_ai_service_enrollment_events(event_id),
 configuration_sha256 text not null references private.ai_release_configurations(payload_sha256),
 service_decision_sha256 text not null references private.real_ai_service_decisions(payload_sha256),
 purpose text not null check(purpose='real_customer_service'), namespace text not null check(namespace='real'),
 environment text not null check(environment in ('development','preview','production','test')),
 database_name name not null default current_database(), kind text not null check(kind in ('granted','revoked')),
 -- Freeze the actual purchased scope; new documents/answers can advance the
 -- source journal, but another purchase cannot inherit this grant.
 purchased_scope jsonb not null check(jsonb_typeof(purchased_scope)='array' and jsonb_array_length(purchased_scope)>0),
 purchased_scope_sha256 text not null check(purchased_scope_sha256 ~ '^[a-f0-9]{64}$'),
 idempotency_key text not null check(char_length(idempotency_key) between 8 and 200),
 issued_at timestamptz not null, expires_at timestamptz not null, reason text not null check(char_length(reason) between 10 and 1000),
 recorded_at timestamptz not null default clock_timestamp(), recorded_by name not null default session_user,
 unique(case_id,sequence), unique(case_id,idempotency_key),
 check(expires_at>issued_at), check((sequence=1)=(predecessor_id is null)),
 check(purchased_scope_sha256=encode(sha256(convert_to(private.governance_jsonb_compact_text(purchased_scope),'UTF8')),'hex'))
);
create table private.real_ai_service_revocations (
 id bigint generated always as identity primary key, case_id uuid not null references public.cases(id),
 target_sha256 text not null check(target_sha256 ~ '^[a-f0-9]{64}$'), effective_at timestamptz not null,
 idempotency_key text not null check(char_length(idempotency_key) between 8 and 200),
 reason text not null check(char_length(reason) between 10 and 1000),
 recorded_at timestamptz not null default clock_timestamp(), recorded_by name not null default session_user,
 unique(case_id,idempotency_key)
);

do $private_acl$ declare t text; begin
 foreach t in array array['real_ai_service_evidence_artifacts','real_ai_service_decisions','real_ai_service_enrollment_events','real_ai_service_revocations'] loop
  execute format('alter table private.%I enable row level security',t);
  execute format('alter table private.%I force row level security',t);
  execute format('create policy tivdoc_owner_access on private.%I for all to tivdoc_dev_migrator using(true) with check(true)',t);
  execute format('revoke all on private.%I from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime',t);
  execute format('create trigger %I before update or delete on private.%I for each row execute function private.ai_release_immutable()',t||'_immutable',t);
 end loop;
end; $private_acl$;
revoke all on sequence private.real_ai_service_revocations_id_seq
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

create function private.real_ai_service_evidence_refs(p_decision jsonb) returns table(sha256 text)
language sql immutable security invoker set search_path='' as $$
 select p_decision->>'product_decision_sha256' union select p_decision->>'action_matrix_sha256'
 union select value from jsonb_each_text(p_decision->'evidence')
 union select r->>'basis_sha256' from jsonb_array_elements(p_decision->'action_reviews') r
$$;
create function private.real_ai_service_dependency_targets(p_configuration jsonb,p_decision jsonb) returns table(sha256 text)
language sql immutable security invoker set search_path='' as $$
 select p_configuration->>'sha256' union select p_configuration#>>'{policy,sha256}' union select p_configuration#>>'{registry,sha256}'
 union select p_decision->>'sha256' union select p_decision#>>'{renderer,code_sha256}'
 union select sha256 from private.real_ai_service_evidence_refs(p_decision)
 union select value->>'sha256' from jsonb_array_elements(p_configuration->'source_receipts')
 union select value->>'sha256' from jsonb_array_elements(p_configuration->'interpretation_receipts')
 union select value->>'sha256' from jsonb_array_elements(p_configuration->'test_receipts')
 union select encode(sha256(convert_to(private.governance_jsonb_compact_text(value),'UTF8')),'hex')
  from jsonb_array_elements(p_configuration#>'{registry,reviewers}')
$$;

-- Internal source/order verifier. Caller owns case lock first, including the
-- same lock used by case_order_payment_verify. Currentness is checked again
-- before execution and must also be checked at future publication/read/send.
create function private.real_ai_service_paid_scope(p_case uuid,p_revision integer,p_input_sha256 text) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare source jsonb; pinned jsonb; current_scope jsonb; result jsonb:='[]'::jsonb;
 o private.product_orders; payment public.payments; checkout private.order_checkouts;
begin
 select v.input into source from private.case_input_heads h join private.case_input_versions v on v.case_id=h.case_id and v.revision=h.revision and v.input_sha256=h.input_sha256
  where h.case_id=p_case and h.revision=p_revision and h.input_sha256=p_input_sha256;
 if source is null then raise exception 'ANALYSIS_INPUT_SUPERSEDED';end if;
 if coalesce(source->'legacy_orders','[]'::jsonb)<>'[]'::jsonb then raise exception 'REAL_SERVICE_LEGACY_ADAPTER_REQUIRED';end if;
 if jsonb_typeof(source->'orders') is distinct from 'array' or jsonb_array_length(source->'orders') not between 1 and 12 then raise exception 'REAL_SERVICE_PAID_SCOPE_REQUIRED';end if;
 if (select count(distinct x->>'id') from jsonb_array_elements(source->'orders') x)<>jsonb_array_length(source->'orders') then raise exception 'REAL_SERVICE_ORDER_AMBIGUOUS';end if;
 for pinned in select value from jsonb_array_elements(source->'orders') order by value->>'id' loop
  select * into o from private.product_orders where case_id=p_case and id::text=pinned->>'id';
  if o.id is null or o.state<>'paid' or o.verified_at is null or o.refund_state='refunded'
   or o.terms_accepted_at is null or not exists(select 1 from private.order_entitlements e where e.order_id=o.id and e.state='active') then raise exception 'REAL_SERVICE_PAID_SCOPE_REQUIRED';end if;
  select * into payment from public.payments where order_id=o.id and case_id=p_case;
  select * into checkout from private.order_checkouts where order_id=o.id;
  if payment.id is null or checkout.order_id is null or payment.status<>'verified' or payment.verified_at is null
   or payment.provider<>'invoice4u' or payment.amount*100 is distinct from o.amount_minor::numeric or payment.currency is distinct from o.currency
   or coalesce(btrim(payment.provider_payment_id),'') in ('','0') or coalesce(btrim(payment.provider_confirmation_number),'')=''
   or checkout.state<>'ready' or coalesce(btrim(checkout.provider_log_id),'')='' or payment.provider_reference is distinct from checkout.provider_log_id
   or (checkout.provider_payment_id is not null and checkout.provider_payment_id is distinct from payment.provider_payment_id)
   then raise exception 'REAL_SERVICE_VERIFIED_PAYMENT_REQUIRED';end if;
  if o.offer->>'sha256' is distinct from o.offer_sha256 or o.offer->>'terms_version' is distinct from o.terms_version
   or encode(sha256(convert_to(private.governance_jsonb_compact_text(o.offer-'sha256'),'UTF8')),'hex') is distinct from o.offer_sha256
   then raise exception 'REAL_SERVICE_PURCHASE_RECEIPT_CHANGED';end if;
  if not coalesce(o.offer->'human_review_required'='false'::jsonb,false)
   or (o.kind='full' and not coalesce(o.offer->>'version' in ('tivdoc-order-offer-v2','tivdoc-order-offer-v3') and o.offer->>'service_kind'='ai_assisted',false))
   then raise exception 'REAL_SERVICE_PURCHASE_TERMS_INCOMPATIBLE';end if;
  if o.period_from<'2026-05-01'::date or o.period_to>'2026-07-01'::date
   or not o.topics<@array['minimum_wage','working_time','pension','travel','convalescence','vacation','rest_day','bonuses','contract']::text[]
   or cardinality(o.topics)<>(select count(distinct t) from unnest(o.topics) t)
   then raise exception 'REAL_SERVICE_PURCHASE_SCOPE_UNSUPPORTED';end if;
  current_scope:=jsonb_build_object('id',o.id,'kind',o.kind,'from',o.period_from,'to',o.period_to,'topics',o.topics,'offer_sha256',o.offer_sha256);
  if o.offer->>'purchase_topics_version'='tivdoc-purchase-topics-v2' then
   current_scope:=current_scope||jsonb_build_object('purchase_topics_version','tivdoc-purchase-topics-v2');
  end if;
  if pinned is distinct from current_scope then raise exception 'REAL_SERVICE_ORDER_SOURCE_CHANGED';end if;
  result:=result||jsonb_build_array(current_scope);
 end loop;
 return result;
end;$$;

create function private.real_ai_service_evidence_register(p_sha256 text,p_content bytea) returns text
language plpgsql security invoker set search_path='' as $$
begin
 if session_user<>'tivdoc_dev_migrator' then raise exception 'REAL_SERVICE_OPERATOR_REQUIRED';end if;
 if p_sha256 is null or p_content is null or encode(sha256(p_content),'hex') is distinct from p_sha256 then raise exception 'REAL_SERVICE_EVIDENCE_BYTES_CHANGED';end if;
 if exists(select 1 from private.real_ai_service_evidence_artifacts a where a.sha256=p_sha256 and a.content<>p_content) then raise exception 'REAL_SERVICE_EVIDENCE_RETRY_MISMATCH';end if;
 insert into private.real_ai_service_evidence_artifacts(sha256,content) values(p_sha256,p_content) on conflict(sha256) do nothing;
 return p_sha256;
end;$$;
create function private.real_ai_service_configuration_register(p_configuration jsonb) returns text
language plpgsql security invoker set search_path='' as $$
begin
 if session_user<>'tivdoc_dev_migrator' then raise exception 'REAL_SERVICE_OPERATOR_REQUIRED';end if;
 if not coalesce(p_configuration->>'schema_version'='tivdoc-ai-release-configuration-v1'
  and p_configuration#>>'{policy,namespace}'='real' and p_configuration#>>'{registry,namespace}'='real'
  and p_configuration#>>'{registry,policy_sha256}'=p_configuration#>>'{policy,sha256}',false)
  or exists(select 1 from jsonb_array_elements(p_configuration->'source_receipts') r where r->>'acquisition'='synthetic_fixture') then raise exception 'REAL_SERVICE_CONFIGURATION_SCOPE';end if;
 -- Existing table enforces canonical content SHA and immutable version ID.
 -- This stores a candidate only. It does not qualify receipts or enroll cases.
 if exists(select 1 from private.ai_release_configurations c where c.payload_sha256=p_configuration->>'sha256' and c.payload<>p_configuration) then raise exception 'REAL_SERVICE_CONFIGURATION_RETRY_MISMATCH';end if;
 insert into private.ai_release_configurations(configuration_id,revision,payload_sha256,payload)
 values((p_configuration->>'configuration_id')::uuid,(p_configuration->>'revision')::integer,p_configuration->>'sha256',p_configuration)
 on conflict(payload_sha256) do nothing;
 return p_configuration->>'sha256';
end;$$;
create function private.real_ai_service_decision_register(p_configuration_sha256 text,p_decision jsonb) returns text
language plpgsql security invoker set search_path='' as $$
declare configuration jsonb; action jsonb; interpretation jsonb;
begin
 if session_user<>'tivdoc_dev_migrator' then raise exception 'REAL_SERVICE_OPERATOR_REQUIRED';end if;
 select c.payload into configuration from private.ai_release_configurations c where c.payload_sha256=p_configuration_sha256;
 if not coalesce(configuration->>'schema_version'='tivdoc-ai-release-configuration-v1'
  and configuration#>>'{policy,namespace}'='real' and configuration#>>'{registry,namespace}'='real'
  and p_decision->>'policy_sha256'=configuration#>>'{policy,sha256}'
  and p_decision->>'product_decision_sha256'=configuration#>>'{policy,product_decision_sha256}',false)
  then raise exception 'REAL_SERVICE_DECISION_CONFIGURATION';end if;
 if jsonb_typeof(p_decision->'action_reviews') is distinct from 'array'
  or jsonb_array_length(p_decision->'action_reviews') not between 1 and 8
  or (select count(distinct r->>'action') from jsonb_array_elements(p_decision->'action_reviews') r)<>jsonb_array_length(p_decision->'action_reviews')
  or exists(select 1 from jsonb_array_elements(p_decision->'action_reviews') r where r->>'action' not in ('A01','A02','A03','A04','A05','A06','A07','A11'))
  then raise exception 'REAL_SERVICE_ACTION_SCOPE';end if;
 if exists(select 1 from private.real_ai_service_evidence_refs(p_decision) r where r.sha256 is null or not exists(select 1 from private.real_ai_service_evidence_artifacts a where a.sha256=r.sha256)) then raise exception 'REAL_SERVICE_EVIDENCE_UNAVAILABLE';end if;
 for action in select value from jsonb_array_elements(p_decision->'action_reviews') loop
  select r into interpretation from jsonb_array_elements(configuration->'interpretation_receipts') r where r->>'sha256'=action->>'interpretation_receipt_sha256';
  if interpretation is null or interpretation#>>'{human_by_law,basis_sha256}' is distinct from action->>'basis_sha256' then raise exception 'REAL_SERVICE_ACTION_REVIEW_BINDING';end if;
 end loop;
 if exists(select 1 from private.real_ai_service_decisions d where d.payload_sha256=p_decision->>'sha256'
  and (d.payload<>p_decision or d.configuration_sha256<>p_configuration_sha256)) then raise exception 'REAL_SERVICE_DECISION_RETRY_MISMATCH';end if;
 insert into private.real_ai_service_decisions(payload_sha256,configuration_sha256,decision_id,version,payload)
 values(p_decision->>'sha256',p_configuration_sha256,p_decision->>'decision_id',p_decision->>'version',p_decision) on conflict(payload_sha256) do nothing;
 return p_decision->>'sha256';
end;$$;

-- Internal stable token: no read-clock or analysis-run ID. Expiry is a separate
-- live guard. Revocation history stays in the token even after another grant.
create function private.real_ai_service_dependency(p_case uuid) returns text
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
create function private.real_ai_service_refresh_dispatch(p_case uuid) returns void
language plpgsql security definer set search_path='' as $$
declare token text;begin
 perform 1 from public.cases where id=p_case for update nowait;
 token:=private.real_ai_service_dependency(p_case);if token is null then return;end if;
 update private.case_analysis_dispatch d set authority_dependency_sha256=token,processing_profile='qualified_ai_v1',job_id=null,dispatched_at=null
 from private.case_input_heads h where d.case_id=p_case and h.case_id=d.case_id and h.revision=d.revision and d.mode='draft'
  and (d.authority_dependency_sha256 is distinct from token or d.processing_profile is distinct from 'qualified_ai_v1');
end;$$;

-- Exact routing hook required in the existing dispatch guard. Preserve its
-- original DEV branch verbatim. REAL history is never treated as absent when
-- expired/revoked, and cannot collide with an owner/DEV enrollment.
create or replace function private.ai_release_dispatch_profile_guard() returns trigger
language plpgsql security definer set search_path='' as $$
declare token text;begin
 token:=private.real_ai_service_dependency(new.case_id);
 if token is not null then
  if new.mode<>'draft' or exists(select 1 from private.ai_release_enrollment_events where case_id=new.case_id)
   or not exists(select 1 from public.cases where id=new.case_id and is_qa is false) then raise exception 'REAL_SERVICE_PROFILE_SCOPE';end if;
  new.authority_dependency_sha256:=token;new.processing_profile:='qualified_ai_v1';return new;
 end if;
 token:=private.ai_release_dependency(new.case_id);
 if token is not null and new.mode='draft' then
  new.authority_dependency_sha256:=token;new.processing_profile:='qualified_ai_v1';
 elsif new.processing_profile is not null then raise exception 'AI_RELEASE_ENROLLMENT_REQUIRED';end if;
 return new;
end;$$;

create function private.real_ai_service_enrollment_record(p_case uuid,p_identity uuid,p_configuration_sha256 text,p_decision_sha256 text,
 p_environment text,p_key text,p_kind text,p_issued_at timestamptz,p_expires_at timestamptz,p_reason text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare prior private.real_ai_service_enrollment_events; existing private.real_ai_service_enrollment_events; written private.real_ai_service_enrollment_events;
 head private.case_input_heads; config jsonb; decision jsonb; purchased jsonb; at_time timestamptz:=clock_timestamp();
begin
 if session_user<>'tivdoc_dev_migrator' then raise exception 'REAL_SERVICE_OPERATOR_REQUIRED';end if;
 perform 1 from public.cases where id=p_case for update;
 if not found then raise exception 'REAL_SERVICE_CASE_REQUIRED';end if;
 if p_kind is null or p_kind not in ('granted','revoked') or p_key is null or char_length(p_key) not between 8 and 200 then raise exception 'REAL_SERVICE_ENROLLMENT_INPUT';end if;
 select * into existing from private.real_ai_service_enrollment_events where case_id=p_case and idempotency_key=p_key;
 if found then
  if existing.identity_id is distinct from p_identity or existing.configuration_sha256 is distinct from p_configuration_sha256
   or existing.service_decision_sha256 is distinct from p_decision_sha256 or existing.environment is distinct from p_environment
   or existing.kind is distinct from p_kind or existing.issued_at is distinct from p_issued_at or existing.expires_at is distinct from p_expires_at
   or existing.reason is distinct from p_reason or existing.database_name<>current_database() then raise exception 'REAL_SERVICE_ENROLLMENT_RETRY_MISMATCH';end if;
  written:=existing;
 else
  select * into prior from private.real_ai_service_enrollment_events where case_id=p_case order by sequence desc limit 1;
  if p_kind='revoked' then
   if prior.kind is distinct from 'granted' or prior.identity_id is distinct from p_identity or prior.configuration_sha256 is distinct from p_configuration_sha256
    or prior.service_decision_sha256 is distinct from p_decision_sha256 or prior.environment is distinct from p_environment
    or prior.issued_at is distinct from p_issued_at or prior.expires_at is distinct from p_expires_at then raise exception 'REAL_SERVICE_REVOKE_SCOPE';end if;
   purchased:=prior.purchased_scope;
  else
   if not exists(select 1 from public.cases c join public.case_identity_cases ic on ic.case_id=c.id
    where c.id=p_case and c.is_qa is false and c.contact_verified_at is not null and ic.identity_id=p_identity)
    or exists(select 1 from private.ai_release_enrollment_events where case_id=p_case) then raise exception 'REAL_SERVICE_IDENTITY_SCOPE';end if;
   select c.payload,d.payload into config,decision from private.ai_release_configurations c join private.real_ai_service_decisions d
    on d.configuration_sha256=c.payload_sha256 where c.payload_sha256=p_configuration_sha256 and d.payload_sha256=p_decision_sha256;
   if not coalesce(config->>'schema_version'='tivdoc-ai-release-configuration-v1' and config#>>'{policy,namespace}'='real' and config#>>'{registry,namespace}'='real'
    and decision->>'status'='active' and decision->>'purpose'='real_customer_service' and decision->>'namespace'='real'
    and config#>'{policy,allowed_environments}' ? p_environment,false) then raise exception 'REAL_SERVICE_ACTIVE_CONFIGURATION_REQUIRED';end if;
   if p_issued_at is null or p_expires_at is null or p_issued_at>at_time or p_expires_at<=at_time or p_expires_at<=p_issued_at
    or p_issued_at<greatest((config#>>'{policy,issued_at}')::timestamptz,(config#>>'{registry,issued_at}')::timestamptz,(decision->>'issued_at')::timestamptz)
    or p_expires_at>least((config#>>'{policy,expires_at}')::timestamptz,(config#>>'{registry,expires_at}')::timestamptz,(decision->>'expires_at')::timestamptz)
    then raise exception 'REAL_SERVICE_ENROLLMENT_WINDOW';end if;
   if exists(select 1 from unnest(array['A01','A03','A05','A06','A07','A11']) required(action)
    where not exists(select 1 from jsonb_array_elements(decision->'action_reviews') r where r->>'action'=required.action)) then raise exception 'REAL_SERVICE_FINANCIAL_ACTION_SCOPE_REQUIRED';end if;
   if exists(select 1 from private.real_ai_service_evidence_refs(decision) ref where not exists(select 1 from private.real_ai_service_evidence_artifacts a where a.sha256=ref.sha256)) then raise exception 'REAL_SERVICE_EVIDENCE_UNAVAILABLE';end if;
   if exists(select 1 from private.real_ai_service_revocations r join private.real_ai_service_dependency_targets(config,decision) t on t.sha256=r.target_sha256
    where r.case_id=p_case and r.effective_at<=at_time) then raise exception 'REAL_SERVICE_REVOKED';end if;
   select * into head from private.case_input_heads where case_id=p_case;
   purchased:=private.real_ai_service_paid_scope(p_case,head.revision,head.input_sha256);
  end if;
  insert into private.real_ai_service_enrollment_events(event_id,case_id,identity_id,sequence,predecessor_id,configuration_sha256,service_decision_sha256,
   purpose,namespace,environment,kind,purchased_scope,purchased_scope_sha256,idempotency_key,issued_at,expires_at,reason)
  values(gen_random_uuid(),p_case,p_identity,coalesce(prior.sequence,0)+1,prior.event_id,p_configuration_sha256,p_decision_sha256,
   'real_customer_service','real',p_environment,p_kind,purchased,encode(sha256(convert_to(private.governance_jsonb_compact_text(purchased),'UTF8')),'hex'),
   p_key,p_issued_at,p_expires_at,p_reason) returning * into written;
  perform private.real_ai_service_refresh_dispatch(p_case);
 end if;
 return jsonb_build_object('event_id',written.event_id,'case_id',written.case_id,'kind',written.kind,'purpose',written.purpose,
  'replayed',existing.event_id is not null,'current',written.event_id=(select e.event_id from private.real_ai_service_enrollment_events e where e.case_id=p_case order by sequence desc limit 1),
  'authority_dependency_sha256',private.real_ai_service_dependency(p_case));
end;$$;
create function private.real_ai_service_revocation_record(p_case uuid,p_target_sha256 text,p_effective_at timestamptz,p_key text,p_reason text) returns bigint
language plpgsql security invoker set search_path='' as $$
declare prior private.real_ai_service_revocations;written bigint;begin
 if session_user<>'tivdoc_dev_migrator' then raise exception 'REAL_SERVICE_OPERATOR_REQUIRED';end if;
 perform 1 from public.cases where id=p_case for update;
 if not found or not exists(select 1 from private.real_ai_service_enrollment_events where case_id=p_case) then raise exception 'REAL_SERVICE_ENROLLMENT_REQUIRED';end if;
 select * into prior from private.real_ai_service_revocations where case_id=p_case and idempotency_key=p_key;
 if found then
  if prior.target_sha256 is distinct from p_target_sha256 or prior.effective_at is distinct from p_effective_at or prior.reason is distinct from p_reason then raise exception 'REAL_SERVICE_REVOCATION_RETRY_MISMATCH';end if;
  return prior.id;
 end if;
 -- A revocation can name a prior or future immutable dependency. It grants
 -- nothing and cannot be deleted/updated to revive the target.
 insert into private.real_ai_service_revocations(case_id,target_sha256,effective_at,idempotency_key,reason)
 values(p_case,p_target_sha256,p_effective_at,p_key,p_reason) returning id into written;
 perform private.real_ai_service_refresh_dispatch(p_case);return written;
end;$$;

-- Explicit routing lookup BEFORE owner/DEV loaders. Its true result remains
-- true after expiry/revocation; the REAL context must then fail closed.
create function private.real_ai_service_processing_enrolled(p_case uuid,p_revision integer,p_input_sha256 text) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 if session_user<>'tivdoc_worker_runtime' or private.runtime_verified_tenant() is distinct from 'saved-case:'||p_case::text then raise exception 'REAL_SERVICE_PROCESSING_FORBIDDEN';end if;
 if not exists(select 1 from private.case_input_heads where case_id=p_case and revision=p_revision and input_sha256=p_input_sha256) then raise exception 'ANALYSIS_INPUT_SUPERSEDED';end if;
 return exists(select 1 from private.real_ai_service_enrollment_events where case_id=p_case);
end;$$;
create function private.real_ai_service_processing_context(p_case uuid,p_revision integer,p_input_sha256 text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e private.real_ai_service_enrollment_events; config jsonb;decision jsonb;token text;purchased jsonb;source_at timestamptz;
 at_time timestamptz:=clock_timestamp();until_time timestamptz;evidence jsonb;revocations jsonb;
begin
 if session_user<>'tivdoc_worker_runtime' or private.runtime_verified_tenant() is distinct from 'saved-case:'||p_case::text then raise exception 'REAL_SERVICE_PROCESSING_FORBIDDEN';end if;
 perform 1 from public.cases where id=p_case and is_qa is false and contact_verified_at is not null for update;
 if not found then raise exception 'REAL_SERVICE_REAL_CASE_REQUIRED';end if;
 if not exists(select 1 from private.case_input_heads where case_id=p_case and revision=p_revision and input_sha256=p_input_sha256) then raise exception 'ANALYSIS_INPUT_SUPERSEDED';end if;
 select * into e from private.real_ai_service_enrollment_events where case_id=p_case order by sequence desc limit 1;
 if not found then return jsonb_build_object('state','absent');end if;
 token:=private.real_ai_service_dependency(p_case);
 if e.kind='revoked' or e.issued_at>at_time or e.expires_at<=at_time then return jsonb_build_object('state','unavailable','reason',case when e.kind='revoked' then 'revoked' else 'expired' end,'dependency_sha256',token);end if;
 if e.database_name<>current_database() or exists(select 1 from private.ai_release_enrollment_events where case_id=p_case)
  or not exists(select 1 from public.case_identity_cases where case_id=p_case and identity_id=e.identity_id) then raise exception 'REAL_SERVICE_IDENTITY_SCOPE';end if;
 if not exists(select 1 from private.case_analysis_dispatch where case_id=p_case and revision=p_revision and mode='draft'
  and processing_profile='qualified_ai_v1' and authority_dependency_sha256=token) then raise exception 'ANALYSIS_AUTHORITY_SUPERSEDED';end if;
 purchased:=private.real_ai_service_paid_scope(p_case,p_revision,p_input_sha256);
 if purchased<>e.purchased_scope then return jsonb_build_object('state','unavailable','reason','unscoped','dependency_sha256',token);end if;
 select c.payload,d.payload into config,decision from private.ai_release_configurations c join private.real_ai_service_decisions d
  on d.configuration_sha256=c.payload_sha256 where c.payload_sha256=e.configuration_sha256 and d.payload_sha256=e.service_decision_sha256;
 if decision->>'status' is distinct from 'active' then return jsonb_build_object('state','unavailable','reason','not_enrolled','dependency_sha256',token);end if;
 -- Future revocations of ANY bound source/test/reviewer also clip processing
 -- expiry. The TS loader validates config/action/evidence as well; SQL must
 -- not rely on only the subset of hashes a future caller happens to inspect.
 select coalesce(jsonb_agg(jsonb_build_object('target_sha256',r.target_sha256,'effective_at',r.effective_at) order by r.target_sha256,r.effective_at),'[]'::jsonb)
 into revocations from (
  select r.target_sha256,r.effective_at from private.real_ai_service_revocations r where r.case_id=p_case
  union select value->>'target_sha256',(value->>'effective_at')::timestamptz from jsonb_array_elements(config#>'{registry,revocations}')
 ) r join private.real_ai_service_dependency_targets(config,decision) t on t.sha256=r.target_sha256;
 if jsonb_array_length(revocations)>1024 then raise exception 'REAL_SERVICE_REVOCATION_LIMIT';end if;
 if exists(select 1 from jsonb_array_elements(revocations) r where (r->>'effective_at')::timestamptz<=at_time) then return jsonb_build_object('state','unavailable','reason','revoked','dependency_sha256',token);end if;
 select least(e.expires_at,min((r->>'effective_at')::timestamptz)) into until_time from jsonb_array_elements(revocations) r;
 if exists(select 1 from private.real_ai_service_evidence_refs(decision) ref where not exists(select 1 from private.real_ai_service_evidence_artifacts a where a.sha256=ref.sha256)) then raise exception 'REAL_SERVICE_EVIDENCE_UNAVAILABLE';end if;
 select jsonb_agg(jsonb_build_object('sha256',a.sha256,'content_base64',replace(encode(a.content,'base64'),E'\n','')) order by a.sha256)
 into evidence from private.real_ai_service_evidence_artifacts a join private.real_ai_service_evidence_refs(decision) ref on ref.sha256=a.sha256;
 select v.created_at into source_at from private.case_input_versions v where v.case_id=p_case and v.revision=p_revision and v.input_sha256=p_input_sha256;
 return jsonb_build_object('state','configured','purpose','real_customer_service','namespace','real','is_qa',false,'environment',e.environment,
  'identity_id',e.identity_id,'source_journal',jsonb_build_object('case_id',p_case,'input_revision',p_revision,'input_sha256',p_input_sha256),
  'configuration',config,'configuration_sha256',e.configuration_sha256,'enrollment_id',e.event_id,'dependency_sha256',token,
  'service_decision',decision,'service_decision_sha256',e.service_decision_sha256,'enrollment_issued_at',e.issued_at,
  'evaluated_at',at_time,'expires_at',until_time,'source_created_at',source_at,'evidence',evidence,'revocations',revocations);
end;$$;

-- No public/schema-wide runtime grants. Revoke every new function, including
-- internal helpers that SECURITY DEFINER entry points can call as their owner.
do $function_acl$ declare f record;begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='private' and p.proname like 'real_ai_service_%' loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime',f.signature);
 end loop;
end;$function_acl$;
grant execute on function private.real_ai_service_processing_enrolled(uuid,integer,text),private.real_ai_service_processing_context(uuid,integer,text) to tivdoc_worker_runtime;


CREATE OR REPLACE FUNCTION private.june2026_regular_dependency_refresh(target_case uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare token text;
begin
 if exists(select 1 from private.real_ai_service_enrollment_events where case_id=target_case) then return;end if;
 -- Append already owns registry/assessment locks. Never wait in the reverse
 -- order of a worker's case->registry locks. Admin retries SQL55P03 atomically.
 perform 1 from public.cases where id=target_case for update nowait;
 if not found then return;end if;
 select encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_object(
  'assessment',a.id,'sha',a.payload_sha256,'revoked',a.revoked_at,
  'registry',a.registry_key,'registry_revision',r.revision,'registry_sha',r.payload_sha256)
  order by a.order_id,a.id),'[]'::jsonb)::text,'UTF8')),'hex') into token
 from private.case_input_heads h join private.june2026_regular_assessments a
  on a.case_id=h.case_id and a.input_revision=h.revision and a.input_sha256=h.input_sha256
 left join lateral(select revision,payload_sha256 from private.june2026_authority_registries
  where registry_key=a.registry_key order by revision desc limit 1) r on true
 where h.case_id=target_case;
 update private.case_analysis_dispatch d set authority_dependency_sha256=token,job_id=null,dispatched_at=null
 from private.case_input_heads h where d.case_id=target_case and h.case_id=d.case_id
  and h.revision=d.revision and d.mode='draft' and d.authority_dependency_sha256 is distinct from token;
end;$function$;

CREATE OR REPLACE FUNCTION private.ai_release_enrollment_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare previous private.ai_release_enrollment_events;configuration jsonb;begin
 if exists(select 1 from private.real_ai_service_enrollment_events where case_id=new.case_id) then raise exception 'REAL_SERVICE_ENROLLMENT_COLLISION';end if;
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
end;$function$;
