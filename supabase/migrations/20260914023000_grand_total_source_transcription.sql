-- Versioned grand-total source transcription through existing identified requests.
-- Historical target families keep their complete existing dispatch and ACLs.
do $install$
declare body text;
begin
 if to_regprocedure('private.document_field_current_before_grand_total_v1(uuid,jsonb)') is not null
  or to_regprocedure('private.document_reading_question_scope_before_grand_total_v1(text[],jsonb)') is not null then
  raise exception 'GRAND_TOTAL_ALREADY_INSTALLED';
 end if;
 body:=pg_get_functiondef('private.document_field_current(uuid,jsonb)'::regprocedure);
 if position('document_field_current_before_source_transcription_v1' in body)=0 then raise exception 'GRAND_TOTAL_CURRENT_BASE_REQUIRED';end if;
 execute replace(body,'FUNCTION private.document_field_current(','FUNCTION private.document_field_current_before_grand_total_v1(');
 body:=pg_get_functiondef('private.document_reading_question_scope_v4(text[],jsonb)'::regprocedure);
 if position('document_reading_question_scope_before_source_transcription_v1' in body)=0 then raise exception 'GRAND_TOTAL_SCOPE_BASE_REQUIRED';end if;
 execute replace(body,'FUNCTION private.document_reading_question_scope_v4(','FUNCTION private.document_reading_question_scope_before_grand_total_v1(');
end;$install$;
revoke all on function private.document_field_current_before_grand_total_v1(uuid,jsonb),private.document_reading_question_scope_before_grand_total_v1(text[],jsonb)
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;

