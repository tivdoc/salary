-- Preserve v1 historical bytes. V2 source completions are engineering evidence
-- only and must equal the actual checkpoint and immutable identified journal.
create function private.dev_financial_completions_bound(body jsonb,source jsonb) returns boolean
 language plpgsql stable security definer set search_path='' as $$
declare completion jsonb:=body->'source_completions'; reading jsonb; answer jsonb; target jsonb; kind text;
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
  target:=reading->'target';kind:=target#>>'{subject,kind}';
  select a into answer from jsonb_array_elements(source#>'{input,answers}') a where a->>'id'=reading->>'request_id';
  if not coalesce(answer->>'case_id'=body->>'case_id' and answer->>'scope_month'='2026-06'
   and answer->>'code'='document_transcription:'||(target->>'target_sha256') and answer->'transcription_target'=target
   and answer->>'answer'=reading->>'answer' and answer->'answer_revision'=reading->'answer_revision'
   and answer->>'answer_identity_id'=reading->>'identity_id'
   and (answer->>'answer_created_at')::timestamptz=(reading->>'answered_at')::timestamptz
   and private.document_transcription_current((body->>'case_id')::uuid,target)
   and exists(select 1 from private.document_transcription_targets t where t.request_id=(reading->>'request_id')::uuid
    and t.case_id=(body->>'case_id')::uuid and t.target=target)
   and (kind='salary_type' and reading->>'answer'='בתלוש כתוב שכר שעתי' and reading->>'normalized_value'='hourly'
    or kind='component_amount' and reading->>'answer'='כן, בדקתי במסמך והערך נכון' and reading->'normalized_value'=target#>'{subject,component,amount}'),false) then return false;end if;
 end loop;
 reading:=completion->'component_nature';target:=reading->'target';
 select a into answer from jsonb_array_elements(source#>'{input,answers}') a where a->>'id'=reading->>'request_id';
 return coalesce(answer->>'case_id'=body->>'case_id' and answer->>'scope_month'='2026-06'
  and answer->>'code'='minimum_wage_june2026:'||(target->>'target_sha256') and answer->'june2026_target'=target
  and answer->>'answer'=reading->>'answer' and reading->>'answer'='שכר יסוד או שכר משולב'
  and answer->'answer_revision'=reading->'answer_revision' and answer->>'answer_identity_id'=reading->>'identity_id'
  and (answer->>'answer_created_at')::timestamptz=(reading->>'answered_at')::timestamptz
  and target#>>'{subject,kind}'='component' and private.june2026_collection_current((body->>'case_id')::uuid,target)
  and exists(select 1 from private.june2026_collection_targets t where t.request_id=(reading->>'request_id')::uuid
   and t.case_id=(body->>'case_id')::uuid and t.target=target)
  and exists(select 1 from jsonb_array_elements(completion->'readings') r where r#>>'{target,subject,kind}'='component_amount'
   and r#>>'{target,subject,component,component_id}'=target#>>'{subject,component,component_id}'),false);
end;$$;
revoke all on function private.dev_financial_completions_bound(jsonb,jsonb) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

do $migration$ declare definition text;needle text;constraint_name text;begin
 select c.conname into strict constraint_name from pg_constraint c
 where c.conrelid='private.dev_financial_runs'::regclass and c.contype='c'
  and position('schema_version' in pg_get_constraintdef(c.oid))>0;
 execute format('alter table private.dev_financial_runs drop constraint %I',constraint_name);
 alter table private.dev_financial_runs add constraint dev_financial_wire_authority check(coalesce(payload->>'authority'='engineering_only'
  and payload->>'schema_version' in ('tivdoc-dev-financial-run-v1','tivdoc-dev-financial-run-v2'),false));
 definition:=pg_get_functiondef('private.dev_financial_save(jsonb,text,text,text)'::regprocedure);
 needle:='body->>''schema_version'' is distinct from ''tivdoc-dev-financial-run-v1''';
 if position(needle in definition)=0 then raise exception 'DEV_COMPLETION_VERSION_BASE';end if;
 definition:=replace(definition,needle,'not coalesce(body->>''schema_version'' in (''tivdoc-dev-financial-run-v1'',''tivdoc-dev-financial-run-v2''),false)');
 needle:=' select * into parent from public.analysis_runs';
 if position(needle in definition)=0 then raise exception 'DEV_COMPLETION_SAVE_BASE';end if;
 execute replace(definition,needle,$guard$
 if body->>'schema_version'='tivdoc-dev-financial-run-v2' then
  if not private.dev_financial_completions_bound(body,source) then raise exception 'DEV_FINANCIAL_COMPLETIONS_BINDING';end if;
 elsif body ? 'source_completions' then raise exception 'DEV_FINANCIAL_COMPLETIONS_BINDING';end if;
 select * into parent from public.analysis_runs$guard$);
end $migration$;
