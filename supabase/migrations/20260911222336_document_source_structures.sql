-- Source relationships, deduction inventories and balance cells are distinct
-- identified readings. Historical targets/answers/checkpoints remain unchanged.
alter table private.document_field_targets drop constraint document_field_targets_check;
alter table private.document_field_targets add constraint document_field_targets_check check(coalesce(
 target->>'schema_version' in ('document-field-confirmation-v1','document-row-cell-confirmation-v1','document-source-scope-confirmation-v1','document-source-transcription-v1',
 'document-source-relationship-v1','document-source-deduction-group-v1','document-source-balance-movement-v1')
 and target->>'case_id'=case_id::text and target->>'target_sha256'=target_sha256,false));

-- Preserve the historical implementation, including its security properties.
do $$ declare d text;begin
 d:=pg_get_functiondef('private.document_reading_question_scope_v4(text[],jsonb)'::regprocedure);
 execute replace(d,'private.document_reading_question_scope_v4(','private.document_reading_question_scope_legacy_v4(');
 d:=pg_get_functiondef('private.document_field_current(uuid,jsonb)'::regprocedure);
 execute replace(d,'private.document_field_current(','private.document_field_current_legacy_v4(');
end;$$;

create or replace function private.document_reading_question_scope_v4(purchased_topics text[],target jsonb) returns boolean
language sql immutable security invoker set search_path='' as $$
 select coalesce(case target->>'schema_version'
 when 'document-row-cell-confirmation-v1' then case when target#>>'{original_component,semantic_kind}'='deduction' then
  target->>'cell'='amount' and char_length(btrim(target#>>'{original_component,amount_raw}')) between 1 and 500 and 'minimum_wage'=any(purchased_topics)
  else private.document_reading_question_scope_legacy_v4(purchased_topics,target) end
 when 'document-source-relationship-v1' then 'pension'=any(purchased_topics) and target#>>'{subject,kind}'='source_relationship'
 when 'document-source-deduction-group-v1' then 'minimum_wage'=any(purchased_topics) and target#>>'{subject,kind}'='deduction_group'
 when 'document-source-balance-movement-v1' then target#>>'{subject,kind}'='balance_movement'
  and case target#>>'{subject,balance_kind}' when 'vacation' then 'vacation' when 'sick' then 'sick_leave' end=any(purchased_topics)
 else private.document_reading_question_scope_legacy_v4(purchased_topics,target) end,false)
 and cardinality(purchased_topics)>0 and array_position(purchased_topics,null) is null
 and purchased_topics <@ array['minimum_wage','working_time','pension','travel','convalescence','vacation','sick_leave','rest_day','bonuses','contract']::text[];
$$;

create function private.source_structure_ref(e jsonb,k text,ref_id text) returns jsonb
language plpgsql immutable security invoker set search_path='' as $$
declare r jsonb;s jsonb;label text;raw jsonb;n integer;
begin
 select count(*) into n from (
 select f->>'candidate_id' id from jsonb_array_elements(e->'fields') f union all
 select f->>'component_id' from jsonb_array_elements(e->'additional_components') f union all
 select f#>>'{candidate,candidate_id}' from jsonb_array_elements(coalesce(e->'source_scope_observations','[]')) f) ids where id=ref_id;
 if n<>1 then return null;end if;
 if k='field' then
 select f into r from jsonb_array_elements(e->'fields') f where f->>'candidate_id'=ref_id;
 s:=r->'source';label:=coalesce(s->>'text_fragment',r->>'field');raw:=r->'raw_value';
 elsif k='scope' then
 select f into r from jsonb_array_elements(coalesce(e->'source_scope_observations','[]')) f where f#>>'{candidate,candidate_id}'=ref_id;
 s:=r#>'{candidate,source}';label:=r->>'source_label';raw:=r#>'{candidate,raw_value}';
 elsif k='component' then
 select f into r from jsonb_array_elements(e->'additional_components') f where f->>'component_id'=ref_id;
 s:=r->'source';label:=r->>'source_label';raw:=r->'amount_raw';
 else return null;end if;
 if r is null then return null;end if;
 return jsonb_build_object('kind',k,'id',ref_id,'sha256',encode(sha256(convert_to(private.governance_jsonb_compact_text(r),'UTF8')),'hex'),'source',s,'label',label,'raw_value',raw);
end;$$;

create function private.source_structure_subject_current(e jsonb,first_pass jsonb,s jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare actual jsonb;refs jsonb;ref jsonb;base jsonb;contribution jsonb;anchor jsonb;rows_value jsonb;total jsonb;voluntary jsonb;n integer;expected text;
begin
 if e->>'document_id' is distinct from first_pass->>'document_id' then return false;end if;
 if s->>'kind'='source_relationship' then
  base:=private.source_structure_ref(e,s#>>'{base,kind}',s#>>'{base,id}');
  contribution:=private.source_structure_ref(e,s#>>'{contribution,kind}',s#>>'{contribution,id}');
  if base is null or contribution is null or s#>>'{base,kind}'<>'field'
   or not exists(select 1 from jsonb_array_elements(e->'fields') f where f->>'candidate_id'=s#>>'{base,id}' and f->>'field'='pension_base') then return false;end if;
  if s->>'component_kind'='combined_employer_funds' then
   if s#>>'{contribution,kind}'<>'scope' or not exists(select 1 from jsonb_array_elements(coalesce(e->'source_scope_observations','[]')) o where o#>>'{candidate,candidate_id}'=s#>>'{contribution,id}' and o->>'scope'='combined_employer_funds') then return false;end if;
  else
   expected:=case s->>'component_kind' when 'pension_employee' then 'pension_employee_contribution' when 'pension_employer' then 'pension_employer_contribution' when 'severance' then 'severance_contribution' end;
   if expected is null then return false;end if;
   if not ((s#>>'{contribution,kind}'='field' and exists(select 1 from jsonb_array_elements(e->'fields') f where f->>'candidate_id'=s#>>'{contribution,id}' and f->>'field'=expected))
    or (s#>>'{contribution,kind}'='component' and exists(select 1 from jsonb_array_elements(e->'additional_components') r where r->>'component_id'=s#>>'{contribution,id}' and r->>'semantic_kind'='deduction'))) then return false;end if;
  end if;
  actual:=jsonb_build_object('kind','source_relationship','component_kind',s->>'component_kind','base',base,'contribution',contribution);refs:=jsonb_build_array(base,contribution);
 elsif s->>'kind'='deduction_group' then
  select count(*) into n from jsonb_array_elements(e->'fields') f where f->>'field'='total_deductions';if n<>1 then return false;end if;
  select private.source_structure_ref(e,'field',f->>'candidate_id') into total from jsonb_array_elements(e->'fields') f where f->>'field'='total_deductions';
  select count(*) into n from jsonb_array_elements(coalesce(e->'source_scope_observations','[]')) f where f->>'scope'='voluntary_deduction';if n>1 then return false;end if;
  select private.source_structure_ref(e,'scope',f#>>'{candidate,candidate_id}') into voluntary from jsonb_array_elements(coalesce(e->'source_scope_observations','[]')) f where f->>'scope'='voluntary_deduction';
  select jsonb_agg(private.source_structure_ref(e,'component',r->>'component_id') order by r->>'component_id') into rows_value from jsonb_array_elements(e->'additional_components') r where r->>'semantic_kind'='deduction';
  if rows_value is null or jsonb_array_length(rows_value) not between 1 and 100 then return false;end if;
  actual:=jsonb_build_object('kind','deduction_group','rows',rows_value,'mandatory_total',total,'voluntary_total',voluntary);
  refs:=rows_value||jsonb_build_array(total)||case when voluntary is null then '[]'::jsonb else jsonb_build_array(voluntary) end;
 elsif s->>'kind'='balance_movement' then
  if (s->>'balance_kind' in ('vacation','sick')) is not true or (s->>'cell' in ('opening','accrued','used','adjustments','closing')) is not true then return false;end if;
  anchor:=private.source_structure_ref(first_pass,'field',s#>>'{anchor,id}');
  if anchor is null or not exists(select 1 from jsonb_array_elements(first_pass->'fields') f where f->>'candidate_id'=s#>>'{anchor,id}' and f->>'field'=(s->>'balance_kind')||'_balance') then return false;end if;
  actual:=jsonb_build_object('kind','balance_movement','balance_kind',s->>'balance_kind','cell',s->>'cell','anchor',anchor,'page',anchor#>'{source,page}',
   'original_raw_value',case when s->>'cell'='closing' then anchor->'raw_value' else 'null'::jsonb end);refs:=jsonb_build_array(anchor);
 else return false;end if;
 if actual is distinct from s then return false;end if;
 for ref in select value from jsonb_array_elements(refs) loop
  if ref is null or ref='null'::jsonb or ref#>>'{source,document_id}' is distinct from e->>'document_id'
   or ref#>>'{source,source_scope,period_kind}' is distinct from 'current'
   or ((ref#>>'{source,page}')::integer between 1 and least(100,(e#>>'{quality_metrics,page_count}')::integer,(first_pass#>>'{quality_metrics,page_count}')::integer)) is not true then return false;end if;
 end loop;
 return true;
exception when invalid_text_representation or numeric_value_out_of_range then return false;
end;$$;

create function private.source_structure_target_current(checkpoint jsonb,target jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare e jsonb:=checkpoint#>'{run,result,final_extraction}';f jsonb:=checkpoint#>'{run,result,first_pass,normalized_extraction}';actual jsonb;schema_name text;
begin
 schema_name:=case target#>>'{subject,kind}' when 'source_relationship' then 'document-source-relationship-v1' when 'deduction_group' then 'document-source-deduction-group-v1' when 'balance_movement' then 'document-source-balance-movement-v1' end;
 if e->>'document_id' is distinct from checkpoint->>'version_id' or f->>'document_id' is distinct from checkpoint->>'version_id' then return false;end if;
 if schema_name is null or not private.source_structure_subject_current(e,f,target->'subject') then return false;end if;
 if exists(select 1 from jsonb_array_elements(e->'fields') p where p->>'field'='salary_period' and (p#>>'{normalized_value,year}')||'-'||lpad(p#>>'{normalized_value,month}',2,'0') is distinct from target->>'month')
  or not exists(select 1 from jsonb_array_elements(e->'fields') p where p->>'field'='salary_period') then return false;end if;
 if e ?| array['customer_readings','customer_row_readings','customer_scope_readings','customer_source_transcriptions','customer_source_structures','source_reading_context']
  or f ?| array['customer_readings','customer_row_readings','customer_scope_readings','customer_source_transcriptions','customer_source_structures','source_reading_context'] then return false;end if;
 actual:=jsonb_build_object('schema_version',schema_name,'case_id',checkpoint->>'case_id','product_document_id',checkpoint->>'product_document_id','version_id',checkpoint->>'version_id',
 'source_sha256',checkpoint->>'input_sha256','month',checkpoint->>'expected_month','policy_version',target->>'policy_version','extraction_result_sha256',checkpoint->>'result_sha256',
 'normalized_extraction_sha256',encode(sha256(convert_to(private.governance_jsonb_compact_text(e),'UTF8')),'hex'),
 'first_pass_extraction_sha256',encode(sha256(convert_to(private.governance_jsonb_compact_text(f),'UTF8')),'hex'),'subject',target->'subject','proposed_value',null);
 return checkpoint->>'result_sha256'=encode(sha256(convert_to(private.governance_jsonb_compact_text(checkpoint#>'{run,result}'),'UTF8')),'hex')
  and target=actual||jsonb_build_object('target_sha256',encode(sha256(convert_to(private.governance_jsonb_compact_text(actual),'UTF8')),'hex'));
end;$$;

create or replace function private.document_field_current(target_case uuid,target jsonb) returns boolean
language sql security definer set search_path='' as $$
 select case when target->>'schema_version' in ('document-source-relationship-v1','document-source-deduction-group-v1','document-source-balance-movement-v1') then exists(
 select 1 from public.documents d join public.cases pc on pc.id=d.case_id
 join private.case_extraction_checkpoints c on c.case_id=d.case_id and c.version_id=d.version_id
 where d.case_id=target_case and d.id::text=target->>'product_document_id' and d.version_id::text=target->>'version_id'
 and d.content_sha256=target->>'source_sha256' and c.input_sha256=d.content_sha256 and c.policy_version=target->>'policy_version'
 and c.result_sha256=target->>'extraction_result_sha256' and c.result->>'case_id'=target_case::text
 and c.result->>'version_id'=d.version_id::text and c.result->>'product_document_id'=d.id::text and c.result->>'input_sha256'=d.content_sha256
 and c.result->>'expected_month'=target->>'month' and c.result->>'period_mismatch'='false'
 and to_char(coalesce(d.period_month,pc.check_period_month),'YYYY-MM')=target->>'month'
 and private.source_structure_target_current(c.result,target))
 else private.document_field_current_legacy_v4(target_case,target) end;
$$;

create function private.document_source_structure_answer_valid(target jsonb,answer_text text) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare a jsonb;v jsonb;b jsonb;s jsonb:=target->'subject';pages jsonb;member jsonb;expected jsonb;
begin
 if answer_text is null or char_length(answer_text)>2000 or target->>'schema_version' not in ('document-source-relationship-v1','document-source-deduction-group-v1','document-source-balance-movement-v1') then return false;end if;
 a:=answer_text::jsonb;
 if a->>'schema_version' is distinct from 'document-field-answer-v3' then return false;end if;
 if a->>'action' in ('unknown','unreadable') then return a=jsonb_build_object('schema_version','document-field-answer-v3','action',a->>'action');end if;
 if (a->>'action' in ('correct','confirm')) is not true then return false;end if;
 v:=a->'structured_value';b:=v->'basis';
 if jsonb_typeof(v) is distinct from 'object' or jsonb_typeof(b) is distinct from 'object'
  or jsonb_typeof(b->'locator') is distinct from 'string' or jsonb_typeof(b->'text') is distinct from 'string'
  or a is distinct from jsonb_build_object('schema_version','document-field-answer-v3','action',a->>'action','structured_value',v)
  or v->>'kind' is distinct from s->>'kind'
  or b is distinct from jsonb_build_object('page',b->'page','locator',b->>'locator','text',b->>'text')
  or jsonb_typeof(b->'page') is distinct from 'number' or (b->>'page')!~'^[1-9][0-9]?$|^100$'
  or char_length(btrim(b->>'locator')) not between 1 and 120 or char_length(btrim(b->>'text')) not between 1 and 160
  or b->>'locator' is distinct from btrim(b->>'locator') or b->>'text' is distinct from btrim(b->>'text') then return false;end if;
 pages:=case s->>'kind' when 'source_relationship' then jsonb_build_array(s#>'{contribution,source,page}',s#>'{base,source,page}')
 when 'deduction_group' then (select jsonb_agg(r#>'{source,page}') from jsonb_array_elements((s->'rows')||jsonb_build_array(s->'mandatory_total')||case when s->'voluntary_total'='null'::jsonb then '[]'::jsonb else jsonb_build_array(s->'voluntary_total') end) r)
 when 'balance_movement' then jsonb_build_array(s->'page') end;
 if not coalesce(pages @> jsonb_build_array(b->'page'),false) then return false;end if;
 if s->>'kind'='source_relationship' then
  expected:=jsonb_build_object('kind','source_relationship','relationship',v->>'relationship','component_kind',s->>'component_kind',
   'fund_kind',v->>'fund_kind','fund_label',v->>'fund_label','source_kind',v->>'source_kind','basis',b);
  return coalesce(v=expected and v->>'relationship' in ('same_base','different_base') and (a->>'action'<>'confirm' or v->>'relationship'='same_base')
   and v->>'fund_kind' in ('pension','study','severance','combined','unknown') and v->>'source_kind' in ('same_row','labelled_section','explicit_reference')
   and char_length(btrim(v->>'fund_label')) between 1 and 160 and v->>'fund_label'=btrim(v->>'fund_label'),false);
 end if;
 if a->>'action'<>'correct' then return false;end if;
 if s->>'kind'='deduction_group' then
  if v is distinct from jsonb_build_object('kind','deduction_group','members',v->'members','inventory',v->>'inventory','basis',b)
   or (v->>'inventory' in ('complete','partial')) is not true or jsonb_typeof(v->'members') is distinct from 'array' then return false;end if;
  if jsonb_array_length(v->'members')<>jsonb_array_length(s->'rows')
   or (select count(distinct m->>'component_id') from jsonb_array_elements(v->'members') m)<>jsonb_array_length(s->'rows') then return false;end if;
  for member in select value from jsonb_array_elements(v->'members') loop
   if member is distinct from jsonb_build_object('component_id',member->>'component_id','group',member->>'group')
    or (member->>'group' in ('mandatory','voluntary','unknown')) is not true
    or not exists(select 1 from jsonb_array_elements(s->'rows') r where r->>'id'=member->>'component_id')
    or (member->>'group'='unknown' and v->>'inventory'='complete')
    or (member->>'group'='voluntary' and s->'voluntary_total'='null'::jsonb) then return false;end if;
  end loop;
  return true;
 elsif s->>'kind'='balance_movement' then
  if v->>'period' is distinct from target->>'month' then return false;end if;
  if v->>'state'='not_present' then return s->>'cell'='adjustments' and v=jsonb_build_object('kind','balance_movement','state','not_present','period',v->>'period','basis',b);end if;
  return coalesce(v=jsonb_build_object('kind','balance_movement','state','value','amount',v->>'amount','unit',v->>'unit','period',v->>'period','basis',b)
   and char_length(v->>'amount') between 1 and 100 and (v->>'amount')~'^-?(0|[1-9][0-9]*)(\.[0-9]+)?$'
   and (s->>'cell'='adjustments' or (v->>'amount')::numeric>=0) and v->>'unit' in ('days','hours','source_native_unknown'),false);
 end if;
 return false;
exception when invalid_text_representation or numeric_value_out_of_range then return false;
end;$$;

-- This helper checks only a bounded envelope, with no request lookup or
-- authorization side effect. The existing locked trigger validates the exact
-- target, account, current source and structured payload before any write.
create function private.document_field_answer_envelope_valid(answer_text text) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare a jsonb;
begin
 if private.document_field_answer_v2_valid(answer_text) then return true;end if;
 if answer_text is null or char_length(answer_text)>2000 then return false;end if;
 a:=answer_text::jsonb;
 if a->>'schema_version' is distinct from 'document-field-answer-v3' then return false;end if;
 if a->>'action' in ('unknown','unreadable') then return a=jsonb_build_object('schema_version','document-field-answer-v3','action',a->>'action');end if;
 return coalesce(a->>'action' in ('confirm','correct') and jsonb_typeof(a->'structured_value')='object'
  and a=jsonb_build_object('schema_version','document-field-answer-v3','action',a->>'action','structured_value',a->'structured_value'),false);
exception when invalid_text_representation then return false;
end;$$;
-- Locked source/currentness and identity checks remain in the existing writers
-- and trigger. The new branch cannot accept v2/plain-number answers.
do $$ declare d text;signature text;begin
 foreach signature in array array['public.case_request_answer(uuid,uuid,text)','public.case_request_edit(uuid,uuid,uuid,text,integer,text)'] loop
 d:=pg_get_functiondef(signature::regprocedure);
 if position('private.document_field_answer_v2_valid(answer)' in d)=0 then raise exception 'STRUCTURE_WRITER_BASE_MISMATCH';end if;
 execute replace(d,'private.document_field_answer_v2_valid(answer)','private.document_field_answer_envelope_valid(answer)');
 end loop;
 d:=pg_get_functiondef('private.guard_document_cell_decision()'::regprocedure);
 if position('if not (coalesce(answer=any(r.options),false) or private.document_field_answer_v2_valid(answer))' in d)=0 then raise exception 'STRUCTURE_GUARD_BASE_MISMATCH';end if;
 execute replace(d,'if not (coalesce(answer=any(r.options),false) or private.document_field_answer_v2_valid(answer))',
 'if not (case when t->>''schema_version'' in (''document-source-relationship-v1'',''document-source-deduction-group-v1'',''document-source-balance-movement-v1'') then private.document_source_structure_answer_valid(t,answer) else coalesce(answer=any(r.options),false) or private.document_field_answer_v2_valid(answer) end)');
 -- Narrow source page projection; authentication/currentness is unchanged.
 d:=pg_get_functiondef('public.case_request_document_source(uuid,uuid,uuid)'::regprocedure);
 if position('(target#>>''{subject,page}'')::integer' in d)=0 then raise exception 'STRUCTURE_SOURCE_BASE_MISMATCH';end if;
 execute replace(d,'(target#>>''{subject,page}'')::integer','(target#>>''{subject,page}'')::integer,(target#>>''{subject,contribution,source,page}'')::integer,(target#>>''{subject,mandatory_total,source,page}'')::integer');
end;$$;

revoke all on function private.document_reading_question_scope_legacy_v4(text[],jsonb),private.document_field_current_legacy_v4(uuid,jsonb),
 private.source_structure_ref(jsonb,text,text),private.source_structure_subject_current(jsonb,jsonb,jsonb),private.source_structure_target_current(jsonb,jsonb),
 private.document_source_structure_answer_valid(jsonb,text),private.document_field_answer_envelope_valid(text)
 from public,anon,authenticated,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,service_role;
-- Only the public answer wrappers call this helper; it contains no source data.
grant execute on function private.document_field_answer_envelope_valid(text) to tivdoc_web_runtime,service_role;
grant execute on function private.document_reading_question_scope_legacy_v4(text[],jsonb) to tivdoc_worker_runtime,service_role;
