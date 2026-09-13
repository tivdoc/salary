-- Source-bound identified contract text. No provider/extraction data is seeded.
-- CLI-generated timestamp resequenced after applied migration200.
create function private.evidence_source_reading_dependencies(journal jsonb,source_version uuid) returns jsonb
language sql immutable security invoker set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('version_id',a#>>'{field_target,version_id}','request_id',a->>'id',
  'answer_revision',a->'answer_revision','answer_sha256',private.source_intake_journal_sha(to_jsonb(a->>'answer')))
  order by a->>'id'),'[]'::jsonb)
 from jsonb_array_elements(journal->'answers') a
 where a->>'code' like 'document_field:%' and a#>>'{field_target,version_id}'=source_version::text
  and a#>>'{field_target,schema_version}' not in ('document-evidence-source-transcription-v1','obligation-payment-choice-v1','obligation-payment-link-v1');
$$;
revoke all on function private.evidence_source_reading_dependencies(jsonb,uuid)
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;

-- Return fresh authority context, never merely echo an old target. Both the
-- protected web reader and the worker opener may use this private helper.
create function private.evidence_source_transcription_context(target_case uuid,t jsonb) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare journal jsonb;source_pin jsonb;d public.documents;physical private.document_physical_page_receipts;
 purchase jsonb;source_value jsonb;deps jsonb;body jsonb;first_day date;last_day date;
begin
 if t->>'schema_version' is distinct from 'document-evidence-source-transcription-v1'
  or t->>'case_id' is distinct from target_case::text
  or t->>'month' !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
  or jsonb_typeof(t->'page') is distinct from 'number' or (t->>'page'~'^[1-9][0-9]?$|^100$') is not true
  or t->>'order_origin' not in ('saved_order','legacy_paid_receipt')
  or not coalesce(t->'purchased_topics' ?| array['contract','bonuses'],false)
  or not private.document_review_paid_scope_current(target_case,(t->>'order_id')::uuid,t->>'order_origin',t->>'order_receipt_sha256',t->'purchased_topics',to_date(t->>'month','YYYY-MM'))
 then return null;end if;
 select v.input into journal from private.case_input_heads h join private.case_input_versions v
  on v.case_id=h.case_id and v.revision=h.revision and v.input_sha256=h.input_sha256 where h.case_id=target_case;
 if journal is null then return null;end if;
 select pin into source_pin from jsonb_array_elements(journal->'documents') pin
  where pin->>'id'=t->>'product_document_id' and pin->>'version_id'=t->>'version_id' and pin->>'sha256'=t->>'source_sha256' and pin->>'type'='contract';
 if source_pin is null then return null;end if;
 select x.* into d from public.documents x where x.case_id=target_case and x.id::text=source_pin->>'id'
  and x.version_id::text=source_pin->>'version_id' and x.content_sha256=source_pin->>'sha256' and x.document_type::text='contract';
 if d.id is null then return null;end if;
 select p.* into physical from private.document_physical_page_receipts p where p.case_id=target_case and p.document_id=d.id
  and p.version_id=d.version_id and p.source_sha256=d.content_sha256 and p.byte_size=d.size and p.mime_type=d.mime_type and p.method='physical-pages-v1';
 if physical.version_id is null or (t->>'page')::integer>physical.page_count then return null;end if;
 select o into purchase from jsonb_array_elements(case when t->>'order_origin'='saved_order' then journal->'orders' else journal->'legacy_orders' end) o
  where o->>'id'=t->>'order_id' and coalesce(o->>'offer_sha256',o->>'receipt_sha256')=t->>'order_receipt_sha256' and o->'topics'=t->'purchased_topics';
 if purchase is null then return null;end if;
 -- The captured input is authenticated. Refuse malformed/foreign dependency
 -- entries instead of silently dropping an answer that could change a period.
 if exists(select 1 from jsonb_array_elements(journal->'answers') a where a->>'code' like 'document_field:%'
  and a#>>'{field_target,version_id}'=d.version_id::text
  and a#>>'{field_target,schema_version}' not in ('document-evidence-source-transcription-v1','obligation-payment-choice-v1','obligation-payment-link-v1')
  and (a->>'case_id' is distinct from target_case::text or a#>>'{field_target,case_id}' is distinct from target_case::text
   or a->>'answer_identity_id' is null or a->>'answer_created_at' is null or a->>'answer' is null or (a->>'answer_revision'~'^[1-9][0-9]*$') is not true))
 then return null;end if;
 deps:=private.evidence_source_reading_dependencies(journal,d.version_id);
 if jsonb_array_length(deps)>512 or (select count(distinct x->>'request_id') from jsonb_array_elements(deps) x)<>jsonb_array_length(deps) then return null;end if;
 first_day:=to_date(t->>'month','YYYY-MM');last_day:=(first_day+interval '1 month'-interval '1 day')::date;
 source_value:=jsonb_build_object('case_id',target_case,'product_document_id',d.id,'version_id',d.version_id,'source_sha256',d.content_sha256,
  'document_kind','contract','document_month',coalesce(source_pin->'month','null'::jsonb),'page_count',physical.page_count,'reading_dependencies',deps);
 body:=source_value||jsonb_build_object('schema_version','document-evidence-source-transcription-v1','policy_version','document-evidence-source-transcription-v1',
  'month',t->>'month','period',jsonb_build_object('from',to_char(first_day,'YYYY-MM-DD'),'to',to_char(last_day,'YYYY-MM-DD')),'page',(t->>'page')::integer,
  'subject',jsonb_build_object('kind','financial_clause','semantic','clause_text'),'order_id',purchase->>'id','order_origin',t->>'order_origin',
  'order_receipt_sha256',coalesce(purchase->>'offer_sha256',purchase->>'receipt_sha256'),'purchased_topics',purchase->'topics');
 if t is distinct from body||jsonb_build_object('target_sha256',private.source_intake_journal_sha(body)) then return null;end if;
 return jsonb_build_object('source',source_value,'purchase',jsonb_build_object('order_id',purchase->>'id','origin',t->>'order_origin',
  'receipt_sha256',coalesce(purchase->>'offer_sha256',purchase->>'receipt_sha256'),'topics',purchase->'topics'),'month',t->>'month','page',(t->>'page')::integer);
