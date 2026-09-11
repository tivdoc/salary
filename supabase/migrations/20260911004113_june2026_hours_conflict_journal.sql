-- Source-bound conflict declarations; no observation, fact or approval is edited.
-- Reuse private.june2026_hours_admit for authenticated machine/current paid
-- source access. Do not change raw OCR, canonical facts or legacy targets.

create table private.june2026_hours_conflict_targets (
 request_id uuid primary key references public.case_requests(id) on delete cascade deferrable initially deferred,
 case_id uuid not null references public.cases(id) on delete cascade,
 order_id uuid not null references private.product_orders(id),
 target jsonb not null, target_sha256 text not null check(target_sha256 ~ '^[a-f0-9]{64}$'),
 unique(case_id,order_id,target_sha256)
);
alter table private.june2026_hours_conflict_targets enable row level security;
revoke all on private.june2026_hours_conflict_targets from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create trigger june_hours_conflict_target_immutable before update on private.june2026_hours_conflict_targets
 for each row execute function private.dev_financial_immutable();

-- Deterministic SQL equivalent of createDocumentHoursConflictTarget.
-- source is returned only by the existing authenticated/current paid-source RPC.
create function private.june2026_hours_conflict_target(source jsonb,target_case uuid,target_order uuid) returns jsonb
 language plpgsql security invoker set search_path='' as $$
declare extraction jsonb:=source#>'{checkpoint,run,result,final_extraction}'; observations jsonb; distinct_values integer;
 body jsonb;reason text;pages integer;record jsonb;