-- Exactly the engine's immutable printed-label test, never an amount comparison.
create function private.document_mandatory_subtotal_candidate_v1(candidate jsonb) returns boolean
language sql immutable security invoker set search_path='' as $$
 select coalesce(candidate->>'field'='total_deductions'
  and jsonb_typeof(candidate->'raw_value')='string'
  and right(candidate#>>'{source,text_fragment}',length(': '||(candidate->>'raw_value')))=': '||(candidate->>'raw_value')
  and lower(btrim(regexp_replace(translate(normalize(left(candidate#>>'{source,text_fragment}',
   length(candidate#>>'{source,text_fragment}')-length(': '||(candidate->>'raw_value'))),NFKC),'"''״׳.',''),'\s+',' ','g')))
    ~ '^(?:(?:סהכ )?ניכויי חובה(?:\s*[-־–]\s*מסים)?|mandatory deductions)$',false);
$$;
revoke all on function private.document_mandatory_subtotal_candidate_v1(jsonb)
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;

create or replace function private.document_reading_question_scope_v4(purchased_topics text[],target jsonb) returns boolean
language sql immutable security invoker set search_path='' as $$
 select case when target->>'schema_version'='document-source-transcription-v1' and target#>>'{subject,kind}'='grand_total' then
  coalesce('minimum_wage'=any(purchased_topics) and array_position(purchased_topics,null) is null
   and purchased_topics <@ array['minimum_wage','working_time','pension','travel','convalescence','vacation','sick_leave','rest_day','bonuses','contract']::text[]
   and target#>'{subject,page}'='1'::jsonb and target#>>'{subject,meaning}'='document_total_deductions'
   and target#>>'{subject,first_pass_extraction_sha256}'~'^[a-f0-9]{64}$'
   and (target->'subject')-array['kind','page','meaning','first_pass_extraction_sha256']='{}'::jsonb,false)
  else private.document_reading_question_scope_before_grand_total_v1(purchased_topics,target) end;
$$;

create or replace function private.document_field_current(target_case uuid,target jsonb) returns boolean
language sql security definer set search_path='' as $$
 select case when target->>'schema_version'='document-source-transcription-v1' and target#>>'{subject,kind}'='grand_total' then
 coalesce(target->>'case_id'=target_case::text
 and target-array['schema_version','case_id','product_document_id','version_id','source_sha256','month','policy_version','extraction_result_sha256','subject','target_sha256']='{}'::jsonb
 and target->>'target_sha256'=encode(sha256(convert_to(private.governance_jsonb_compact_text(target-'target_sha256'),'UTF8')),'hex')
 and private.document_reading_question_scope_v4(array['minimum_wage'],target)
 and exists(select 1 from public.documents d join public.cases pc on pc.id=d.case_id
  join private.case_extraction_checkpoints c on c.case_id=d.case_id and c.version_id=d.version_id
  join private.document_physical_page_receipts p on p.case_id=d.case_id and p.document_id=d.id and p.version_id=d.version_id
   and p.source_sha256=d.content_sha256 and p.byte_size=d.size and p.mime_type=d.mime_type and p.page_count=1
  where d.case_id=target_case and d.id::text=target->>'product_document_id' and d.version_id::text=target->>'version_id'
   and to_char(coalesce(d.period_month,pc.check_period_month),'YYYY-MM')=target->>'month'
   and d.content_sha256=target->>'source_sha256' and c.input_sha256=d.content_sha256
   and c.policy_version=target->>'policy_version' and c.result_sha256=target->>'extraction_result_sha256'
   and c.result->>'expected_month'=target->>'month' and c.result->>'period_mismatch'='false'
   and c.result->>'case_id'=target_case::text and c.result->>'product_document_id'=d.id::text
   and c.result->>'version_id'=d.version_id::text and c.result->>'input_sha256'=d.content_sha256
   and c.result#>>'{run,result,final_extraction,document_id}'=d.version_id::text
   and c.result#>>'{run,result,first_pass,normalized_extraction,document_id}'=d.version_id::text
   and c.result#>'{run,result,final_extraction,quality_metrics,page_count}'='1'::jsonb
   and c.result#>'{run,result,first_pass,normalized_extraction,quality_metrics,page_count}'='1'::jsonb
   and target#>>'{subject,first_pass_extraction_sha256}'=encode(sha256(convert_to(private.governance_jsonb_compact_text(c.result#>'{run,result,first_pass,normalized_extraction}'),'UTF8')),'hex')
   and jsonb_typeof(c.result#>'{run,result,final_extraction,fields}')='array'
   and jsonb_typeof(c.result#>'{run,result,first_pass,normalized_extraction,fields}')='array'
   and exists(select 1 from jsonb_array_elements(c.result#>'{run,result,final_extraction,fields}') f where f->>'field'='salary_period')
   and not exists(select 1 from jsonb_array_elements(c.result#>'{run,result,final_extraction,fields}') f
    where f->>'field'='salary_period' and (f#>>'{normalized_value,year}'||'-'||lpad(f#>>'{normalized_value,month}',2,'0')) is distinct from target->>'month')
   and not exists(select 1 from jsonb_array_elements((c.result#>'{run,result,final_extraction,fields}')||(c.result#>'{run,result,first_pass,normalized_extraction,fields}')) f
    where f->>'field'='total_deductions' and not private.document_mandatory_subtotal_candidate_v1(f))),false)
 else private.document_field_current_before_grand_total_v1(target_case,target) end;
$$;
-- Existing current/request/answer/source ACLs remain unchanged. Existing source
-- dispatcher already reads subject.page; no URL, storage or identity expansion.

-- Reuse verified physical inspection for eligible payslips as well as contracts.
-- Keep the installed215 contract behavior verbatim, including its actor/head/
-- lease checks even when there is no eligible paid contract scope.
do $install$
declare definition text;
begin
 if to_regprocedure('private.contract_transcription_physical_pages_contracts_v1(uuid,integer,text,text,text,bigint)') is not null
  then raise exception 'GRAND_TOTAL_PHYSICAL_ALREADY_INSTALLED';end if;
 if to_regprocedure('private.document_mandatory_subtotal_candidate_v1(jsonb)') is null
  then raise exception 'GRAND_TOTAL_SCOPE_HELPER_REQUIRED';end if;
 definition:=pg_get_functiondef('private.contract_transcription_physical_pages_pending(uuid,integer,text,text,text,bigint)'::regprocedure);
 if position('legacy_source_period_evidence' in definition)=0 or position('runtime_verified_actor' in definition)=0
  or position('SAVED_JOB_FENCE' in definition)=0 then raise exception 'GRAND_TOTAL_PHYSICAL_215_BASE_REQUIRED';end if;
 execute replace(definition,'FUNCTION private.contract_transcription_physical_pages_pending(',
  'FUNCTION private.contract_transcription_physical_pages_contracts_v1(');
end;$install$;
revoke all on function private.contract_transcription_physical_pages_contracts_v1(uuid,integer,text,text,text,bigint)
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;

-- Preserve this RPC's OID and existing worker-only ACL. The ordinary facade
-- calls it before and after actual byte inspection; no new queue or write API.
create or replace function private.contract_transcription_physical_pages_pending(
 target_case uuid,expected_revision integer,expected_sha text,target_job text,target_worker text,target_fence bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare journal jsonb;contracts jsonb;payslips jsonb;items jsonb;
begin
 contracts:=private.contract_transcription_physical_pages_contracts_v1(target_case,expected_revision,expected_sha,target_job,target_worker,target_fence);
 -- The base always verifies actual LOGIN actor, tenant, current hashed source,
 -- qualified job payload, unexpired exact lease/fence and cancellation first.
 select v.input into journal from private.case_input_heads h join private.case_input_versions v
  on v.case_id=h.case_id and v.revision=h.revision and v.input_sha256=h.input_sha256
  where h.case_id=target_case and h.revision=expected_revision and h.input_sha256=expected_sha
   and encode(sha256(convert_to(v.input::text,'UTF8')),'hex')=expected_sha;
 if journal is null then raise exception 'REQUEST_FIELD_SOURCE_CHANGED';end if;
 select coalesce(jsonb_agg(jsonb_build_object('document_id',eligible.id,'version_id',eligible.version_id,
  'source_sha256',eligible.content_sha256,'byte_size',eligible.size,'mime_type',eligible.mime_type,'storage_path',eligible.storage_path)
  order by eligible.id),'[]'::jsonb) into payslips
 from (
  select d.* from jsonb_array_elements(journal->'documents') pin
  join public.documents d on d.case_id=target_case and d.id::text=pin->>'id' and d.version_id::text=pin->>'version_id'
   and d.content_sha256=pin->>'sha256' and d.document_type::text=pin->>'type'
  join public.cases pc on pc.id=d.case_id
  -- Reuse a retained source checkpoint. A new source revision need not cause
  -- extraction or rewrite the original observation. Select latest source
  -- receipt first, then validate it; do not fall back to an older valid row.
  cross join lateral (select cp.* from private.case_extraction_checkpoints cp
   where cp.case_id=d.case_id and cp.version_id=d.version_id and cp.input_sha256=d.content_sha256
    and cp.revision<=expected_revision
   order by cp.revision desc,cp.created_at desc,cp.policy_version desc limit 1) c
  where d.document_type::text='payslip'
   and c.result_sha256=c.result->>'result_sha256'
   and c.result_sha256=encode(sha256(convert_to(private.governance_jsonb_compact_text(c.result#>'{run,result}'),'UTF8')),'hex')
   and c.result->>'schema_version'='tivdoc-saved-extraction-v1'
   and c.result->>'case_id'=target_case::text and c.result->>'product_document_id'=d.id::text
   and c.result->>'version_id'=d.version_id::text and c.result->>'input_sha256'=d.content_sha256
   and c.result->>'expected_month'~'^[0-9]{4}-(0[1-9]|1[0-2])$'
   and to_char(coalesce(d.period_month,pc.check_period_month),'YYYY-MM')=c.result->>'expected_month'
   and c.result->>'period_mismatch'='false'
   and c.result#>>'{run,result,final_extraction,document_id}'=d.version_id::text
   and c.result#>>'{run,result,first_pass,normalized_extraction,document_id}'=d.version_id::text
   and c.result#>>'{run,result,final_extraction,detected_document_type}'='payslip'
   and c.result#>>'{run,result,first_pass,normalized_extraction,detected_document_type}'='payslip'
   -- These are eligibility observations, never a physical page certificate.
   -- inspectSourcePhysicalPages must still decode the actual bytes. A two-page
   -- result stays two pages and cannot subsequently pass217's one-page target.
   and c.result#>'{run,result,final_extraction,quality_metrics,page_count}'='1'::jsonb
   and c.result#>'{run,result,first_pass,normalized_extraction,quality_metrics,page_count}'='1'::jsonb
   and jsonb_typeof(c.result#>'{run,result,final_extraction,fields}')='array'
   and jsonb_typeof(c.result#>'{run,result,first_pass,normalized_extraction,fields}')='array'
   and exists(select 1 from jsonb_array_elements(c.result#>'{run,result,final_extraction,fields}') f where f->>'field'='salary_period')
   and not exists(select 1 from jsonb_array_elements(c.result#>'{run,result,final_extraction,fields}') f
    where f->>'field'='salary_period' and (f#>>'{normalized_value,year}'||'-'||lpad(f#>>'{normalized_value,month}',2,'0')) is distinct from c.result->>'expected_month')
   and not exists(select 1 from jsonb_array_elements((c.result#>'{run,result,final_extraction,fields}')||(c.result#>'{run,result,first_pass,normalized_extraction,fields}')) f
    where f->>'field'='total_deductions' and not private.document_mandatory_subtotal_candidate_v1(f))
   and (exists(select 1 from jsonb_array_elements(coalesce(journal->'orders','[]'::jsonb)) o
     where o->'topics' ? 'minimum_wage'
      and private.document_review_paid_scope_current(target_case,(o->>'id')::uuid,'saved_order',o->>'offer_sha256',o->'topics',to_date(c.result->>'expected_month','YYYY-MM')))
    or exists(select 1 from jsonb_array_elements(coalesce(journal->'legacy_orders','[]'::jsonb)) o
     where o->'topics' ? 'minimum_wage'
      -- Existing verified legacy scope covers only a genuine complete month;
      -- it resolves missing receipt periods from authenticated financial-source
      -- evidence and refuses refunds/cancellation. Contract text supplies none.
      and private.document_review_paid_scope_current(target_case,(o->>'id')::uuid,'legacy_paid_receipt',o->>'receipt_sha256',o->'topics',to_date(c.result->>'expected_month','YYYY-MM'))))
   and not exists(select 1 from private.document_physical_page_receipts p where p.case_id=d.case_id and p.document_id=d.id
    and p.version_id=d.version_id and p.source_sha256=d.content_sha256 and p.byte_size=d.size and p.mime_type=d.mime_type and p.method='physical-pages-v1')
 ) eligible;
 items:=contracts||payslips;
 if jsonb_array_length(items)>24 then raise exception 'SOURCE_INTAKE_PHYSICAL_BOUND';end if;
 return items;
end;$$;
-- No grants change. Required actual-role acceptance: contracts retained;
-- payslip-only minimum_wage paid source with absent physical receipt is read
-- once and physically recorded; existing true grand total/unpaid/foreign/
-- replaced source/expired or cancelled lease are denied or omitted. The same
-- eligibility is checked after Storage I/O, including refunded purchase.
