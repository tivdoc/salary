-- Identified source-cell decisions; no whole-document or legal approval.
-- Historical answer text, targets, provider receipts and policy v1/v2 remain intact.
create function private.document_field_answer_v2_valid(answer_text text) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare a jsonb;
begin
 if answer_text is null or char_length(answer_text)>2000 then return false;end if;
 a:=answer_text::jsonb;
 if jsonb_typeof(a)<>'object' or a->>'schema_version' is distinct from 'document-field-answer-v2' then return false;end if;
 if a->>'action' in ('confirm','unreadable','unknown') then
  return a=jsonb_build_object('schema_version','document-field-answer-v2','action',a->>'action');
 elsif a->>'action'='correct' then
  return jsonb_typeof(a->'corrected_raw_value')='string' and char_length(btrim(a->>'corrected_raw_value')) between 1 and 500
   and a=jsonb_build_object('schema_version','document-field-answer-v2','action','correct','corrected_raw_value',a->>'corrected_raw_value');
 end if;
 return false;
exception when invalid_text_representation then return false;
end;$$;
revoke all on function private.document_field_answer_v2_valid(text) from public,anon,authenticated;
grant execute on function private.document_field_answer_v2_valid(text) to service_role,tivdoc_web_runtime;

-- Existing locked/revision-checked writers accept strict v2 only for bound cells.
do $$ declare definition text; signature text; needle text:='(r.answer_kind=''choice'' and not coalesce(answer=any(r.options),false))';begin
 foreach signature in array array['public.case_request_answer(uuid,uuid,text)','public.case_request_edit(uuid,uuid,uuid,text,integer,text)'] loop
  definition:=pg_get_functiondef(signature::regprocedure);
  if position(needle in definition)=0 then raise exception 'READING_V2_WRITER_BASE_MISMATCH';end if;
  execute replace(definition,needle,'(r.answer_kind=''choice'' and not (coalesce(answer=any(r.options),false) or (r.code like ''document_field:%'' and private.document_field_answer_v2_valid(answer))))');
 end loop;
end;$$;

create function private.guard_document_cell_decision() returns trigger
language plpgsql security definer set search_path='' as $$
declare r public.case_requests;t jsonb;actor uuid;answer text;
begin
 if tg_table_schema='public' then
  if new.code not like 'document_field:%' or new.answered_at is null then return new;end if;
  if old.answered_at is not null then return new;end if;
  r:=new;actor:=new.answered_by_identity;answer:=new.answer_text;
 else
  select * into r from public.case_requests where id=new.request_id;
  if r.code not like 'document_field:%' then return new;end if;
  actor:=new.identity_id;answer:=new.answer_text;
 end if;
 perform 1 from public.cases where id=r.case_id for update;
 select target into t from private.document_field_targets where request_id=r.id and case_id=r.case_id;
 if t is null or not private.document_field_current(r.case_id,t) then raise exception 'REQUEST_FIELD_SOURCE_CHANGED';end if;
 if actor is null or not exists(select 1 from public.case_identity_cases where identity_id=actor and case_id=r.case_id) then raise exception 'REQUEST_FIELD_FORBIDDEN';end if;
 if tg_table_name='case_request_drafts' and answer='' then return new;end if;
 if not (coalesce(answer=any(r.options),false) or private.document_field_answer_v2_valid(answer)) then raise exception 'REQUEST_ANSWER_INVALID';end if;
 return new;
end;$$;
revoke all on function private.guard_document_cell_decision() from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create trigger guard_document_cell_decision before update on public.case_requests for each row execute function private.guard_document_cell_decision();
create trigger guard_document_cell_decision before insert on private.case_request_answer_versions for each row execute function private.guard_document_cell_decision();
create trigger guard_document_cell_decision before insert or update on private.case_request_drafts for each row execute function private.guard_document_cell_decision();

create function public.case_request_field_reading_targets(target_case uuid,target_identity uuid)
returns table(request_id uuid,target jsonb) language plpgsql stable security definer set search_path='' as $$
begin
 if not exists(select 1 from public.case_identity_cases where case_id=target_case and identity_id=target_identity) then raise exception 'REQUEST_FIELD_FORBIDDEN';end if;
 return query select t.request_id,t.target from private.document_field_targets t join public.case_requests r on r.id=t.request_id and r.case_id=t.case_id
  where t.case_id=target_case and r.code='document_field:'||t.target_sha256;
end;$$;
revoke all on function public.case_request_field_reading_targets(uuid,uuid) from public,anon,authenticated,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function public.case_request_field_reading_targets(uuid,uuid) to tivdoc_web_runtime,service_role;

-- v3 adds monetary contribution cells; membership still follows the purchased
-- topic. Legacy topics are accepted without pretending all have executors.
create function private.document_field_question_fields_v3(purchased_topics text[]) returns text[]
language sql immutable security invoker set search_path='' as $$
 select coalesce(array_agg(f.field order by f.field),'{}'::text[]) from (values
 ('salary_type',null::text),('salary_period',null),('base_monthly_salary',null),('hourly_rate',null),('gross_salary',null),('net_salary',null),('regular_hours',null),('total_deductions',null),
 ('overtime_125_hours','working_time'),('overtime_150_hours','working_time'),('pension_base','pension'),('travel_amount','travel'),('convalescence_amount','convalescence'),('vacation_balance','vacation'),('sick_balance','sick_leave'),
 ('pension_employee_contribution','pension'),('pension_employer_contribution','pension'),('severance_contribution','pension'),('pension_employee_rate','pension'),('pension_employer_rate','pension'),('severance_rate','pension')
 )f(field,topic) where cardinality(purchased_topics)>0 and array_position(purchased_topics,null) is null
 and purchased_topics <@ array['minimum_wage','working_time','pension','travel','convalescence','vacation','sick_leave','rest_day','bonuses','contract']::text[]
 and (f.topic is null or f.topic=any(purchased_topics));
$$;
revoke all on function private.document_field_question_fields_v3(text[]) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_operations_runtime;
grant execute on function private.document_field_question_fields_v3(text[]) to tivdoc_worker_runtime;