begin
 if source#>>'{checkpoint,case_id}' is distinct from target_case::text
  or source#>>'{checkpoint,product_document_id}' is distinct from source->>'document_id'
  or source#>>'{checkpoint,input_sha256}' is distinct from source->>'source_sha256'
  or source#>>'{checkpoint,result_sha256}' is distinct from source->>'checkpoint_sha256'
  or source->>'checkpoint_sha256' is distinct from encode(sha256(convert_to(private.governance_jsonb_compact_text(source#>'{checkpoint,run,result}'),'UTF8')),'hex')
  or source#>>'{checkpoint,expected_month}' is distinct from '2026-06'
  or source#>>'{checkpoint,period_mismatch}' is distinct from 'false'
  or extraction->>'document_id' is distinct from source->>'version_id'
  or extraction ? 'customer_readings' then raise exception 'HOURS_CONFLICT_SOURCE_BINDING';end if;
 if not exists(select 1 from jsonb_array_elements(extraction->'fields') f where f->>'field'='salary_period')
  or exists(select 1 from jsonb_array_elements(extraction->'fields') f where f->>'field'='salary_period'
   and f->'normalized_value' is distinct from '{"year":2026,"month":6,"start_date":"2026-06-01","end_date":"2026-06-30"}'::jsonb)
  then raise exception 'HOURS_CONFLICT_PERIOD_UNSUPPORTED';end if;
 if extraction->>'detected_document_type'<>'payslip' or extraction->>'status' not in ('completed','partial')
  then raise exception 'HOURS_CONFLICT_EXTRACTION_REQUIRED';end if;
 pages:=(extraction#>>'{quality_metrics,page_count}')::integer;
 if pages is null or pages<1 or pages>100 or jsonb_array_length(source#>'{checkpoint,run,provider_receipts}') not between 1 and 2
  then raise exception 'HOURS_CONFLICT_RECEIPT_REQUIRED';end if;
 for record in select value from jsonb_array_elements(source#>'{checkpoint,run,provider_receipts}') loop
  if record->>'status' is distinct from 'completed' or (record->>'source_page_count')::integer is distinct from pages
   or record->>'source_sha256' is distinct from source->>'source_sha256'
   or record->>'case_id' is distinct from target_case::text or record->>'document_id' is distinct from source->>'version_id'
   then raise exception 'HOURS_CONFLICT_RECEIPT_REQUIRED';end if;
 end loop;
 select coalesce(jsonb_agg(f order by n),'[]'::jsonb),count(distinct f->'normalized_value') filter(where f->'normalized_value'<>'null'::jsonb)
 into observations,distinct_values from jsonb_array_elements(extraction->'fields') with ordinality x(f,n) where f->>'field'='regular_hours';
 if distinct_values>=2 then reason:='conflicting_observations';
 elsif jsonb_array_length(observations)=0 and extraction->'warnings' ? 'conflicting_values' then reason:='provider_reported_conflict';
 else return null;end if;
 if jsonb_array_length(observations)>12 or exists(select 1 from jsonb_array_elements(observations) f
  where f#>>'{source,document_id}' is distinct from source->>'version_id' or (f#>>'{source,page}')::integer not between 1 and pages
   or nullif(trim(f#>>'{source,text_fragment}'),'') is null)
  or (select count(*)<>count(distinct f->>'candidate_id') from jsonb_array_elements(observations) f)
  then raise exception 'HOURS_CONFLICT_TARGET_BINDING';end if;
 body:=jsonb_build_object('schema_version','document-hours-conflict-target-v1','case_id',target_case,'order_id',target_order,
  'product_document_id',source->'document_id','version_id',source->'version_id','source_sha256',source->'source_sha256','month','2026-06',
  'extraction_policy_version','saved-payslip-v21-p95-v1','extraction_result_sha256',source->'checkpoint_sha256','source_page_count',pages,
  'reason',reason,'observations',observations,'source_warning_flags',extraction->'warnings');
 return body||jsonb_build_object('target_sha256',encode(sha256(convert_to(private.governance_jsonb_compact_text(body),'UTF8')),'hex'));
end;$$;

create function private.june2026_hours_conflict_admit(target_case uuid,target_order uuid,target_revision integer,target_input_sha text) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare source jsonb;current_target jsonb;t private.june2026_hours_conflict_targets;a jsonb;
begin
 source:=private.june2026_hours_admit(target_case,target_order,target_revision,target_input_sha);
 current_target:=private.june2026_hours_conflict_target(source,target_case,target_order);
 if current_target is not null then
  select * into t from private.june2026_hours_conflict_targets where case_id=target_case and order_id=target_order and target=current_target;
  if found then
   if (select count(*) from jsonb_array_elements(source#>'{input,answers}') value where value->>'id'=t.request_id::text)>1 then raise exception 'HOURS_CONFLICT_ANSWER_AMBIGUOUS';end if;
   select jsonb_build_object('request_id',value->'id','answer_revision',value->'answer_revision',
    'identity_id',value->'answer_identity_id','answered_at',value->'answer_created_at','answer',value->'answer') into a
    from jsonb_array_elements(source#>'{input,answers}') value where value->>'id'=t.request_id::text;
  end if;
 end if;
 return jsonb_build_object('target',t.target,'checkpoint',source->'checkpoint','policy_version','saved-payslip-v21-p95-v1','answer',a);
end;$$;

create function private.june2026_hours_conflict_request_open(target_case uuid,target_order uuid,target_revision integer,target_input_sha text) returns uuid
 language plpgsql security definer set search_path='' as $$
declare source jsonb;target jsonb;request uuid;question text;
begin
 source:=private.june2026_hours_admit(target_case,target_order,target_revision,target_input_sha);
 target:=private.june2026_hours_conflict_target(source,target_case,target_order);
 if target is null then return null;end if;
 select request_id into request from private.june2026_hours_conflict_targets where case_id=target_case and order_id=target_order and target_sha256=target->>'target_sha256';
 if request is not null then return request;end if;
 request:=gen_random_uuid();
 question:='בתלוש יוני 2026: '||(case when target->>'reason'='conflicting_observations' then 'נמצאו קריאות שעות שונות במקור.' else 'החילוץ סימן סתירה אך לא שמר מספיק קריאות שעות כדי לברר אותה.' end)||
  ' יש לבדוק את המסמך ואת רישומי העבודה, לציין את מספר השעות הרגילות ואת הבסיס לתשובה, או לבחור שלא ניתן לקבוע. התשובה היא הצהרה לבירור ואינה מתקנת את המקור או מאשרת זכאות.';
 insert into private.june2026_hours_conflict_targets values(request,target_case,target_order,target,target->>'target_sha256');
 insert into public.case_requests(id,case_id,code,question,answer_kind,field_crop,blocking,expires_at)
 values(request,target_case,'document_hours_conflict:'||(target->>'target_sha256'),question,'text','regular_hours',false,clock_timestamp()+interval '10 days');
 return request;
end;$$;

revoke all on function private.june2026_hours_conflict_target(jsonb,uuid,uuid),
 private.june2026_hours_conflict_admit(uuid,uuid,integer,text),private.june2026_hours_conflict_request_open(uuid,uuid,integer,text)
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function private.june2026_hours_conflict_admit(uuid,uuid,integer,text),
 private.june2026_hours_conflict_request_open(uuid,uuid,integer,text) to tivdoc_worker_runtime;

-- Invoker-only helper, called by authenticated wrappers. A selected historical
-- checkpoint is current only while it is the latest extraction of that version.
create function private.june2026_hours_conflict_current(target_case uuid,target jsonb) returns boolean
 language plpgsql stable security invoker set search_path='' as $$
declare d public.documents;c private.case_extraction_checkpoints;source jsonb;
begin
 if target->>'case_id' is distinct from target_case::text or target->>'schema_version' is distinct from 'document-hours-conflict-target-v1'
  or not private.june2026_hours_source_current(target_case,(target->>'order_id')::uuid,(target->>'version_id')::uuid,target->>'source_sha256') then return false;end if;
 select * into d from public.documents where case_id=target_case and id::text=target->>'product_document_id' and version_id::text=target->>'version_id' and content_sha256=target->>'source_sha256';
 if not found then return false;end if;
 select * into c from private.case_extraction_checkpoints where case_id=target_case and version_id=d.version_id and policy_version='saved-payslip-v21-p95-v1' order by revision desc limit 1;
 if not found or c.result_sha256 is distinct from target->>'extraction_result_sha256' or c.input_sha256 is distinct from d.content_sha256 then return false;end if;
 source:=jsonb_build_object('document_id',d.id,'version_id',d.version_id,'source_sha256',d.content_sha256,'checkpoint_sha256',c.result_sha256,'checkpoint',c.result);
 return private.june2026_hours_conflict_target(source,target_case,(target->>'order_id')::uuid)=target;
end;$$;

create function private.june2026_hours_conflict_answer_guard() returns trigger language plpgsql security definer set search_path='' as $$
declare r public.case_requests;t private.june2026_hours_conflict_targets;actor uuid;answer text;parsed jsonb;keys text[];
begin
 if tg_table_schema='public' then
  if old.code not like 'document_hours_conflict:%' then return new;end if;
  if (to_jsonb(new)-array['answered_at','answer_text','answered_by_identity','expired_at']) is distinct from (to_jsonb(old)-array['answered_at','answer_text','answered_by_identity','expired_at']) then raise exception 'HOURS_CONFLICT_TARGET_IMMUTABLE';end if;
  if old.answered_at is not null then
   if (new.answer_text,new.answered_at,new.answered_by_identity) is distinct from (old.answer_text,old.answered_at,old.answered_by_identity) then raise exception 'HOURS_CONFLICT_ORIGINAL_IMMUTABLE';end if;
   return new;
  end if;
  if new.answered_at is null then return new;end if;
  r:=new;actor:=new.answered_by_identity;answer:=new.answer_text;
 else
  select * into r from public.case_requests where id=new.request_id;
  if r.code not like 'document_hours_conflict:%' then return new;end if;
  actor:=new.identity_id;answer:=new.answer_text;
 end if;
 perform 1 from public.cases where id=r.case_id for update;
 select * into t from private.june2026_hours_conflict_targets where request_id=r.id and case_id=r.case_id and r.code='document_hours_conflict:'||target_sha256;
 if not found or not private.june2026_hours_conflict_current(r.case_id,t.target) then raise exception 'HOURS_CONFLICT_SOURCE_CHANGED';end if;
 if actor is null or not exists(select 1 from public.case_identity_cases where case_id=r.case_id and identity_id=actor) then raise exception 'HOURS_CONFLICT_FORBIDDEN';end if;
 if tg_table_name='case_request_drafts' and answer='' then return new;end if;
 if answer is null or char_length(answer)>1800 then raise exception 'REQUEST_ANSWER_INVALID';end if;
 begin parsed:=answer::jsonb;exception when invalid_text_representation then raise exception 'REQUEST_ANSWER_INVALID';end;
 if jsonb_typeof(parsed)<>'object' then raise exception 'REQUEST_ANSWER_INVALID';end if;
 select array_agg(key order by key) into keys from jsonb_object_keys(parsed) key;
 if parsed->>'schema_version' is distinct from 'document-hours-conflict-answer-v1' or jsonb_typeof(parsed->'basis') is distinct from 'string'
  or char_length(trim(parsed->>'basis'))>1000 then raise exception 'REQUEST_ANSWER_INVALID';end if;
 if parsed->>'state'='unknown' then
  if keys is distinct from array['basis','schema_version','state'] then raise exception 'REQUEST_ANSWER_INVALID';end if;
 elsif parsed->>'state'='declared' then
  if keys is distinct from array['basis','hours','schema_version','state'] or jsonb_typeof(parsed->'hours') is distinct from 'string'
   or parsed->>'hours' !~ '^(0|[1-9][0-9]{0,2})([.][0-9]{1,4})?$' or char_length(trim(parsed->>'basis'))<10 then raise exception 'REQUEST_ANSWER_INVALID';end if;
  if (parsed->>'hours')::numeric<=0 or (parsed->>'hours')::numeric>182 then raise exception 'REQUEST_ANSWER_INVALID';end if;
 else raise exception 'REQUEST_ANSWER_INVALID';end if;
 return new;
end;$$;
create trigger hours_conflict_original_guard before update on public.case_requests for each row execute function private.june2026_hours_conflict_answer_guard();
create trigger hours_conflict_correction_guard before insert on private.case_request_answer_versions for each row execute function private.june2026_hours_conflict_answer_guard();
create trigger hours_conflict_draft_guard before insert or update on private.case_request_drafts for each row execute function private.june2026_hours_conflict_answer_guard();
revoke all on function private.june2026_hours_conflict_current(uuid,jsonb),private.june2026_hours_conflict_answer_guard() from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

create function public.case_request_hours_conflict_states(target_case uuid,target_identity uuid)
 returns table(request_id uuid,source_current boolean,source_observations jsonb,conflict_reason text)
 language plpgsql security definer set search_path='' as $$
begin
 if session_user<>'tivdoc_web_runtime' or not exists(select 1 from public.case_identity_cases where case_id=target_case and identity_id=target_identity) then raise exception 'HOURS_CONFLICT_FORBIDDEN';end if;
 return query select r.id,coalesce(private.june2026_hours_conflict_current(target_case,t.target),false),
  coalesce((select jsonb_agg(jsonb_build_object('candidate_id',f->'candidate_id','raw_value',f->'raw_value','page',f#>'{source,page}','source_label',f#>'{source,text_fragment}') order by n)
   from jsonb_array_elements(t.target->'observations') with ordinality x(f,n) where n<=12),'[]'::jsonb),t.target->>'reason'
 from public.case_requests r left join private.june2026_hours_conflict_targets t on t.request_id=r.id and t.case_id=r.case_id
 where r.case_id=target_case and r.code like 'document_hours_conflict:%';
end;$$;
revoke all on function public.case_request_hours_conflict_states(uuid,uuid) from public,anon,authenticated,service_role,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function public.case_request_hours_conflict_states(uuid,uuid) to tivdoc_web_runtime;

do $migration$ declare definition text;needle text;signature text;scope text;begin
 definition:=pg_get_functiondef('private.pin_request_statement_month()'::regprocedure);
 needle:='  elsif new.code like ''document_field:%'' then';
 if position(needle in definition)=0 then raise exception 'HOURS_CONFLICT_MONTH_BASE';end if;
 execute replace(definition,needle,$new$  elsif new.code like 'document_hours_conflict:%' then
   if not exists(select 1 from private.june2026_hours_conflict_targets where request_id=new.id and case_id=new.case_id and new.code='document_hours_conflict:'||target_sha256) then raise exception 'HOURS_CONFLICT_TARGET_REQUIRED';end if;
   new.statement_month:='2026-06';
  elsif new.code like 'document_field:%' then$new$);
 definition:=pg_get_functiondef('private.capture_case_input(uuid,text)'::regprocedure);
 needle:='''field_target'',(select t.target from private.document_field_targets t where t.request_id=r.id and t.case_id=r.case_id),';
 if position(needle in definition)=0 then raise exception 'HOURS_CONFLICT_CAPTURE_BASE';end if;
 execute replace(definition,needle,needle||E'\n ''hours_conflict_target'',(select t.target from private.june2026_hours_conflict_targets t where t.request_id=r.id and t.case_id=r.case_id),');
 foreach signature in array array['private.managed_dev_worker_status(text)','public.case_notification_managed_pending(text)','private.managed_dev_notification_event_current(uuid,text)'] loop
  definition:=pg_get_functiondef(signature::regprocedure);
  scope:=case when signature like 'private.managed_dev_worker_status%' then 'r.case_id' when signature like 'public.case_notification_managed_pending%' then 'e.case_id' else 'target_case' end;
  needle:='or exists(select 1 from private.dev_financial_request_targets t where t.request_id=q.id and';
  if position(needle in definition)=0 then raise exception 'HOURS_CONFLICT_NOTIFICATION_BASE';end if;
  execute replace(definition,needle,format('or exists(select 1 from private.june2026_hours_conflict_targets t where t.request_id=q.id and t.case_id=%s and private.june2026_hours_conflict_current(%s,t.target)) ',scope,scope)||needle);
 end loop;
 definition:=pg_get_functiondef('public.case_request_document_source(uuid,uuid,uuid)'::regprocedure);
 needle:=' if target is null then return null;end if;';
 if position(needle in definition)=0 then raise exception 'HOURS_CONFLICT_SOURCE_LINK_BASE';end if;
 execute replace(definition,needle,$new$ if target is null then
  select t.target into target from private.june2026_hours_conflict_targets t join public.case_requests r on r.id=t.request_id and r.case_id=t.case_id
   where t.case_id=target_case and t.request_id=target_request and r.code='document_hours_conflict:'||t.target_sha256 and private.june2026_hours_conflict_current(target_case,t.target);
  if target is not null then
   return (select jsonb_build_object('path',d.storage_path,'mime',d.mime_type,'size',d.size,'sha256',d.content_sha256,'version',d.version_id,'page',1)
    from public.documents d where d.case_id=target_case and d.id::text=target->>'product_document_id' and d.version_id::text=target->>'version_id' and d.content_sha256=target->>'source_sha256');
  end if;
 end if;
 if target is null then return null;end if;$new$);
 definition:=pg_get_functiondef('private.june2026_hours_request_open(uuid,uuid,integer,text)'::regprocedure);
 needle:=' if exists(select 1 from jsonb_array_elements(source#>''{checkpoint,run,result,final_extraction,fields}'')';
 if position(needle in definition)=0 then raise exception 'HOURS_CONFLICT_LEGACY_OPEN_BASE';end if;
 execute replace(definition,needle,$new$ if private.june2026_hours_conflict_target(source,target_case,target_order) is not null then
  return private.june2026_hours_conflict_request_open(target_case,target_order,target_revision,target_input_sha);
 end if;
 if exists(select 1 from jsonb_array_elements(source#>'{checkpoint,run,result,final_extraction,fields}')$new$);
end $migration$;

