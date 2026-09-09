-- Explicit engineering lane. This does not activate legal rules, write the
-- ordinary findings/projection tables, accept payments or operate in production.
create table private.dev_financial_runs (
 id uuid primary key, case_id uuid not null references public.cases(id) on delete cascade,
 order_id uuid not null references private.product_orders(id), input_revision integer not null,
 input_sha256 text not null, parent_run_id text not null,
 payload jsonb not null, payload_sha256 text not null check(payload_sha256 ~ '^[a-f0-9]{64}$'),
 html text not null, pdf bytea not null, html_sha256 text not null, pdf_sha256 text not null,
 created_at timestamptz not null default clock_timestamp(),
 unique(case_id,order_id,input_revision),
 check(octet_length(html)<2000000 and octet_length(pdf)<2000000),
 check(coalesce(payload->>'authority'='engineering_only' and payload->>'schema_version'='tivdoc-dev-financial-run-v1',false))
);
create table private.dev_financial_findings (
 id uuid primary key, run_id uuid not null unique references private.dev_financial_runs(id) on delete cascade,
 case_id uuid not null references public.cases(id) on delete cascade, finding jsonb not null
);
create table private.dev_financial_request_targets (
 request_id uuid primary key references public.case_requests(id) on delete cascade deferrable initially deferred,
 case_id uuid not null references public.cases(id) on delete cascade,
 order_id uuid not null references private.product_orders(id), document_id uuid not null,
 version_id uuid not null, source_sha256 text not null, checkpoint_sha256 text not null,
 unique(case_id,order_id,version_id,checkpoint_sha256)
);
alter table private.dev_financial_runs enable row level security;
alter table private.dev_financial_findings enable row level security;
alter table private.dev_financial_request_targets enable row level security;
revoke all on private.dev_financial_runs,private.dev_financial_findings,private.dev_financial_request_targets
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create function private.dev_financial_immutable() returns trigger language plpgsql security invoker set search_path='' as $$
begin raise exception 'DEV_FINANCIAL_IMMUTABLE';end;$$;
revoke all on function private.dev_financial_immutable() from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create trigger dev_financial_run_immutable before update on private.dev_financial_runs for each row execute function private.dev_financial_immutable();
create trigger dev_financial_finding_immutable before update on private.dev_financial_findings for each row execute function private.dev_financial_immutable();
create trigger dev_financial_target_immutable before update on private.dev_financial_request_targets for each row execute function private.dev_financial_immutable();

create function private.dev_financial_source_current(target_case uuid,target_order uuid,target_version uuid,target_sha text) returns boolean
 language sql stable security invoker set search_path='' as $$
 select current_database()='tivdoc_release_replay_20260907' and exists(
  select 1 from public.cases c join public.documents d on d.case_id=c.id
  join private.product_orders o on o.case_id=c.id join private.order_entitlements e on e.order_id=o.id
  where c.id=target_case and c.is_qa and c.check_period_month='2026-06-01' and c.contact_verified_at is not null
   and d.version_id=target_version and d.content_sha256=target_sha and d.document_type='payslip' and d.period_month='2026-06-01'
   and o.id=target_order and o.state='paid' and o.refund_state<>'refunded' and e.state='active'
   and '2026-06-01'::date between o.period_from and o.period_to and 'minimum_wage'=any(o.topics));
$$;
revoke all on function private.dev_financial_source_current(uuid,uuid,uuid,text) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

