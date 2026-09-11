-- Component: legacy-admission-proposal.sql
-- PRIVATE EXECUTABLE PROPOSAL ONLY. Root reviews/creates actual migration.
-- Exact isolated DEV only; original source case UUID must equal destination.
-- Source original is_qa=false and DEV destination is_qa=true are separate facts.
-- No public.payments or private.product_orders row is inserted or rewritten.

create table private.legacy_paid_source_snapshots(
 snapshot_sha256 text primary key check(snapshot_sha256~'^[a-f0-9]{64}$'),
 project_ref text not null check(project_ref='hedgdltsonvypefbigag'),captured_at timestamptz not null,
 source_snapshot jsonb not null,imported_at timestamptz not null default clock_timestamp(),imported_by text not null
);
create table private.legacy_paid_scope_admissions(
 payment_id uuid not null,receipt_sha256 text not null check(receipt_sha256~'^[a-f0-9]{64}$'),
 case_id uuid not null references public.cases(id),source_case_id uuid not null,
 source_snapshot_sha256 text not null references private.legacy_paid_source_snapshots(snapshot_sha256),
 scope jsonb not null,source_case_sha256 text not null,source_payment_sha256 text not null,
 destination_isolated_qa boolean not null check(destination_isolated_qa),
 registered_by text not null,registered_at timestamptz not null default clock_timestamp(),
 primary key(payment_id,receipt_sha256),check(case_id=source_case_id)
);
create table private.legacy_paid_scope_events(
 id bigint generated always as identity primary key,payment_id uuid not null,receipt_sha256 text not null,
 case_id uuid not null references public.cases(id),action text not null check(action in ('active','revoked')),
 reason text not null check(char_length(reason) between 4 and 400),actor text not null,created_at timestamptz not null default clock_timestamp(),
 foreign key(payment_id,receipt_sha256) references private.legacy_paid_scope_admissions(payment_id,receipt_sha256)
);
alter table private.legacy_paid_source_snapshots enable row level security;
alter table private.legacy_paid_scope_admissions enable row level security;
alter table private.legacy_paid_scope_events enable row level security;
revoke all on private.legacy_paid_source_snapshots,private.legacy_paid_scope_admissions,private.legacy_paid_scope_events
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create trigger legacy_paid_source_immutable before update or delete on private.legacy_paid_source_snapshots for each row execute function private.reject_engine_append_only_mutation();
create trigger legacy_paid_admission_immutable before update or delete on private.legacy_paid_scope_admissions for each row execute function private.reject_engine_append_only_mutation();
create trigger legacy_paid_event_immutable before update or delete on private.legacy_paid_scope_events for each row execute function private.reject_engine_append_only_mutation();

-- Owner-only internal reader is shared with the input journal. No unguarded
-- helper is exposed to a runtime. Current scope requires the same QA binding,
-- latest active receipt, source hashes, and no modern order UUID collision.
create function private.legacy_paid_scopes_internal(target_case uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(a.scope order by a.payment_id),'[]'::jsonb)
 from private.legacy_paid_scope_admissions a
 join private.legacy_paid_source_snapshots s on s.snapshot_sha256=a.source_snapshot_sha256
 join public.cases c on c.id=a.case_id and c.is_qa is true and c.contact_verified_at is not null
 join lateral(select e.action,e.receipt_sha256 from private.legacy_paid_scope_events e where e.payment_id=a.payment_id and e.case_id=a.case_id order by e.id desc limit 1) latest
  on latest.action='active' and latest.receipt_sha256=a.receipt_sha256
 where current_database()='tivdoc_release_replay_20260907' and a.case_id=target_case and a.source_case_id=target_case
  and a.destination_isolated_qa and a.scope->>'case_id'=target_case::text and a.scope->>'id'=a.payment_id::text
  and a.scope->>'receipt_sha256'=a.receipt_sha256
  and a.source_case_sha256=a.scope->>'case_record_sha256' and a.source_payment_sha256=a.scope->>'payment_record_sha256'
  and a.scope#>>'{source,snapshot_sha256}'=s.snapshot_sha256 and a.scope#>>'{source,project_ref}'=s.project_ref
  and not exists(select 1 from private.product_orders o where o.id=a.payment_id)
