-- RETURNS TABLE exposes case_id as a PL/pgSQL variable. The enrollment
-- subquery must name its table explicitly; otherwise the real scheduler
-- raises 42702 before it can discover any work. Keep every scope/lease gate.
do $migration$
declare definition text; anchor text := 'private.ai_release_enrollment_events where case_id=r.case_id';
begin
 select pg_get_functiondef('private.managed_dev_worker_candidates(text,integer)'::regprocedure) into definition;
 if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then
  raise exception 'MANAGED_CANDIDATE_SCOPE_ALIAS_ANCHOR';
 end if;
 execute replace(definition,anchor,'private.ai_release_enrollment_events enrollment where enrollment.case_id=r.case_id');
end;
$migration$;
