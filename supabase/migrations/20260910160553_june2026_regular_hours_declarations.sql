-- Identified missing-hours declarations for the canonical single-month scope.
-- This does not admit a declaration, activate a rule or alter historical DEV requests.
create table private.june2026_hours_targets (
 request_id uuid primary key references public.case_requests(id) on delete cascade deferrable initially deferred,
 case_id uuid not null references public.cases(id) on delete cascade,
 order_id uuid not null references private.product_orders(id), document_id uuid not null,
 version_id uuid not null, source_sha256 text not null, checkpoint_sha256 text not null,
 unique(case_id,order_id,version_id,checkpoint_sha256)
);
alter table private.june2026_hours_targets enable row level security;
revoke all on private.june2026_hours_targets from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create trigger june2026_hours_target_immutable before update on private.june2026_hours_targets for each row execute function private.dev_financial_immutable();
create function private.june2026_hours_source_current(target_case uuid,target_order uuid,target_version uuid,target_sha text) returns boolean
 language sql stable security invoker set search_path='' as $$
 select exists(
  select 1 from public.cases c join public.documents d on d.case_id=c.id
  join private.product_orders o on o.case_id=c.id join private.order_entitlements e on e.order_id=o.id
  where c.id=target_case and c.check_period_month='2026-06-01' and c.contact_verified_at is not null
   and d.version_id=target_version and d.content_sha256=target_sha and d.document_type='payslip' and d.period_month='2026-06-01'
   and o.id=target_order and o.state='paid' and o.refund_state<>'refunded' and e.state='active'
   and '2026-06-01'::date between o.period_from and o.period_to and 'minimum_wage'=any(o.topics));
$$;
revoke all on function private.june2026_hours_source_current(uuid,uuid,uuid,text) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

create function private.june2026_hours_admit(target_case uuid,target_order uuid,target_revision integer,target_input_sha text) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare h private.case_input_heads; d public.documents; c private.case_extraction_checkpoints; result jsonb;
begin
 if session_user<>'tivdoc_worker_runtime'
  or private.runtime_verified_tenant() is distinct from 'saved-case:'||target_case::text then raise exception 'JUNE_REGULAR_HOURS_FORBIDDEN';end if;
 perform 1 from public.cases where id=target_case and check_period_month='2026-06-01' for update;
 if not found then raise exception 'JUNE_REGULAR_HOURS_FORBIDDEN';end if;
 select * into h from private.case_input_heads where case_id=target_case;
 if h.revision is distinct from target_revision or h.input_sha256 is distinct from target_input_sha then raise exception 'ANALYSIS_INPUT_SUPERSEDED';end if;
 if (select count(*) from public.documents where case_id=target_case and document_type='payslip' and period_month='2026-06-01')<>1 then raise exception 'JUNE_REGULAR_HOURS_DOCUMENT_SCOPE';end if;
 select * into d from public.documents where case_id=target_case and document_type='payslip' and period_month='2026-06-01';
 if not private.june2026_hours_source_current(target_case,target_order,d.version_id,d.content_sha256) then raise exception 'JUNE_REGULAR_HOURS_FORBIDDEN';end if;
 if not exists(select 1 from private.case_input_versions v cross join lateral jsonb_array_elements(v.input->'orders') p
  join private.product_orders o on o.id=target_order and o.case_id=v.case_id
  where v.case_id=target_case and v.revision=target_revision and v.input_sha256=target_input_sha
   and p=jsonb_build_object('id',o.id,'kind',o.kind,'from',o.period_from,'to',o.period_to,'topics',o.topics,'offer_sha256',o.offer_sha256)) then raise exception 'JUNE_REGULAR_HOURS_ORDER_UNPINNED';end if;
 select * into c from private.case_extraction_checkpoints where case_id=target_case and revision=target_revision and version_id=d.version_id and policy_version='saved-payslip-v21-p95-v1';
 if not found or c.input_sha256 is distinct from d.content_sha256 or c.result->>'period_mismatch' is distinct from 'false' or c.result->>'expected_month' is distinct from '2026-06' then raise exception 'JUNE_REGULAR_HOURS_EXTRACTION_REQUIRED';end if;
 result:=jsonb_build_object('document_id',d.id,'version_id',d.version_id,'source_sha256',d.content_sha256,'checkpoint_sha256',c.result_sha256,
  'path',d.storage_path,'mime',d.mime_type,'size',d.size,'checkpoint',c.result,'public_id',(select public_id from public.cases where id=target_case),
  'request_id',(select t.request_id from private.june2026_hours_targets t where t.case_id=target_case and t.order_id=target_order and t.version_id=d.version_id and t.checkpoint_sha256=c.result_sha256),
  'input',(select input from private.case_input_versions where case_id=target_case and revision=target_revision));
 return result;
