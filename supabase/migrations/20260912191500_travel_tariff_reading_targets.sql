-- Add one versioned document_field target. Existing targets/answers and their
-- source hashes keep their historical verifier. Tariffs need no OCR checkpoint.
create function private.travel_tariff_target_matches(purpose jsonb,target jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare doc jsonb;inner_body jsonb;outer_body jsonb;policy_hash text;group_hash text;
begin
 if not coalesce(target#>>'{tariff,subject}' in ('context','daily_fare','ticket_inventory','monthly_pass_cost'),false) then return false;end if;
 policy_hash:=encode(sha256(convert_to(private.governance_jsonb_compact_text('{"schema_version":"travel-tariff-source-policy-v1","purpose":"travel_tariff","physical_document_type":"other","provider_proposal":false,"subjects":["context","daily_fare","ticket_inventory","monthly_pass_cost"],"source_reading_only":true,"legal_applicability_approved":false,"latest_authenticated_answer_only":true}'::jsonb),'UTF8')),'hex');
 doc:=jsonb_build_object('case_id',purpose->'case_id','document_id',purpose->'document_id','version_id',purpose->'version_id',
  'file_sha256',purpose->'file_sha256','page_count',purpose->'page_count','month',purpose->'month',
  'evidence_purpose','travel_tariff','document_type','other','purpose_sha256',purpose->'purpose_sha256');
 group_hash:=encode(sha256(convert_to(private.governance_jsonb_compact_text(jsonb_build_object('schema_version','travel-tariff-source-group-v1',
  'document',doc,'group',purpose->'group','policy_sha256',policy_hash)),'UTF8')),'hex');
 inner_body:=jsonb_build_object('schema_version','travel-tariff-transcription-v1','document',doc,'group',purpose->'group',
  'subject',target#>'{tariff,subject}','policy_sha256',policy_hash,'source_group_sha256',group_hash);
 outer_body:=jsonb_build_object('schema_version','document-travel-tariff-transcription-v1','case_id',purpose->'case_id',
  'product_document_id',purpose->'document_id','version_id',purpose->'version_id','source_sha256',purpose->'file_sha256',
  'month',purpose->'month','policy_version','document-travel-tariff-identified-v1','purpose_sha256',purpose->'purpose_sha256',
  'tariff',inner_body||jsonb_build_object('target_sha256',encode(sha256(convert_to(private.governance_jsonb_compact_text(inner_body),'UTF8')),'hex')));
 return coalesce(target=outer_body||jsonb_build_object('target_sha256',encode(sha256(convert_to(private.governance_jsonb_compact_text(outer_body),'UTF8')),'hex')),false);
end;$$;
revoke all on function private.travel_tariff_target_matches(jsonb,jsonb) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

create function private.travel_tariff_target_current(target_case uuid,target jsonb) returns boolean
language sql stable security invoker set search_path='' as $$
 select coalesce(target->>'case_id'=target_case::text
  and exists(select 1 from jsonb_array_elements(private.document_source_purpose_journal(target_case)) p
   join private.case_input_heads h on h.case_id=target_case
   join private.case_input_versions v on v.case_id=h.case_id and v.revision=h.revision and v.input_sha256=h.input_sha256
   where p->>'purpose_sha256'=target->>'purpose_sha256'
    and exists(select 1 from jsonb_array_elements(v.input->'source_purposes') pinned where pinned=p)
    and private.travel_tariff_paid(target_case,to_date(p->>'month','YYYY-MM'))
    and private.travel_tariff_target_matches(p,target)),false);
$$;
revoke all on function private.travel_tariff_target_current(uuid,jsonb) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

create function private.travel_tariff_answer_valid(target jsonb,answer_text text) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare a jsonb;s jsonb;v jsonb;b jsonb;subject text;
begin
 if answer_text is null or length(answer_text)>2000 then return false;end if;
 a:=answer_text::jsonb;
 if jsonb_typeof(a) is distinct from 'object' or a->>'schema_version' is distinct from 'document-field-answer-v3' then return false;end if;
 if a->>'action' in ('unknown','unreadable') then return a=jsonb_build_object('schema_version','document-field-answer-v3','action',a->>'action');end if;
 if a->>'action' is distinct from 'correct' or (select count(*) from jsonb_object_keys(a))<>3 then return false;end if;
 s:=a->'structured_value';v:=s->'value';b:=s->'basis';subject:=s->>'subject';
 if not coalesce(jsonb_typeof(s)='object' and (select count(*) from jsonb_object_keys(s))=4
  and s->>'kind'='travel_tariff' and subject=target#>>'{tariff,subject}' and jsonb_typeof(b)='object'
  and (select count(*) from jsonb_object_keys(b))=3 and b->'page'=target#>'{tariff,group,page}'
  and jsonb_typeof(b->'locator')='string' and char_length(b->>'locator') between 1 and 120 and b->>'locator'=btrim(b->>'locator')
  and jsonb_typeof(b->'text')='string' and char_length(b->>'text') between 1 and 160 and b->>'text'=btrim(b->>'text'),false) then return false;end if;
 if subject in ('daily_fare','monthly_pass_cost') then
  return coalesce(jsonb_typeof(v)='string' and v#>>'{}'~'^(0|[1-9][0-9]{0,8})(\.[0-9]{1,2})?$',false);
 elsif subject='ticket_inventory' then
  return coalesce(jsonb_typeof(v)='object' and (select count(*) from jsonb_object_keys(v))=2
   and v->>'ticket_inventory' in ('complete','partial') and v->>'monthly_pass_availability' in ('available','unavailable'),false);
 elsif subject='context' then
  return coalesce(jsonb_typeof(v)='object' and (select count(*) from jsonb_object_keys(v))=4
   and jsonb_typeof(v->'route_reference')='string' and char_length(v->>'route_reference') between 1 and 200 and v->>'route_reference'=btrim(v->>'route_reference')
   and v->>'discount_profile' in ('standard_adult','special_discount') and v->>'directions' in ('both','outbound','return')
   and jsonb_typeof(v->'effective_period')='object' and (select count(*) from jsonb_object_keys(v->'effective_period'))=2
   and v#>>'{effective_period,from}'~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' and v#>>'{effective_period,to}'~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
   and (v#>>'{effective_period,from}')::date<=(v#>>'{effective_period,to}')::date,false);
 end if;
 return false;
exception when invalid_text_representation or invalid_parameter_value or datetime_field_overflow then return false;
end;$$;
revoke all on function private.travel_tariff_answer_valid(jsonb,text) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

do $migration$
declare definition text;body text;anchor text;
begin
 definition:=pg_get_functiondef('private.document_field_current(uuid,jsonb)'::regprocedure);
 execute replace(definition,'private.document_field_current(','private.document_field_current_before_tariff_v1(');
 definition:=pg_get_functiondef('private.document_reading_question_scope_v4(text[],jsonb)'::regprocedure);
 execute replace(definition,'private.document_reading_question_scope_v4(','private.document_reading_question_scope_before_tariff_v1(');
 select pg_get_constraintdef(oid) into definition from pg_constraint where conrelid='private.document_field_targets'::regclass and conname='document_field_targets_check';
 anchor:='''document-evidence-reading-v1''::text';
 if position(anchor in definition)=0 then raise exception 'TARIFF_TARGET_CHECK_ANCHOR';end if;
 alter table private.document_field_targets drop constraint document_field_targets_check;
 execute 'alter table private.document_field_targets add constraint document_field_targets_check '||replace(definition,anchor,anchor||', ''document-travel-tariff-transcription-v1''::text');
 body:=pg_get_functiondef('private.guard_document_cell_decision()'::regprocedure);
 anchor:='case when t->>''schema_version''=''document-evidence-reading-v1''';
 if position(anchor in body)=0 then raise exception 'TARIFF_ANSWER_GUARD_ANCHOR';end if;
 execute replace(body,anchor,'case when t->>''schema_version''=''document-travel-tariff-transcription-v1'' then private.travel_tariff_answer_valid(t,answer) when t->>''schema_version''=''document-evidence-reading-v1''');
 body:=pg_get_functiondef('private.document_field_request_open(uuid,integer,text,jsonb,text)'::regprocedure);
 anchor:='case target_payload->>''schema_version'' when ''document-evidence-reading-v1''';
 if position(anchor in body)=0 then raise exception 'TARIFF_REQUEST_FIELD_ANCHOR';end if;
 execute replace(body,anchor,'case target_payload->>''schema_version'' when ''document-travel-tariff-transcription-v1'' then ''travel_tariff.''||(target_payload#>>''{tariff,subject}'') when ''document-evidence-reading-v1''');
 body:=pg_get_functiondef('public.case_request_document_source(uuid,uuid,uuid)'::regprocedure);
 anchor:='''page'',coalesce((target#>>''{observation,original,page}'')::integer';
 if position(anchor in body)=0 then raise exception 'TARIFF_SOURCE_PAGE_ANCHOR';end if;
 execute replace(body,anchor,'''page'',coalesce((target#>>''{tariff,group,page}'')::integer,(target#>>''{observation,original,page}'')::integer');
end;$migration$;
revoke all on function private.document_field_current_before_tariff_v1(uuid,jsonb),private.document_reading_question_scope_before_tariff_v1(text[],jsonb) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function private.document_reading_question_scope_before_tariff_v1(text[],jsonb) to service_role,tivdoc_worker_runtime;

create or replace function private.document_field_current(target_case uuid,target jsonb) returns boolean
language sql security definer set search_path='' as $$
 select case when target->>'schema_version'='document-travel-tariff-transcription-v1'
  then private.travel_tariff_target_current(target_case,target)
  else private.document_field_current_before_tariff_v1(target_case,target) end;
$$;
create or replace function private.document_reading_question_scope_v4(purchased_topics text[],target jsonb) returns boolean
language sql immutable security invoker set search_path='' as $$
 select case when target->>'schema_version'='document-travel-tariff-transcription-v1' then coalesce(
  'travel'=any(purchased_topics) and array_position(purchased_topics,null) is null
  and purchased_topics <@ array['minimum_wage','working_time','pension','travel','convalescence','vacation','sick_leave','rest_day','bonuses','contract']::text[]
  and target#>>'{tariff,subject}' in ('context','daily_fare','ticket_inventory','monthly_pass_cost'),false)
 else private.document_reading_question_scope_before_tariff_v1(purchased_topics,target) end;
$$;