create function private.dev_financial_admit(target_case uuid,target_order uuid,target_revision integer,target_input_sha text) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare h private.case_input_heads; d public.documents; c private.case_extraction_checkpoints; result jsonb;
begin
 if current_database()<>'tivdoc_release_replay_20260907' or session_user<>'tivdoc_worker_runtime'
  or private.runtime_verified_tenant() is distinct from 'saved-case:'||target_case::text then raise exception 'DEV_FINANCIAL_FORBIDDEN';end if;
 perform 1 from public.cases where id=target_case and is_qa and check_period_month='2026-06-01' for update;
 if not found then raise exception 'DEV_FINANCIAL_FORBIDDEN';end if;
 select * into h from private.case_input_heads where case_id=target_case;
 if h.revision is distinct from target_revision or h.input_sha256 is distinct from target_input_sha then raise exception 'ANALYSIS_INPUT_SUPERSEDED';end if;
 if (select count(*) from public.documents where case_id=target_case and document_type='payslip' and period_month='2026-06-01')<>1 then raise exception 'DEV_FINANCIAL_DOCUMENT_SCOPE';end if;
 select * into d from public.documents where case_id=target_case and document_type='payslip' and period_month='2026-06-01';
 if not private.dev_financial_source_current(target_case,target_order,d.version_id,d.content_sha256) then raise exception 'DEV_FINANCIAL_FORBIDDEN';end if;
 if not exists(select 1 from private.case_input_versions v cross join lateral jsonb_array_elements(v.input->'orders') p
  join private.product_orders o on o.id=target_order and o.case_id=v.case_id
  where v.case_id=target_case and v.revision=target_revision and v.input_sha256=target_input_sha
   and p=jsonb_build_object('id',o.id,'kind',o.kind,'from',o.period_from,'to',o.period_to,'topics',o.topics,'offer_sha256',o.offer_sha256)) then raise exception 'DEV_FINANCIAL_ORDER_UNPINNED';end if;
 select * into c from private.case_extraction_checkpoints where case_id=target_case and revision=target_revision and version_id=d.version_id and policy_version='saved-payslip-v21-p95-v1';
 if not found or c.input_sha256 is distinct from d.content_sha256 or c.result->>'period_mismatch' is distinct from 'false' or c.result->>'expected_month' is distinct from '2026-06' then raise exception 'DEV_FINANCIAL_EXTRACTION_REQUIRED';end if;
 result:=jsonb_build_object('document_id',d.id,'version_id',d.version_id,'source_sha256',d.content_sha256,'checkpoint_sha256',c.result_sha256,
  'path',d.storage_path,'mime',d.mime_type,'size',d.size,'checkpoint',c.result,'public_id',(select public_id from public.cases where id=target_case),
  'request_id',(select t.request_id from private.dev_financial_request_targets t where t.case_id=target_case and t.order_id=target_order and t.version_id=d.version_id and t.checkpoint_sha256=c.result_sha256),
  'input',(select input from private.case_input_versions where case_id=target_case and revision=target_revision));
 return result;
end;$$;
revoke all on function private.dev_financial_admit(uuid,uuid,integer,text) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_operations_runtime;
grant execute on function private.dev_financial_admit(uuid,uuid,integer,text) to tivdoc_worker_runtime;

create function private.dev_financial_request_open(target_case uuid,target_order uuid,target_revision integer,target_input_sha text) returns uuid
 language plpgsql security definer set search_path='' as $$