exception when invalid_text_representation or invalid_parameter_value or datetime_field_overflow or numeric_value_out_of_range then return null;
end;$$;
revoke all on function private.evidence_source_transcription_context(uuid,jsonb)
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;

create function private.evidence_source_transcription_answer_valid(t jsonb,answer_text text) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare a jsonb;v jsonb;
begin
 if answer_text is null or char_length(answer_text)>2000 or t->>'schema_version' is distinct from 'document-evidence-source-transcription-v1' then return false;end if;
 a:=answer_text::jsonb;
 if jsonb_typeof(a) is distinct from 'object' or a->>'schema_version' is distinct from 'document-evidence-source-answer-v1' then return false;end if;
 if a->>'action' in ('unknown','unreadable') then return a=jsonb_build_object('schema_version','document-evidence-source-answer-v1','action',a->>'action');end if;
 if a->>'action' is distinct from 'correct' then return false;end if;
 v:=a->'value';
 return coalesce(jsonb_typeof(v)='object' and a=jsonb_build_object('schema_version','document-evidence-source-answer-v1','action','correct','value',v)
  and v=jsonb_build_object('raw_value',v->'raw_value','locator',v->'locator')
  and jsonb_typeof(v->'raw_value')='string' and char_length(v->>'raw_value') between 1 and 1600 and v->>'raw_value'=btrim(v->>'raw_value')
  and jsonb_typeof(v->'locator')='string' and char_length(v->>'locator') between 1 and 120 and v->>'locator'=btrim(v->>'locator'),false);
