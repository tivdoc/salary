-- Extend exact-cell decisions; retain historical providers, targets and answers.
alter table private.document_field_targets drop constraint document_field_targets_check;
alter table private.document_field_targets add constraint document_field_targets_check check(coalesce(
 target->>'schema_version' in ('document-field-confirmation-v1','document-row-cell-confirmation-v1','document-source-scope-confirmation-v1','document-source-transcription-v1',
 'document-source-relationship-v1','document-source-deduction-group-v1','document-source-balance-movement-v1','document-evidence-reading-v1')
 and target->>'case_id'=case_id::text and target->>'target_sha256'=target_sha256,false));

do $$ declare d text;begin
 d:=pg_get_functiondef('private.document_reading_question_scope_v4(text[],jsonb)'::regprocedure);
 execute replace(d,'private.document_reading_question_scope_v4(','private.document_reading_question_scope_before_evidence_v1(');
 d:=pg_get_functiondef('private.document_field_current(uuid,jsonb)'::regprocedure);
 execute replace(d,'private.document_field_current(','private.document_field_current_before_evidence_v1(');
end;$$;
create or replace function private.document_reading_question_scope_v4(purchased_topics text[],target jsonb) returns boolean
language sql immutable security invoker set search_path='' as $$
 select case when target->>'schema_version'='document-evidence-reading-v1' then coalesce(
  cardinality(purchased_topics)>0 and array_position(purchased_topics,null) is null
  and purchased_topics <@ array['minimum_wage','working_time','pension','travel','convalescence','vacation','sick_leave','rest_day','bonuses','contract']::text[]
  and case target#>>'{observation,original,semantic}'
   when 'period_start' then true when 'period_end' then true
   when 'employment_start' then purchased_topics && array['pension','vacation','convalescence','contract']::text[]
   when 'employment_end' then purchased_topics && array['pension','vacation','convalescence','contract']::text[]
   when 'effective_from' then purchased_topics && array['contract','bonuses','pension','working_time','rest_day']::text[]
   when 'effective_to' then purchased_topics && array['contract','bonuses','pension','working_time','rest_day']::text[]
   when 'clause_text' then purchased_topics && array['contract','bonuses']::text[]
   when 'condition_text' then purchased_topics && array['contract','bonuses']::text[]
   when 'annex_reference' then purchased_topics && array['contract','bonuses']::text[]
   when 'balance' then purchased_topics && array['vacation','sick_leave']::text[]
   when 'percentage' then purchased_topics && array['pension','contract','bonuses']::text[]
   when 'amount' then purchased_topics && array['minimum_wage','working_time','rest_day','pension','travel','convalescence','contract','bonuses']::text[]
   when 'rate' then purchased_topics && array['minimum_wage','working_time','rest_day','contract','bonuses']::text[]
   when 'quantity' then purchased_topics && array['working_time','rest_day','travel','contract','bonuses']::text[]
   when 'absence_quantity' then purchased_topics && array['working_time','rest_day','vacation','sick_leave']::text[]
   else target#>>'{observation,original,semantic}' in ('row_date','entry_time','exit_time','break_duration','reported_duration','regular_duration','overtime_duration','paid_duration')
    and purchased_topics && array['working_time','rest_day','minimum_wage','travel']::text[] end,false)
 else private.document_reading_question_scope_before_evidence_v1(purchased_topics,target) end;
$$;

