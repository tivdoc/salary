-- Drafts are identified/current-source notes, never admitted answers. They may
-- be partial; final answers retain the strict value/basis schema.
do $migration$ declare definition text;needle text;begin
 definition:=pg_get_functiondef('private.june2026_hours_conflict_answer_guard()'::regprocedure);
 needle:=' if parsed->>''state''=''unknown'' then';
 if position(needle in definition)=0 then raise exception 'HOURS_CONFLICT_DRAFT_BASE';end if;
 execute replace(definition,needle,$new$ if tg_table_name='case_request_drafts' then
  if char_length(parsed->>'basis')>1000 then raise exception 'REQUEST_ANSWER_INVALID';end if;
  if parsed->>'state'='unknown' and keys=array['basis','schema_version','state'] then return new;end if;
  if parsed->>'state'='declared' and keys=array['basis','hours','schema_version','state']
   and jsonb_typeof(parsed->'hours')='string' and char_length(parsed->>'hours')<=8 then return new;end if;
  raise exception 'REQUEST_ANSWER_INVALID';
 end if;
 if parsed->>'basis' is distinct from trim(parsed->>'basis') then raise exception 'REQUEST_ANSWER_INVALID';end if;
 if parsed->>'state'='unknown' then$new$);
end $migration$;