exception when invalid_text_representation or invalid_parameter_value then return false;
end;$$;
revoke all on function private.evidence_source_transcription_answer_valid(jsonb,text)
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;

-- Executable wrapper proposal follows. Preserve previous schema branches.

create function private.evidence_source_transcription_sources(target_case uuid,expected_revision integer,expected_sha text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare journal jsonb;docs jsonb;
begin
 if session_user<>'tivdoc_worker_runtime' or private.runtime_verified_tenant() is distinct from 'saved-case:'||target_case::text then raise exception 'REQUEST_FIELD_FORBIDDEN';end if;
 select v.input into journal from private.case_input_heads h join private.case_input_versions v
  on v.case_id=h.case_id and v.revision=h.revision and v.input_sha256=h.input_sha256
  where h.case_id=target_case and h.revision=expected_revision and h.input_sha256=expected_sha
   and encode(sha256(convert_to(v.input::text,'UTF8')),'hex')=expected_sha;
 if journal is null then raise exception 'REQUEST_FIELD_SOURCE_CHANGED';end if;
 select coalesce(jsonb_agg(jsonb_build_object('case_id',target_case,'product_document_id',d.id,'version_id',d.version_id,'source_sha256',d.content_sha256,
  'document_kind','contract','document_month',coalesce(pin->'month','null'::jsonb),'page_count',p.page_count,
  'reading_dependencies',private.evidence_source_reading_dependencies(journal,d.version_id)) order by d.id),'[]'::jsonb) into docs
 from jsonb_array_elements(journal->'documents') pin join public.documents d on d.case_id=target_case
  and d.id::text=pin->>'id' and d.version_id::text=pin->>'version_id' and d.content_sha256=pin->>'sha256' and d.document_type::text=pin->>'type'
 join private.document_physical_page_receipts p on p.case_id=d.case_id and p.document_id=d.id and p.version_id=d.version_id
  and p.source_sha256=d.content_sha256 and p.byte_size=d.size and p.mime_type=d.mime_type and p.method='physical-pages-v1'
 where d.document_type::text='contract';
 return jsonb_build_object('case_id',target_case,'source_documents',docs,'journal',journal);
end;$$;
revoke all on function private.evidence_source_transcription_sources(uuid,integer,text)
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;
grant execute on function private.evidence_source_transcription_sources(uuid,integer,text) to tivdoc_worker_runtime;

create function public.case_request_evidence_source_context(target_case uuid,target_identity uuid,target_request uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t jsonb;
begin
 if session_user not in ('tivdoc_web_runtime','service_role') or not exists(select 1 from public.case_identity_cases where case_id=target_case and identity_id=target_identity)
  then raise exception 'REQUEST_FIELD_FORBIDDEN';end if;
 select f.target into t from private.document_field_targets f join public.case_requests r on r.id=f.request_id and r.case_id=f.case_id
  where f.case_id=target_case and f.request_id=target_request and r.code='document_field:'||f.target_sha256
   and f.target->>'schema_version'='document-evidence-source-transcription-v1';
 if t is null then return null;end if;
 return private.evidence_source_transcription_context(target_case,t);
end;$$;
revoke all on function public.case_request_evidence_source_context(uuid,uuid,uuid)
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;
grant execute on function public.case_request_evidence_source_context(uuid,uuid,uuid) to tivdoc_web_runtime,service_role;

do $install_source_transcription$
declare body text;anchor text;f record;
begin
 for f in select signature,old_name,new_name from (values
  ('private.document_field_current(uuid,jsonb)','private.document_field_current(','private.document_field_current_before_source_transcription_v1('),
  ('private.document_reading_question_scope_v4(text[],jsonb)','private.document_reading_question_scope_v4(','private.document_reading_question_scope_before_source_transcription_v1('),
  ('private.document_field_request_answer_valid(uuid,uuid,text)','private.document_field_request_answer_valid(','private.document_field_request_answer_valid_before_source_transcription_v1('),
  ('private.document_field_request_open(uuid,integer,text,jsonb,text)','private.document_field_request_open(','private.document_field_request_open_before_source_transcription_v1('),
  ('public.case_request_document_source(uuid,uuid,uuid)','public.case_request_document_source(','public.case_request_document_source_before_source_transcription_v1(')
 ) x(signature,old_name,new_name) loop
  body:=pg_get_functiondef(f.signature::regprocedure);execute replace(body,f.old_name,f.new_name);
 end loop;
 select pg_get_constraintdef(oid) into body from pg_constraint where conrelid='private.document_field_targets'::regclass and conname='document_field_targets_check';
 anchor:='''document-source-period-intake-v1''::text';
 if position(anchor in body)=0 then raise exception 'SOURCE_TRANSCRIPTION_TARGET_CHECK_BASE';end if;
 alter table private.document_field_targets drop constraint document_field_targets_check;
 execute 'alter table private.document_field_targets add constraint document_field_targets_check '||replace(body,anchor,anchor||', ''document-evidence-source-transcription-v1''::text');
 body:=pg_get_functiondef('private.guard_document_cell_decision()'::regprocedure);
 anchor:='case when t->>''schema_version''=''obligation-payment-choice-v1''';
 if position(anchor in body)=0 then raise exception 'SOURCE_TRANSCRIPTION_ANSWER_GUARD_BASE';end if;
 execute replace(body,anchor,'case when t->>''schema_version''=''document-evidence-source-transcription-v1'' then private.evidence_source_transcription_answer_valid(t,answer) when t->>''schema_version''=''obligation-payment-choice-v1''');
end;$install_source_transcription$;
revoke all on function private.document_field_current_before_source_transcription_v1(uuid,jsonb),
 private.document_reading_question_scope_before_source_transcription_v1(text[],jsonb),
 private.document_field_request_answer_valid_before_source_transcription_v1(uuid,uuid,text),
 private.document_field_request_open_before_source_transcription_v1(uuid,integer,text,jsonb,text),
 public.case_request_document_source_before_source_transcription_v1(uuid,uuid,uuid)
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;
grant execute on function private.document_reading_question_scope_before_source_transcription_v1(text[],jsonb) to service_role,tivdoc_worker_runtime;

create or replace function private.document_field_current(target_case uuid,target jsonb) returns boolean
language sql security definer set search_path='' as $$
 select case when target->>'schema_version'='document-evidence-source-transcription-v1'
  then private.evidence_source_transcription_context(target_case,target) is not null
  else private.document_field_current_before_source_transcription_v1(target_case,target) end;
$$;
create or replace function private.document_reading_question_scope_v4(purchased_topics text[],target jsonb) returns boolean
language sql immutable security invoker set search_path='' as $$
 select case when target->>'schema_version'='document-evidence-source-transcription-v1' then coalesce(
  to_jsonb(purchased_topics)=target->'purchased_topics' and purchased_topics && array['contract','bonuses']::text[]
  and array_position(purchased_topics,null) is null
  and purchased_topics <@ array['minimum_wage','working_time','pension','travel','convalescence','vacation','sick_leave','rest_day','bonuses','contract']::text[],false)
 else private.document_reading_question_scope_before_source_transcription_v1(purchased_topics,target) end;
$$;
create or replace function private.document_field_request_answer_valid(target_case uuid,target_request uuid,answer text) returns boolean
language plpgsql stable security definer set search_path='' as $$
declare t jsonb;
begin
 select target into t from private.document_field_targets where case_id=target_case and request_id=target_request;
 if t->>'schema_version'='document-evidence-source-transcription-v1' then
  return private.evidence_source_transcription_context(target_case,t) is not null and private.evidence_source_transcription_answer_valid(t,answer);end if;
 return private.document_field_request_answer_valid_before_source_transcription_v1(target_case,target_request,answer);
end;$$;
create or replace function private.document_field_request_open(target_case uuid,expected_revision integer,expected_input_sha256 text,target_payload jsonb,target_question text) returns uuid
language plpgsql security definer set search_path='' as $$
declare h private.case_input_heads;r public.case_requests;next_id uuid;generation integer:=0;
begin
 if target_payload->>'schema_version' is distinct from 'document-evidence-source-transcription-v1' then
  return private.document_field_request_open_before_source_transcription_v1(target_case,expected_revision,expected_input_sha256,target_payload,target_question);end if;
 if session_user<>'tivdoc_worker_runtime' or private.runtime_verified_tenant() is distinct from 'saved-case:'||target_case::text then raise exception 'REQUEST_FIELD_FORBIDDEN';end if;
 perform 1 from public.cases where id=target_case for update;if not found then raise exception 'REQUEST_FIELD_FORBIDDEN';end if;
 select * into h from private.case_input_heads where case_id=target_case;
 if h.revision is distinct from expected_revision or h.input_sha256 is distinct from expected_input_sha256 then raise exception 'REQUEST_FIELD_SOURCE_CHANGED';end if;
 if private.evidence_source_transcription_context(target_case,target_payload) is null then raise exception 'REQUEST_FIELD_SOURCE_CHANGED';end if;
 if target_question is null or char_length(target_question) not between 4 and 400 then raise exception 'REQUEST_FIELD_TARGET_INVALID';end if;
 select f.request_id,f.renewal_index into next_id,generation from private.document_field_targets f
  where f.case_id=target_case and f.target_sha256=target_payload->>'target_sha256' order by f.renewal_index desc limit 1;
 if next_id is not null then select * into r from public.case_requests where id=next_id for update;end if;
 if r.id is not null then
  if r.answered_at is not null or r.expired_at is null and r.expires_at>clock_timestamp() then return r.id;end if;
  update public.case_requests set expired_at=coalesce(expired_at,clock_timestamp()) where id=r.id and answered_at is null;generation:=generation+1;
 else generation:=0;end if;
 next_id:=gen_random_uuid();
 insert into private.document_field_targets(request_id,case_id,target_sha256,target,renewal_index,predecessor_request_id)
 values(next_id,target_case,target_payload->>'target_sha256',target_payload,generation,r.id);
 insert into public.case_requests(id,case_id,code,question,answer_kind,options,field_crop,blocking,expires_at)
 values(next_id,target_case,'document_field:'||(target_payload->>'target_sha256'),target_question,'choice',
  array['העתקת הסעיף מהמקור','לא קריא','לא יודע'],'source_transcription.financial_clause',false,clock_timestamp()+interval '7 days');
 return next_id;
end;$$;
create or replace function public.case_request_document_source(target_case uuid,target_identity uuid,target_request uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t jsonb;d public.documents;
begin
 if session_user not in ('tivdoc_web_runtime','service_role') or not exists(select 1 from public.case_identity_cases where case_id=target_case and identity_id=target_identity)
  then raise exception 'REQUEST_FIELD_FORBIDDEN';end if;
 select f.target into t from private.document_field_targets f join public.case_requests r on r.id=f.request_id and r.case_id=f.case_id
  where f.case_id=target_case and f.request_id=target_request and r.code='document_field:'||f.target_sha256;
 if t->>'schema_version' is distinct from 'document-evidence-source-transcription-v1' then
  return public.case_request_document_source_before_source_transcription_v1(target_case,target_identity,target_request);end if;
 if private.evidence_source_transcription_context(target_case,t) is null then return null;end if;
 select x.* into d from public.documents x where x.case_id=target_case and x.id::text=t->>'product_document_id'
  and x.version_id::text=t->>'version_id' and x.content_sha256=t->>'source_sha256';
 if d.id is null then return null;end if;
 return jsonb_build_object('path',d.storage_path,'mime',d.mime_type,'size',d.size,'sha256',d.content_sha256,'version',d.version_id,'page',(t->>'page')::integer);
end;$$;

