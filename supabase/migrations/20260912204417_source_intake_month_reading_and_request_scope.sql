-- Additive intake compatibility: exact historical answers remain unchanged.
-- Fix the actual-role 42702 variable/column collision without changing ACL or target admission.
create or replace function private.legacy_source_document_request_open(target_case uuid,expected_revision integer,expected_sha text,t jsonb,q text) returns uuid
language plpgsql security definer set search_path='' as $$
declare h private.case_input_heads;r public.case_requests;target_id uuid;generation integer:=0;previous uuid;request_code text;expected_question text;
begin
 if session_user<>'tivdoc_worker_runtime' or private.runtime_verified_tenant() is distinct from 'saved-case:'||target_case::text then raise exception 'REQUEST_FIELD_FORBIDDEN';end if;
 perform 1 from public.cases where id=target_case for update;if not found then raise exception 'REQUEST_FIELD_FORBIDDEN';end if;
 select * into h from private.case_input_heads where case_id=target_case;
 if h.revision is distinct from expected_revision or h.input_sha256 is distinct from expected_sha
  or t->>'schema_version' is distinct from 'legacy-source-intake-document-v1' or not private.source_intake_target_current(target_case,t) then raise exception 'REQUEST_FIELD_SOURCE_CHANGED';end if;
 request_code:='legacy.source.document:'||(t->>'order_id')||case when t->>'month' is null then '' else ':'||(t->>'month') end;
 expected_question:=case when t->>'month' is null then 'נא לצרף תלוש שכר מלא או מסמך מקור המציג את התקופה לבדיקה. תקופת הרכישה לא נרשמה; אין צורך לשלם שוב.'
  else 'נא לצרף תלוש שכר מלא לחודש '||(t->>'month')||'. אין כרגע מסמך מקור שמור לתקופה זו.' end;
 if q is distinct from expected_question and (t->>'month' is null or q is distinct from 'נא לצרף תלוש שכר מלא לחודש '||(t->>'month')||'. אין כרגע תלוש שכר המשויך לתקופה זו.') then raise exception 'REQUEST_FIELD_TARGET_INVALID';end if;
 -- An answer-created head does not by itself create another upload request.
 select cr.* into r from private.legacy_source_document_targets x join public.case_requests cr on cr.id=x.request_id
 where x.case_id=target_case and cr.code=request_code and private.source_intake_target_current(target_case,x.target)
 order by x.created_at desc limit 1;
 if r.id is not null and (r.answered_at is not null or r.expired_at is null and r.expires_at>clock_timestamp()) then return r.id;end if;
 select x.request_id,x.renewal_index into previous,generation from private.legacy_source_document_targets x
 where x.case_id=target_case and x.target_sha256=t->>'target_sha256' order by x.renewal_index desc limit 1;
 if previous is not null then
  select * into r from public.case_requests where id=previous for update;
  if r.answered_at is not null or r.expired_at is null and r.expires_at>clock_timestamp() then return r.id;end if;
  if r.expires_at>clock_timestamp() then raise exception 'REQUEST_FIELD_RENEWAL_NOT_DUE';end if;
  update public.case_requests set expired_at=coalesce(expired_at,clock_timestamp()) where id=previous and answered_at is null;
  generation:=generation+1;
 else generation:=0;end if;
 target_id:=gen_random_uuid();
 insert into private.legacy_source_document_targets(request_id,case_id,target_sha256,target,renewal_index,predecessor_request_id)
 values(target_id,target_case,t->>'target_sha256',t,generation,previous);
 insert into public.case_requests(id,case_id,code,question,answer_kind,blocking,expires_at,statement_month)
 values(target_id,target_case,request_code,q,'document',true,clock_timestamp()+interval '10 days',case when t->>'month' is null then null else ((t->>'month')||'-01')::date end);
 return target_id;
end;$$;
revoke all on function private.legacy_source_document_request_open(uuid,integer,text,jsonb,text) from public,anon,authenticated,service_role,
 tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;
grant execute on function private.legacy_source_document_request_open(uuid,integer,text,jsonb,text) to tivdoc_worker_runtime;