end;$$;
revoke all on function private.june2026_hours_admit(uuid,uuid,integer,text) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_operations_runtime;
grant execute on function private.june2026_hours_admit(uuid,uuid,integer,text) to tivdoc_worker_runtime;

create function private.june2026_hours_request_open(target_case uuid,target_order uuid,target_revision integer,target_input_sha text) returns uuid
 language plpgsql security definer set search_path='' as $$
declare source jsonb; target_id uuid; code text;
begin
 if session_user<>'tivdoc_worker_runtime' or private.runtime_verified_tenant() is distinct from 'saved-case:'||target_case::text then raise exception 'JUNE_REGULAR_HOURS_FORBIDDEN';end if;
 perform 1 from public.cases where id=target_case for update;
 if not exists(select 1 from private.case_input_heads where case_id=target_case and revision=target_revision and input_sha256=target_input_sha) then raise exception 'ANALYSIS_INPUT_SUPERSEDED';end if;
 -- Multiple payslips remain supported by extraction; this narrow declaration
 -- cannot choose which document describes the month's hours.
 if (select count(*) from public.documents where case_id=target_case and document_type='payslip' and period_month='2026-06-01')<>1 then return null;end if;
 source:=private.june2026_hours_admit(target_case,target_order,target_revision,target_input_sha);
 if exists(select 1 from jsonb_array_elements(source#>'{checkpoint,run,result,final_extraction,fields}') f where f->>'field'='regular_hours') then raise exception 'JUNE_REGULAR_HOURS_HOURS_NOT_MISSING';end if;
 select request_id into target_id from private.june2026_hours_targets where case_id=target_case and order_id=target_order and version_id=(source->>'version_id')::uuid and checkpoint_sha256=source->>'checkpoint_sha256';
 if target_id is not null then return target_id;end if;
 target_id:=gen_random_uuid();code:='june2026_regular_hours:'||encode(sha256(convert_to(target_case::text||'|'||target_order::text||'|'||(source->>'version_id')||'|'||(source->>'checkpoint_sha256'),'UTF8')),'hex');
 insert into private.june2026_hours_targets values(target_id,target_case,target_order,(source->>'document_id')::uuid,(source->>'version_id')::uuid,source->>'source_sha256',source->>'checkpoint_sha256');
 insert into public.case_requests(id,case_id,code,question,answer_kind,field_crop,blocking,expires_at)
 values(target_id,target_case,code,'לבדיקת שכר המינימום ביוני 2026 חסר מספר השעות הרגילות במסמך הזה. לפי רישומי העבודה או המידע שבידיך, כמה שעות רגילות עבדת בחודש? אין לכלול שעות נוספות או היעדרויות. התשובה תישמר כהצהרה שלך, ולא כנתון שנקרא מהתלוש.','number','regular_hours',false,clock_timestamp()+interval '10 days');
 return target_id;
end;$$;
revoke all on function private.june2026_hours_request_open(uuid,uuid,integer,text) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_operations_runtime;
grant execute on function private.june2026_hours_request_open(uuid,uuid,integer,text) to tivdoc_worker_runtime;

-- Both original answers and corrections must still refer to the selected
-- source. The existing identified-answer and immutable journal are reused.
create function private.june2026_hours_answer_guard() returns trigger language plpgsql security definer set search_path='' as $$
declare t private.june2026_hours_targets; identity uuid; answer text; target_request_id uuid;
begin
 if tg_table_name='case_requests' then
  target_request_id:=new.id;identity:=new.answered_by_identity;answer:=new.answer_text;
  if new.answered_at is null then return new;end if;
 else target_request_id:=new.request_id;identity:=new.identity_id;answer:=new.answer_text;end if;
 select * into t from private.june2026_hours_targets x where x.request_id=target_request_id;
 if not found then return new;end if;
 if identity is null or not exists(select 1 from public.case_identity_cases where case_id=t.case_id and identity_id=identity)
  or not private.june2026_hours_source_current(t.case_id,t.order_id,t.version_id,t.source_sha256)
  or not exists(select 1 from private.case_extraction_checkpoints c where c.case_id=t.case_id and c.version_id=t.version_id and c.result_sha256=t.checkpoint_sha256
   and c.policy_version='saved-payslip-v21-p95-v1' and c.revision=(select max(c2.revision) from private.case_extraction_checkpoints c2 where c2.case_id=t.case_id and c2.version_id=t.version_id and c2.policy_version=c.policy_version)
   and not exists(select 1 from jsonb_array_elements(c.result#>'{run,result,final_extraction,fields}') f where f->>'field'='regular_hours'))
  then raise exception 'JUNE_REGULAR_HOURS_ANSWER_SOURCE_CHANGED';end if;
 if answer is null or answer!~'^(0|[1-9][0-9]{0,2})([.][0-9]{1,4})?$' then raise exception 'REQUEST_ANSWER_INVALID';end if;
 if answer::numeric<=0 or answer::numeric>182 then raise exception 'REQUEST_ANSWER_INVALID';end if;
 return new;
end;$$;
revoke all on function private.june2026_hours_answer_guard() from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create trigger june2026_hours_original_guard before update on public.case_requests for each row execute function private.june2026_hours_answer_guard();
create trigger june2026_hours_correction_guard before insert on private.case_request_answer_versions for each row execute function private.june2026_hours_answer_guard();

create function public.case_request_regular_hours_states(target_case uuid,target_identity uuid) returns table(request_id uuid,source_current boolean)
 language plpgsql security definer set search_path='' as $$
begin
 if session_user<>'tivdoc_web_runtime' or not exists(select 1 from public.case_identity_cases where case_id=target_case and identity_id=target_identity) then raise exception 'REGULAR_HOURS_FORBIDDEN';end if;
 return query select r.id,coalesce(private.june2026_hours_source_current(t.case_id,t.order_id,t.version_id,t.source_sha256)
  and exists(select 1 from private.case_extraction_checkpoints c join private.case_input_heads h on h.case_id=c.case_id and h.revision=c.revision
   where c.case_id=t.case_id and c.version_id=t.version_id and c.result_sha256=t.checkpoint_sha256 and c.policy_version='saved-payslip-v21-p95-v1'),false)
 from public.case_requests r left join private.june2026_hours_targets t on t.request_id=r.id and t.case_id=r.case_id
 where r.case_id=target_case and r.code like 'june2026_regular_hours:%';
end;$$;
revoke all on function public.case_request_regular_hours_states(uuid,uuid) from public,anon,authenticated,service_role,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function public.case_request_regular_hours_states(uuid,uuid) to tivdoc_web_runtime;

do $migration$ declare definition text;needle text;begin
 definition:=pg_get_functiondef('private.pin_request_statement_month()'::regprocedure);
 needle:='  elsif new.code like ''document_field:%'' then';
 if position(needle in definition)=0 then raise exception 'REGULAR_HOURS_MONTH_BASE';end if;
 execute replace(definition,needle,$new$  elsif new.code like 'june2026_regular_hours:%' then
   if not exists(select 1 from private.june2026_hours_targets where request_id=new.id and case_id=new.case_id) then raise exception 'REGULAR_HOURS_TARGET_REQUIRED';end if;
   new.statement_month:='2026-06';
  elsif new.code like 'document_field:%' then$new$);
end $migration$;
