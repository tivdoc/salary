-- Persist where and when an explicit questionnaire assertion applies. Historical
-- payloads keep unknown scope; no date or period is backfilled by inference.
alter table public.questionnaire_responses add column statement_month date
 check(statement_month is null or date_trunc('month',statement_month)=statement_month);
create function private.questionnaire_statement_scope() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if tg_table_schema<>'public' or tg_table_name<>'questionnaire_responses' then raise exception 'QUESTIONNAIRE_SCOPE_INVALID';end if;
 if tg_op='INSERT' then
  select check_period_month into new.statement_month from public.cases where id=new.case_id;
 elsif new.case_id is distinct from old.case_id or new.statement_month is distinct from old.statement_month then
  raise exception 'QUESTIONNAIRE_SCOPE_IMMUTABLE';
 end if;
 return new;
end;$$;
revoke all on function private.questionnaire_statement_scope() from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create trigger questionnaire_statement_scope before insert or update on public.questionnaire_responses for each row execute function private.questionnaire_statement_scope();
do $upgrade$ declare definition text; needle text; replacement text;begin
 definition:=pg_get_functiondef('private.capture_case_input(uuid,text)'::regprocedure);
 needle:=$old$'questionnaire',(select q.payload from public.questionnaire_responses q where q.case_id=c.id),$old$;
 replacement:=needle || $new$ 'questionnaire_source',(select jsonb_build_object('id',q.id,'case_id',q.case_id,'scope_month',to_char(q.statement_month,'YYYY-MM'),'created_at',q.created_at) from public.questionnaire_responses q where q.case_id=c.id),$new$;
 if position(needle in definition)=0 then raise exception 'QUESTIONNAIRE_CAPTURE_UPGRADE_MISSING';end if;
 execute replace(definition,needle,replacement);
end $upgrade$;
-- Capture affects only subsequent input changes; append-only historic journals remain exact.