-- Retain the original v1 validator verbatim behind the version dispatcher.
create function private.source_intake_answer_valid_v1(t jsonb,answer_text text) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare a jsonb;v jsonb;p jsonb;f date;l date;
begin
 if t->>'schema_version' is distinct from 'document-source-period-intake-v1' or answer_text is null or char_length(answer_text)>2000 then return false;end if;
 a:=answer_text::jsonb;
 if a->'v' is distinct from '1'::jsonb then return false;end if;
 if a->>'action' in ('unknown','unreadable') then return a=jsonb_build_object('v',1,'action',a->>'action');end if;
 if a->>'action' is distinct from 'correct' then return false;end if;
 v:=a->'value';p:=v->'period';
 if a is distinct from jsonb_build_object('v',1,'action','correct','value',v)
  or v is distinct from jsonb_build_object('document_kind',v->>'document_kind','period',p,'page',v->'page','source_label',v->>'source_label')
  or (v->>'document_kind' in ('payslip','attendance','contract','other')) is not true
  or jsonb_typeof(v->'page') is distinct from 'number' or (v->>'page'~'^[1-9][0-9]?$|^100$') is not true
  or (v->>'page')::integer>(t->>'page_count')::integer
  or jsonb_typeof(v->'source_label') is distinct from 'string' or char_length(btrim(v->>'source_label')) not between 1 and 400
  or btrim(v->>'source_label') is distinct from v->>'source_label' then return false;end if;
 if p='null'::jsonb then return true;end if;
 if p is distinct from jsonb_build_object('from',p->>'from','to',p->>'to')
  or (p->>'from'~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' and p->>'to'~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$') is not true then return false;end if;
 f:=(p->>'from')::date;l:=(p->>'to')::date;
 return to_char(f,'YYYY-MM-DD')=p->>'from' and to_char(l,'YYYY-MM-DD')=p->>'to' and f<=l
  and (extract(year from l)-extract(year from f))*12+extract(month from l)-extract(month from f)<600;
exception when invalid_text_representation or invalid_parameter_value or datetime_field_overflow or numeric_value_out_of_range then return false;
end;$$;
revoke all on function private.source_intake_answer_valid_v1(jsonb,text) from public,anon,authenticated,service_role,
 tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;

-- v2 records the month actually printed. Boundaries are a checked calendar
-- derivation, not a declaration of employment dates or a rewritten purchase.
create or replace function private.source_intake_answer_valid(t jsonb,answer_text text) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare a jsonb;v jsonb;s jsonb;f date;l date;legacy jsonb;
begin
 if answer_text is null or char_length(answer_text)>2000 then return false;end if;
 a:=answer_text::jsonb;
 if a->'v'='1'::jsonb then return private.source_intake_answer_valid_v1(t,answer_text);end if;
 if a->'v' is distinct from '2'::jsonb or a->>'action' is distinct from 'correct'
  or a is distinct from jsonb_build_object('v',2,'action','correct','value',a->'value') then return false;end if;
 v:=a->'value';s:=v->'source_period';
 if s is distinct from jsonb_build_object('kind','calendar_month','month',s->>'month')
  or jsonb_typeof(s->'month') is distinct from 'string'
  or (s->>'month'~'^[0-9]{4}-(0[1-9]|1[0-2])$') is not true
  or left(s->>'month',4)='0000' then return false;end if;
 f:=((s->>'month')||'-01')::date;
 l:=(f+interval '1 month'-interval '1 day')::date;
 if v->'period' is distinct from jsonb_build_object('from',to_char(f,'YYYY-MM-DD'),'to',to_char(l,'YYYY-MM-DD')) then return false;end if;
 legacy:=jsonb_build_object('v',1,'action','correct','value',v-'source_period');
 return private.source_intake_answer_valid_v1(t,legacy::text);
exception when invalid_text_representation or invalid_parameter_value or datetime_field_overflow or numeric_value_out_of_range then return false;
end;$$;
revoke all on function private.source_intake_answer_valid(jsonb,text) from public,anon,authenticated,service_role,
 tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;