$$;
revoke all on function private.legacy_paid_scopes_internal(uuid) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create function private.legacy_paid_scopes(target_case uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if session_user<>'tivdoc_worker_runtime' or private.runtime_verified_tenant() is distinct from 'saved-case:'||target_case::text
  then raise exception 'LEGACY_SCOPE_FORBIDDEN';end if;
 return private.legacy_paid_scopes_internal(target_case);
end;$$;
revoke all on function private.legacy_paid_scopes(uuid) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_operations_runtime;
grant execute on function private.legacy_paid_scopes(uuid) to tivdoc_worker_runtime;

-- A full source period must cover the entire requested month. Calendar labels,
-- check_period_month and min/max across gaps do not admit missing coverage.
create function private.legacy_scope_covers_month(scope jsonb,target_month date) returns boolean
language sql immutable security invoker set search_path='' as $$
 select target_month is not null and date_trunc('month',target_month)::date=target_month
  and exists(select 1 from jsonb_array_elements(scope->'periods') p
   where (p#>>'{period,from}')::date<=target_month
    and (p#>>'{period,to}')::date>=(target_month+interval '1 month - 1 day')::date)
$$;
revoke all on function private.legacy_scope_covers_month(jsonb,date) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

-- Register authentic private snapshot bytes and a scope produced by the strict
-- adapter. Bytes retain the original SHA, including whitespace; the database
-- validates selected payment/case values against that actual snapshot.
-- Operations identity is authenticated by the existing runtime context, not an
-- arbitrary actor string or a synthetic legal attestation.
create function private.legacy_paid_scope_register(target_case uuid,snapshot_bytes bytea,target_scope jsonb) returns text
language plpgsql security definer set search_path='' as $$
declare snapshot jsonb;source_case jsonb;source_payment jsonb;case_record jsonb;payment_record jsonb;
 snapshot_hash text;scope_hash text;actor text;v_payment_id uuid;existing private.legacy_paid_scope_admissions;
 amount_text text;amount_minor numeric;p jsonb;pin jsonb;source_document jsonb;prior_action text;prior_hash text;
begin
 if current_database()<>'tivdoc_release_replay_20260907' or session_user<>'tivdoc_operations_runtime'
  or private.runtime_verified_tenant() is distinct from 'saved-case:'||target_case::text then raise exception 'LEGACY_SCOPE_FORBIDDEN';end if;
 actor:=private.runtime_verified_actor();if actor is null then raise exception 'LEGACY_SCOPE_FORBIDDEN';end if;
 perform 1 from public.cases where id=target_case and is_qa is true and contact_verified_at is not null for update;
 if not found then raise exception 'LEGACY_SCOPE_DESTINATION_BINDING';end if;
 if snapshot_bytes is null or octet_length(snapshot_bytes) not between 2 and 4194304 or jsonb_typeof(target_scope) is distinct from 'object'
  then raise exception 'LEGACY_SCOPE_INVALID';end if;
 snapshot:=convert_from(snapshot_bytes,'UTF8')::jsonb;snapshot_hash:=encode(sha256(snapshot_bytes),'hex');
 scope_hash:=encode(sha256(convert_to(private.governance_jsonb_compact_text(target_scope-'receipt_sha256'),'UTF8')),'hex');
 if snapshot->>'sourceProject' is distinct from 'hedgdltsonvypefbigag' or jsonb_typeof(snapshot->'cases') is distinct from 'array'
  or target_scope#>>'{source,project_ref}' is distinct from snapshot->>'sourceProject'
  or target_scope#>>'{source,snapshot_sha256}' is distinct from snapshot_hash
  or (target_scope#>>'{source,captured_at}')::timestamptz is distinct from (snapshot->>'capturedAt')::timestamptz
  or target_scope->>'receipt_sha256' is distinct from scope_hash or target_scope->>'case_id' is distinct from target_case::text
  or target_scope->>'schema_version' is distinct from 'legacy-saved-paid-receipt-v1'
  or target_scope->>'kind' is distinct from 'legacy_initial' or target_scope->>'origin' is distinct from 'legacy_paid_receipt'
  or target_scope->>'id' is distinct from target_scope->>'payment_id' then raise exception 'LEGACY_SCOPE_SOURCE_BINDING';end if;
 v_payment_id:=(target_scope->>'payment_id')::uuid;
 if v_payment_id is null or exists(select 1 from private.product_orders where id=v_payment_id) then raise exception 'LEGACY_SCOPE_ORDER_COLLISION';end if;
 if (select count(*) from jsonb_array_elements(snapshot->'cases') c where c->>'id'=target_case::text)<>1 then raise exception 'LEGACY_SCOPE_SOURCE_CASE';end if;
 select c into source_case from jsonb_array_elements(snapshot->'cases') c where c->>'id'=target_case::text;
 if source_case->'is_qa' is distinct from 'false'::jsonb or source_case->>'payment_status' is distinct from 'verified'
  or source_case->>'attribution_status'='internal_qa' then raise exception 'LEGACY_SCOPE_SOURCE_OWNERSHIP';end if;
 if (select count(*) from jsonb_array_elements(source_case->'payments') p where p->>'id'=v_payment_id::text)<>1 then raise exception 'LEGACY_SCOPE_SOURCE_PAYMENT';end if;
 select p into source_payment from jsonb_array_elements(source_case->'payments') p where p->>'id'=v_payment_id::text;
 if source_payment->>'status' is distinct from 'verified' or source_payment->>'provider' is distinct from 'invoice4u'
  or source_payment->>'currency' is distinct from 'ILS' or source_payment->>'verified_at' is null
  or source_payment->>'idempotency_key' is distinct from target_case::text||':initial-check'
  or source_payment->>'provider_order_id' is distinct from 'tivdoc-salary:'|| (source_case->>'public_id')
  or source_payment->>'provider_reference' is distinct from source_payment->>'provider_clearing_log_id'
  or coalesce(btrim(source_payment->>'provider_payment_id'),'') in ('','0')
  or coalesce(source_payment->>'provider_payment_id','')~'^0+$'
  or coalesce(btrim(source_payment->>'provider_reference'),'')=''
  or coalesce(btrim(source_payment->>'provider_confirmation_number'),'')='' then raise exception 'LEGACY_SCOPE_VERIFICATION_REQUIRED';end if;
 amount_text:=source_payment->>'amount';
 if amount_text is null or amount_text!~'^(0|[1-9][0-9]{0,10})([.][0-9]{1,2})?$' then raise exception 'LEGACY_SCOPE_AMOUNT';end if;
 amount_minor:=amount_text::numeric*100;
 if amount_minor<=0 or amount_minor>9007199254740991 or target_scope->>'amount_minor' is null
  or (target_scope->>'amount_minor')::numeric<>amount_minor then raise exception 'LEGACY_SCOPE_AMOUNT';end if;
 case_record:=jsonb_build_object('id',source_case->'id','public_id',source_case->'public_id','payment_status',source_case->'payment_status','is_qa',source_case->'is_qa');
 if source_case?'attribution_status' then case_record:=case_record||jsonb_build_object('attribution_status',source_case->'attribution_status');end if;
 payment_record:=jsonb_build_object('id',source_payment->'id','case_id',target_case,'provider',source_payment->'provider','amount',source_payment->'amount',
  'currency',source_payment->'currency','status',source_payment->'status','verified_at',source_payment->'verified_at',
  'idempotency_key',source_payment->'idempotency_key','provider_order_id',source_payment->'provider_order_id','provider_payment_id',source_payment->'provider_payment_id',
  'provider_reference',source_payment->'provider_reference','provider_clearing_log_id',source_payment->'provider_clearing_log_id','provider_confirmation_number',source_payment->'provider_confirmation_number');
 if target_scope->>'case_record_sha256' is distinct from encode(sha256(convert_to(private.governance_jsonb_compact_text(case_record),'UTF8')),'hex')
  or target_scope->>'payment_record_sha256' is distinct from encode(sha256(convert_to(private.governance_jsonb_compact_text(payment_record),'UTF8')),'hex')
  or target_scope->'topics' is distinct from '["working_time","pension","vacation","convalescence","travel","rest_day","minimum_wage","bonuses","contract"]'::jsonb
  or target_scope->>'payment_assurance' is distinct from 'saved_server_verified' or target_scope->>'currency' is distinct from 'ILS'
  or target_scope->>'scope_basis' is distinct from 'legacy_initial_scope_not_versioned' or target_scope->>'historical_offer_commit' is distinct from '8d00dc9'
  or target_scope->'publication_authority' is distinct from 'false'::jsonb or target_scope->'new_payment_required' is distinct from 'false'::jsonb
  or target_scope->'deployment_at_purchase_verified' is distinct from 'false'::jsonb then raise exception 'LEGACY_SCOPE_CONTRACT';end if;
 if jsonb_typeof(target_scope->'periods') is distinct from 'array' or jsonb_array_length(target_scope->'periods')>600
  or target_scope->>'period_state' is distinct from (case when jsonb_array_length(target_scope->'periods')=0 then 'missing' else 'source_observed' end)
  then raise exception 'LEGACY_SCOPE_PERIOD';end if;
 if (select count(distinct p->'period') from jsonb_array_elements(target_scope->'periods') p)<>jsonb_array_length(target_scope->'periods') then raise exception 'LEGACY_SCOPE_PERIOD';end if;
 for p in select * from jsonb_array_elements(target_scope->'periods') loop
  if p#>>'{period,from}' is null or p#>>'{period,to}' is null or (p#>>'{period,from}')::date>(p#>>'{period,to}')::date
   or coalesce(p->>'evidence_sha256','')!~'^[a-f0-9]{64}$' or jsonb_typeof(p->'source_pins') is distinct from 'array'
   or jsonb_array_length(p->'source_pins') not between 1 and 32 then raise exception 'LEGACY_SCOPE_PERIOD';end if;
  for pin in select * from jsonb_array_elements(p->'source_pins') loop
   if pin->>'case_id' is distinct from target_case::text or coalesce(pin->>'source_sha256','')!~'^[a-f0-9]{64}$'
    or not exists(select 1 from public.documents d where d.case_id=target_case and d.id::text=pin->>'document_id'
      and d.version_id::text=pin->>'version_id' and d.content_sha256=pin->>'source_sha256')
    then raise exception 'LEGACY_SCOPE_PERIOD_SOURCE';end if;
   -- The import authenticates exact source bytes; period interpretation is an
   -- explicit AI source-reading receipt, not an observed purchase month or a
   -- human legal signature. Root must supply an immutable period evidence row
   -- (below) before adding periods; empty periods remain fully supported.
   if not exists(select 1 from private.legacy_paid_period_evidence e where e.case_id=target_case
    and e.evidence_sha256=p->>'evidence_sha256' and e.period=p->'period' and e.source_pins=p->'source_pins'
    and e.source_snapshot_sha256=snapshot_hash) then raise exception 'LEGACY_SCOPE_PERIOD_EVIDENCE_REQUIRED';end if;
  end loop;
 end loop;
 -- Reject reuse of real clearing identifiers across source cases/payments.
 if exists(select 1 from jsonb_array_elements(snapshot->'cases') other_case cross join lateral jsonb_array_elements(other_case->'payments') other_payment
  where other_case->>'id'<>target_case::text and other_payment->>'provider'='invoice4u'
   and (other_payment->>'provider_payment_id'=source_payment->>'provider_payment_id' or other_payment->>'provider_clearing_log_id'=source_payment->>'provider_clearing_log_id')) then raise exception 'LEGACY_SCOPE_PROVIDER_REUSE';end if;
 insert into private.legacy_paid_source_snapshots(snapshot_sha256,project_ref,captured_at,source_snapshot,imported_by)
 values(snapshot_hash,snapshot->>'sourceProject',(snapshot->>'capturedAt')::timestamptz,snapshot,actor) on conflict do nothing;
 if not exists(select 1 from private.legacy_paid_source_snapshots where snapshot_sha256=snapshot_hash and source_snapshot=snapshot) then raise exception 'LEGACY_SCOPE_SNAPSHOT_CONFLICT';end if;
 select * into existing from private.legacy_paid_scope_admissions a where a.payment_id=v_payment_id and a.receipt_sha256=scope_hash;
 if found and (existing.case_id<>target_case or existing.scope<>target_scope) then raise exception 'LEGACY_SCOPE_RETRY_CONFLICT';end if;
 insert into private.legacy_paid_scope_admissions(payment_id,receipt_sha256,case_id,source_case_id,source_snapshot_sha256,scope,source_case_sha256,source_payment_sha256,destination_isolated_qa,registered_by)
 values(v_payment_id,scope_hash,target_case,target_case,snapshot_hash,target_scope,target_scope->>'case_record_sha256',target_scope->>'payment_record_sha256',true,actor) on conflict do nothing;
 select e.action,e.receipt_sha256 into prior_action,prior_hash from private.legacy_paid_scope_events e where e.payment_id=v_payment_id order by e.id desc limit 1;
 -- Re-registering a revoked identical receipt cannot silently reactivate it.
 if prior_hash=scope_hash and prior_action='revoked' then raise exception 'LEGACY_SCOPE_REVOKED';end if;
 if prior_hash is distinct from scope_hash or prior_action is distinct from 'active' then
  insert into private.legacy_paid_scope_events(payment_id,receipt_sha256,case_id,action,reason,actor) values(v_payment_id,scope_hash,target_case,'active','Authenticated source snapshot admitted for isolated document review',actor);
  perform private.capture_case_input(target_case,'legacy_paid_scope_registered');
 end if;
 return scope_hash;
end;$$;
revoke all on function private.legacy_paid_scope_register(uuid,bytea,jsonb) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime;
grant execute on function private.legacy_paid_scope_register(uuid,bytea,jsonb) to tivdoc_operations_runtime;

-- A source-reading packet may state a period, but cannot change the original
-- payment. Kept distinct so its AI-origin/locators stay auditable. Operations
-- imports exact reviewed artifacts; this is not a new legal trust registry.
create table private.legacy_paid_period_evidence(
 evidence_sha256 text primary key check(evidence_sha256~'^[a-f0-9]{64}$'),case_id uuid not null references public.cases(id),
 source_snapshot_sha256 text not null check(source_snapshot_sha256~'^[a-f0-9]{64}$'),
 period jsonb not null,source_pins jsonb not null,evidence jsonb not null,recorded_by text not null,
 recorded_at timestamptz not null default clock_timestamp()
);
alter table private.legacy_paid_period_evidence enable row level security;
revoke all on private.legacy_paid_period_evidence from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create trigger legacy_paid_period_immutable before update or delete on private.legacy_paid_period_evidence for each row execute function private.reject_engine_append_only_mutation();
create function private.legacy_paid_period_register(target_case uuid,target_evidence jsonb) returns text
language plpgsql security definer set search_path='' as $$
declare digest text;actor text;pin jsonb;
begin
 if current_database()<>'tivdoc_release_replay_20260907' or session_user<>'tivdoc_operations_runtime'
  or private.runtime_verified_tenant() is distinct from 'saved-case:'||target_case::text then raise exception 'LEGACY_SCOPE_FORBIDDEN';end if;
 actor:=private.runtime_verified_actor();
 perform 1 from public.cases where id=target_case and is_qa is true and contact_verified_at is not null for update;
 if not found or actor is null then raise exception 'LEGACY_SCOPE_FORBIDDEN';end if;
 if jsonb_typeof(target_evidence) is distinct from 'object' or target_evidence->>'case_id' is distinct from target_case::text
  or target_evidence->>'schema_version' is distinct from 'legacy-source-period-reading-v1'
  or target_evidence->>'origin' is distinct from 'ai_document_review' or target_evidence->'human_attestation' is distinct from 'false'::jsonb
  or coalesce(target_evidence->>'source_snapshot_sha256','')!~'^[a-f0-9]{64}$'
  or jsonb_typeof(target_evidence->'source_pins') is distinct from 'array' or jsonb_array_length(target_evidence->'source_pins') not between 1 and 32
  or target_evidence#>>'{period,from}' is null or target_evidence#>>'{period,to}' is null
  or (target_evidence#>>'{period,from}')::date>(target_evidence#>>'{period,to}')::date
  or jsonb_typeof(target_evidence->'locators') is distinct from 'array' or jsonb_array_length(target_evidence->'locators')<1
  then raise exception 'LEGACY_SCOPE_PERIOD_EVIDENCE_REQUIRED';end if;
 for pin in select * from jsonb_array_elements(target_evidence->'source_pins') loop
  if pin->>'case_id' is distinct from target_case::text or not exists(select 1 from public.documents d
   where d.case_id=target_case and d.id::text=pin->>'document_id' and d.version_id::text=pin->>'version_id' and d.content_sha256=pin->>'source_sha256') then raise exception 'LEGACY_SCOPE_PERIOD_SOURCE';end if;
 end loop;
 digest:=encode(sha256(convert_to(private.governance_jsonb_compact_text(target_evidence),'UTF8')),'hex');
 insert into private.legacy_paid_period_evidence(evidence_sha256,case_id,source_snapshot_sha256,period,source_pins,evidence,recorded_by)
 values(digest,target_case,target_evidence->>'source_snapshot_sha256',target_evidence->'period',target_evidence->'source_pins',target_evidence,actor) on conflict do nothing;
 if not exists(select 1 from private.legacy_paid_period_evidence where evidence_sha256=digest and case_id=target_case and evidence=target_evidence) then raise exception 'LEGACY_SCOPE_PERIOD_CONFLICT';end if;
 return digest;
end;$$;
revoke all on function private.legacy_paid_period_register(uuid,jsonb) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime;
grant execute on function private.legacy_paid_period_register(uuid,jsonb) to tivdoc_operations_runtime;

create function private.legacy_paid_scope_revoke(target_case uuid,target_payment uuid,target_receipt text,reason text) returns void
language plpgsql security definer set search_path='' as $$
declare actor text;latest private.legacy_paid_scope_events;
begin
 if current_database()<>'tivdoc_release_replay_20260907' or session_user<>'tivdoc_operations_runtime'
  or private.runtime_verified_tenant() is distinct from 'saved-case:'||target_case::text then raise exception 'LEGACY_SCOPE_FORBIDDEN';end if;
 actor:=private.runtime_verified_actor();
 perform 1 from public.cases where id=target_case and is_qa is true for update;
 if not found or actor is null or reason is null or char_length(reason) not between 4 and 400 then raise exception 'LEGACY_SCOPE_FORBIDDEN';end if;
 select * into latest from private.legacy_paid_scope_events where payment_id=target_payment and case_id=target_case order by id desc limit 1;
 if not found or latest.receipt_sha256 is distinct from target_receipt then raise exception 'LEGACY_SCOPE_RETRY_CONFLICT';end if;
 if latest.action='revoked' then return;end if;
 insert into private.legacy_paid_scope_events(payment_id,receipt_sha256,case_id,action,reason,actor) values(target_payment,target_receipt,target_case,'revoked',reason,actor);
 perform private.capture_case_input(target_case,'legacy_paid_scope_revoked');
end;$$;
revoke all on function private.legacy_paid_scope_revoke(uuid,uuid,text,text) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime;
grant execute on function private.legacy_paid_scope_revoke(uuid,uuid,text,text) to tivdoc_operations_runtime;

do $upgrade$ declare definition text;old_block text;begin
 definition:=pg_get_functiondef('private.capture_case_input(uuid,text)'::regprocedure);
 old_block:=$old$ digest:=encode(sha256(convert_to(payload::text,'UTF8')),'hex');$old$;
 if position(old_block in definition)=0 then raise exception 'LEGACY_CAPTURE_BASE_DRIFT';end if;
 execute replace(definition,old_block,E' if private.legacy_paid_scopes_internal(target_case)<>''[]''::jsonb then\n  payload:=payload||jsonb_build_object(''legacy_orders'',private.legacy_paid_scopes_internal(target_case));\n end if;\n'||old_block);
end;$upgrade$;

-- Activation prerequisite: root must read the scope with the strict TS parser;
-- periods=[] remains a valid nine-topic purchase with no executable month.
-- Late source evidence creates a new immutable receipt/event/input revision;
-- historical source snapshots, payments, orders and run outputs are untouched.

-- Component: review-upload-proposal.sql
-- PRIVATE EXECUTABLE PROPOSAL ONLY. Root creates the real migration and owns
-- original function rewrites/legacy entitlement adapter/application. No grants
-- to browser roles; existing trusted case-cookie server boundary is preserved.
-- These helpers must be called inside the original case-locked reserve/commit.

create table private.document_review_upload_bindings(
 batch_id uuid primary key references public.document_upload_batches(id) deferrable initially deferred,
 request_id uuid not null references public.case_requests(id),case_id uuid not null references public.cases(id),
 scope jsonb not null,source_pins_before jsonb not null,case_source_hashes_before jsonb not null,case_sources_before jsonb not null,
 created_at timestamptz not null default transaction_timestamp()
);
create table private.document_review_upload_receipts(
 batch_id uuid primary key references private.document_review_upload_bindings(batch_id),
 request_id uuid not null references public.case_requests(id),case_id uuid not null references public.cases(id),
 receipt jsonb not null,receipt_sha256 text not null check(receipt_sha256~'^[a-f0-9]{64}$'),
 created_at timestamptz not null default transaction_timestamp()
);
alter table private.document_review_upload_bindings enable row level security;
alter table private.document_review_upload_receipts enable row level security;
revoke all on private.document_review_upload_bindings,private.document_review_upload_receipts from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create trigger document_review_upload_binding_immutable before update or delete on private.document_review_upload_bindings for each row execute function private.reject_engine_append_only_mutation();
create trigger document_review_upload_receipt_immutable before update or delete on private.document_review_upload_receipts for each row execute function private.reject_engine_append_only_mutation();

-- Reserve already holds the case lock and has validated the whole allocation.
-- Call this before original legacy code matching, only for document_review:.
create function private.document_review_upload_validate(target_case uuid,target_request uuid,allocated jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare r public.case_requests;t private.document_review_request_targets;kind text;month text;
begin
 if session_user not in ('tivdoc_web_runtime','service_role') then raise exception 'UPLOAD_FORBIDDEN';end if;
 perform 1 from public.cases where id=target_case and contact_verified_at is not null for update;
 if not found then raise exception 'UPLOAD_FORBIDDEN';end if;
 select * into r from public.case_requests where id=target_request and case_id=target_case;
 select * into t from private.document_review_request_targets where request_id=target_request and case_id=target_case;
 if r.id is null or t.request_id is null or r.code is distinct from 'document_review:'||t.target_sha256
  or r.answer_kind is distinct from 'document' or r.answered_at is not null or r.expired_at is not null or r.expires_at<=clock_timestamp()
  or not private.document_review_request_current(target_case,target_request) then raise exception 'UPLOAD_REQUEST_CONFLICT';end if;
 kind:=t.target->>'document_kind';month:=left(t.target#>>'{period,from}',7);
 if t.target->>'kind' is distinct from 'document' or t.target->>'answer_kind' is distinct from 'document'
  or kind is null or kind not in ('payslip','contract','attendance') or jsonb_typeof(allocated) is distinct from 'array'
  or not exists(select 1 from jsonb_array_elements(allocated) f where f->>'documentType'=kind)
  or exists(select 1 from jsonb_array_elements(allocated) f where f->>'documentType'=kind and kind='payslip' and f->>'periodMonth' is distinct from month)
  then raise exception 'UPLOAD_REQUEST_CONFLICT';end if;
end;$$;
revoke all on function private.document_review_upload_validate(uuid,uuid,jsonb) from public,anon,authenticated,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function private.document_review_upload_validate(uuid,uuid,jsonb) to tivdoc_web_runtime,service_role;

-- Insert after the actual batch row, BEFORE commit has changed any document.
create function private.document_review_upload_bind(target_case uuid,target_batch uuid) returns void
language plpgsql security definer set search_path='' as $$
declare b public.document_upload_batches;t private.document_review_request_targets;bound_scope jsonb;
begin
 if session_user not in ('tivdoc_web_runtime','service_role') then raise exception 'UPLOAD_FORBIDDEN';end if;
 perform 1 from public.cases where id=target_case and contact_verified_at is not null for update;if not found then raise exception 'UPLOAD_FORBIDDEN';end if;
 select * into b from public.document_upload_batches where id=target_batch and case_id=target_case;
 if not found then raise exception 'UPLOAD_FORBIDDEN';end if;
 if not b.manifest ? 'requestId' then return;end if;
 select * into t from private.document_review_request_targets where request_id=(b.manifest->>'requestId')::uuid and case_id=target_case;
 if not found then return;end if; -- ordinary historical request untouched
 perform private.document_review_upload_validate(target_case,t.request_id,b.files);
 -- Root extends order_origin for the explicit legacy admission union. Never
 -- infer legacy merely because product_orders lookup failed.
 bound_scope:=jsonb_build_object('request_id',t.request_id,'request',jsonb_build_object('code','document_review:'||t.target_sha256,'target',t.target,'dependent_check_ids',t.dependent_check_ids),
  'order_id',t.order_id,'order_origin','saved_order','order_receipt_sha256',t.offer_sha256);
 insert into private.document_review_upload_bindings(batch_id,request_id,case_id,scope,source_pins_before,case_source_hashes_before,case_sources_before)
 values(b.id,t.request_id,target_case,bound_scope,t.target->'source_pins',coalesce((select jsonb_agg(content_sha256 order by id) from public.documents where case_id=target_case),'[]'::jsonb),
  coalesce((select jsonb_agg(jsonb_build_object('document_id',id,'version_id',version_id,'source_sha256',content_sha256) order by id) from public.documents where case_id=target_case),'[]'::jsonb))
 on conflict(batch_id) do nothing;
 if not exists(select 1 from private.document_review_upload_bindings where batch_id=b.id and case_id=target_case and request_id=t.request_id and document_review_upload_bindings.scope=bound_scope)
  then raise exception 'UPLOAD_REQUEST_CONFLICT';end if;
end;$$;
revoke all on function private.document_review_upload_bind(uuid,uuid) from public,anon,authenticated,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function private.document_review_upload_bind(uuid,uuid) to tivdoc_web_runtime,service_role;

-- Call before modifying source rows in original commit. Old/source/request
-- currentness is checked here, not after replacement invalidates old pins.
create function private.document_review_upload_commit_guard(target_case uuid,target_batch uuid) returns void
language plpgsql security definer set search_path='' as $$
declare b public.document_upload_batches;binding private.document_review_upload_bindings;
begin
 if session_user not in ('tivdoc_web_runtime','service_role') then raise exception 'UPLOAD_FORBIDDEN';end if;
 select * into b from public.document_upload_batches where id=target_batch and case_id=target_case;
 select * into binding from private.document_review_upload_bindings where batch_id=target_batch and case_id=target_case;
 if binding.batch_id is null then
  if exists(select 1 from private.document_review_request_targets where request_id=(b.manifest->>'requestId')::uuid and case_id=target_case) then raise exception 'UPLOAD_REQUEST_CONFLICT';end if;
  return;
 end if;
 if b.id is null or b.manifest->>'requestId' is distinct from binding.request_id::text then raise exception 'UPLOAD_REQUEST_CONFLICT';end if;
 perform private.document_review_upload_validate(target_case,binding.request_id,b.files);
end;$$;
revoke all on function private.document_review_upload_commit_guard(uuid,uuid) from public,anon,authenticated,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function private.document_review_upload_commit_guard(uuid,uuid) to tivdoc_web_runtime,service_role;

-- Call AFTER actual verified file writes, BEFORE completed_at is set, instead
-- of legacy answered_at update for this exact request. It does not close it.
create function private.document_review_upload_received(target_case uuid,target_batch uuid,target_checks jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare b public.document_upload_batches;binding private.document_review_upload_bindings;files jsonb;body jsonb;digest text;kind text;
begin
 if session_user not in ('tivdoc_web_runtime','service_role') then raise exception 'UPLOAD_FORBIDDEN';end if;
 perform 1 from public.cases where id=target_case and contact_verified_at is not null for update;if not found then raise exception 'UPLOAD_FORBIDDEN';end if;
 select * into b from public.document_upload_batches where id=target_batch and case_id=target_case;
 select * into binding from private.document_review_upload_bindings where batch_id=target_batch and case_id=target_case;
 if binding.batch_id is null then raise exception 'UPLOAD_REQUEST_CONFLICT';end if;
 if b.id is null or b.cancelled_at is not null or b.manifest->>'requestId' is distinct from binding.request_id::text
  or jsonb_typeof(target_checks) is distinct from 'object' then raise exception 'UPLOAD_REQUEST_CONFLICT';end if;
 if exists(select 1 from private.document_review_upload_receipts where batch_id=b.id) then return;end if;
 kind:=binding.scope#>>'{request,target,document_kind}';
 if exists(select 1 from jsonb_array_elements(b.files) f where target_checks->>(f->>'versionId') is distinct from f->>'sha256'
  or not exists(select 1 from public.documents d where d.case_id=target_case and d.id::text=f->>'documentId' and d.version_id::text=f->>'versionId'
   and d.content_sha256=f->>'sha256' and d.storage_path=f->>'path' and d.size=(f->>'size')::bigint and d.mime_type=f->>'type')) then raise exception 'UPLOAD_UNVERIFIED';end if;
 select jsonb_agg(jsonb_build_object('document_id',f->>'documentId','version_id',f->>'versionId','source_sha256',f->>'sha256',
  'document_kind',f->>'documentType','period_month',f->>'periodMonth','duplicate_content',
   binding.case_source_hashes_before @> jsonb_build_array(f->>'sha256') or (select count(*) from jsonb_array_elements(b.files) x where x->>'sha256'=f->>'sha256')>1)
  order by f->>'versionId') into files from jsonb_array_elements(b.files) f where f->>'documentType'=kind;
 if files is null then raise exception 'UPLOAD_REQUEST_CONFLICT';end if;
 body:=jsonb_build_object('schema_version','document-review-upload-receipt-v1','case_id',target_case,'request_id',binding.request_id,
  'target_sha256',binding.scope#>>'{request,target,target_sha256}','order_id',binding.scope->>'order_id','order_origin',binding.scope->>'order_origin',
  'order_receipt_sha256',binding.scope->>'order_receipt_sha256','period',binding.scope#>'{request,target,period}',
  'batch_id',b.id,'received_at',to_char(transaction_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'state','received_pending_review','files',files);
 digest:=encode(sha256(convert_to(private.governance_jsonb_compact_text(body),'UTF8')),'hex');
 insert into private.document_review_upload_receipts(batch_id,request_id,case_id,receipt,receipt_sha256)
 values(b.id,binding.request_id,target_case,body||jsonb_build_object('receipt_sha256',digest),digest);
end;$$;
revoke all on function private.document_review_upload_received(uuid,uuid,jsonb) from public,anon,authenticated,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function private.document_review_upload_received(uuid,uuid,jsonb) to tivdoc_web_runtime,service_role;

-- REQUIRED ROOT INTEGRATION (same migration, before code activation):
-- 1. opener159 permits only target.kind=document,answer_kind=document and
--    document_kind in payslip/contract/attendance in addition to factual. All
--    original saved stage/hash/paid/source/dependency guards unchanged.
-- 2. reserve request code switch calls validate for document_review:, and bind
--    after actual batch insert. Replays use immutable prior binding.
-- 3. commit calls commit_guard BEFORE source writes; its review request branch
--    calls received INSTEAD OF updating case_requests. completed_at/capture and
--    case/payment status logic remains atomic and unchanged.
-- 4. snapshot includes review document requests plus reviewReceipts. The
--    existing four legacy request types keep existing behavior. Received
--    review requests stay open/visible with pending-review status, not answered.
-- 5. request_current for a review DOCUMENT target may follow an original pin
--    to a current received version ONLY when the immutable same-request
--    binding.source_pins_before includes that exact old pin AND batch.files
--    contains same documentId/expectedVersion→versionId, current SHA matches
--    receipt. Unrelated replacement/other request never repairs a stale pin.
-- 6. expose binding.scope as optional review_scope on batch/reserve response;
--    runtime original RPCs need narrowly scoped helper SELECT access via
--    SECURITY DEFINER functions rather than grants to private tables.
-- 7. assessment table/function separate: SAME current saved analysis stage,
--    exact receipt/doc/version/SHA/order/period and target.fact_key OBSERVED
--    evidence required. Use TS assessReviewUpload rules mirrored in DB. Do not
--    accept generic complete, absence of filtered gap, text answer or caller
--    proposed boolean as authority. Store assessment SHA+run; only verified
--    satisfied may close, received/duplicate/wrong/cropped remains open.
-- 8. legacy order union/currentness handled by root admission migration;
--    do not fabricate product_orders or backfill offer hashes.

-- Component: review-upload-hooks.sql
-- PRIVATE PROPOSAL, never applied by this agent. Apply AFTER foundational
-- review-upload-proposal.sql. Root merges legacy order union independently.
-- These changes preserve every installed signature, invoker/definer mode and
-- grant; base drift aborts the migration rather than dropping a guard.

-- Only an immutable receipt for THIS exact target/request can carry an old pin
-- across an explicit replacement. document_versions lacks the prior SHA, so
-- the immutable reservation snapshot supplies it. New files cannot establish
-- a replacement edge. Unrelated batch files do not appear in receipt.files.
create function private.document_review_upload_pin_current(target_case uuid,target_request uuid,pin jsonb) returns boolean
language sql stable security definer set search_path='' as $$
 with recursive edges as (
  select old_source->>'document_id' document_id,old_source->>'version_id' old_version,old_source->>'source_sha256' old_sha,
   f->>'versionId' new_version,rf->>'source_sha256' new_sha
  from private.document_review_upload_bindings x
  join private.document_review_request_targets t on t.request_id=x.request_id and t.case_id=x.case_id
  join private.document_review_upload_receipts r on r.batch_id=x.batch_id and r.request_id=x.request_id and r.case_id=x.case_id
  join public.document_upload_batches b on b.id=x.batch_id and b.case_id=x.case_id and b.completed_at is not null and b.cancelled_at is null
  cross join lateral jsonb_array_elements(x.case_sources_before) old_source
  cross join lateral jsonb_array_elements(b.files) f
  cross join lateral jsonb_array_elements(r.receipt->'files') rf
  where x.case_id=target_case and x.request_id=target_request
   and pin->>'case_id'=target_case::text and x.source_pins_before @> jsonb_build_array(pin)
   and x.scope#>>'{request,target,target_sha256}'=t.target_sha256
   and r.receipt->>'target_sha256'=t.target_sha256 and b.manifest->>'requestId'=target_request::text
   and old_source->>'document_id'=f->>'documentId' and old_source->>'version_id'=f->>'expectedVersion'
   and rf->>'document_id'=f->>'documentId' and rf->>'version_id'=f->>'versionId' and rf->>'source_sha256'=f->>'sha256'
 ), reachable(document_id,version_id,source_sha256) as (
  select d.id::text,pin->>'version_id',pin->>'source_sha256' from public.documents d
   where d.case_id=target_case and (d.id::text=pin->>'document_id' or pin->>'document_id'=pin->>'version_id')
    and (d.id::text=pin->>'document_id' or exists(select 1 from public.document_versions v
     where v.case_id=target_case and v.document_id=d.id and v.version_id::text=pin->>'version_id'))
  union
  select e.document_id,e.new_version,e.new_sha from reachable p join edges e
   on e.document_id=p.document_id and e.old_version=p.version_id and e.old_sha=p.source_sha256
 ) select pin->>'case_id'=target_case::text and (
  exists(select 1 from public.documents d where d.case_id=target_case
   and (d.id::text=pin->>'document_id' or d.version_id::text=pin->>'document_id')
   and d.version_id::text=pin->>'version_id' and d.content_sha256=pin->>'source_sha256')
  or exists(select 1 from reachable p join public.documents d on d.case_id=target_case and d.id::text=p.document_id
   and d.version_id::text=p.version_id and d.content_sha256=p.source_sha256))
$$;
revoke all on function private.document_review_upload_pin_current(uuid,uuid,jsonb) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

-- Return-only helper called inside the already authenticated case-cookie RPC.
create function private.document_review_upload_batch_scope(target_case uuid,target_batch uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if session_user not in ('tivdoc_web_runtime','service_role') or not exists(select 1 from public.cases where id=target_case and contact_verified_at is not null)
  or not exists(select 1 from public.document_upload_batches where id=target_batch and case_id=target_case) then raise exception 'UPLOAD_FORBIDDEN';end if;
 return (select scope from private.document_review_upload_bindings where case_id=target_case and batch_id=target_batch);
end;$$;
revoke all on function private.document_review_upload_batch_scope(uuid,uuid) from public,anon,authenticated,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function private.document_review_upload_batch_scope(uuid,uuid) to service_role,tivdoc_web_runtime;

-- The received state is independent of original customer answers. A later
-- assessment decorates this view; it must never fabricate answered_by_identity.
create function private.document_review_upload_snapshot(target_case uuid,base jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare requests jsonb;receipts jsonb;
begin
 if session_user not in ('tivdoc_web_runtime','service_role') or base->>'caseId' is distinct from target_case::text
  or not exists(select 1 from public.cases where id=target_case and contact_verified_at is not null) then raise exception 'UPLOAD_FORBIDDEN';end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',q.id,'code',q.code,'question',q.question,
  'documentType',t.target->>'document_kind','state',case when exists(select 1 from private.document_review_upload_receipts r
    where r.request_id=q.id and r.case_id=target_case) then 'received_pending_review' else 'requested' end) order by q.opened_at,q.id),'[]'::jsonb)
 into requests from public.case_requests q join private.document_review_request_targets t on t.request_id=q.id and t.case_id=q.case_id
 where q.case_id=target_case and q.answer_kind='document' and q.answered_at is null and q.expired_at is null and q.expires_at>clock_timestamp()
  and t.target->>'document_kind' in ('payslip','contract','attendance') and private.document_review_request_current(target_case,q.id);
 select coalesce(jsonb_agg(r.receipt order by r.created_at,r.batch_id),'[]'::jsonb) into receipts
 from private.document_review_upload_receipts r join public.document_upload_batches b on b.id=r.batch_id and b.case_id=r.case_id
 where r.case_id=target_case and b.completed_at is not null and b.cancelled_at is null;
 -- Do not add empty metadata to historical cases.
 if requests='[]'::jsonb and receipts='[]'::jsonb then return base;end if;
 return base||jsonb_build_object('requests',coalesce(base->'requests','[]'::jsonb)||requests,'reviewReceipts',receipts);
end;$$;
revoke all on function private.document_review_upload_snapshot(uuid,jsonb) from public,anon,authenticated,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function private.document_review_upload_snapshot(uuid,jsonb) to service_role,tivdoc_web_runtime;

-- A receipt is journal input; later assessment is an output and MUST NOT enter
-- the input hash (otherwise every analysis would create another source job).
create function private.document_review_upload_journal(target_case uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(r.receipt order by r.batch_id),'[]'::jsonb)
 from private.document_review_upload_receipts r join public.document_upload_batches b on b.id=r.batch_id and b.case_id=r.case_id
 where r.case_id=target_case and b.completed_at is not null and b.cancelled_at is null
$$;
revoke all on function private.document_review_upload_journal(uuid) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create function private.document_review_upload_capture(target_case uuid,target_batch uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 if session_user not in ('tivdoc_web_runtime','service_role') or not exists(select 1 from public.document_upload_batches b
  join private.document_review_upload_receipts r on r.batch_id=b.id and r.case_id=b.case_id
  where b.id=target_batch and b.case_id=target_case and b.completed_at is not null and b.cancelled_at is null) then raise exception 'UPLOAD_FORBIDDEN';end if;
 perform private.capture_case_input(target_case,'document_review_upload_received');
end;$$;
revoke all on function private.document_review_upload_capture(uuid,uuid) from public,anon,authenticated,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function private.document_review_upload_capture(uuid,uuid) to service_role,tivdoc_web_runtime;

do $upgrade$ declare definition text; changed text;old_block text;replacement text;start_at integer;end_at integer;begin
 -- Broaden only the explicit supported document branch. All saved-run and
 -- purchased-scope/current-source checks remain exactly installed.
 definition:=pg_get_functiondef('private.document_review_request_open(uuid,integer,text,text,text,text)'::regprocedure);
 old_block:=$old$or target->'period' is distinct from review->'period' or target->>'kind' is distinct from 'factual'
  or not coalesce(target->>'answer_kind' in ('text','number','boolean','choice'),false)$old$;
 replacement:=$new$or target->'period' is distinct from review->'period'
  or not coalesce((target->>'kind'='factual' and target->>'answer_kind' in ('text','number','boolean','choice'))
   or (target->>'kind'='document' and target->>'answer_kind'='document' and target->>'document_kind' in ('payslip','contract','attendance')),false)$new$;
 if position(old_block in definition)=0 then raise exception 'REVIEW_UPLOAD_OPENER_BASE_DRIFT';end if;
 execute replace(definition,old_block,replacement);

 definition:=pg_get_functiondef('private.document_review_request_current(uuid,uuid)'::regprocedure);
 old_block:=$old$or not exists(select 1 from public.documents d where d.case_id=target_case
   and (d.id::text=p->>'document_id' or d.version_id::text=p->>'document_id')
   and d.version_id::text=p->>'version_id' and d.content_sha256=p->>'source_sha256')$old$;
 replacement:=$new$or not (case when t.target->>'kind'='document' then coalesce(private.document_review_upload_pin_current(target_case,target_request,p),false)
  else exists(select 1 from public.documents d where d.case_id=target_case
   and (d.id::text=p->>'document_id' or d.version_id::text=p->>'document_id')
   and d.version_id::text=p->>'version_id' and d.content_sha256=p->>'source_sha256') end)$new$;
 if position(old_block in definition)=0 then raise exception 'REVIEW_UPLOAD_CURRENT_BASE_DRIFT';end if;
 execute replace(definition,old_block,replacement);

 definition:=pg_get_functiondef('public.case_documents_reserve(uuid,uuid,jsonb)'::regprocedure);
 old_block:=$old$    request_type := case r.code when 'document_missing' then 'payslip' when 'document_unreadable' then 'payslip'
      when 'contract_missing' then 'contract' when 'attendance_missing' then 'attendance' end;
    if request_type is null or not exists(select 1 from jsonb_array_elements(allocated) x
      where x->>'documentType' = request_type and (r.code <> 'document_unreadable' or x->>'expectedVersion' is not null))
      then raise exception 'UPLOAD_REQUEST_CONFLICT'; end if;$old$;
 if position(old_block in definition)=0 then raise exception 'REVIEW_UPLOAD_RESERVE_REQUEST_BASE_DRIFT';end if;
 changed:=replace(definition,old_block,E'    if r.code like ''document_review:%'' then\n      perform private.document_review_upload_validate(target_case,r.id,allocated);\n    else\n'||old_block||E'\n    end if;');
 old_block:='values (target_batch, target_case, target_manifest, allocated) returning * into b;';
 if position(old_block in changed)=0 then raise exception 'REVIEW_UPLOAD_RESERVE_BIND_BASE_DRIFT';end if;
 changed:=replace(changed,old_block,old_block||E'\n  perform private.document_review_upload_bind(target_case,target_batch);');
 if position('return to_jsonb(b);' in changed)=0 then raise exception 'REVIEW_UPLOAD_RESERVE_RETURN_BASE_DRIFT';end if;
 changed:=replace(changed,'return to_jsonb(b);','return to_jsonb(b)||jsonb_build_object(''review_scope'',private.document_review_upload_batch_scope(target_case,target_batch));');
 execute changed;

 definition:=pg_get_functiondef('public.case_documents_batch(uuid,uuid)'::regprocedure);
 if position('return to_jsonb(b);' in definition)=0 then raise exception 'REVIEW_UPLOAD_BATCH_RETURN_BASE_DRIFT';end if;
 execute replace(definition,'return to_jsonb(b);','return to_jsonb(b)||jsonb_build_object(''review_scope'',private.document_review_upload_batch_scope(target_case,target_batch));');

 definition:=pg_get_functiondef('public.case_documents_commit(uuid,uuid,jsonb)'::regprocedure);
 old_block:='  for f in select * from jsonb_array_elements(b.files) loop';
 if position(old_block in definition)=0 then raise exception 'REVIEW_UPLOAD_COMMIT_PRECHECK_BASE_DRIFT';end if;
 changed:=replace(definition,old_block,E'  perform private.document_review_upload_commit_guard(target_case,target_batch);\n'||old_block);
 start_at:=position(E'  if b.manifest ? ''requestId'' then\n    -- Exactly the request chosen at reservation;' in changed);
 end_at:=position('  update public.cases set check_period_month = month,' in changed);
 if start_at=0 or end_at<=start_at then raise exception 'REVIEW_UPLOAD_COMMIT_REQUEST_BASE_DRIFT';end if;
 old_block:=substring(changed from start_at for end_at-start_at);
 replacement:=E'  if private.document_review_upload_batch_scope(target_case,target_batch) is not null then\n    perform private.document_review_upload_received(target_case,target_batch,target_checks);\n  else\n'||old_block||E'  end if;\n';
 changed:=substring(changed from 1 for start_at-1)||replacement||substring(changed from end_at);
 old_block:='  update public.document_upload_batches set completed_at = now() where id = target_batch;';
 if position(old_block in changed)=0 then raise exception 'REVIEW_UPLOAD_COMMIT_CAPTURE_BASE_DRIFT';end if;
 changed:=replace(changed,old_block,old_block||E'\n  if private.document_review_upload_batch_scope(target_case,target_batch) is not null then\n    perform private.document_review_upload_capture(target_case,target_batch);\n  end if;');
 execute changed;

 definition:=pg_get_functiondef('public.case_documents_snapshot(uuid)'::regprocedure);
 if position('return jsonb_build_object(' in definition)=0 or position(E'  );\nend;' in definition)=0 then raise exception 'REVIEW_UPLOAD_SNAPSHOT_BASE_DRIFT';end if;
 changed:=replace(definition,'return jsonb_build_object(','return private.document_review_upload_snapshot(target_case,jsonb_build_object(');
 execute replace(changed,E'  );\nend;',E'  ));\nend;');

 definition:=pg_get_functiondef('private.capture_case_input(uuid,text)'::regprocedure);
 old_block:=$old$ digest:=encode(sha256(convert_to(payload::text,'UTF8')),'hex');$old$;
 if position(old_block in definition)=0 then raise exception 'REVIEW_UPLOAD_CAPTURE_BASE_DRIFT';end if;
 execute replace(definition,old_block,E' if private.document_review_upload_journal(target_case)<>''[]''::jsonb then\n  payload:=payload||jsonb_build_object(''document_review_uploads'',private.document_review_upload_journal(target_case));\n end if;\n'||old_block);
end;$upgrade$;

-- Remaining separate integration: root must wire SAME-run assessment (see
-- review-upload-assessment.sql) and legacy order union before activation.
-- No customer answer/history row is created by any receipt hook above.

-- Component: legacy-review-hooks.sql
-- PRIVATE PROPOSAL; requires legacy-admission-proposal + root reading v3.
-- Apply AFTER review-upload-hooks (whose base-drift checks still use old order
-- predicates). All original columns/targets remain immutable.
alter table private.document_review_request_targets
 add column order_origin text not null default 'saved_order' check(order_origin in ('saved_order','legacy_paid_receipt')),
 add column legacy_receipt_sha256 text check(legacy_receipt_sha256~'^[a-f0-9]{64}$'),
 add column receipt_sha256 text generated always as(coalesce(legacy_receipt_sha256,offer_sha256)) stored;
alter table private.document_review_request_targets alter column offer_sha256 drop not null;
alter table private.document_review_request_targets add constraint document_review_order_origin_receipt check(
 (order_origin='saved_order' and offer_sha256 is not null and legacy_receipt_sha256 is null)
 or (order_origin='legacy_paid_receipt' and offer_sha256 is null and legacy_receipt_sha256 is not null));
do $$ declare fk record;begin
 for fk in select conname from pg_constraint where conrelid='private.document_review_request_targets'::regclass and confrelid='private.product_orders'::regclass and contype='f' loop
  execute format('alter table private.document_review_request_targets drop constraint %I',fk.conname);
 end loop;
end;$$;

create function private.document_review_paid_scope_current(target_case uuid,target_order uuid,target_origin text,target_receipt text,target_topics jsonb,target_month date) returns boolean
language sql stable security definer set search_path='' as $$
 select case when target_origin='saved_order' then exists(select 1 from private.product_orders o join private.order_entitlements e on e.order_id=o.id
  where o.id=target_order and o.case_id=target_case and o.state='paid' and o.refund_state<>'refunded' and e.state='active'
   and o.offer_sha256=target_receipt and to_jsonb(o.topics)=target_topics and o.period_from<=target_month and o.period_to>=target_month)
 when target_origin='legacy_paid_receipt' then exists(select 1 from jsonb_array_elements(private.legacy_paid_scopes_internal(target_case)) s
  where s->>'id'=target_order::text and s->>'case_id'=target_case::text and s->>'receipt_sha256'=target_receipt
   and s->'topics'=target_topics and private.legacy_scope_covers_month(s,target_month)) else false end
$$;
revoke all on function private.document_review_paid_scope_current(uuid,uuid,text,text,jsonb,date) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create function private.document_review_scope_insert_guard() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if session_user<>'tivdoc_worker_runtime' or private.runtime_verified_tenant() is distinct from 'saved-case:'||new.case_id::text
  or not private.document_review_paid_scope_current(new.case_id,new.order_id,new.order_origin,coalesce(new.legacy_receipt_sha256,new.offer_sha256),new.purchased_topics,(new.target#>>'{period,from}')::date)
  then raise exception 'REVIEW_REQUEST_ORDER_SCOPE';end if;
 return new;
end;$$;
revoke all on function private.document_review_scope_insert_guard() from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create trigger document_review_scope_insert_guard before insert on private.document_review_request_targets for each row execute function private.document_review_scope_insert_guard();

-- One exact public source is permitted in review.documents, never arbitrary
-- law/source claims and never customer completion source_pins. Version/hash
-- are the already acquired primary law, not a new approval or activation.
create function private.document_review_pinned_public_law(target_case uuid,candidate jsonb) returns boolean
language sql immutable security invoker set search_path='' as $$
 select candidate=jsonb_build_object('case_id',target_case::text,'document_id','il.hours-work-rest-law.1951',
 'version_id','IL_HOURS_WORK_REST_LAW@discovery-v0','file_sha256','ca770f73436663094f546e53bed93aeca867bbed7124991fecfa1a8d750fdcd9',
 'page_count',6,'kind','other','label','חוק שעות עבודה ומנוחה — מקור רשמי לחישוב המותנה','period',null,
 'reading_origin','ai_document_review','reading_sha256','2d3be1afb43e053000bf7f1aec35cf36c448a71dc8bd239df2177b413e01fa62')
$$;
revoke all on function private.document_review_pinned_public_law(uuid,jsonb) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

do $upgrade$ declare definition text;old_block text;new_block text;begin
 definition:=pg_get_functiondef('private.document_review_request_current(uuid,uuid)'::regprocedure);
 old_block:=$old$if not exists(select 1 from private.product_orders o join private.order_entitlements e on e.order_id=o.id
  where o.id=t.order_id and o.case_id=target_case and o.state='paid' and o.refund_state<>'refunded' and e.state='active'
   and o.offer_sha256=t.offer_sha256 and to_jsonb(o.topics)=t.purchased_topics and o.period_from<=from_date and o.period_to>=from_date) then return false;end if;$old$;
 if position(old_block in definition)=0 then raise exception 'LEGACY_REVIEW_CURRENT_BASE_DRIFT';end if;
 execute replace(definition,old_block,'if not private.document_review_paid_scope_current(target_case,t.order_id,t.order_origin,t.receipt_sha256,t.purchased_topics,from_date) then return false;end if;');

 definition:=pg_get_functiondef('private.document_review_request_open(uuid,integer,text,text,text,text)'::regprocedure);
 old_block:=$old$or review#>>'{purchased_scope,origin}' is distinct from 'saved_order'$old$;
 if position(old_block in definition)=0 then raise exception 'LEGACY_REVIEW_OPENER_ORIGIN_DRIFT';end if;
 definition:=replace(definition,old_block,$new$or not coalesce(review#>>'{purchased_scope,origin}' in ('saved_order','legacy_paid_receipt'),false)$new$);
 old_block:=$old$or prior.offer_sha256 is distinct from review#>>'{purchased_scope,receipt_sha256}'$old$;
 if position(old_block in definition)=0 then raise exception 'LEGACY_REVIEW_OPENER_RETRY_DRIFT';end if;
 definition:=replace(definition,old_block,$new$or prior.receipt_sha256 is distinct from review#>>'{purchased_scope,receipt_sha256}' or prior.order_origin is distinct from review#>>'{purchased_scope,origin}'$new$);
 old_block:=$old$origin_analysis_run_id,review_result_sha256,order_id,offer_sha256,purchased_topics)$old$;
 if position(old_block in definition)=0 then raise exception 'LEGACY_REVIEW_OPENER_INSERT_DRIFT';end if;
 definition:=replace(definition,old_block,'origin_analysis_run_id,review_result_sha256,order_id,offer_sha256,purchased_topics,order_origin,legacy_receipt_sha256)');
 old_block:=$old$(review#>>'{purchased_scope,order_id}')::uuid,review#>>'{purchased_scope,receipt_sha256}',review#>'{purchased_scope,topics}');$old$;
 new_block:=$new$(review#>>'{purchased_scope,order_id}')::uuid,case when review#>>'{purchased_scope,origin}'='saved_order' then review#>>'{purchased_scope,receipt_sha256}' else null end,review#>'{purchased_scope,topics}',review#>>'{purchased_scope,origin}',case when review#>>'{purchased_scope,origin}'='legacy_paid_receipt' then review#>>'{purchased_scope,receipt_sha256}' else null end);$new$;
 if position(old_block in definition)=0 then raise exception 'LEGACY_REVIEW_OPENER_VALUES_DRIFT';end if;
 definition:=replace(definition,old_block,new_block);
 -- Only the document-manifest lookup gets this exact-object public-law option.
 old_block:=$old$or not exists(select 1 from public.documents d join private.case_input_versions v on v.case_id=d.case_id and v.revision=expected_revision$old$;
 if position(old_block in definition)=0 then raise exception 'REVIEW_LAW_MANIFEST_BASE_DRIFT';end if;
 definition:=replace(definition,old_block,$new$or (not coalesce(private.document_review_pinned_public_law(target_case,p),false) and not exists(select 1 from public.documents d join private.case_input_versions v on v.case_id=d.case_id and v.revision=expected_revision$new$);
 old_block:=$old$and d.version_id::text=p->>'version_id' and d.content_sha256=p->>'file_sha256')) then raise exception 'REVIEW_REQUEST_SOURCE_CHANGED';end if;$old$;
 if position(old_block in definition)=0 then raise exception 'REVIEW_LAW_MANIFEST_CLOSE_DRIFT';end if;
 definition:=replace(definition,old_block,$new$and d.version_id::text=p->>'version_id' and d.content_sha256=p->>'file_sha256'))) then raise exception 'REVIEW_REQUEST_SOURCE_CHANGED';end if;$new$);
 execute definition;

 definition:=pg_get_functiondef('private.document_review_upload_bind(uuid,uuid)'::regprocedure);
 old_block:=$old$'order_id',t.order_id,'order_origin','saved_order','order_receipt_sha256',t.offer_sha256$old$;
 if position(old_block in definition)=0 then raise exception 'LEGACY_REVIEW_UPLOAD_BIND_DRIFT';end if;
 execute replace(definition,old_block,$new$'order_id',t.order_id,'order_origin',t.order_origin,'order_receipt_sha256',t.receipt_sha256$new$);
end;$upgrade$;

-- Existing candidate-target/source/read receipt remains unchanged. v3 applies
-- only to newly opened questions, including full historical nine-topic scope.
create or replace function private.document_field_request_open(target_case uuid,expected_revision integer,expected_input_sha256 text,target_payload jsonb,target_question text) returns uuid
 language plpgsql security definer set search_path='' as $$
declare new_request uuid;head private.case_input_heads;candidate_field text:=target_payload#>>'{candidate,field}';target_month date;
begin
 if session_user<>'tivdoc_worker_runtime' or private.runtime_verified_tenant() is distinct from 'saved-case:'||target_case::text then raise exception 'REQUEST_FIELD_FORBIDDEN';end if;
 perform 1 from public.cases where id=target_case for update;if not found then raise exception 'REQUEST_FIELD_FORBIDDEN';end if;
 select * into head from private.case_input_heads where case_id=target_case;
 if head.revision is distinct from expected_revision or head.input_sha256 is distinct from expected_input_sha256 then raise exception 'REQUEST_FIELD_SOURCE_CHANGED';end if;
 if not coalesce(target_payload->>'schema_version'='document-field-confirmation-v1' and target_payload->>'case_id'=target_case::text
  and target_payload->>'target_sha256'~'^[a-f0-9]{64}$' and target_payload->>'month'~'^\d{4}-(0[1-9]|1[0-2])$'
  and target_payload->'candidate'->'normalized_value'<>'null'::jsonb
  and candidate_field=any(private.document_field_question_fields_v3(array['minimum_wage','working_time','pension','travel','convalescence','vacation','sick_leave','rest_day','bonuses','contract']::text[])),false)
  or char_length(target_question) not between 4 and 400 or target_question is null then raise exception 'REQUEST_FIELD_TARGET_INVALID';end if;
 if not private.document_field_current(target_case,target_payload) then raise exception 'REQUEST_FIELD_SOURCE_CHANGED';end if;
 target_month:=to_date(target_payload->>'month','YYYY-MM');
 if not (exists(select 1 from private.product_orders o join private.order_entitlements e on e.order_id=o.id and e.state='active'
  where o.case_id=target_case and o.state='paid' and o.refund_state<>'refunded' and target_month between o.period_from and o.period_to)
  or exists(select 1 from jsonb_array_elements(private.legacy_paid_scopes_internal(target_case)) s where private.legacy_scope_covers_month(s,target_month)))
  then raise exception 'REQUEST_FIELD_UNPURCHASED_MONTH';end if;
 if not (exists(select 1 from private.case_input_versions v
  cross join lateral jsonb_array_elements(v.input->'orders') pinned
  join private.product_orders o on o.case_id=v.case_id and o.id::text=pinned->>'id'
  join private.order_entitlements e on e.order_id=o.id and e.state='active'
  where v.case_id=target_case and v.revision=expected_revision and v.input_sha256=expected_input_sha256 and o.state='paid' and o.refund_state<>'refunded'
   and pinned=jsonb_build_object('id',o.id,'kind',o.kind,'from',o.period_from,'to',o.period_to,'topics',o.topics,'offer_sha256',o.offer_sha256)
   and target_month between o.period_from and o.period_to and candidate_field=any(private.document_field_question_fields_v3(o.topics)))
  or exists(select 1 from private.case_input_versions v cross join lateral jsonb_array_elements(v.input->'legacy_orders') pinned
   cross join lateral jsonb_array_elements(private.legacy_paid_scopes_internal(target_case)) active
   where v.case_id=target_case and v.revision=expected_revision and v.input_sha256=expected_input_sha256 and pinned=active
    and private.legacy_scope_covers_month(active,target_month)
    and candidate_field=any(private.document_field_question_fields_v3(array(select jsonb_array_elements_text(active->'topics'))))))
  then raise exception 'REQUEST_FIELD_UNPURCHASED_TOPIC';end if;
 select t.request_id into new_request from private.document_field_targets t where t.case_id=target_case and t.target_sha256=target_payload->>'target_sha256';
 if new_request is not null then
  if (select t.target from private.document_field_targets t where t.request_id=new_request) is distinct from target_payload then raise exception 'REQUEST_FIELD_TARGET_CONFLICT';end if;
  return new_request;
 end if;
 new_request:=gen_random_uuid();
 insert into private.document_field_targets(request_id,case_id,target_sha256,target) values(new_request,target_case,target_payload->>'target_sha256',target_payload);
 insert into public.case_requests(id,case_id,code,question,answer_kind,options,field_crop,blocking,expires_at)
 values(new_request,target_case,'document_field:'||(target_payload->>'target_sha256'),target_question,'choice',
 array['כן, בדקתי במסמך והערך נכון','הערך שונה במסמך','לא ניתן לקרוא את השדה'],candidate_field,false,clock_timestamp()+interval '10 days');
 return new_request;
end;$$;
revoke all on function private.document_field_request_open(uuid,integer,text,jsonb,text) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_operations_runtime;
grant execute on function private.document_field_request_open(uuid,integer,text,jsonb,text) to tivdoc_worker_runtime;

-- Identified read model contains no raw snapshot, payment-provider IDs, source
-- documents or internal import actor. Period arrays retain actual coverage.
create function public.case_order_legacy_receipts(target_case uuid,target_identity uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if session_user not in ('tivdoc_web_runtime','service_role') or target_identity is null
  or not exists(select 1 from public.case_identity_cases where case_id=target_case and identity_id=target_identity)
  or not exists(select 1 from public.cases where id=target_case and is_qa is true and contact_verified_at is not null)
  then raise exception 'ORDER_FORBIDDEN';end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('id',s->>'id','kind','legacy_initial','origin','legacy_paid_receipt',
  'topics',s->'topics','periods',(select coalesce(jsonb_agg(p->'period' order by p#>>'{period,from}',p#>>'{period,to}'),'[]'::jsonb) from jsonb_array_elements(s->'periods') p),
  'amount_minor',s->'amount_minor','currency',s->'currency','period_state',s->>'period_state','receipt_sha256',s->>'receipt_sha256',
  'scope_basis',s->>'scope_basis','new_payment_required',false) order by s->>'id'),'[]'::jsonb)
  from jsonb_array_elements(private.legacy_paid_scopes_internal(target_case)) s);
end;$$;
revoke all on function public.case_order_legacy_receipts(uuid,uuid) from public,anon,authenticated,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function public.case_order_legacy_receipts(uuid,uuid) to tivdoc_web_runtime,service_role;

-- Component: review-upload-assessment.sql
-- PRIVATE PROPOSAL. Requires foundational upload tables/helpers and hooks.
-- The caller names a persisted run; it cannot submit a completion boolean or
-- unpersisted evidence. No original answer or identity history is manufactured.
create table private.document_review_upload_assessments(
 batch_id uuid not null references private.document_review_upload_receipts(batch_id),
 request_id uuid not null references public.case_requests(id),case_id uuid not null references public.cases(id),
 analysis_run_id uuid not null references public.analysis_runs(id),canonical_analysis_run_id text not null,
 input_revision integer not null,input_sha256 text not null,assessment jsonb not null,
 created_at timestamptz not null default clock_timestamp(),primary key(batch_id,analysis_run_id)
);
alter table private.document_review_upload_assessments enable row level security;
revoke all on private.document_review_upload_assessments from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create trigger document_review_upload_assessment_immutable before update or delete on private.document_review_upload_assessments for each row execute function private.reject_engine_append_only_mutation();

create function private.document_review_upload_assess(target_case uuid,expected_revision integer,expected_input_sha256 text,
 target_batch uuid,target_run text,expected_dependency_sha256 text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare h private.case_input_heads;ar public.analysis_runs;stage public.engine_analysis_stage_versions;
 x private.document_review_upload_bindings;r private.document_review_upload_receipts;t private.document_review_request_targets;
 review jsonb;planner jsonb;body jsonb;assessment jsonb;prior jsonb;pins jsonb;
 state text:='satisfied';reason text:='target_specific_observed_source';evidence_origin text;
begin
 if session_user<>'tivdoc_worker_runtime' or private.runtime_verified_tenant() is distinct from 'saved-case:'||target_case::text then raise exception 'REVIEW_UPLOAD_FORBIDDEN';end if;
 perform 1 from public.cases where id=target_case for update;if not found then raise exception 'REVIEW_UPLOAD_FORBIDDEN';end if;
 select * into h from private.case_input_heads where case_id=target_case;
 if h.revision is distinct from expected_revision or h.input_sha256 is distinct from expected_input_sha256
  or not exists(select 1 from private.case_analysis_dispatch d where d.case_id=target_case and d.revision=h.revision and d.mode='draft'
    and d.authority_dependency_sha256 is not distinct from expected_dependency_sha256) then raise exception 'REVIEW_UPLOAD_SOURCE_CHANGED';end if;
 select * into x from private.document_review_upload_bindings where batch_id=target_batch and case_id=target_case;
 select * into r from private.document_review_upload_receipts where batch_id=target_batch and case_id=target_case;
 select * into t from private.document_review_request_targets where request_id=x.request_id and case_id=target_case;
 if r.batch_id is null or x.batch_id is null or t.request_id is null or r.request_id<>x.request_id
  or not exists(select 1 from public.document_upload_batches where id=target_batch and case_id=target_case and completed_at is not null and cancelled_at is null)
  or not exists(select 1 from private.case_input_versions v where v.case_id=target_case and v.revision=expected_revision and v.input_sha256=expected_input_sha256
   and v.input->'document_review_uploads' @> jsonb_build_array(r.receipt)) then raise exception 'REVIEW_UPLOAD_RECEIPT_REQUIRED';end if;
 select * into ar from public.analysis_runs where canonical_analysis_run_id=target_run and canonical_case_id=target_case::text and tenant_id='saved-case:'||target_case::text;
 if not found or ar.status not in ('running','completed') then raise exception 'REVIEW_UPLOAD_STAGE_REQUIRED';end if;
 select * into stage from public.engine_analysis_stage_versions s where s.analysis_run_id=ar.id and s.stage='topic_results' and s.case_id=ar.case_id and s.tenant_id=ar.tenant_id;
 if not found or stage.payload_sha256 is distinct from encode(sha256(convert_to(private.governance_jsonb_compact_text(stage.payload),'UTF8')),'hex') then raise exception 'REVIEW_UPLOAD_STAGE_HASH';end if;
 review:=stage.payload#>'{bundle,document_review}';planner:=review#>'{input,completion_input}';
 if review->>'schema_version' is distinct from 'document-review-product-v1' or review->>'analysis_run_id' is distinct from target_run
  or review->>'case_id' is distinct from target_case::text or review->>'input_sha256' is distinct from ar.command_payload->>'document_review_sha256'
  or review->>'result_sha256' is distinct from encode(sha256(convert_to(private.governance_jsonb_compact_text(review-'result_sha256'),'UTF8')),'hex')
  or ar.command_payload->>'document_snapshot_id' is distinct from 'saved-documents:'||left(review#>>'{period,from}',7)||':'||expected_input_sha256
  or review->'period' is distinct from r.receipt->'period' or t.target->'period' is distinct from r.receipt->'period'
  or review#>>'{purchased_scope,order_id}' is distinct from r.receipt->>'order_id'
  or review#>>'{purchased_scope,origin}' is distinct from r.receipt->>'order_origin'
  or review#>>'{purchased_scope,receipt_sha256}' is distinct from r.receipt->>'order_receipt_sha256'
  or t.target_sha256 is distinct from r.receipt->>'target_sha256' or x.scope#>>'{request,target,target_sha256}' is distinct from t.target_sha256
  or not private.document_review_request_current(target_case,t.request_id)
  or jsonb_typeof(planner->'evidence') is distinct from 'array' or jsonb_typeof(planner->'documents') is distinct from 'array'
  then raise exception 'REVIEW_UPLOAD_STAGE_SCOPE';end if;
 select jsonb_agg(jsonb_build_object('case_id',target_case,'document_id',f->>'document_id','version_id',f->>'version_id','source_sha256',f->>'source_sha256') order by f->>'version_id')
 into pins from jsonb_array_elements(r.receipt->'files') f;
 evidence_origin:=case when t.target->>'required_evidence_kind'='actual_transfer' then 'transfer_receipt' else 'document' end;
 if exists(select 1 from jsonb_array_elements(r.receipt->'files') f where not exists(select 1 from public.documents d
  where d.case_id=target_case and d.id::text=f->>'document_id' and d.version_id::text=f->>'version_id' and d.content_sha256=f->>'source_sha256')) then
  state:='stale';reason:='submitted_source_replaced';
 elsif exists(select 1 from jsonb_array_elements(r.receipt->'files') f where f->'duplicate_content' is distinct from 'false'::jsonb) then
  state:='insufficient';reason:='duplicate_content';
 elsif exists(select 1 from jsonb_array_elements_text(t.dependent_check_ids) dep where not exists(select 1 from jsonb_array_elements((review->'checks')||(review->'coverage_gaps')) c where c->>'check_id'=dep)) then
  state:='insufficient';reason:='dependent_check_not_evaluated';
 elsif exists(select 1 from jsonb_array_elements(planner->'evidence') e where e->>'fact_key'=t.target->>'fact_key'
  and e#>>'{period,from}'<=t.target#>>'{period,from}' and e#>>'{period,to}'>=t.target#>>'{period,to}' and e->>'state' in ('unknown','conflicted')) then
  state:='insufficient';reason:='requested_evidence_unresolved';
 elsif not exists(select 1 from jsonb_array_elements(planner->'evidence') e where e->>'fact_key'=t.target->>'fact_key'
  and e#>>'{period,from}'<=t.target#>>'{period,from}' and e#>>'{period,to}'>=t.target#>>'{period,to}'
  and e->>'state'='observed' and e->'source_reviewed'='true'::jsonb and e->'value'<>'null'::jsonb and e->>'origin'=evidence_origin) then
  state:='insufficient';reason:='target_specific_observation_required';
 elsif exists(select 1 from jsonb_array_elements(pins) pin where not exists(
  select 1 from jsonb_array_elements(review->'documents') d cross join lateral jsonb_array_elements(planner->'documents') pd
  where (d->>'document_id'=pin->>'document_id' or d->>'document_id'=pin->>'version_id') and d->>'version_id'=pin->>'version_id' and d->>'file_sha256'=pin->>'source_sha256'
   and d->>'case_id'=target_case::text and d->>'kind'=t.target->>'document_kind'
   and d->>'reading_origin'<>'source_inventory' and d->'page_count'<>'null'::jsonb
   and pd#>>'{pin,case_id}'=pin->>'case_id' and pd#>>'{pin,version_id}'=pin->>'version_id' and pd#>>'{pin,source_sha256}'=pin->>'source_sha256'
   and (pd#>>'{pin,document_id}'=pin->>'document_id' or pd#>>'{pin,document_id}'=pin->>'version_id')
   and pd->>'review'='complete' and pd#>>'{period,from}'<=t.target#>>'{period,from}' and pd#>>'{period,to}'>=t.target#>>'{period,to}'
   and exists(select 1 from jsonb_array_elements(planner->'evidence') e where e->>'fact_key'=t.target->>'fact_key'
    and e#>>'{period,from}'<=t.target#>>'{period,from}' and e#>>'{period,to}'>=t.target#>>'{period,to}'
    and e->>'state'='observed' and e->'source_reviewed'='true'::jsonb and e->'value'<>'null'::jsonb and e->>'origin'=evidence_origin
    and exists(select 1 from jsonb_array_elements(e->'source_pins') ep where ep->>'case_id'=pin->>'case_id' and ep->>'version_id'=pin->>'version_id'
     and ep->>'source_sha256'=pin->>'source_sha256' and (ep->>'document_id'=pin->>'document_id' or ep->>'document_id'=pin->>'version_id'))))) then
  state:='insufficient';reason:='submitted_document_not_fully_verified';
 end if;
 body:=jsonb_build_object('state',state,'reason',reason,'request_id',r.request_id,'receipt_sha256',r.receipt_sha256,
  'analysis_run_id',target_run,'analysis_result_sha256',review->>'result_sha256','target_sha256',t.target_sha256,
  'verified_source_pins',case when state='satisfied' then pins else '[]'::jsonb end,'invalidated_check_ids',t.dependent_check_ids,
  'information_satisfied',state='satisfied','customer_declaration_is_source',false);
 assessment:=body||jsonb_build_object('assessment_sha256',encode(sha256(convert_to(private.governance_jsonb_compact_text(body),'UTF8')),'hex'));
 select a.assessment into prior from private.document_review_upload_assessments a where a.batch_id=target_batch and a.analysis_run_id=ar.id;
 if prior is not null and prior is distinct from assessment then raise exception 'REVIEW_UPLOAD_ASSESSMENT_CONFLICT';end if;
 insert into private.document_review_upload_assessments(batch_id,request_id,case_id,analysis_run_id,canonical_analysis_run_id,input_revision,input_sha256,assessment)
 values(target_batch,r.request_id,target_case,ar.id,target_run,expected_revision,expected_input_sha256,assessment) on conflict do nothing;
 return assessment;
end;$$;
revoke all on function private.document_review_upload_assess(uuid,integer,text,uuid,text,text) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_operations_runtime;
grant execute on function private.document_review_upload_assess(uuid,integer,text,uuid,text,text) to tivdoc_worker_runtime;

-- Read model helper is owner-only. Satisfaction is current only while the exact
-- assessed source input and submitted file versions are current. Old entries
-- remain history. This does not silently renew an expired product request.
create function private.document_review_upload_state(target_case uuid,target_request uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select case when a.assessment is not null and a.input_revision=h.revision and a.input_sha256=h.input_sha256
  and not exists(select 1 from jsonb_array_elements(r.receipt->'files') f where not exists(select 1 from public.documents d
   where d.case_id=target_case and d.id::text=f->>'document_id' and d.version_id::text=f->>'version_id' and d.content_sha256=f->>'source_sha256'))
 then a.assessment else jsonb_build_object('state','received_pending_review','information_satisfied',false,'receipt_sha256',r.receipt_sha256) end
 from private.document_review_upload_receipts r
 join private.case_input_heads h on h.case_id=r.case_id
 left join lateral(select * from private.document_review_upload_assessments a where a.batch_id=r.batch_id and a.case_id=r.case_id order by a.created_at desc,a.analysis_run_id desc limit 1) a on true
 where r.case_id=target_case and r.request_id=target_request order by r.created_at desc,r.batch_id desc limit 1
$$;
revoke all on function private.document_review_upload_state(uuid,uuid) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

do $upgrade$ declare definition text;old_block text;begin
 definition:=pg_get_functiondef('private.document_review_upload_snapshot(uuid,jsonb)'::regprocedure);
 old_block:=$old$'state',case when exists(select 1 from private.document_review_upload_receipts r
    where r.request_id=q.id and r.case_id=target_case) then 'received_pending_review' else 'requested' end$old$;
 if position(old_block in definition)=0 then raise exception 'REVIEW_UPLOAD_ASSESSMENT_SNAPSHOT_DRIFT';end if;
 execute replace(definition,old_block,$new$'state',coalesce(private.document_review_upload_state(target_case,q.id)->>'state','requested'),
  'fulfillment',private.document_review_upload_state(target_case,q.id)$new$);
end;$upgrade$;

-- Root integration hooks: after persisted topic_results, call assess for the
-- SAME job and each current received batch whose request/order/month matches.
-- Include fulfillment in identified case_request_review_states; never change
-- answered_at, insert correction answers, or send a notification from here.

-- Saved adapter reads the same persisted run plus latest receipt for each
-- request. The worker never SELECTs the private tables directly.
create function private.document_review_upload_assessment_inputs(target_case uuid,expected_revision integer,expected_input_sha256 text,
 target_run text,expected_dependency_sha256 text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare h private.case_input_heads;ar public.analysis_runs;s public.engine_analysis_stage_versions;review jsonb;items jsonb;pins jsonb;
begin
 if session_user<>'tivdoc_worker_runtime' or private.runtime_verified_tenant() is distinct from 'saved-case:'||target_case::text then raise exception 'REVIEW_UPLOAD_FORBIDDEN';end if;
 perform 1 from public.cases where id=target_case for update;if not found then raise exception 'REVIEW_UPLOAD_FORBIDDEN';end if;
 select * into h from private.case_input_heads where case_id=target_case;
 if h.revision is distinct from expected_revision or h.input_sha256 is distinct from expected_input_sha256
  or not exists(select 1 from private.case_analysis_dispatch d where d.case_id=target_case and d.revision=h.revision and d.mode='draft'
   and d.authority_dependency_sha256 is not distinct from expected_dependency_sha256) then raise exception 'REVIEW_UPLOAD_SOURCE_CHANGED';end if;
 select * into ar from public.analysis_runs where canonical_analysis_run_id=target_run and canonical_case_id=target_case::text and tenant_id='saved-case:'||target_case::text;
 if not found or ar.status not in ('running','completed') then raise exception 'REVIEW_UPLOAD_STAGE_REQUIRED';end if;
 select * into s from public.engine_analysis_stage_versions where analysis_run_id=ar.id and stage='topic_results' and case_id=ar.case_id and tenant_id=ar.tenant_id;
 if not found or s.payload_sha256 is distinct from encode(sha256(convert_to(private.governance_jsonb_compact_text(s.payload),'UTF8')),'hex') then raise exception 'REVIEW_UPLOAD_STAGE_HASH';end if;
 review:=s.payload#>'{bundle,document_review}';
 if review->>'case_id' is distinct from target_case::text or review->>'analysis_run_id' is distinct from target_run
  or review->>'input_sha256' is distinct from ar.command_payload->>'document_review_sha256'
  or review->>'result_sha256' is distinct from encode(sha256(convert_to(private.governance_jsonb_compact_text(review-'result_sha256'),'UTF8')),'hex')
  or ar.command_payload->>'document_snapshot_id' is distinct from 'saved-documents:'||left(review#>>'{period,from}',7)||':'||expected_input_sha256
  then raise exception 'REVIEW_UPLOAD_STAGE_SCOPE';end if;
 select coalesce(jsonb_agg(jsonb_build_object('scope',x.scope,'receipt',r.receipt) order by r.request_id),'[]'::jsonb) into items
 from private.case_input_versions v
 cross join lateral(select distinct on(r0.request_id) r0.* from private.document_review_upload_receipts r0
  where r0.case_id=v.case_id and v.input->'document_review_uploads' @> jsonb_build_array(r0.receipt)
  order by r0.request_id,r0.created_at desc,r0.batch_id desc) r
 join private.document_review_upload_bindings x on x.batch_id=r.batch_id and x.case_id=r.case_id and x.request_id=r.request_id
 where v.case_id=target_case and v.revision=expected_revision and v.input_sha256=expected_input_sha256
  and r.receipt->'period'=review->'period' and r.receipt->>'order_id'=review#>>'{purchased_scope,order_id}'
  and r.receipt->>'order_origin'=review#>>'{purchased_scope,origin}' and r.receipt->>'order_receipt_sha256'=review#>>'{purchased_scope,receipt_sha256}';
 select coalesce(jsonb_agg(jsonb_build_object('case_id',d.case_id,'document_id',d.id,'version_id',d.version_id,'source_sha256',d.content_sha256) order by d.id),'[]'::jsonb)
 into pins from public.documents d where d.case_id=target_case;
 return jsonb_build_object('review',review,'current_source_pins',pins,'items',items);
end;$$;
revoke all on function private.document_review_upload_assessment_inputs(uuid,integer,text,text,text) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_operations_runtime;
grant execute on function private.document_review_upload_assessment_inputs(uuid,integer,text,text,text) to tivdoc_worker_runtime;

create function public.case_request_review_upload_states(target_case uuid,target_identity uuid)
returns table(request_id uuid,state text,source_current boolean,information_satisfied boolean,analysis_run_id text,reason text)
language plpgsql stable security definer set search_path='' as $$
begin
 if session_user not in ('tivdoc_web_runtime','service_role') or target_identity is null
  or not exists(select 1 from public.case_identity_cases where case_id=target_case and identity_id=target_identity) then raise exception 'REVIEW_REQUEST_FORBIDDEN';end if;
 return query select q.id,coalesce(v.value->>'state','requested'),coalesce(private.document_review_request_current(target_case,q.id),false),
  coalesce((v.value->>'information_satisfied')::boolean,false),v.value->>'analysis_run_id',v.value->>'reason'
 from public.case_requests q join private.document_review_request_targets t on t.request_id=q.id and t.case_id=q.case_id
 left join lateral(select private.document_review_upload_state(target_case,q.id) value) v on true
 where q.case_id=target_case and q.answer_kind='document' and t.target->>'kind'='document';
end;$$;
revoke all on function public.case_request_review_upload_states(uuid,uuid) from public,anon,authenticated,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function public.case_request_review_upload_states(uuid,uuid) to service_role,tivdoc_web_runtime;
