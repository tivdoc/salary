-- Versioned exact-cell readings; no mutation of provider payloads or v1 receipts.
-- A number confirmation is not classification, applicability or remittance evidence.
alter table private.document_field_targets drop constraint document_field_targets_check;
alter table private.document_field_targets add constraint document_field_targets_check check(coalesce(
 target->>'schema_version' in ('document-field-confirmation-v1','document-row-cell-confirmation-v1','document-source-scope-confirmation-v1','document-source-transcription-v1')
 and target->>'case_id'=case_id::text and target->>'target_sha256'=target_sha256,false));
-- Reopening an expired, unanswered request creates a successor. Original
-- deadlines, targets and answer journals remain immutable.
alter table private.document_field_targets drop constraint document_field_targets_case_id_target_sha256_key;
alter table private.document_field_targets add column renewal_index integer not null default 0 check(renewal_index>=0);
alter table private.document_field_targets add column predecessor_request_id uuid unique references private.document_field_targets(request_id);
alter table private.document_field_targets add constraint document_field_renewal_chain check((renewal_index=0)=(predecessor_request_id is null));
alter table private.document_field_targets add constraint document_field_target_generation unique(case_id,target_sha256,renewal_index);

create function private.document_reading_question_scope_v4(purchased_topics text[], target jsonb) returns boolean
language sql immutable security invoker set search_path='' as $$
 select coalesce(case target->>'schema_version'
 when 'document-field-confirmation-v1' then target#>'{candidate,normalized_value}'<>'null'::jsonb
  and target#>>'{candidate,field}'=any(private.document_field_question_fields_v3(purchased_topics))
 when 'document-row-cell-confirmation-v1' then
  target->>'cell' in ('amount','quantity','rate','percentage')
  and char_length(btrim(target->'original_component'->>(target->>'cell'||'_raw'))) between 1 and 500
  and case target#>>'{original_component,semantic_kind}'
   when 'base_salary' then 'minimum_wage' when 'hourly_base' then 'minimum_wage'
   when 'overtime_125' then 'working_time' when 'overtime_150' then 'working_time'
   when 'travel' then 'travel' when 'convalescence' then 'convalescence' when 'bonus' then 'bonuses'
   else null end=any(purchased_topics)
 when 'document-source-scope-confirmation-v1' then
  char_length(btrim(target#>>'{original_observation,candidate,raw_value}')) between 1 and 500
  and case target#>>'{original_observation,scope}'
   when 'voluntary_deduction' then 'minimum_wage' when 'final_payable' then 'minimum_wage'
   when 'mandatory_deduction_subtotal' then 'minimum_wage' when 'attendance_total' then 'working_time'
   when 'combined_employer_funds' then 'pension' when 'severance_fund' then 'pension'
   when 'study_fund' then 'pension' when 'tax_exemption_reference' then 'pension'
   else null end=any(purchased_topics)
 when 'document-source-transcription-v1' then case target#>>'{subject,kind}'
  when 'reported_work_hours' then 'working_time'=any(purchased_topics) and target#>>'{subject,meaning}'='document_reported_total_hours'
   and target#>>'{subject,page}'~'^[1-9][0-9]?$|^100$'
  when 'balance_unit' then target#>'{subject,original_candidate,normalized_value}'='null'::jsonb
   and char_length(btrim(target#>>'{subject,original_candidate,raw_value}')) between 1 and 500
   and case target#>>'{subject,original_candidate,field}' when 'vacation_balance' then 'vacation' when 'sick_balance' then 'sick_leave' else null end=any(purchased_topics)
  else false end
 else false end,false)
 and cardinality(purchased_topics)>0 and array_position(purchased_topics,null) is null
 and purchased_topics <@ array['minimum_wage','working_time','pension','travel','convalescence','vacation','sick_leave','rest_day','bonuses','contract']::text[];
$$;
revoke all on function private.document_reading_question_scope_v4(text[],jsonb) from public,anon,authenticated,tivdoc_web_runtime,tivdoc_operations_runtime;
grant execute on function private.document_reading_question_scope_v4(text[],jsonb) to tivdoc_worker_runtime,service_role;

CREATE OR REPLACE FUNCTION private.document_field_current(target_case uuid, target jsonb)
 RETURNS boolean
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
 select exists(select 1 from public.documents d join public.cases pc on pc.id=d.case_id
  join private.case_extraction_checkpoints c on c.case_id=d.case_id and c.version_id=d.version_id
  where d.case_id=target_case and d.id::text=target->>'product_document_id' and d.version_id::text=target->>'version_id'
   and to_char(coalesce(d.period_month,pc.check_period_month),'YYYY-MM')=target->>'month'
   and d.content_sha256=target->>'source_sha256' and c.input_sha256=d.content_sha256
   and c.policy_version=target->>'policy_version' and c.result_sha256=target->>'extraction_result_sha256'
   and c.result->>'expected_month'=target->>'month' and c.result->>'period_mismatch'='false'
   and c.result->>'case_id'=target_case::text and c.result->>'product_document_id'=d.id::text
   and c.result->>'version_id'=d.version_id::text and c.result->>'input_sha256'=d.content_sha256
   and (
    (target->>'schema_version'='document-field-confirmation-v1' and exists(select 1 from jsonb_array_elements(c.result#>'{run,result,final_extraction,fields}') f where f=target->'candidate' and f#>>'{source,document_id}'=d.version_id::text))
    or (target->>'schema_version' in ('document-row-cell-confirmation-v1','document-source-scope-confirmation-v1','document-source-transcription-v1')
     and target->>'target_sha256'=encode(sha256(convert_to(private.governance_jsonb_compact_text(target-'target_sha256'),'UTF8')),'hex')
     and private.document_reading_question_scope_v4(array['minimum_wage','working_time','pension','travel','convalescence','vacation','sick_leave','rest_day','bonuses','contract']::text[],target)
     and ((target->>'schema_version'='document-row-cell-confirmation-v1'
       and (select count(*) from jsonb_array_elements(c.result#>'{run,result,final_extraction,additional_components}') r
        where r->>'component_id'=target#>>'{original_component,component_id}')=1
       and exists(select 1 from jsonb_array_elements(c.result#>'{run,result,final_extraction,additional_components}') r
        where r=target->'original_component' and r#>>'{source,document_id}'=d.version_id::text))
      or (target->>'schema_version'='document-source-scope-confirmation-v1'
       and (select count(*) from jsonb_array_elements(coalesce(c.result#>'{run,result,final_extraction,source_scope_observations}','[]'::jsonb)) o
        where o#>>'{candidate,candidate_id}'=target#>>'{original_observation,candidate,candidate_id}')=1
       and exists(select 1 from jsonb_array_elements(coalesce(c.result#>'{run,result,final_extraction,source_scope_observations}','[]'::jsonb)) o
        where o=target->'original_observation' and o#>>'{candidate,source,document_id}'=d.version_id::text))
      or (target->>'schema_version'='document-source-transcription-v1'
       and c.result#>>'{run,result,first_pass,normalized_extraction,document_id}'=d.version_id::text
       and ((target#>>'{subject,kind}'='reported_work_hours'
        and (target#>>'{subject,page}')::integer <= (c.result#>>'{run,result,final_extraction,quality_metrics,page_count}')::integer
        and (target#>>'{subject,page}')::integer <= (c.result#>>'{run,result,first_pass,normalized_extraction,quality_metrics,page_count}')::integer
        and not exists(select 1 from jsonb_array_elements(coalesce(c.result#>'{run,result,final_extraction,source_scope_observations}','[]'::jsonb)||coalesce(c.result#>'{run,result,first_pass,normalized_extraction,source_scope_observations}','[]'::jsonb)) o where o->>'scope'='attendance_total'))
        or (target#>>'{subject,kind}'='balance_unit'
         and target#>>'{subject,first_pass_extraction_sha256}'=encode(sha256(convert_to(private.governance_jsonb_compact_text(c.result#>'{run,result,first_pass,normalized_extraction}'),'UTF8')),'hex')
         and (select count(*) from jsonb_array_elements(c.result#>'{run,result,first_pass,normalized_extraction,fields}') b where b->>'candidate_id'=target#>>'{subject,original_candidate,candidate_id}')=1
         and exists(select 1 from jsonb_array_elements(c.result#>'{run,result,first_pass,normalized_extraction,fields}') b where b=target#>'{subject,original_candidate}' and b#>>'{source,document_id}'=d.version_id::text
          and (b#>>'{source,page}')::integer <= (c.result#>>'{run,result,final_extraction,quality_metrics,page_count}')::integer)
         and not exists(select 1 from jsonb_array_elements(c.result#>'{run,result,final_extraction,fields}') b where b->>'field'=target#>>'{subject,original_candidate,field}'))))))));
$function$
;

CREATE OR REPLACE FUNCTION private.document_field_request_open(target_case uuid, expected_revision integer, expected_input_sha256 text, target_payload jsonb, target_question text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare new_request uuid; previous_request uuid; generation integer:=0; previous_state public.case_requests;head private.case_input_heads;candidate_field text:=target_payload#>>'{candidate,field}';target_month date;
begin
 if session_user<>'tivdoc_worker_runtime' or private.runtime_verified_tenant() is distinct from 'saved-case:'||target_case::text then raise exception 'REQUEST_FIELD_FORBIDDEN';end if;
 perform 1 from public.cases where id=target_case for update;if not found then raise exception 'REQUEST_FIELD_FORBIDDEN';end if;
 select * into head from private.case_input_heads where case_id=target_case;
 if head.revision is distinct from expected_revision or head.input_sha256 is distinct from expected_input_sha256 then raise exception 'REQUEST_FIELD_SOURCE_CHANGED';end if;
 if not coalesce(target_payload->>'case_id'=target_case::text
  and target_payload->>'target_sha256'~'^[a-f0-9]{64}$' and target_payload->>'month'~'^\d{4}-(0[1-9]|1[0-2])$'
  and private.document_reading_question_scope_v4(array['minimum_wage','working_time','pension','travel','convalescence','vacation','sick_leave','rest_day','bonuses','contract']::text[],target_payload),false)
  or char_length(target_question) not between 4 and 400 or target_question is null then raise exception 'REQUEST_FIELD_TARGET_INVALID';end if;
 if not private.document_field_current(target_case,target_payload) then raise exception 'REQUEST_FIELD_SOURCE_CHANGED';end if;
 target_month:=to_date(target_payload->>'month','YYYY-MM');
 if not (exists(select 1 from private.product_orders o join private.order_entitlements e on e.order_id=o.id and e.state='active'
  where o.case_id=target_case and o.state='paid' and o.refund_state<>'refunded' and target_month between o.period_from and o.period_to)
  or exists(select 1 from jsonb_array_elements(private.legacy_paid_scopes_internal(target_case)) s where private.legacy_scope_covers_month(s,target_month)))
  then raise exception 'REQUEST_FIELD_UNPURCHASED_MONTH';end if;
 if not (exists(select 1 from private.case_input_versions v
  cross join lateral jsonb_array_elements(v.input->'orders') pinned
  join private.product_orders o on o.case_id=v.case_id and o.id::text=pinned->>'id'
  join private.order_entitlements e on e.order_id=o.id and e.state='active'
  where v.case_id=target_case and v.revision=expected_revision and v.input_sha256=expected_input_sha256 and o.state='paid' and o.refund_state<>'refunded'
   and pinned=jsonb_build_object('id',o.id,'kind',o.kind,'from',o.period_from,'to',o.period_to,'topics',o.topics,'offer_sha256',o.offer_sha256)
   and target_month between o.period_from and o.period_to and private.document_reading_question_scope_v4(o.topics,target_payload))
  or exists(select 1 from private.case_input_versions v cross join lateral jsonb_array_elements(v.input->'legacy_orders') pinned
   cross join lateral jsonb_array_elements(private.legacy_paid_scopes_internal(target_case)) active
   where v.case_id=target_case and v.revision=expected_revision and v.input_sha256=expected_input_sha256 and pinned=active
    and private.legacy_scope_covers_month(active,target_month)
    and private.document_reading_question_scope_v4(array(select jsonb_array_elements_text(active->'topics')),target_payload)))
  then raise exception 'REQUEST_FIELD_UNPURCHASED_TOPIC';end if;
 select t.request_id,t.renewal_index into new_request,generation from private.document_field_targets t where t.case_id=target_case and t.target_sha256=target_payload->>'target_sha256' order by t.renewal_index desc limit 1;
 if new_request is not null then
  if (select t.target from private.document_field_targets t where t.request_id=new_request) is distinct from target_payload then raise exception 'REQUEST_FIELD_TARGET_CONFLICT';end if;
  select * into previous_state from public.case_requests where id=new_request for update;
  if previous_state.answered_at is not null or (previous_state.expired_at is null and previous_state.expires_at>clock_timestamp()) then return new_request;end if;
  if previous_state.expires_at>clock_timestamp() then raise exception 'REQUEST_FIELD_RENEWAL_NOT_DUE';end if;
  update public.case_requests set expired_at=coalesce(expired_at,clock_timestamp()) where id=new_request and answered_at is null;
  previous_request:=new_request;generation:=generation+1;
 else generation:=0;
 end if;
 candidate_field:=case target_payload->>'schema_version' when 'document-row-cell-confirmation-v1' then 'row_cell.'||(target_payload->>'cell')
  when 'document-source-scope-confirmation-v1' then 'source_scope.'||(target_payload#>>'{original_observation,scope}')
  when 'document-source-transcription-v1' then 'source_transcription.'||(target_payload#>>'{subject,kind}') else candidate_field end;
 new_request:=gen_random_uuid();
 insert into private.document_field_targets(request_id,case_id,target_sha256,target,renewal_index,predecessor_request_id) values(new_request,target_case,target_payload->>'target_sha256',target_payload,generation,previous_request);
 insert into public.case_requests(id,case_id,code,question,answer_kind,options,field_crop,blocking,expires_at)
 values(new_request,target_case,'document_field:'||(target_payload->>'target_sha256'),target_question,'choice',
 array['כן, בדקתי במסמך והערך נכון','הערך שונה במסמך','לא ניתן לקרוא את השדה'],candidate_field,false,clock_timestamp()+interval '10 days');
 return new_request;
end;$function$
;

CREATE OR REPLACE FUNCTION public.case_request_document_source(target_case uuid, target_identity uuid, target_request uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare target jsonb; source jsonb;
begin
 if not exists(select 1 from public.case_identity_cases where case_id=target_case and identity_id=target_identity) then raise exception 'REQUEST_FIELD_FORBIDDEN';end if;
 select t.target into target from private.document_field_targets t join public.case_requests r on r.id=t.request_id and r.case_id=t.case_id
 where t.case_id=target_case and t.request_id=target_request and private.document_field_current(target_case,t.target);
 if target is null then
  select t.target into target from private.june2026_collection_targets t join public.case_requests r on r.id=t.request_id and r.case_id=t.case_id
   where t.case_id=target_case and t.request_id=target_request and r.code='minimum_wage_june2026:'||t.target_sha256
    and private.june2026_collection_current(target_case,t.target);
 end if;
 if target is null then
  select t.target into target from private.document_transcription_targets t join public.case_requests r on r.id=t.request_id and r.case_id=t.case_id
   where t.case_id=target_case and t.request_id=target_request and r.code='document_transcription:'||t.target_sha256
    and private.document_transcription_current(target_case,t.target);
 end if;
 if target is null then
  select t.target into target from private.june2026_hours_conflict_targets t join public.case_requests r on r.id=t.request_id and r.case_id=t.case_id
   where t.case_id=target_case and t.request_id=target_request and r.code='document_hours_conflict:'||t.target_sha256 and private.june2026_hours_conflict_current(target_case,t.target);
  if target is not null then
   return (select jsonb_build_object('path',d.storage_path,'mime',d.mime_type,'size',d.size,'sha256',d.content_sha256,'version',d.version_id,'page',1)
    from public.documents d where d.case_id=target_case and d.id::text=target->>'product_document_id' and d.version_id::text=target->>'version_id' and d.content_sha256=target->>'source_sha256');
  end if;
 end if;
 if target is null then return null;end if;
 select jsonb_build_object('path',d.storage_path,'mime',d.mime_type,'size',d.size,'sha256',d.content_sha256,'version',d.version_id,'page',coalesce((target#>>'{candidate,source,page}')::integer,(target#>>'{original_component,source,page}')::integer,(target#>>'{original_observation,candidate,source,page}')::integer,(target#>>'{subject,original_candidate,source,page}')::integer,(target#>>'{subject,page}')::integer,(target#>>'{subject,component,source,page}')::integer,1))
 into source from public.documents d where d.case_id=target_case and d.id::text=target->>'product_document_id'
  and d.version_id::text=target->>'version_id' and d.content_sha256=target->>'source_sha256';
 return source;
end;$function$
;
