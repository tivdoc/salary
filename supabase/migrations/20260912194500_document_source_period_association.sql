-- Forward migration: identified source-period document_field branch.
-- Preserves prior numeric decisions and original extraction evidence.
-- Apply after the tariff wrappers and a rollback upgrade preflight.
-- Execute as the existing migration owner inside the caller's transaction.
-- No data backfill, new answer store, provider call or runtime-authority grant.

-- Capture the latest wrappers, including non-payslip evidence and tariff.
-- Existing period helpers must be absent: never silently replace a prior policy.
do $capture$
declare body text;needle text;
begin
 if to_regprocedure('private.document_field_current_before_period_v1(uuid,jsonb)') is not null
  or to_regprocedure('private.document_reading_question_scope_before_period_v1(text[],jsonb)') is not null
  or to_regprocedure('private.source_period_target_matches(jsonb,jsonb)') is not null
  then raise exception 'SOURCE_PERIOD_CANDIDATE_ALREADY_INSTALLED';end if;
 body:=pg_get_functiondef('private.document_field_current(uuid,jsonb)'::regprocedure);
 if position('document-travel-tariff-transcription-v1' in body)=0 or position('private.document_field_current_before_tariff_v1' in body)=0
  then raise exception 'SOURCE_PERIOD_CURRENT_TARIFF_BASE_MISMATCH';end if;
 execute replace(body,'FUNCTION private.document_field_current(','FUNCTION private.document_field_current_before_period_v1(');
 body:=pg_get_functiondef('private.document_reading_question_scope_v4(text[],jsonb)'::regprocedure);
 if position('document-travel-tariff-transcription-v1' in body)=0 or position('private.document_reading_question_scope_before_tariff_v1' in body)=0
  then raise exception 'SOURCE_PERIOD_SCOPE_TARIFF_BASE_MISMATCH';end if;
 execute replace(body,'FUNCTION private.document_reading_question_scope_v4(','FUNCTION private.document_reading_question_scope_before_period_v1(');
 -- Reuse the original canonical target constructor without changing it.
 body:=pg_get_functiondef('private.source_structure_target_current(jsonb,jsonb)'::regprocedure);
 needle:=$needle$schema_name:=case target#>>'{subject,kind}' when 'source_relationship' then 'document-source-relationship-v1' when 'deduction_group' then 'document-source-deduction-group-v1' when 'balance_movement' then 'document-source-balance-movement-v1' end;$needle$;
 if position(needle in body)=0 or position('private.source_structure_subject_current(e,f,target->''subject'')' in body)=0
  then raise exception 'SOURCE_PERIOD_TARGET_CONSTRUCTOR_BASE_MISMATCH';end if;
 body:=replace(body,'FUNCTION private.source_structure_target_current(','FUNCTION private.source_period_target_matches(');
 body:=replace(body,needle,$replacement$if checkpoint->>'schema_version' is distinct from 'tivdoc-saved-extraction-v1'
  or checkpoint->>'period_mismatch' is distinct from 'false'
  or target->>'schema_version' is distinct from 'document-source-period-association-v1' then return false;end if;
 schema_name:=case when target#>>'{subject,kind}'='period_association' then 'document-source-period-association-v1' end;$replacement$);
 body:=replace(body,'private.source_structure_subject_current(e,f,target->''subject'')','private.source_period_subject_current(e,f,target->''subject'')');
 -- PL/pgSQL resolves the helper when invoked, after its definition below.
 execute body;
end;$capture$;

revoke all on function private.document_field_current_before_period_v1(uuid,jsonb),
 private.document_reading_question_scope_before_period_v1(text[],jsonb),private.source_period_target_matches(jsonb,jsonb)
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function private.document_reading_question_scope_before_period_v1(text[],jsonb) to service_role,tivdoc_worker_runtime;

create function private.source_period_subject_current(e jsonb,first_pass jsonb,s jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $subject$
declare supplied jsonb;actual_ref jsonb;refs jsonb:='[]'::jsonb;ordered jsonb;page_number integer;first_page integer;
begin
 if jsonb_typeof(s) is distinct from 'object' or s->>'kind' is distinct from 'period_association'
  or jsonb_typeof(s->'refs') is distinct from 'array' or e->>'document_id' is null
  or e->>'document_id' is distinct from first_pass->>'document_id' then return false;end if;
 if jsonb_array_length(s->'refs') not between 1 and 20
  or (select count(distinct r.value->>'id') from jsonb_array_elements(s->'refs') r(value))<>jsonb_array_length(s->'refs') then return false;end if;
 for supplied in select r.value from jsonb_array_elements(s->'refs') r(value) loop
  if jsonb_typeof(supplied) is distinct from 'object' or (supplied->>'kind' in ('field','component')) is not true then return false;end if;
  actual_ref:=private.source_structure_ref(e,supplied->>'kind',supplied->>'id');
  if actual_ref is null or actual_ref='null'::jsonb or actual_ref is distinct from supplied
   or actual_ref#>>'{source,document_id}' is distinct from e->>'document_id'
   or jsonb_typeof(actual_ref#>'{source,page}') is distinct from 'number'
   or (actual_ref#>>'{source,page}')!~'^[1-9][0-9]?$|^100$' then return false;end if;
  page_number:=(actual_ref#>>'{source,page}')::integer;
  if (page_number between 1 and (e#>>'{quality_metrics,page_count}')::integer) is not true
   or (page_number between 1 and (first_pass#>>'{quality_metrics,page_count}')::integer) is not true
   or (first_page is not null and first_page<>page_number) then return false;end if;
  first_page:=page_number;refs:=refs||jsonb_build_array(actual_ref);
 end loop;
 select jsonb_agg(r.value order by ((r.value->>'kind')||':'||(r.value->>'id')) collate "C") into ordered
  from jsonb_array_elements(refs) r(value);
 -- Only this new metadata branch permits absent/unknown period labels.
 -- An explicit original label remains intact and conflicts in the TS consumer.
 return s=jsonb_build_object('kind','period_association','refs',ordered);
exception when invalid_text_representation or numeric_value_out_of_range or invalid_parameter_value then return false;
end;$subject$;
revoke all on function private.source_period_subject_current(jsonb,jsonb,jsonb)
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

create function private.source_period_refs_in_scope(e jsonb,topics text[],s jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $scope$
declare ref jsonb;field_name text;semantic text;required_topic text;
begin
 if coalesce(cardinality(topics)>0 and array_position(topics,null) is null
  and topics <@ array['minimum_wage','working_time','pension','travel','convalescence','vacation','sick_leave','rest_day','bonuses','contract']::text[],false) is not true
  or s->>'kind' is distinct from 'period_association' or jsonb_typeof(s->'refs') is distinct from 'array' then return false;end if;
 if jsonb_array_length(s->'refs') not between 1 and 20 then return false;end if;
 for ref in select r.value from jsonb_array_elements(s->'refs') r(value) loop
  if private.source_structure_ref(e,ref->>'kind',ref->>'id') is distinct from ref then return false;end if;
  if ref->>'kind'='field' then
   select f.value->>'field' into field_name from jsonb_array_elements(e->'fields') f(value) where f.value->>'candidate_id'=ref->>'id';
   if (field_name=any(private.document_field_question_fields_v3(topics))) is not true then return false;end if;
  elsif ref->>'kind'='component' then
   select r.value->>'semantic_kind' into semantic from jsonb_array_elements(e->'additional_components') r(value) where r.value->>'component_id'=ref->>'id';
   -- Same topic map as document_reading_question_scope_v4 row readings.
   -- No deduction/unknown row or label/amount-based classification is added.
   required_topic:=case semantic when 'base_salary' then 'minimum_wage' when 'hourly_base' then 'minimum_wage'
    when 'overtime_125' then 'working_time' when 'overtime_150' then 'working_time'
    when 'travel' then 'travel' when 'convalescence' then 'convalescence' when 'bonus' then 'bonuses' end;
   if (required_topic=any(topics)) is not true then return false;end if;
  else return false;end if;
 end loop;
 return true;
exception when invalid_text_representation or invalid_parameter_value then return false;
end;$scope$;
revoke all on function private.source_period_refs_in_scope(jsonb,text[],jsonb)
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

create function private.source_period_current_checkpoint(target_case uuid,target jsonb) returns jsonb
language plpgsql stable security invoker set search_path='' as $checkpoint$
declare checkpoint jsonb;
begin
 if target->>'schema_version' is distinct from 'document-source-period-association-v1'
  or target->>'case_id' is distinct from target_case::text
  or coalesce(target->>'month'~'^[0-9]{4}-(0[1-9]|1[0-2])$',false) is not true
  or jsonb_typeof(target->'policy_version') is distinct from 'string'
  or char_length(target->>'policy_version') not between 1 and 100 then return null;end if;
 select c.result into checkpoint from public.documents d
 join private.case_input_heads h on h.case_id=d.case_id
 join private.case_input_versions v on v.case_id=h.case_id and v.revision=h.revision and v.input_sha256=h.input_sha256
 join private.case_extraction_checkpoints c on c.case_id=d.case_id and c.version_id=d.version_id
 where d.case_id=target_case and d.id::text=target->>'product_document_id' and d.version_id::text=target->>'version_id'
  and d.document_type::text='payslip' and d.content_sha256=target->>'source_sha256'
  and (d.period_month is null or to_char(d.period_month,'YYYY-MM')=target->>'month')
  and exists(select 1 from jsonb_array_elements(v.input->'documents') p(value)
   where p.value->>'id'=d.id::text and p.value->>'version_id'=d.version_id::text
    and p.value->>'sha256'=d.content_sha256 and p.value->>'type'='payslip')
  and c.input_sha256=d.content_sha256 and c.policy_version=target->>'policy_version'
  and c.revision=(select max(latest.revision) from private.case_extraction_checkpoints latest
   where latest.case_id=d.case_id and latest.version_id=d.version_id and latest.input_sha256=d.content_sha256
    and latest.policy_version=target->>'policy_version' and latest.revision<=h.revision)
  and c.result_sha256=target->>'extraction_result_sha256' and c.result->>'result_sha256'=c.result_sha256
  and c.result->>'case_id'=target_case::text and c.result->>'version_id'=d.version_id::text
  and c.result->>'product_document_id'=d.id::text and c.result->>'input_sha256'=d.content_sha256
  and c.result->>'expected_month'=target->>'month' and c.result->>'period_mismatch'='false';
 if checkpoint is null or private.source_period_target_matches(checkpoint,target) is not true then return null;end if;
 return checkpoint;
exception when invalid_text_representation or numeric_value_out_of_range or invalid_parameter_value or datetime_field_overflow then return null;
end;$checkpoint$;
revoke all on function private.source_period_current_checkpoint(uuid,jsonb)
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

create function private.source_period_target_in_scope(target_case uuid,target jsonb,topics text[]) returns boolean
language plpgsql stable security invoker set search_path='' as $target_scope$
declare checkpoint jsonb:=private.source_period_current_checkpoint(target_case,target);
begin
 if checkpoint is null then return false;end if;
 return private.source_period_refs_in_scope(checkpoint#>'{run,result,final_extraction}',topics,target->'subject');
end;$target_scope$;
revoke all on function private.source_period_target_in_scope(uuid,jsonb,text[])
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

create function private.source_period_target_current(target_case uuid,target jsonb) returns boolean
language plpgsql stable security invoker set search_path='' as $current$
declare checkpoint jsonb:=private.source_period_current_checkpoint(target_case,target);target_month date;
begin
 if checkpoint is null then return false;end if;
 target_month:=(target->>'month'||'-01')::date;
 return exists(select 1 from private.case_input_heads h
  join private.case_input_versions v on v.case_id=h.case_id and v.revision=h.revision and v.input_sha256=h.input_sha256
  where h.case_id=target_case and (
   exists(select 1 from jsonb_array_elements(v.input->'orders') pinned(value)
    join private.product_orders o on o.case_id=target_case and o.id::text=pinned.value->>'id'
    join private.order_entitlements ent on ent.order_id=o.id and ent.state='active'
    where o.state='paid' and o.refund_state<>'refunded' and target_month between o.period_from and o.period_to
     and pinned.value=jsonb_build_object('id',o.id,'kind',o.kind,'from',o.period_from,'to',o.period_to,'topics',o.topics,'offer_sha256',o.offer_sha256)
     and private.source_period_refs_in_scope(checkpoint#>'{run,result,final_extraction}',o.topics,target->'subject'))
   or exists(select 1 from jsonb_array_elements(v.input->'legacy_orders') pinned(value)
    cross join lateral jsonb_array_elements(private.legacy_paid_scopes_internal(target_case)) active(value)
    where pinned.value=active.value and private.legacy_scope_covers_month(active.value,target_month)
     and private.source_period_refs_in_scope(checkpoint#>'{run,result,final_extraction}',array(select jsonb_array_elements_text(active.value->'topics')),target->'subject'))));
exception when invalid_text_representation or invalid_parameter_value or datetime_field_overflow then return false;
end;$current$;
revoke all on function private.source_period_target_current(uuid,jsonb)
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

create or replace function private.document_field_current(target_case uuid,target jsonb) returns boolean
language sql security definer set search_path='' as $wrapper$
 select case when target->>'schema_version'='document-source-period-association-v1'
  then private.source_period_target_current(target_case,target)
  else private.document_field_current_before_period_v1(target_case,target) end;
$wrapper$;

create or replace function private.document_reading_question_scope_v4(purchased_topics text[],target jsonb) returns boolean
language sql immutable security invoker set search_path='' as $question_scope$
 select case when target->>'schema_version'='document-source-period-association-v1' then coalesce(
  cardinality(purchased_topics)>0 and array_position(purchased_topics,null) is null
  and purchased_topics <@ array['minimum_wage','working_time','pension','travel','convalescence','vacation','sick_leave','rest_day','bonuses','contract']::text[]
  and target#>>'{subject,kind}'='period_association'
  and case when jsonb_typeof(target#>'{subject,refs}')='array' then jsonb_array_length(target#>'{subject,refs}') between 1 and 20 else false end,false)
 else private.document_reading_question_scope_before_period_v1(purchased_topics,target) end;
$question_scope$;
-- This scope function is preliminary only. Both currentness and the opener's
-- exact pinned order checks call the deep checkpoint-aware scope helper.

create function private.source_period_answer_valid(target jsonb,answer_text text) returns boolean
language plpgsql immutable security invoker set search_path='' as $answer$
declare a jsonb;v jsonb;b jsonb;p jsonb;from_date date;to_date date;month_start date;
begin
 if target->>'schema_version' is distinct from 'document-source-period-association-v1'
  or target#>>'{subject,kind}' is distinct from 'period_association'
  or answer_text is null or char_length(answer_text)>2000 then return false;end if;
 a:=answer_text::jsonb;
 if jsonb_typeof(a) is distinct from 'object' or a->>'schema_version' is distinct from 'document-field-answer-v3' then return false;end if;
 if a->>'action' in ('unknown','unreadable') then
  return a=jsonb_build_object('schema_version','document-field-answer-v3','action',a->>'action');end if;
 if a->>'action' is distinct from 'correct' then return false;end if;
 v:=a->'structured_value';b:=v->'basis';p:=v->'period';
 if jsonb_typeof(v) is distinct from 'object' or jsonb_typeof(b) is distinct from 'object' or jsonb_typeof(p) is distinct from 'object'
  or v->>'kind' is distinct from 'period_association' or (v->>'period_kind' in ('current','retroactive','cumulative')) is not true
  or a is distinct from jsonb_build_object('schema_version','document-field-answer-v3','action','correct','structured_value',v)
  or v is distinct from jsonb_build_object('kind','period_association','period_kind',v->>'period_kind','period',p,'basis',b)
  or p is distinct from jsonb_build_object('from',p->>'from','to',p->>'to')
  or jsonb_typeof(p->'from') is distinct from 'string' or jsonb_typeof(p->'to') is distinct from 'string'
  or coalesce(p->>'from'~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' and p->>'to'~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$',false) is not true
  or b is distinct from jsonb_build_object('page',b->'page','locator',b->>'locator','text',b->>'text')
  or jsonb_typeof(b->'page') is distinct from 'number' or coalesce(b->>'page'~'^[1-9][0-9]?$|^100$',false) is not true
  or b->'page' is distinct from target#>'{subject,refs,0,source,page}'
  or jsonb_typeof(b->'locator') is distinct from 'string' or jsonb_typeof(b->'text') is distinct from 'string'
  or char_length(btrim(b->>'locator')) not between 1 and 120 or char_length(btrim(b->>'text')) not between 1 and 160
  or b->>'locator' is distinct from btrim(b->>'locator') or b->>'text' is distinct from btrim(b->>'text') then return false;end if;
 from_date:=(p->>'from')::date;to_date:=(p->>'to')::date;
 if to_char(from_date,'YYYY-MM-DD') is distinct from p->>'from' or to_char(to_date,'YYYY-MM-DD') is distinct from p->>'to' or from_date>to_date then return false;end if;
 if v->>'period_kind'='current' then
  if coalesce(target->>'month'~'^[0-9]{4}-(0[1-9]|1[0-2])$',false) is not true then return false;end if;
  month_start:=(target->>'month'||'-01')::date;
  if from_date<>month_start or to_date<>(month_start+interval '1 month - 1 day')::date then return false;end if;
 end if;
 return true;
exception when invalid_text_representation or invalid_parameter_value or datetime_field_overflow or numeric_value_out_of_range then return false;
end;$answer$;
revoke all on function private.source_period_answer_valid(jsonb,text)
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

-- Exact anchors refuse unexpected function drift. No definition is replaced
-- from an old migration body, and no old answer/target row is rewritten.
do $integration$
declare body text;definition text;needle text;replacement text;
begin
 select pg_get_constraintdef(oid) into definition from pg_constraint
  where conrelid='private.document_field_targets'::regclass and conname='document_field_targets_check';
 needle:='''document-travel-tariff-transcription-v1''::text';
 if definition is null or position(needle in definition)=0 then raise exception 'SOURCE_PERIOD_TARGET_CHECK_BASE_MISMATCH';end if;
 alter table private.document_field_targets drop constraint document_field_targets_check;
 execute 'alter table private.document_field_targets add constraint document_field_targets_check '||replace(definition,needle,needle||', ''document-source-period-association-v1''::text');

 body:=pg_get_functiondef('private.guard_document_cell_decision()'::regprocedure);
 needle:='case when t->>''schema_version''=''document-travel-tariff-transcription-v1''';
 if position(needle in body)=0 then raise exception 'SOURCE_PERIOD_ANSWER_GUARD_BASE_MISMATCH';end if;
 execute replace(body,needle,'case when t->>''schema_version''=''document-source-period-association-v1'' then private.source_period_answer_valid(t,answer) when t->>''schema_version''=''document-travel-tariff-transcription-v1''');

 body:=pg_get_functiondef('private.document_field_request_open(uuid,integer,text,jsonb,text)'::regprocedure);
 needle:='candidate_field:=case target_payload->>''schema_version''';
 if position(needle in body)=0 then raise exception 'SOURCE_PERIOD_OPENER_FIELD_BASE_MISMATCH';end if;
 body:=replace(body,needle,needle||' when ''document-source-period-association-v1'' then ''source_structure.period_association''');
 needle:='private.document_reading_question_scope_v4(o.topics,target_payload)';
 if (char_length(body)-char_length(replace(body,needle,'')))<>char_length(needle) then raise exception 'SOURCE_PERIOD_OPENER_MODERN_SCOPE_BASE_MISMATCH';end if;
 replacement:='('||needle||' and (target_payload->>''schema_version'' is distinct from ''document-source-period-association-v1'' or private.source_period_target_in_scope(target_case,target_payload,o.topics)))';
 body:=replace(body,needle,replacement);
 needle:='private.document_reading_question_scope_v4(array(select jsonb_array_elements_text(active->''topics'')),target_payload)';
 if (char_length(body)-char_length(replace(body,needle,'')))<>char_length(needle) then raise exception 'SOURCE_PERIOD_OPENER_LEGACY_SCOPE_BASE_MISMATCH';end if;
 replacement:='('||needle||' and (target_payload->>''schema_version'' is distinct from ''document-source-period-association-v1'' or private.source_period_target_in_scope(target_case,target_payload,array(select jsonb_array_elements_text(active->''topics'')))))';
 body:=replace(body,needle,replacement);
 execute body;

 body:=pg_get_functiondef('public.case_request_document_source(uuid,uuid,uuid)'::regprocedure);
 needle:='''page'',coalesce((target#>>''{tariff,group,page}'')::integer';
 if position(needle in body)=0 then raise exception 'SOURCE_PERIOD_SOURCE_PAGE_BASE_MISMATCH';end if;
 execute replace(body,needle,'''page'',coalesce(case when target->>''schema_version''=''document-source-period-association-v1'' then (target#>>''{subject,refs,0,source,page}'')::integer end,(target#>>''{tariff,group,page}'')::integer');
end;$integration$;

-- CREATE OR REPLACE keeps the original callable wrappers' ACLs. Only the
-- captured invoker scope helper receives its existing worker/service pattern.
-- No grants to document_field_current, answer/source RPCs or tables are added.