create or replace function private.document_field_current(target_case uuid,target jsonb) returns boolean
language sql security definer set search_path='' as $$
 select case when target->>'schema_version'='document-evidence-reading-v1' then coalesce(
  target->>'case_id'=target_case::text and target->>'policy_version'='saved-document-evidence-v1'
  and target->>'month'~'^[0-9]{4}-(0[1-9]|1[0-2])$'
  and target->>'target_sha256'=encode(sha256(convert_to(private.governance_jsonb_compact_text(target-'target_sha256'),'UTF8')),'hex')
  and exists(select 1 from public.documents d join private.case_input_heads h on h.case_id=d.case_id
   join private.case_input_versions v on v.case_id=h.case_id and v.revision=h.revision and v.input_sha256=h.input_sha256
   join private.case_extraction_checkpoints c on c.case_id=d.case_id and c.version_id=d.version_id and c.revision=h.revision
   where d.case_id=target_case and d.id::text=target->>'product_document_id' and d.version_id::text=target->>'version_id'
    and d.document_type::text in ('contract','attendance') and d.content_sha256=target->>'source_sha256'
    and exists(select 1 from jsonb_array_elements(v.input->'documents') p where p->>'id'=d.id::text and p->>'version_id'=d.version_id::text
      and p->>'sha256'=d.content_sha256 and p->>'type'=d.document_type::text)
    and c.input_sha256=d.content_sha256 and c.policy_version='saved-document-evidence-v1' and c.result_sha256=target->>'checkpoint_sha256'
    and c.result->>'schema_version'='tivdoc-saved-document-evidence-v1' and c.result#>>'{run,result,status}'='completed'
    and c.result->>'case_id'=target_case::text and c.result->>'product_document_id'=d.id::text
    and c.result->>'version_id'=d.version_id::text and c.result->>'input_sha256'=d.content_sha256
    and c.result#>>'{run,result,normalized,case_id}'=target_case::text and c.result#>>'{run,result,normalized,document_id}'=d.version_id::text
    and c.result#>>'{run,result,normalized,source_sha256}'=d.content_sha256
    and c.result#>>'{run,result,normalized,declared_document_type}'=d.document_type::text
    and c.result#>>'{run,result,normalized,detected_document_type}'=d.document_type::text
    and target->>'normalized_sha256'=encode(sha256(convert_to(private.governance_jsonb_compact_text(c.result#>'{run,result,normalized}'),'UTF8')),'hex')
    and (select count(*) from jsonb_array_elements(c.result#>'{run,result,normalized,observations}') o where o->>'observation_id'=target#>>'{observation,observation_id}')=1
    and exists(select 1 from jsonb_array_elements(c.result#>'{run,result,normalized,observations}') o where o=target->'observation'
     and o->>'original_sha256'=encode(sha256(convert_to(private.governance_jsonb_compact_text(o->'original'),'UTF8')),'hex')
     and (o#>>'{original,page}')::integer between 1 and (c.result#>>'{run,result,normalized,physical_page_count}')::integer))
  and (exists(select 1 from private.product_orders po join private.order_entitlements e on e.order_id=po.id and e.state='active'
   where po.case_id=target_case and po.state='paid' and po.refund_state<>'refunded'
    and to_date(target->>'month','YYYY-MM') between po.period_from and po.period_to and private.document_reading_question_scope_v4(po.topics,target))
   or exists(select 1 from jsonb_array_elements(private.legacy_paid_scopes_internal(target_case)) s
    where private.legacy_scope_covers_month(s,to_date(target->>'month','YYYY-MM'))
     and private.document_reading_question_scope_v4(array(select jsonb_array_elements_text(s->'topics')),target))),false)
 else private.document_field_current_before_evidence_v1(target_case,target) end;
$$;

-- SQL confirms only candidate observations; value semantics are rechecked by
-- the request API and on every worker replay before accepting an input fact.
create function private.document_evidence_answer_valid(target jsonb,answer_text text) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare a jsonb;raw text;k text;u text;begin
 if not private.document_field_answer_v2_valid(answer_text) then return false;end if;
 a:=answer_text::jsonb;
 if a->>'action' in ('unknown','unreadable') then return true;end if;
 if a->>'action'='confirm' then return coalesce(target#>>'{observation,original,state}'='present'
  and target#>>'{observation,state}'='candidate' and target#>'{observation,issues}'='[]'::jsonb
  and target#>'{observation,normalized_value}'<>'null'::jsonb,false);end if;
 raw:=btrim(a->>'corrected_raw_value');k:=target#>>'{observation,original,value_kind}';u:=target#>>'{observation,original,unit}';
 if k='text' then return char_length(raw) between 1 and 500;end if;
 if k='iso_date' then
  if raw~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return to_char(raw::date,'YYYY-MM-DD')=raw;end if;
  if raw~'^[0-9]{1,2}[/.][0-9]{1,2}[/.][0-9]{4}$' then
   raw:=replace(raw,'.','/');return to_char(make_date(split_part(raw,'/',3)::integer,split_part(raw,'/',2)::integer,split_part(raw,'/',1)::integer),'YYYY-MM-DD') is not null;end if;
  return false;
 end if;
 if k='clock_time' then return raw~'^([0-9]|[01][0-9]|2[0-3]):[0-5][0-9]$';end if;
 if k='duration_hhmm' then return u='hours' and raw~'^[0-9]{1,5}:[0-5][0-9]$';end if;
 if k='percentage' then return u='percent' and raw~'^[-+]?[0-9]+([.,][0-9]+)? *%?$';end if;
 if k='decimal' then return u in ('hours','days','count','unknown') and raw~'^[-+]?[0-9]+([.,][0-9]+)?$';end if;
 if k='money' then return u='ILS' and raw~'^[-+]?[0-9]+([.,][0-9]+)?$';end if;
 return false;
exception when invalid_text_representation or datetime_field_overflow or numeric_value_out_of_range then return false;
end;$$;

do $$ declare d text;needle text;begin
 d:=pg_get_functiondef('private.guard_document_cell_decision()'::regprocedure);
 needle:='if not (case when t->>''schema_version'' in';
 if position(needle in d)=0 then raise exception 'DOCUMENT_EVIDENCE_GUARD_BASE_MISMATCH';end if;
 execute replace(d,needle,'if not (case when t->>''schema_version''=''document-evidence-reading-v1'' then private.document_evidence_answer_valid(t,answer) when t->>''schema_version'' in');
 d:=pg_get_functiondef('private.document_field_request_open(uuid,integer,text,jsonb,text)'::regprocedure);
 needle:='candidate_field:=case target_payload->>''schema_version''';
 if position(needle in d)=0 then raise exception 'DOCUMENT_EVIDENCE_OPENER_BASE_MISMATCH';end if;
 execute replace(d,needle,needle||' when ''document-evidence-reading-v1'' then ''document_evidence.''||(target_payload#>>''{observation,original,semantic}'')');
 d:=pg_get_functiondef('public.case_request_document_source(uuid,uuid,uuid)'::regprocedure);
 needle:='(target#>>''{candidate,source,page}'')::integer';
 if position(needle in d)=0 then raise exception 'DOCUMENT_EVIDENCE_SOURCE_BASE_MISMATCH';end if;
 execute replace(d,needle,'(target#>>''{observation,original,page}'')::integer,'||needle);
end;$$;
revoke all on function private.document_reading_question_scope_before_evidence_v1(text[],jsonb),private.document_field_current_before_evidence_v1(uuid,jsonb),private.document_evidence_answer_valid(jsonb,text)
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function private.document_reading_question_scope_before_evidence_v1(text[],jsonb) to tivdoc_worker_runtime,service_role;
