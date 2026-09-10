-- Avoid PL/pgSQL variable/column ambiguity while retaining every source and answer binding.
create or replace function private.dev_financial_completions_bound(body jsonb,source jsonb) returns boolean
 language plpgsql stable security definer set search_path='' as $$
declare completion jsonb:=body->'source_completions'; reading jsonb; answer jsonb; completion_target jsonb; kind text;
begin
 if not coalesce(completion->>'schema_version'='dev-financial-source-completions-v1'
  and completion->>'authority'='engineering_only' and completion->>'case_id'=body->>'case_id'
  and completion->>'order_id'=body->>'order_id' and completion->>'extraction_policy_version'='saved-payslip-v21-p95-v1'
  and completion->'checkpoint'=source->'checkpoint'
  and jsonb_array_length(completion->'readings')=2
  and completion->>'snapshot_sha256'=encode(sha256(convert_to(private.governance_jsonb_compact_text(completion-'snapshot_sha256'),'UTF8')),'hex')
  and (select count(distinct r#>>'{target,subject,kind}')=2 and bool_and(r#>>'{target,subject,kind}' in ('salary_type','component_amount'))
   from jsonb_array_elements(completion->'readings') r),false) then return false;end if;
 for reading in select value from jsonb_array_elements(completion->'readings') loop
  completion_target:=reading->'target';kind:=completion_target#>>'{subject,kind}';
  select a into answer from jsonb_array_elements(source#>'{input,answers}') a where a->>'id'=reading->>'request_id';
  if not coalesce(answer->>'case_id'=body->>'case_id' and answer->>'scope_month'='2026-06'
   and answer->>'code'='document_transcription:'||(completion_target->>'target_sha256') and answer->'transcription_target'=completion_target
   and answer->>'answer'=reading->>'answer' and answer->'answer_revision'=reading->'answer_revision'
   and answer->>'answer_identity_id'=reading->>'identity_id'
   and (answer->>'answer_created_at')::timestamptz=(reading->>'answered_at')::timestamptz
   and private.document_transcription_current((body->>'case_id')::uuid,completion_target)
   and exists(select 1 from private.document_transcription_targets t where t.request_id=(reading->>'request_id')::uuid
    and t.case_id=(body->>'case_id')::uuid and t.target=completion_target)
   and (kind='salary_type' and reading->>'answer'='בתלוש כתוב שכר שעתי' and reading->>'normalized_value'='hourly'
    or kind='component_amount' and reading->>'answer'='כן, בדקתי במסמך והערך נכון' and reading->'normalized_value'=completion_target#>'{subject,component,amount}'),false) then return false;end if;
 end loop;
 reading:=completion->'component_nature';completion_target:=reading->'target';
 select a into answer from jsonb_array_elements(source#>'{input,answers}') a where a->>'id'=reading->>'request_id';
 return coalesce(answer->>'case_id'=body->>'case_id' and answer->>'scope_month'='2026-06'
  and answer->>'code'='minimum_wage_june2026:'||(completion_target->>'target_sha256') and answer->'june2026_target'=completion_target
  and answer->>'answer'=reading->>'answer' and reading->>'answer'='שכר יסוד או שכר משולב'
  and answer->'answer_revision'=reading->'answer_revision' and answer->>'answer_identity_id'=reading->>'identity_id'
  and (answer->>'answer_created_at')::timestamptz=(reading->>'answered_at')::timestamptz
  and completion_target#>>'{subject,kind}'='component' and private.june2026_collection_current((body->>'case_id')::uuid,completion_target)
  and exists(select 1 from private.june2026_collection_targets t where t.request_id=(reading->>'request_id')::uuid
   and t.case_id=(body->>'case_id')::uuid and t.target=completion_target)
  and exists(select 1 from jsonb_array_elements(completion->'readings') r where r#>>'{target,subject,kind}'='component_amount'
   and r#>>'{target,subject,component,component_id}'=completion_target#>>'{subject,component,component_id}'),false);
end;$$;
