-- The QA-only gate must be checked again under the same case lock that
-- serializes source changes. Preserve the already applied predecessor bytes.
do $forward$
declare definition text;needle text;replacement text;
begin
 definition:=pg_get_functiondef('private.extraction_prompt_derivation_put(uuid,integer,uuid,text,jsonb)'::regprocedure);
 needle:=' perform 1 from public.cases where id=target_case for update;';
 replacement:=$sql$ perform 1 from public.cases where id=target_case and is_qa=true for update;
 if not found then raise exception 'EXTRACTION_PROMPT_DERIVATION_FORBIDDEN';end if;$sql$;
 if length(definition)-length(replace(definition,needle,''))<>length(needle) then raise exception 'EXTRACTION_PROMPT_QA_LOCK_DRIFT';end if;
 execute replace(definition,needle,replacement);
end;$forward$;
