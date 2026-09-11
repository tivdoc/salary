-- PRIVATE FORWARD PROPOSAL. Root owns migration creation/application.
-- Rename only the PL/pgSQL period loop variable; retain SQL aliases p.
-- CREATE OR REPLACE obtained via pg_get_functiondef preserves exact ACLs.
do $forward$
declare definition text;old_block text;new_block text;loop_start integer;loop_end integer;
begin
 definition:=pg_get_functiondef('private.legacy_paid_scope_register(uuid,bytea,jsonb)'::regprocedure);
 old_block:='amount_text text;amount_minor numeric;p jsonb;pin jsonb;';
 if length(definition)-length(replace(definition,old_block,''))<>length(old_block) then raise exception 'LEGACY_PERIOD_VARIABLE_DECLARATION_DRIFT';end if;
 definition:=replace(definition,old_block,'amount_text text;amount_minor numeric;v_period jsonb;pin jsonb;');
 loop_start:=position(' for p in select * from jsonb_array_elements(target_scope->''periods'') loop' in definition);
 loop_end:=position(' -- Reject reuse of real clearing identifiers across source cases/payments.' in definition);
 if loop_start=0 or loop_end<=loop_start then raise exception 'LEGACY_PERIOD_VARIABLE_LOOP_DRIFT';end if;
 old_block:=substring(definition from loop_start for loop_end-loop_start);
 new_block:=regexp_replace(old_block,'\mp\M','v_period','g');
 if new_block=old_block or position('for v_period in' in new_block)=0 then raise exception 'LEGACY_PERIOD_VARIABLE_PATCH_EMPTY';end if;
 execute replace(definition,old_block,new_block);
end;$forward$;