declare source jsonb; target_id uuid; code text;
begin
 source:=private.dev_financial_admit(target_case,target_order,target_revision,target_input_sha);
 if exists(select 1 from jsonb_array_elements(source#>'{checkpoint,run,result,final_extraction,fields}') f where f->>'field'='regular_hours' and f->'normalized_value' is distinct from 'null'::jsonb) then raise exception 'DEV_FINANCIAL_HOURS_NOT_MISSING';end if;
 select request_id into target_id from private.dev_financial_request_targets where case_id=target_case and order_id=target_order and version_id=(source->>'version_id')::uuid and checkpoint_sha256=source->>'checkpoint_sha256';
 if target_id is not null then return target_id;end if;
 target_id:=gen_random_uuid();code:='dev_financial_hours:'||encode(sha256(convert_to(target_case::text||'|'||target_order::text||'|'||(source->>'version_id')||'|'||(source->>'checkpoint_sha256'),'UTF8')),'hex');
 insert into private.dev_financial_request_targets values(target_id,target_case,target_order,(source->>'document_id')::uuid,(source->>'version_id')::uuid,source->>'source_sha256',source->>'checkpoint_sha256');
 insert into public.case_requests(id,case_id,code,question,answer_kind,field_crop,blocking,expires_at)
 values(target_id,target_case,code,'לניסוי ההנדסי של יוני 2026 חסר מספר השעות הרגילות במסמך הזה. מה מספר השעות הרגילות המופיע בו? אין לכלול שעות נוספות.','number','regular_hours',false,clock_timestamp()+interval '10 days');
 return target_id;
end;$$;
revoke all on function private.dev_financial_request_open(uuid,uuid,integer,text) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_operations_runtime;
grant execute on function private.dev_financial_request_open(uuid,uuid,integer,text) to tivdoc_worker_runtime;

-- Both original answers and corrections must still refer to the selected
-- source. The existing identified-answer and immutable journal are reused.
create function private.dev_financial_answer_guard() returns trigger language plpgsql security definer set search_path='' as $$
declare t private.dev_financial_request_targets; identity uuid; answer text; target_request_id uuid;
begin
 if tg_table_name='case_requests' then
  target_request_id:=new.id;identity:=new.answered_by_identity;answer:=new.answer_text;
  if new.answered_at is null then return new;end if;
 else target_request_id:=new.request_id;identity:=new.identity_id;answer:=new.answer_text;end if;
 select * into t from private.dev_financial_request_targets x where x.request_id=target_request_id;
 if not found then return new;end if;
 if identity is null or not exists(select 1 from public.case_identity_cases where case_id=t.case_id and identity_id=identity)
  or not private.dev_financial_source_current(t.case_id,t.order_id,t.version_id,t.source_sha256)
  or not exists(select 1 from private.case_extraction_checkpoints c where c.case_id=t.case_id and c.version_id=t.version_id and c.result_sha256=t.checkpoint_sha256
   and c.policy_version='saved-payslip-v21-p95-v1' and c.revision=(select max(c2.revision) from private.case_extraction_checkpoints c2 where c2.case_id=t.case_id and c2.version_id=t.version_id and c2.policy_version=c.policy_version)
   and not exists(select 1 from jsonb_array_elements(c.result#>'{run,result,final_extraction,fields}') f where f->>'field'='regular_hours' and f->'normalized_value' is distinct from 'null'::jsonb))
  then raise exception 'DEV_FINANCIAL_ANSWER_SOURCE_CHANGED';end if;
 if answer is null or answer!~'^(0|[1-9][0-9]{0,2})([.][0-9]{1,4})?$' then raise exception 'REQUEST_ANSWER_INVALID';end if;
 if answer::numeric<=0 or answer::numeric>182 then raise exception 'REQUEST_ANSWER_INVALID';end if;
 return new;
end;$$;
revoke all on function private.dev_financial_answer_guard() from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create trigger dev_financial_original_guard before update on public.case_requests for each row execute function private.dev_financial_answer_guard();
create trigger dev_financial_correction_guard before insert on private.case_request_answer_versions for each row execute function private.dev_financial_answer_guard();

create function private.dev_financial_save(body jsonb,body_sha text,report_html text,report_pdf text) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare source jsonb; prior private.dev_financial_runs; parent public.analysis_runs; facts jsonb; bytes bytea; id uuid:=(body->>'run_id')::uuid;
begin
 source:=private.dev_financial_admit((body->>'case_id')::uuid,(body->>'order_id')::uuid,(body->>'input_revision')::integer,body->>'input_sha256');
 if body->>'schema_version' is distinct from 'tivdoc-dev-financial-run-v1' or body->>'authority' is distinct from 'engineering_only' or body->>'month' is distinct from '2026-06'
  or body#>>'{source,version_id}' is distinct from source->>'version_id' or body#>>'{source,source_sha256}' is distinct from source->>'source_sha256'
  or body#>>'{source,checkpoint_sha256}' is distinct from source->>'checkpoint_sha256' or body->>'public_id' is distinct from source->>'public_id' then raise exception 'DEV_FINANCIAL_RESULT_SCOPE';end if;
 select * into parent from public.analysis_runs where tenant_id='saved-case:'||(body->>'case_id') and canonical_analysis_run_id=body->>'parent_run_id' and status='completed';
 if not found or parent.command_payload->>'document_snapshot_id' is distinct from 'saved-documents:2026-06:'||(body->>'input_sha256')
  or parent.command_payload->>'extraction_snapshot_id' is distinct from 'saved-extractions:2026-06:'||(body->>'input_sha256')
  or parent.command_payload->>'declared_fact_snapshot_id' is distinct from 'saved-declarations:2026-06:'||(body->>'input_sha256')
  or parent.command_payload#>>'{period,start_date}' is distinct from '2026-06-01' or parent.command_payload#>>'{period,end_date}' is distinct from '2026-06-30'
  or parent.idempotency_key is distinct from body->>'parent_key'
  or parent.completion_payload#>>'{bundle,result_sha256}' is distinct from body->>'parent_result_sha256' then raise exception 'DEV_FINANCIAL_PARENT_REQUIRED';end if;
 select payload->'facts' into facts from public.engine_analysis_stage_versions where analysis_run_id=parent.id and stage='canonical_facts';
 if facts is null or facts is distinct from body->'parent_facts' or body#>>'{facts,analysis_run_id}' is distinct from id::text then raise exception 'DEV_FINANCIAL_FACTS_BINDING';end if;
 select * into prior from private.dev_financial_runs where case_id=(body->>'case_id')::uuid and order_id=(body->>'order_id')::uuid and input_revision=(body->>'input_revision')::integer;
 bytes:=decode(report_pdf,'base64');
 if prior.id is not null then
  if prior.id<>id or prior.payload<>body or prior.payload_sha256<>body_sha or prior.html<>report_html or prior.pdf<>bytes then raise exception 'DEV_FINANCIAL_REPLAY_CONFLICT';end if;
  return jsonb_build_object('run_id',id,'replayed',true);
 end if;
 insert into private.dev_financial_runs(id,case_id,order_id,input_revision,input_sha256,parent_run_id,payload,payload_sha256,html,pdf,html_sha256,pdf_sha256)
 values(id,(body->>'case_id')::uuid,(body->>'order_id')::uuid,(body->>'input_revision')::integer,body->>'input_sha256',body->>'parent_run_id',body,body_sha,report_html,bytes,
  encode(sha256(convert_to(report_html,'UTF8')),'hex'),encode(sha256(bytes),'hex'));
 if body->'finding'<>'null'::jsonb then insert into private.dev_financial_findings values((body#>>'{finding,id}')::uuid,id,(body->>'case_id')::uuid,body->'finding');end if;
 return jsonb_build_object('run_id',id,'replayed',false);
end;$$;
revoke all on function private.dev_financial_save(jsonb,text,text,text) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_operations_runtime;
grant execute on function private.dev_financial_save(jsonb,text,text,text) to tivdoc_worker_runtime;

create function private.dev_financial_customer(target_case uuid,target_identity uuid,target_run uuid default null) returns jsonb
 language plpgsql security definer set search_path='' as $$
begin
 if current_database()<>'tivdoc_release_replay_20260907' or not exists(select 1 from public.cases c join public.case_identity_cases i on i.case_id=c.id
  where c.id=target_case and c.contact_verified_at is not null and i.identity_id=target_identity) then raise exception 'DEV_FINANCIAL_FORBIDDEN';end if;
 if not (select is_qa from public.cases where id=target_case) then return '[]'::jsonb;end if;
 return coalesce((select jsonb_agg(jsonb_build_object('payload',r.payload,'payload_sha256',r.payload_sha256,'html',r.html,'html_sha256',r.html_sha256,'pdf_sha256',r.pdf_sha256,
  'pdf_base64',case when target_run is not null then encode(r.pdf,'base64') else null end,
  'current',r.input_revision=h.revision and r.input_sha256=h.input_sha256 and private.dev_financial_source_current(r.case_id,r.order_id,(r.payload#>>'{source,version_id}')::uuid,r.payload#>>'{source,source_sha256}')) order by r.input_revision desc)
  from private.dev_financial_runs r join private.case_input_heads h on h.case_id=r.case_id where r.case_id=target_case and (target_run is null or r.id=target_run)),'[]'::jsonb);
end;$$;
revoke all on function private.dev_financial_customer(uuid,uuid,uuid) from public,anon,authenticated,service_role,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function private.dev_financial_customer(uuid,uuid,uuid) to tivdoc_web_runtime;
create function public.case_report_dev_financial(target_case uuid,target_identity uuid,target_run uuid default null) returns jsonb
 language sql security invoker set search_path='' as $$select private.dev_financial_customer(target_case,target_identity,target_run);$$;
revoke all on function public.case_report_dev_financial(uuid,uuid,uuid) from public,anon,authenticated,service_role,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function public.case_report_dev_financial(uuid,uuid,uuid) to tivdoc_web_runtime;
