-- Missing source readings are identified transcriptions, never legal approval.
-- Reuse the request/revision/input-journal/outbox boundaries; no new queue.
create table private.document_transcription_targets (
 request_id uuid primary key references public.case_requests(id) on delete cascade deferrable initially deferred,
 case_id uuid not null references public.cases(id) on delete cascade,
 target_sha256 text not null check(target_sha256 ~ '^[a-f0-9]{64}$'),
 target jsonb not null check(jsonb_typeof(target)='object'),
 created_at timestamptz not null default clock_timestamp(), unique(case_id,target_sha256),
 check(coalesce(target->>'schema_version'='document-transcription-v1' and target->>'case_id'=case_id::text and target->>'target_sha256'=target_sha256,false))
);
alter table private.document_transcription_targets enable row level security;
revoke all on private.document_transcription_targets from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant select on private.document_transcription_targets to tivdoc_worker_runtime;
create policy document_transcription_worker_read on private.document_transcription_targets for select to tivdoc_worker_runtime
 using(private.runtime_verified_tenant()='saved-case:'||case_id::text);
create trigger preserve_document_transcription_target before update on private.document_transcription_targets for each row execute function private.preserve_document_field_target();

-- A transcription never changes the saved OCR JSON. This predicate admits only
-- an absent salary-type field or the sole unknown, fully bound earnings row.
create function private.document_transcription_content_current(target jsonb,checkpoint jsonb) returns boolean
 language plpgsql immutable security invoker set search_path='' as $$
