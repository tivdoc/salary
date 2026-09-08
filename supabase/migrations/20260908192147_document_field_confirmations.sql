-- A customer's confirmation is tied to the exact saved machine reading.
-- It is not a professional attestation, rule activation or arithmetic approval.
create table private.document_field_targets(
 request_id uuid primary key references public.case_requests(id) on delete cascade deferrable initially deferred,
 case_id uuid not null references public.cases(id) on delete cascade,
 target_sha256 text not null check(target_sha256 ~ '^[a-f0-9]{64}$'),
 target jsonb not null check(jsonb_typeof(target)='object'),
 created_at timestamptz not null default clock_timestamp(),
 unique(case_id,target_sha256),
 check(coalesce(target->>'schema_version'='document-field-confirmation-v1' and target->>'case_id'=case_id::text and target->>'target_sha256'=target_sha256,false))
);
alter table private.document_field_targets enable row level security;
revoke all on private.document_field_targets from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant select on private.document_field_targets to tivdoc_worker_runtime;
create policy document_field_worker_read on private.document_field_targets for select to tivdoc_worker_runtime
 using(private.runtime_verified_tenant()='saved-case:'||case_id::text);
create function private.preserve_document_field_target() returns trigger language plpgsql security invoker set search_path='' as $$
begin raise exception 'REQUEST_FIELD_TARGET_IMMUTABLE';end;$$;
revoke all on function private.preserve_document_field_target() from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create trigger preserve_document_field_target before update on private.document_field_targets for each row execute function private.preserve_document_field_target();

-- The existing original-answer ledger did not record an actor. Only future
-- authenticated answers get one; never infer actors for historical answers.
alter table public.case_requests add column answered_by_identity uuid references public.case_identities(id);
create index case_requests_answered_identity_idx on public.case_requests(answered_by_identity) where answered_by_identity is not null;

