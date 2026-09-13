-- Persist invalidation metadata alongside new results, never in historical
-- report bytes. Existing rows remain NULL and become unavailable if their
-- current dispatch has since acquired a different authority dependency.
alter table private.june2026_regular_results add column authority_dependency_sha256 text
 check(authority_dependency_sha256 is null or authority_dependency_sha256 ~ '^[a-f0-9]{64}$');
create function private.june2026_regular_result_dependency() returns trigger
 language plpgsql security invoker set search_path='' as $$
begin
 select d.authority_dependency_sha256 into new.authority_dependency_sha256
 from private.case_analysis_dispatch d join private.case_input_heads h on h.case_id=d.case_id and h.revision=d.revision
 where d.case_id=new.case_id and d.revision=new.input_revision and h.input_sha256=new.input_sha256 and d.mode='draft';
 if not found then raise exception 'REGULAR_RESULT_DEPENDENCY_SOURCE';end if;
 return new;
end;$$;
revoke all on function private.june2026_regular_result_dependency()
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create trigger june_regular_result_dependency before insert on private.june2026_regular_results
 for each row execute function private.june2026_regular_result_dependency();
do $migration$
declare original text;body text;
begin
 select pg_get_functiondef('private.june2026_regular_publication_current(uuid)'::regprocedure) into original;
 body:=replace(original,'select * into a from private.june2026_regular_assessments where id=result.assessment_id;',
  'if not exists(select 1 from private.case_analysis_dispatch d where d.case_id=result.case_id and d.revision=result.input_revision and d.mode=''draft'' and d.authority_dependency_sha256 is not distinct from result.authority_dependency_sha256) then return false;end if; select * into a from private.june2026_regular_assessments where id=result.assessment_id;');
 if body=original then raise exception 'REGULAR_RESULT_CURRENT_DEPENDENCY_ANCHOR';end if;execute body;
 select pg_get_functiondef('private.june2026_regular_result_save(uuid,uuid,integer,text,text,jsonb,jsonb)'::regprocedure) into original;
 body:=replace(original,'if prior.execution is distinct from execution',
  'if not exists(select 1 from private.case_analysis_dispatch d where d.case_id=target_case and d.revision=target_revision and d.mode=''draft'' and d.authority_dependency_sha256 is not distinct from prior.authority_dependency_sha256) then raise exception ''REGULAR_RESULT_DEPENDENCY_SUPERSEDED'';end if; if prior.execution is distinct from execution');
 if body=original then raise exception 'REGULAR_RESULT_REPLAY_DEPENDENCY_ANCHOR';end if;execute body;
end $migration$;