declare extraction jsonb:=checkpoint#>'{run,result,final_extraction}'; component jsonb:=target#>'{subject,component}'; kind text:=target#>>'{subject,kind}';
begin
 if not coalesce(extraction->>'status'='completed' and extraction->>'detected_document_type'='payslip'
  and (extraction->>'document_quality_confidence')::numeric>=0.9 and extraction#>>'{quality_metrics,page_count}'='1'
  and not(extraction ? 'customer_readings')
  and jsonb_array_length(checkpoint#>'{run,provider_receipts}') between 1 and 2
  and not exists(select 1 from jsonb_array_elements(checkpoint#>'{run,provider_receipts}') receipt
   where receipt->>'status' is distinct from 'completed' or receipt->>'source_page_count' is distinct from '1'
    or receipt->>'origin' not in ('openai_live','injected_test_provider') or receipt->>'origin' is null
    or receipt->>'case_id' is distinct from target->>'case_id' or receipt->>'document_id' is distinct from target->>'version_id'
    or receipt->>'source_sha256' is distinct from target->>'source_sha256')
  and not exists(select 1 from jsonb_array_elements(extraction->'fields') f group by f->>'field' having count(*)>1)
  and not exists(select 1 from jsonb_array_elements(extraction->'fields') f where f->'normalized_value'='null'::jsonb
   or (f->'normalized_value' ? 'minor_units' and (f#>>'{normalized_value,minor_units}')::numeric<0))
  and not exists(select 1 from jsonb_array_elements(extraction->'fields') g
   cross join jsonb_array_elements(extraction->'fields') d cross join jsonb_array_elements(extraction->'fields') n
   where g->>'field'='gross_salary' and d->>'field'='total_deductions' and n->>'field'='net_salary'
    and abs((g#>>'{normalized_value,minor_units}')::numeric-(d#>>'{normalized_value,minor_units}')::numeric-(n#>>'{normalized_value,minor_units}')::numeric)>100)
  and not exists(select 1 from jsonb_array_elements_text(extraction->'warnings') w where w not in ('salary_type_documented_pair_invalid','aggregate_total_rows_classified'))
  and not exists(select 1 from jsonb_array_elements(extraction->'fields') f where f#>>'{source,document_id}' is distinct from target->>'version_id'
   or f#>>'{source,page}' is distinct from '1' or exists(select 1 from jsonb_array_elements_text(f->'warning_flags') w
    where w not in ('low_field_confidence','moderate_field_confidence','ocr_value_ambiguous','recovery_reading_confirmation_required'))),false) then return false;end if;
 if kind='salary_type' then
  return target->'subject'=jsonb_build_object('kind','salary_type','page',1)
   and not exists(select 1 from jsonb_array_elements(extraction->'fields') f where f->>'field'='salary_type');
 end if;
 if kind<>'component_amount' then return false;end if;
 return coalesce(target->'subject'=jsonb_build_object('kind',kind,'component',component)
  and not exists(select 1 from jsonb_array_elements(extraction->'fields') f where f->>'field'='base_monthly_salary')
  and extraction->>'earnings_components_complete'='true' and jsonb_array_length(extraction->'additional_components')=1
  and extraction#>'{additional_components,0}'=component
  and component->>'semantic_kind'='unknown' and component->'normalized_label'='null'::jsonb
  and component#>>'{source,document_id}'=target->>'version_id' and component#>>'{source,page}'='1'
  and component->'percentage'='null'::jsonb and component->'percentage_raw'='null'::jsonb
  and component->'warning_flags'='[]'::jsonb and component->'normalization_warnings'='[]'::jsonb
  and component#>>'{amount,currency}'='ILS' and (component#>>'{amount,minor_units}')::numeric between 1 and 9007199254740991
  and (component#>>'{amount,minor_units}')::numeric=trunc((component#>>'{amount,minor_units}')::numeric)
  and component->>'amount_raw' ~ '^[0-9]+([,][0-9]{3})*([.][0-9]{1,2})?$'
  and replace(component->>'amount_raw',',','')::numeric*100=(component#>>'{amount,minor_units}')::numeric
  and (select count(*)=1 and bool_and(f->'normalized_value'=component->'amount') from jsonb_array_elements(extraction->'fields') f where f->>'field'='gross_salary'),false);
exception when invalid_text_representation or numeric_value_out_of_range then return false;
end;$$;
revoke all on function private.document_transcription_content_current(jsonb,jsonb) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

create function private.document_transcription_current(target_case uuid,target jsonb) returns boolean
 language sql stable security definer set search_path='' as $$
 select coalesce(target->>'month'='2026-06'
  and target->>'case_id'=target_case::text
  and exists(select 1 from public.documents d join public.cases pc on pc.id=d.case_id
   join private.case_extraction_checkpoints c on c.case_id=d.case_id and c.version_id=d.version_id
   where d.case_id=target_case and d.document_type='payslip' and d.id::text=target->>'product_document_id'
    and d.version_id::text=target->>'version_id' and d.content_sha256=target->>'source_sha256'
    and to_char(coalesce(d.period_month,pc.check_period_month),'YYYY-MM')='2026-06'
    and c.input_sha256=d.content_sha256 and c.policy_version=target->>'policy_version'
    and c.result_sha256=target->>'extraction_result_sha256'
    and c.result->>'schema_version'='tivdoc-saved-extraction-v1'
    and c.result->>'case_id'=target_case::text and c.result->>'product_document_id'=d.id::text
    and c.result->>'version_id'=d.version_id::text and c.result->>'input_sha256'=d.content_sha256
    and c.result->>'result_sha256'=c.result_sha256 and c.result->>'expected_month'='2026-06'
    and c.result->>'period_mismatch'='false'
    and not(c.result#>'{run,result,final_extraction}' ? 'customer_readings')
    and c.result#>>'{run,result,final_extraction,document_id}'=d.version_id::text
    and not exists(select 1 from private.case_extraction_checkpoints newer
     where newer.case_id=c.case_id and newer.version_id=c.version_id and newer.policy_version=c.policy_version and newer.revision>c.revision)
    and (select count(*)=1 and bool_and(f#>'{normalized_value}'=jsonb_build_object('year',2026,'month',6,'start_date','2026-06-01','end_date','2026-06-30') and f#>>'{source,document_id}'=d.version_id::text)
      from jsonb_array_elements(c.result#>'{run,result,final_extraction,fields}') f where f->>'field'='salary_period')
    and not exists(select 1 from jsonb_array_elements(c.result#>'{run,provider_receipts}') receipt
     where (receipt->>'source_size_bytes')::bigint is distinct from d.size or receipt->>'source_mime_type' is distinct from d.mime_type)
    and private.document_transcription_content_current(target,c.result))
  and exists(select 1 from private.case_input_heads h join private.case_input_versions v on v.case_id=h.case_id and v.revision=h.revision and v.input_sha256=h.input_sha256
   cross join lateral jsonb_array_elements(v.input->'orders') pinned
   join private.product_orders o on o.case_id=v.case_id and o.id::text=pinned->>'id'
   join private.order_entitlements e on e.order_id=o.id and e.state='active'
   where h.case_id=target_case and o.state='paid' and o.refund_state<>'refunded' and 'minimum_wage'=any(o.topics)
    and date '2026-06-01' between o.period_from and o.period_to
    and pinned=jsonb_build_object('id',o.id,'kind',o.kind,'from',o.period_from,'to',o.period_to,'topics',o.topics,'offer_sha256',o.offer_sha256)),false);
$$;
revoke all on function private.document_transcription_current(uuid,jsonb) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

-- Exact question semantics are part of the write boundary: a worker cannot
-- invert the displayed question while the answer materializer assumes yes=no.
create function private.document_transcription_question(target jsonb) returns text
 language plpgsql immutable security invoker set search_path='' as $$
declare amount numeric:=(target#>>'{subject,component,amount,minor_units}')::numeric;
begin
 if target#>>'{subject,kind}'='salary_type' then
  return 'בתלוש לחודש יוני 2026, בעמוד 1, איזה סוג שכר כתוב במפורש? יש להעתיק את סוג השכר מהמסמך; אין להסיק אותו מהשעות או מהתעריף.';
 elsif target#>>'{subject,kind}'='component_amount' then
  return 'בתלוש לחודש יוני 2026, בעמוד 1, בשורה «'||(target#>>'{subject,component,source_label}')||'» קראנו סכום '||trunc(amount/100)::text||'.'||lpad(mod(amount,100)::text,2,'0')||' ₪. האם הסכום מופיע כך במסמך? האישור מתייחס לקריאת הסכום בלבד, ולא לסוג הרכיב או לזכאות.';
 end if;
 return null;
end;$$;
revoke all on function private.document_transcription_question(jsonb) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

create function private.document_transcription_request_open(target_case uuid,expected_revision integer,expected_input_sha256 text,target_payload jsonb,target_question text) returns uuid
 language plpgsql security definer set search_path='' as $$
declare head private.case_input_heads; new_request uuid; kind text:=target_payload#>>'{subject,kind}';
 answer_kind text:='choice'; choices text[];
begin
 if session_user<>'tivdoc_worker_runtime' or private.runtime_verified_tenant() is distinct from 'saved-case:'||target_case::text then raise exception 'TRANSCRIPTION_FORBIDDEN';end if;
 perform 1 from public.cases where id=target_case for update;if not found then raise exception 'TRANSCRIPTION_FORBIDDEN';end if;
 select * into head from private.case_input_heads where case_id=target_case;
 if head.revision is distinct from expected_revision or head.input_sha256 is distinct from expected_input_sha256 then raise exception 'TRANSCRIPTION_SOURCE_CHANGED';end if;
 if not coalesce(target_payload->>'schema_version'='document-transcription-v1' and target_payload->>'case_id'=target_case::text
  and target_payload->>'month'='2026-06' and target_payload->>'target_sha256' ~ '^[a-f0-9]{64}$'
  and target_payload->>'source_sha256' ~ '^[a-f0-9]{64}$' and target_payload->>'extraction_result_sha256' ~ '^[a-f0-9]{64}$'
  and target_payload->>'policy_version'='saved-payslip-v21-p95-v1'
  and target_payload-array['schema_version','case_id','product_document_id','version_id','source_sha256','month','policy_version','extraction_result_sha256','subject','target_sha256']='{}'::jsonb
  and target_payload->>'target_sha256'=encode(sha256(convert_to(private.governance_jsonb_compact_text(target_payload-'target_sha256'),'UTF8')),'hex')
  and (kind='salary_type' and target_payload->'subject'=jsonb_build_object('kind',kind,'page',1)
   or kind='component_amount' and target_payload->'subject'=jsonb_build_object('kind',kind,'component',target_payload#>'{subject,component}')),false)
  or target_question is null or char_length(target_question) not between 4 and 400
  or target_question is distinct from private.document_transcription_question(target_payload) then raise exception 'TRANSCRIPTION_TARGET_INVALID';end if;
 if not private.document_transcription_current(target_case,target_payload) then raise exception 'TRANSCRIPTION_SOURCE_OR_SCOPE_CHANGED';end if;
 if kind='salary_type' then choices:=array['בתלוש כתוב שכר שעתי','בתלוש כתוב שכר חודשי','בתלוש כתוב שכר משולב','לא מופיע בתלוש','לא ניתן לקרוא'];
 else choices:=array['כן, בדקתי במסמך והערך נכון','הערך שונה במסמך','לא ניתן לקרוא את השדה'];end if;
 select t.request_id into new_request from private.document_transcription_targets t where t.case_id=target_case and t.target_sha256=target_payload->>'target_sha256';
 if new_request is not null then
  if (select t.target from private.document_transcription_targets t where t.request_id=new_request) is distinct from target_payload then raise exception 'TRANSCRIPTION_TARGET_CONFLICT';end if;
  if exists(select 1 from public.case_requests q where q.id=new_request and q.answered_at is null and (q.expired_at is not null or q.expires_at<=clock_timestamp())) then return null;end if;
  return new_request;
 end if;
 new_request:=gen_random_uuid();
 insert into private.document_transcription_targets(request_id,case_id,target_sha256,target) values(new_request,target_case,target_payload->>'target_sha256',target_payload);
 insert into public.case_requests(id,case_id,code,question,answer_kind,options,field_crop,blocking,expires_at)
 values(new_request,target_case,'document_transcription:'||(target_payload->>'target_sha256'),target_question,answer_kind,choices,kind,false,clock_timestamp()+interval '10 days');
 return new_request;
end;$$;
revoke all on function private.document_transcription_request_open(uuid,integer,text,jsonb,text) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_operations_runtime;
grant execute on function private.document_transcription_request_open(uuid,integer,text,jsonb,text) to tivdoc_worker_runtime;

-- Bind originals, corrections and drafts. Direct legacy/unidentified writes
-- cannot bypass the new namespace by choosing a different RPC.
create function private.guard_document_transcription_answer() returns trigger language plpgsql security definer set search_path='' as $$
declare r public.case_requests; target jsonb; actor uuid; answer text;
begin
 if tg_table_schema='public' then
  if old.code not like 'document_transcription:%' then return new;end if;
  if (to_jsonb(new)-array['answered_at','answer_text','answered_by_identity','expired_at']) is distinct from (to_jsonb(old)-array['answered_at','answer_text','answered_by_identity','expired_at']) then raise exception 'TRANSCRIPTION_TARGET_IMMUTABLE';end if;
  if old.answered_at is not null then
   if (new.answer_text,new.answered_at,new.answered_by_identity) is distinct from (old.answer_text,old.answered_at,old.answered_by_identity) then raise exception 'TRANSCRIPTION_ORIGINAL_IMMUTABLE';end if;
   return new;
  end if;
  if new.answered_at is null then return new;end if;
  r:=new;actor:=new.answered_by_identity;answer:=new.answer_text;
 else
  select * into r from public.case_requests where id=new.request_id;
  if r.code not like 'document_transcription:%' then return new;end if;
  actor:=new.identity_id;answer:=new.answer_text;
 end if;
 perform 1 from public.cases where id=r.case_id for update;
 select t.target into target from private.document_transcription_targets t where t.request_id=r.id and t.case_id=r.case_id and r.code='document_transcription:'||t.target_sha256;
 if target is null or not private.document_transcription_current(r.case_id,target) then raise exception 'TRANSCRIPTION_SOURCE_OR_SCOPE_CHANGED';end if;
 if r.answer_kind<>'choice' or r.question is distinct from private.document_transcription_question(target)
  or r.options is distinct from (case when target#>>'{subject,kind}'='salary_type'
   then array['בתלוש כתוב שכר שעתי','בתלוש כתוב שכר חודשי','בתלוש כתוב שכר משולב','לא מופיע בתלוש','לא ניתן לקרוא']
   else array['כן, בדקתי במסמך והערך נכון','הערך שונה במסמך','לא ניתן לקרוא את השדה'] end) then raise exception 'TRANSCRIPTION_TARGET_INVALID';end if;
 if actor is null or not exists(select 1 from public.case_identity_cases where case_id=r.case_id and identity_id=actor) then raise exception 'TRANSCRIPTION_FORBIDDEN';end if;
 if answer is null or char_length(answer)>1500 or (not coalesce(answer=any(r.options),false) and not(tg_table_name='case_request_drafts' and answer='')) then raise exception 'TRANSCRIPTION_ANSWER_INVALID';end if;
 return new;
end;$$;
revoke all on function private.guard_document_transcription_answer() from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create trigger guard_document_transcription_answer before update on public.case_requests for each row execute function private.guard_document_transcription_answer();
create trigger guard_document_transcription_revision before insert on private.case_request_answer_versions for each row execute function private.guard_document_transcription_answer();
create trigger guard_document_transcription_draft before insert or update on private.case_request_drafts for each row execute function private.guard_document_transcription_answer();

create function public.case_request_transcription_states(target_case uuid,target_identity uuid) returns table(request_id uuid,source_current boolean)
 language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.case_identity_cases where case_id=target_case and identity_id=target_identity) then raise exception 'TRANSCRIPTION_FORBIDDEN';end if;
 return query select r.id,coalesce(private.document_transcription_current(target_case,t.target),false)
 from public.case_requests r left join private.document_transcription_targets t on t.request_id=r.id and t.case_id=r.case_id
 where r.case_id=target_case and r.code like 'document_transcription:%';
end;$$;
revoke all on function public.case_request_transcription_states(uuid,uuid) from public,anon,authenticated,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function public.case_request_transcription_states(uuid,uuid) to tivdoc_web_runtime,service_role;

-- Preserve historical function/ACL behavior and fail closed if the expected
-- upgrade base differs. No RLS policy or existing approval guard is removed.
do $migration$ declare definition text; needle text; signature text; scope text;begin
 definition:=pg_get_functiondef('private.pin_request_statement_month()'::regprocedure);
 needle:='  elsif new.code like ''document_field:%'' then';
 if position(needle in definition)=0 then raise exception 'TRANSCRIPTION_MONTH_BASE';end if;
 execute replace(definition,needle,$new$  elsif new.code like 'document_transcription:%' then
   select t.target->>'month' into new.statement_month from private.document_transcription_targets t where t.request_id=new.id and t.case_id=new.case_id and new.code='document_transcription:'||t.target_sha256;
   if not found then raise exception 'TRANSCRIPTION_TARGET_MISSING';end if;
  elsif new.code like 'document_field:%' then$new$);
 definition:=pg_get_functiondef('private.capture_case_input(uuid,text)'::regprocedure);
 needle:='''field_target'',(select t.target from private.document_field_targets t where t.request_id=r.id and t.case_id=r.case_id),';
 if position(needle in definition)=0 then raise exception 'TRANSCRIPTION_CAPTURE_BASE';end if;
 execute replace(definition,needle,needle||E'\n ''transcription_target'',(select t.target from private.document_transcription_targets t where t.request_id=r.id and t.case_id=r.case_id),');
 foreach signature in array array['private.managed_dev_worker_status(text)','public.case_notification_managed_pending(text)','private.managed_dev_notification_event_current(uuid,text)'] loop
  definition:=pg_get_functiondef(signature::regprocedure);
  scope:=case when signature like 'private.managed_dev_worker_status%' then 'r.case_id' when signature like 'public.case_notification_managed_pending%' then 'e.case_id' else 'target_case' end;
  needle:='or exists(select 1 from private.dev_financial_request_targets t where t.request_id=q.id and';
  if position(needle in definition)=0 then raise exception 'TRANSCRIPTION_NOTIFICATION_BASE';end if;
  execute replace(definition,needle,format('or exists(select 1 from private.document_transcription_targets t where t.request_id=q.id and t.case_id=%s and private.document_transcription_current(%s,t.target)) ',scope,scope)||needle);
 end loop;
end $migration$;

do $migration$ declare definition text;needle text;begin
 definition:=pg_get_functiondef('public.case_request_document_source(uuid,uuid,uuid)'::regprocedure);
 needle:=' if target is null then return null;end if;';
 if position(needle in definition)=0 then raise exception 'TRANSCRIPTION_SOURCE_LINK_BASE';end if;
 execute replace(definition,needle,$new$ if target is null then
  select t.target into target from private.document_transcription_targets t join public.case_requests r on r.id=t.request_id and r.case_id=t.case_id
   where t.case_id=target_case and t.request_id=target_request and r.code='document_transcription:'||t.target_sha256
    and private.document_transcription_current(target_case,t.target);
 end if;
 if target is null then return null;end if;$new$);
end $migration$;