create function private.document_field_current(target_case uuid, target jsonb) returns boolean
 language sql security definer set search_path='' as $$
 select exists(select 1 from public.documents d join private.case_extraction_checkpoints c
  on c.case_id=d.case_id and c.version_id=d.version_id
  cross join lateral jsonb_array_elements(c.result#>'{run,result,final_extraction,fields}') f
  where d.case_id=target_case and d.id::text=target->>'product_document_id' and d.version_id::text=target->>'version_id'
   and d.content_sha256=target->>'source_sha256' and c.input_sha256=d.content_sha256
   and c.policy_version=target->>'policy_version' and c.result_sha256=target->>'extraction_result_sha256'
   and c.result->>'expected_month'=target->>'month' and c.result->>'period_mismatch'='false'
   and c.result->>'case_id'=target_case::text and c.result->>'product_document_id'=d.id::text
   and c.result->>'version_id'=d.version_id::text and c.result->>'input_sha256'=d.content_sha256
   and f=target->'candidate' and f#>>'{source,document_id}'=d.version_id::text);
$$;
revoke all on function private.document_field_current(uuid,jsonb) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

-- Target rows are inserted before their deferred request FK. The trigger owns
-- the month, including a purchased month different from the initial case month.
create or replace function private.pin_request_statement_month() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='INSERT' then
  if new.code like 'document_field:%' then
   select t.target->>'month' into new.statement_month from private.document_field_targets t
    where t.request_id=new.id and t.case_id=new.case_id and new.code='document_field:'||t.target_sha256;
   if not found then raise exception 'REQUEST_FIELD_TARGET_MISSING';end if;
  else
   select to_char(c.check_period_month,'YYYY-MM') into new.statement_month from public.cases c where c.id=new.case_id;
   if not found then raise exception 'REQUEST_SCOPE_UNKNOWN';end if;
  end if;
 elsif new.case_id is distinct from old.case_id or new.statement_month is distinct from old.statement_month then
  raise exception 'REQUEST_STATEMENT_SCOPE_IMMUTABLE';
 end if;
 return new;
end;$$;
revoke all on function private.pin_request_statement_month() from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
do $$ begin execute format('create policy document_field_request_creator on public.case_requests for insert to %I with check(true)',current_user);end;$$;

create function private.document_field_request_open(target_case uuid,expected_revision integer,expected_input_sha256 text,target_payload jsonb,target_question text) returns uuid
 language plpgsql security definer set search_path='' as $$
declare new_request uuid; head private.case_input_heads; candidate_field text:=target_payload#>>'{candidate,field}';
begin
 if session_user<>'tivdoc_worker_runtime' or private.runtime_verified_tenant() is distinct from 'saved-case:'||target_case::text then raise exception 'REQUEST_FIELD_FORBIDDEN';end if;
 perform 1 from public.cases where id=target_case for update;if not found then raise exception 'REQUEST_FIELD_FORBIDDEN';end if;
 select * into head from private.case_input_heads where case_id=target_case;
 if head.revision is distinct from expected_revision or head.input_sha256 is distinct from expected_input_sha256 then raise exception 'REQUEST_FIELD_SOURCE_CHANGED';end if;
 if not coalesce(target_payload->>'schema_version'='document-field-confirmation-v1' and target_payload->>'case_id'=target_case::text
  and target_payload->>'target_sha256' ~ '^[a-f0-9]{64}$' and target_payload->>'month' ~ '^\d{4}-(0[1-9]|1[0-2])$'
  and target_payload->'candidate'->'normalized_value'<>'null'::jsonb
  and candidate_field in ('base_monthly_salary','hourly_rate','gross_salary','net_salary','regular_hours','overtime_125_hours','overtime_150_hours','pension_base','travel_amount','convalescence_amount','vacation_balance','sick_balance'),false)
  or char_length(target_question) not between 4 and 400 or target_question is null then raise exception 'REQUEST_FIELD_TARGET_INVALID';end if;
 if not private.document_field_current(target_case,target_payload) then raise exception 'REQUEST_FIELD_SOURCE_CHANGED';end if;
 if not exists(select 1 from private.product_orders o join private.order_entitlements e on e.order_id=o.id and e.state='active'
  where o.case_id=target_case and o.state='paid' and o.refund_state<>'refunded'
   and to_date(target_payload->>'month','YYYY-MM') between o.period_from and o.period_to) then raise exception 'REQUEST_FIELD_UNPURCHASED_MONTH';end if;
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

create function private.guard_document_field_answer() returns trigger language plpgsql security definer set search_path='' as $$
declare target jsonb;
begin
 if old.answered_by_identity is not null and new.answered_by_identity is distinct from old.answered_by_identity then raise exception 'REQUEST_FIELD_ACTOR_IMMUTABLE';end if;
 if old.code like 'document_field:%' then
  if (to_jsonb(new)-array['answered_at','answer_text','answered_by_identity','expired_at']) is distinct from
   (to_jsonb(old)-array['answered_at','answer_text','answered_by_identity','expired_at']) then raise exception 'REQUEST_FIELD_TARGET_IMMUTABLE';end if;
  if old.answered_at is null and new.answered_at is not null then
   select t.target into target from private.document_field_targets t where t.request_id=old.id and t.case_id=old.case_id;
   if target is null or not private.document_field_current(old.case_id,target) then raise exception 'REQUEST_FIELD_SOURCE_CHANGED';end if;
   if new.answered_by_identity is null or not exists(select 1 from public.case_identity_cases where case_id=new.case_id and identity_id=new.answered_by_identity) then raise exception 'REQUEST_FIELD_FORBIDDEN';end if;
  end if;
 end if;
 return new;
end;$$;
revoke all on function private.guard_document_field_answer() from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create trigger guard_document_field_answer before update on public.case_requests for each row execute function private.guard_document_field_answer();

create function public.case_request_answer_identified(target_request uuid,target_case uuid,target_identity uuid,target_answer text) returns setof public.case_requests
 language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.case_identity_cases where identity_id=target_identity and case_id=target_case) then raise exception 'REQUEST_FIELD_FORBIDDEN';end if;
 perform 1 from public.cases where id=target_case for update;
 perform 1 from public.case_requests where id=target_request and case_id=target_case for update;if not found then return;end if;
 update public.case_requests set answered_by_identity=target_identity where id=target_request and answered_at is null and expired_at is null and expires_at>clock_timestamp() and answered_by_identity is null;
 return query select * from public.case_request_answer(target_request,target_case,target_answer);
end;$$;
revoke all on function public.case_request_answer_identified(uuid,uuid,uuid,text) from public,anon,authenticated,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function public.case_request_answer_identified(uuid,uuid,uuid,text) to tivdoc_web_runtime,service_role;

create function public.case_request_document_source(target_case uuid,target_identity uuid,target_request uuid) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare target jsonb; source jsonb;
begin
 if not exists(select 1 from public.case_identity_cases where case_id=target_case and identity_id=target_identity) then raise exception 'REQUEST_FIELD_FORBIDDEN';end if;
 select t.target into target from private.document_field_targets t join public.case_requests r on r.id=t.request_id and r.case_id=t.case_id
 where t.case_id=target_case and t.request_id=target_request;
 if target is null then return null;end if;
 select jsonb_build_object('path',d.storage_path,'mime',d.mime_type,'size',d.size,'sha256',d.content_sha256,'version',d.version_id,'page',(target#>>'{candidate,source,page}')::integer)
 into source from public.documents d where d.case_id=target_case and d.id::text=target->>'product_document_id'
  and d.version_id::text=target->>'version_id' and d.content_sha256=target->>'source_sha256';
 return source;
end;$$;
revoke all on function public.case_request_document_source(uuid,uuid,uuid) from public,anon,authenticated,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function public.case_request_document_source(uuid,uuid,uuid) to tivdoc_web_runtime,service_role;

-- Original and corrected readings retain the actual actor and immutable target
-- in the already versioned input journal. Old snapshots are never rewritten.
do $$ declare definition text; needle text;begin
 definition:=pg_get_functiondef('private.case_request_record_original()'::regprocedure);
 needle:='insert into private.case_request_answer_versions(request_id,revision,answer_text,origin) values(new.id,1,new.answer_text,''original'')';
 if position(needle in definition)=0 then raise exception 'REQUEST_FIELD_ORIGINAL_BASE_MISMATCH';end if;
 execute replace(definition,needle,'insert into private.case_request_answer_versions(request_id,revision,answer_text,identity_id,origin) values(new.id,1,new.answer_text,new.answered_by_identity,''original'')');
 definition:=pg_get_functiondef('private.capture_case_input(uuid,text)'::regprocedure);
 needle:='''code'',r.code,';
 if position(needle in definition)=0 then raise exception 'REQUEST_FIELD_CAPTURE_BASE_MISMATCH';end if;
 execute replace(definition,needle,$new$'field_target',(select t.target from private.document_field_targets t where t.request_id=r.id and t.case_id=r.case_id),
  'answer_identity_id',coalesce((select a.identity_id from private.case_request_answer_versions a where a.request_id=r.id order by a.revision desc limit 1),r.answered_by_identity),
  'code',r.code,$new$);
end;$$;
