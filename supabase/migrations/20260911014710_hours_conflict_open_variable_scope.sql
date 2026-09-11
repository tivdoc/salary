-- The first real 100/120-hour conflict reached this function and exposed a
-- PL/pgSQL ambiguity: its local `target` also names a column in the journal.
-- Rename only the local identifier. Keep default ambiguity errors, all source
-- authorization, the current-input lock and immutable journal behavior.
do $migration$
declare definition text;
begin
 definition:=pg_get_functiondef('private.june2026_hours_conflict_request_open(uuid,uuid,integer,text)'::regprocedure);
 if position('declare source jsonb;target jsonb;request uuid;question text;' in definition)=0
  or position('and target_sha256=target->>''target_sha256''' in definition)=0
  then raise exception 'HOURS_CONFLICT_OPEN_VARIABLE_BASE';end if;
 execute regexp_replace(definition,'\mtarget\M','conflict_target','g');
end $migration$;
